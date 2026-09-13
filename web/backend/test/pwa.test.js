/**
 * 前端 Service Worker 的缓存策略测试。
 *
 * 位置说明：本仓库只有一个测试运行器（`npm test` 跑 backend/test/*.test.js），
 * 所以这个测前端 sw.js 的文件也放在这里。它读取的是 web/sw.js 的真实源码。
 *
 * 覆盖的是「浏览器里没法验证」的部分：断网回退、接口绕过、旧缓存清理。
 * 真实的注册与接管行为已在本机浏览器实测（见方案验收记录）。
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../../sw.js'), 'utf8');
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
  assert.ok(sw.stores.get('ca-shell-v1').has(ORIGIN + '/index.html'));
});

test('失败响应（500）不写入缓存', async () => {
  const sw = loadSW(async () => new Response('boom', { status: 500 }));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  await got.promise;
  // 500 时压根不会 open 缓存，所以这里用可选链判断
  assert.equal(sw.stores.get('ca-shell-v1')?.has(ORIGIN + '/index.html') ?? false, false);
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

test('断网且没有缓存时，如实抛出网络错误', async () => {
  const sw = loadSW(async () => { throw new TypeError('Failed to fetch'); });
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/never-visited.html'));
  await assert.rejects(() => got.promise, /Failed to fetch/);
});

test('安装时预热应用壳，且单个资源失败不影响整体', async () => {
  const sw = loadSW(async (path) => {
    if (String(path).includes('admin.html')) throw new Error('该页临时取不到');
    return ok('shell');
  });
  let installWork = null;
  sw.handlers.install({ waitUntil(p) { installWork = p; } });
  await installWork;

  const entries = sw.stores.get('ca-shell-v1');
  assert.ok(entries.size >= 10, '预热的资源数量应接近清单长度');
  assert.ok(entries.has(ORIGIN + '/index.html'));
  assert.ok(entries.has(ORIGIN + '/assets/js/app.js'));
  assert.equal(entries.has(ORIGIN + '/admin.html'), false);
  assert.equal(sw.state.skipped, true, '安装后应立即接管，避免用户停在旧版本');
});

test('激活时清掉旧版本缓存，并接管页面', async () => {
  const sw = loadSW(async () => ok('shell'));
  sw.stores.set('ca-shell-v0', new Map());   // 模拟上一版遗留
  sw.stores.set('some-other-cache', new Map());
  let activateWork = null;
  sw.handlers.activate({ waitUntil(p) { activateWork = p; } });
  await activateWork;

  assert.deepEqual(sw.deletedCaches.sort(), ['ca-shell-v0', 'some-other-cache']);
  assert.equal(sw.stores.has('ca-shell-v1'), false, '当前版本缓存不应被清掉（activate 只删旧的）');
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
