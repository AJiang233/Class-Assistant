/**
 * 前端 PWA 相关测试：Service Worker 的缓存策略 + 安装入口的平台判定。
 *
 * 位置说明：本仓库只有一个测试运行器（`npm test` 跑 backend/test/*.test.js），
 * 所以这些测前端文件（web/sw.js、web/assets/js/app.js）的用例也放在这里，读的是真实源码。
 *
 * 覆盖的是「浏览器里没法逐个验证」的部分：断网回退、接口绕过、旧缓存清理、各平台是否给安装入口。
 * 真实的注册与接管行为已在本机浏览器实测（见方案验收记录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../../sw.js'), 'utf8');
const APP_SOURCE = readFileSync(join(HERE, '../../assets/js/app.js'), 'utf8');
const ORIGIN = 'https://class.test';

/** 把 sw.js 放进一个带假 caches / fetch / self 的沙箱里执行，取出它注册的各个事件处理器 */
function loadSW(fetchImpl) {
  const handlers = {};
  const stores = new Map();        // 缓存名 -> Map<绝对URL, Response>
  const deletedCaches = [];
  const state = { skipped: false, claimed: false };

  const absolute = (input) => (typeof input === 'string' ? new URL(input, ORIGIN).href : input.url);

  const caches = {
    async open(name) {
      if (!stores.has(name)) stores.set(name, new Map());
      const entries = stores.get(name);
      return {
        async add(path) {
          const res = await fetchImpl(path);
          if (!res.ok) throw new Error('add 失败：' + res.status);
          entries.set(absolute(path), res);
        },
        async put(request, response) { entries.set(absolute(request), response); },
        async keys() { return [...entries.keys()].map((u) => new Request(u)); },
        async match(request) { return entries.get(absolute(request)); }
      };
    },
    async keys() { return [...stores.keys()]; },
    async delete(name) { deletedCaches.push(name); return stores.delete(name); },
    async match(request) {
      const key = absolute(request);
      for (const entries of stores.values()) if (entries.has(key)) return entries.get(key);
      return undefined;
    }
  };

  const self = {
    location: { origin: ORIGIN },
    clients: { claim: async () => { state.claimed = true; } },
    skipWaiting: async () => { state.skipped = true; },
    addEventListener(type, fn) { handlers[type] = fn; }
  };

  // sw.js 是纯脚本，用 Function 注入沙箱全局
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetchImpl);
  return { handlers, stores, deletedCaches, state, self };
}

/** 构造一个 fetch 事件，并捕获 respondWith 的 promise */
function fire(handler, request) {
  const captured = { called: false, promise: null };
  handler({
    request,
    respondWith(p) { captured.called = true; captured.promise = p; }
  });
  return captured;
}

const ok = (body) => new Response(body, { status: 200 });

/** 造一个「跟过 308 跳转」的响应：redirected 为 true，其余与普通响应一致 */
function followedRedirect(body) {
  const res = new Response(body, { status: 200 });
  Object.defineProperty(res, 'redirected', { value: true });
  return res;
}

test('接口请求完全不拦截（断网时必须如实报错，不能拿旧数据糊弄）', () => {
  const sw = loadSW(async () => ok('x'));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/api/notices'));
  assert.equal(got.called, false);
});

test('跨域请求不拦截', () => {
  const sw = loadSW(async () => ok('x'));
  const got = fire(sw.handlers.fetch, new Request('https://other.test/a.js'));
  assert.equal(got.called, false);
});

test('非 GET 请求不拦截', () => {
  const sw = loadSW(async () => ok('x'));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/api/forms', { method: 'POST' }));
  assert.equal(got.called, false);
});

test('联网时页面走网络，并写入缓存', async () => {
  const sw = loadSW(async () => ok('fresh'));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  assert.equal(got.called, true);
  const res = await got.promise;
  assert.equal(await res.text(), 'fresh');
  // 键落到规范地址：/index.html 与 / 是同一份，写 .html 会让离线时按另一种写法取不到
  assert.ok(sw.stores.get('ca-shell-v2').has(ORIGIN + '/'));
});

test('跟过跳转的响应落缓存前去掉 redirected 标记', async () => {
  // 站点把 /notices.html 308 跳到 /notices。带 redirected 标记的响应被规范禁止用于
  // 导航请求（页面/iframe 的加载），原样存下来断网回放时会直接变成「网页无法打开」。
  const sw = loadSW(async () => followedRedirect('shell'));
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/notices.html')).promise;
  const stored = sw.stores.get('ca-shell-v2').get(ORIGIN + '/notices');
  assert.ok(stored, '应存在规范地址 /notices 下');
  assert.equal(stored.redirected, false, '存下来的必须是能应答导航的那一份');
});

test('同源请求强制回源校验，不吃浏览器 HTTP 缓存', async () => {
  // 本域名的 CDN 会把 /assets/*、/sw.js 的 Cache-Control 改写成 max-age=14400，
  // 不带 cache: 'no-cache' 的话「network-first」会退化成拿最多 4 小时前的旧文件。
  const inits = [];
  const sw = loadSW(async (request, init) => { inits.push(init); return ok('fresh'); });
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/assets/css/style.css')).promise;
  assert.equal(inits.length, 1);
  assert.equal(inits[0] && inits[0].cache, 'no-cache');
});

test('失败响应（500）不写入缓存', async () => {
  const sw = loadSW(async () => new Response('boom', { status: 500 }));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  await got.promise;
  // 500 时压根不会 open 缓存，所以这里用可选链判断
  assert.equal(sw.stores.get('ca-shell-v2')?.has(ORIGIN + '/') ?? false, false);
});

test('断网且缓存命中时回退到缓存（离线壳）', async () => {
  let online = true;
  const sw = loadSW(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return ok('v1');
  });
  // 先在线访问一次写入缓存
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html')).promise;
  // 再断网
  online = false;
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  const res = await got.promise;
  assert.equal(await res.text(), 'v1');
});

test('断网时 .html 请求回退到规范地址的缓存', async () => {
  // 页面里的 iframe 请求的正是 notices.html，而预热/落缓存存的是 /notices。
  // 只按请求地址找缓存的话，这里会取不到 —— 现场就是「主页能开、点别的标签全打不开」。
  let online = true;
  const sw = loadSW(async () => {
    if (!online) throw new TypeError('Failed to fetch');
    return ok('shell');
  });
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/notices')).promise;
  online = false;

  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/notices.html'));
  const res = await got.promise;
  assert.equal(await res.text(), 'shell');
});

test('断网且没有缓存时，如实抛出网络错误', async () => {
  const sw = loadSW(async () => { throw new TypeError('Failed to fetch'); });
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/never-visited.html'));
  await assert.rejects(() => got.promise, /Failed to fetch/);
});

test('安装时预热应用壳，且单个资源失败不影响整体', async () => {
  const sw = loadSW(async (path) => {
    if (String(path) === '/admin') throw new Error('该页临时取不到');
    return ok('shell');
  });
  let installWork = null;
  sw.handlers.install({ waitUntil(p) { installWork = p; } });
  await installWork;

  const entries = sw.stores.get('ca-shell-v2');
  assert.ok(entries.size >= 9, '预热的资源数量应接近清单长度（10 条里故意失败 1 条）');
  // 预热用规范地址：写成 .html 会让站点 308 跳转，存下来的响应带着 redirected 标记，
  // 断网时交给导航请求会被浏览器判成网络错误 —— 也就是「断网后除主页都打不开」
  assert.ok(entries.has(ORIGIN + '/notices'), '预热的是去扩展名的地址');
  assert.equal(entries.has(ORIGIN + '/notices.html'), false);
  assert.ok(entries.has(ORIGIN + '/assets/js/app.js'));
  assert.equal(entries.has(ORIGIN + '/admin'), false);
  assert.equal(sw.state.skipped, true, '安装后应立即接管，避免用户停在旧版本');
});

test('激活时清掉旧版本缓存，并接管页面', async () => {
  const sw = loadSW(async () => ok('shell'));
  sw.stores.set('ca-shell-v1', new Map());   // 模拟上一版遗留（键是 .html，正是这次修掉的）
  sw.stores.set('some-other-cache', new Map());
  let activateWork = null;
  sw.handlers.activate({ waitUntil(p) { activateWork = p; } });
  await activateWork;

  assert.deepEqual(sw.deletedCaches.sort(), ['ca-shell-v1', 'some-other-cache']);
  assert.equal(sw.stores.has('ca-shell-v2'), false, '当前版本缓存不应被清掉（activate 只删旧的）');
  assert.equal(sw.state.claimed, true);
});

// ===== 推送 =====

/** 装上假的 registration.showNotification，返回收集到的通知数组 */
function captureNotifications(sw) {
  const shown = [];
  sw.self.registration = {
    async showNotification(title, options) { shown.push({ title, options }); }
  };
  return shown;
}

test('收到推送必须立刻展示通知（Safari 不允许隐形推送，否则权限会被撤销）', async () => {
  const sw = loadSW(async () => ok('x'));
  const shown = captureNotifications(sw);

  const waits = [];
  sw.handlers.push({
    data: { json: () => ({ title: '班级通知', body: '明天交表', url: '/?view=notices&id=3' }) },
    waitUntil(p) { waits.push(p); }
  });
  await Promise.all(waits);

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '班级通知');
  assert.equal(shown[0].options.body, '明天交表');
  assert.equal(shown[0].options.data.url, '/?view=notices&id=3');
});

test('载荷解析失败也要弹兜底通知，不能静默丢弃', async () => {
  const sw = loadSW(async () => ok('x'));
  const shown = captureNotifications(sw);

  const waits = [];
  sw.handlers.push({
    data: { json() { throw new Error('坏载荷'); } },
    waitUntil(p) { waits.push(p); }
  });
  await Promise.all(waits);

  assert.equal(shown.length, 1);
  assert.equal(shown[0].title, '班级助理');
  assert.equal(shown[0].options.data.url, '/');
});

test('点通知：已有同源窗口时导航并聚焦，不再新开', async () => {
  const sw = loadSW(async () => ok('x'));
  const navigated = [];
  const focused = [];
  const opened = [];
  sw.self.clients = {
    async matchAll() {
      return [{
        url: ORIGIN + '/',
        async navigate(u) { navigated.push(u); },
        async focus() { focused.push(1); }
      }];
    },
    async openWindow(u) { opened.push(u); }
  };

  let closed = 0;
  const waits = [];
  sw.handlers.notificationclick({
    notification: { close() { closed++; }, data: { url: '/?view=notices&id=3' } },
    waitUntil(p) { waits.push(p); }
  });
  await Promise.all(waits);

  assert.equal(closed, 1);
  assert.deepEqual(navigated, [ORIGIN + '/?view=notices&id=3']);
  assert.equal(focused.length, 1);
  assert.deepEqual(opened, []);
});

test('点通知：没有打开的窗口时新开一个', async () => {
  const sw = loadSW(async () => ok('x'));
  const opened = [];
  sw.self.clients = {
    async matchAll() { return []; },
    async openWindow(u) { opened.push(u); }
  };

  const waits = [];
  sw.handlers.notificationclick({
    notification: { close() {}, data: { url: '/?view=activities&id=8' } },
    waitUntil(p) { waits.push(p); }
  });
  await Promise.all(waits);

  assert.deepEqual(opened, [ORIGIN + '/?view=activities&id=8']);
});

test('点通知：跨域窗口不会被导航', async () => {
  const sw = loadSW(async () => ok('x'));
  const navigated = [];
  const opened = [];
  sw.self.clients = {
    async matchAll() {
      return [{ url: 'https://other.test/page', async navigate(u) { navigated.push(u); }, async focus() {} }];
    },
    async openWindow(u) { opened.push(u); }
  };

  const waits = [];
  sw.handlers.notificationclick({
    notification: { close() {}, data: { url: '/?view=notices' } },
    waitUntil(p) { waits.push(p); }
  });
  await Promise.all(waits);

  assert.deepEqual(navigated, []);
  assert.deepEqual(opened, [ORIGIN + '/?view=notices']);
});

// ===== 安装入口的平台判定 =====
// 安卓与鸿蒙都已有原生 App，所以安装引导只该给 iOS 与 PC；壳内靠 CAHost 桥识别后整块隐藏。

const UA_IPHONE = 'Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1';
// iPadOS 13+ 的 Safari 报的就是这串 Mac UA，只能靠触点数区分 iPad 与真 Mac
const UA_MAC_SAFARI = 'Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Safari/605.1.15';
const UA_ANDROID = 'Mozilla/5.0 (Linux; Android 14; Pixel 8) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Mobile Safari/537.36';
const UA_HARMONY = 'Mozilla/5.0 (Phone; OpenHarmony 5.0) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/114.0.0.0 Safari/537.36 ArkWeb/4.1.6.1';
const UA_PC_CHROME = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36';

const DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];

/** 造一个「窗口」：matchMedia 只对 display-mode 系列作答 */
function fakeWindow({ ua, maxTouchPoints, standalone, document, localStorage, cahost = false }) {
  const noop = () => {};
  const win = {
    document,
    localStorage,
    addEventListener: noop,
    navigator: {
      userAgent: ua,
      maxTouchPoints,
      standalone,
      serviceWorker: { register: () => Promise.resolve() }
    },
    matchMedia(query) {
      const q = String(query);
      return {
        matches: standalone && DISPLAY_MODES.some((m) => q.indexOf('(display-mode: ' + m + ')') === 0),
        addEventListener: noop,
        addListener: noop
      };
    }
  };
  // 安卓壳与鸿蒙壳注入的都是 CAHost
  if (cahost) win.CAHost = {};
  return win;
}

/**
 * 在沙箱里跑真实的 app.js，只取判定用得到的函数。
 * inIframe 用来模拟「个人页被装在 iframe 里」：此时 iframe 自己问出来的
 * display-mode / navigator.standalone 可能与顶层不一致，这正是出过 bug 的地方。
 */
function loadApp({ ua, standalone = false, maxTouchPoints = 0, inShell = false, inIframe = false, topStandalone = false }) {
  const noop = () => {};
  const card = { hidden: false, querySelector: () => null };
  const document = {
    readyState: 'complete',
    addEventListener: noop,
    getElementById: () => card,
    querySelector: () => null,
    createElement: () => ({ style: {}, setAttribute: noop, appendChild: noop }),
    body: { appendChild: noop }
  };
  const localStorage = { getItem: () => null, setItem: noop };

  const win = fakeWindow({ ua, maxTouchPoints, standalone, document, localStorage, cahost: inShell });
  win.location = { href: ORIGIN + '/' };
  win.top = inIframe
    ? fakeWindow({ ua, maxTouchPoints, standalone: topStandalone, document, localStorage })
    : win;
  win.self = win;
  win.window = win;

  const sandbox = {
    window: win,
    document,
    navigator: win.navigator,
    localStorage,
    location: win.location,
    fetch: async () => new Response('{}', { status: 200 }),
    console,
    setTimeout,
    clearTimeout,
    Request,
    Response,
    Headers,
    atob,
    btoa,
    TextEncoder,
    TextDecoder
  };
  const factory = new Function(...Object.keys(sandbox),
    APP_SOURCE + '\n;return { shouldOfferInstall: shouldOfferInstall };');
  return factory(...Object.values(sandbox));
}

const INSTALL_CASES = [
  ['iPhone Safari 未安装 → 给引导', { ua: UA_IPHONE }, true],
  ['iPhone 已加到主屏 → 不给', { ua: UA_IPHONE, standalone: true }, false],
  ['iPad（UA 伪装成 Mac，有触点）→ 给引导', { ua: UA_MAC_SAFARI, maxTouchPoints: 5 }, true],
  ['安卓 Chrome → 不给（已有 App）', { ua: UA_ANDROID }, false],
  ['鸿蒙 ArkWeb → 不给（已有 App）', { ua: UA_HARMONY }, false],
  ['安卓 App 壳（CAHost）→ 不给', { ua: UA_ANDROID, inShell: true }, false],
  ['鸿蒙 App 壳（CAHost）→ 不给', { ua: UA_HARMONY, inShell: true }, false],
  ['Windows Chrome → 给引导', { ua: UA_PC_CHROME }, true],
  ['Mac Safari（同样 UA 但无触点）→ 给引导', { ua: UA_MAC_SAFARI }, true],
  ['PC 上已装的独立窗口 → 不给', { ua: UA_PC_CHROME, standalone: true }, false],
  // 已装的 App 里打开个人页：个人页在 iframe 里，iframe 自己的 display-mode 未必反映顶层，
  // 所以必须以顶层为准 —— 否则装好了还会再推一次安装（线上出过这个 bug）
  ['已装 App 内打开个人页（顶层是 standalone，iframe 自身不是）→ 不给', { ua: UA_IPHONE, inIframe: true, standalone: false, topStandalone: true }, false],
  ['PC 已装 App 内打开个人页 → 不给', { ua: UA_PC_CHROME, inIframe: true, standalone: false, topStandalone: true }, false],
  ['普通浏览器里的个人页（都不是 standalone）→ 给引导', { ua: UA_PC_CHROME, inIframe: true, standalone: false, topStandalone: false }, true]
];

for (const [name, opts, want] of INSTALL_CASES) {
  test('安装入口：' + name, () => {
    assert.equal(loadApp(opts).shouldOfferInstall(), want);
  });
}
