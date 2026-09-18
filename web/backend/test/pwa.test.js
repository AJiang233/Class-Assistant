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
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const HERE = dirname(fileURLToPath(import.meta.url));
const SOURCE = readFileSync(join(HERE, '../../sw.js'), 'utf8');
const APP_SOURCE = readFileSync(join(HERE, '../../assets/js/app.js'), 'utf8');
const ORIGIN = 'https://class.test';

/** 把 sw.js 放进一个带假 caches / fetch / self 的沙箱里执行，取出它注册的各个事件处理器 */
function loadSW(fetchImpl, options = {}) {
  const handlers = {};
  const stores = new Map();        // 缓存名 -> Map<绝对URL, Response>
  const deletedCaches = [];
  const state = { skipped: false, claimed: false };

  // 假装「当前打开着这些页面」：默认一个停在首页的窗口。每条用例都可以自己指定，
  // 用来验证「回源发现新壳后通知谁」。messages 收下 postMessage 的内容。
  const clients = (options.clients || [ORIGIN + '/']).map((url) => {
    const client = { url, messages: [], postMessage(msg) { client.messages.push(msg); } };
    return client;
  });

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
        async put(request, response) {
          // putDelayMs 用来验证「响应返回前缓存是否已经写完」：默认不延迟
          if (options.putDelayMs) await new Promise((r) => setTimeout(r, options.putDelayMs));
          entries.set(absolute(request), response);
        },
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
    clients: {
      claim: async () => { state.claimed = true; },
      matchAll: async () => clients
    },
    skipWaiting: async () => { state.skipped = true; },
    addEventListener(type, fn) { handlers[type] = fn; }
  };

  // sw.js 是纯脚本，用 Function 注入沙箱全局
  new Function('self', 'caches', 'fetch', SOURCE)(self, caches, fetchImpl);
  return { handlers, stores, deletedCaches, state, self, clients };
}

/** 构造一个 fetch 事件，并捕获 respondWith 的 promise 与 waitUntil 的后台任务 */
function fire(handler, request) {
  const captured = { called: false, promise: null, waits: [] };
  handler({
    request,
    respondWith(p) { captured.called = true; captured.promise = p; },
    waitUntil(p) { captured.waits.push(p); }
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

/**
 * 造一个导航请求（页面 / iframe 的加载）。
 * Request 构造函数明确禁止 init.mode = 'navigate'（浏览器只把它发给真实导航），
 * 所以只能在构造完之后再把 mode 打上去。
 */
function navigateRequest(url) {
  const req = new Request(url);
  Object.defineProperty(req, 'mode', { value: 'navigate' });
  return req;
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
  assert.ok(sw.stores.get('ca-shell').has(ORIGIN + '/'));
});

test('缓存写入要 await 完成后再返回响应（否则 SW 被回收会静默丢缓存）', async () => {
  // cache.put 不 await 的话就是个游离 Promise，跑在 respondWith 之外，
  // SW 线程随时可能被回收 —— 写入被静默丢弃，离线壳表现为「有时有、有时没有」。
  const sw = loadSW(async () => ok('fresh'), { putDelayMs: 20 });
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  const res = await got.promise;
  assert.equal(await res.text(), 'fresh');
  // respondWith 的 promise 结算时，缓存写入必须已经落地
  assert.ok(sw.stores.get('ca-shell').has(ORIGIN + '/'), '响应返回时缓存应已写入');
});

test('跟过跳转的响应落缓存前去掉 redirected 标记', async () => {
  // 站点把 /notices.html 308 跳到 /notices。带 redirected 标记的响应被规范禁止用于
  // 导航请求（页面/iframe 的加载），原样存下来断网回放时会直接变成「网页无法打开」。
  const sw = loadSW(async () => followedRedirect('shell'));
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/notices.html')).promise;
  const stored = sw.stores.get('ca-shell').get(ORIGIN + '/notices');
  assert.ok(stored, '应存在规范地址 /notices 下');
  assert.equal(stored.redirected, false, '存下来的必须是能应答导航的那一份');
});

test('同源请求强制回源校验，不吃浏览器 HTTP 缓存', async () => {
  // 本域名的 CDN 会把 /assets/*、/sw.js 的 Cache-Control 改写成 max-age=14400，
  // 不带 cache: 'no-cache' 的话「回源」会退化成拿最多 4 小时前的旧文件。
  const inits = [];
  const sw = loadSW(async (request, init) => { inits.push(init); return ok('fresh'); });
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/assets/css/style.css')).promise;
  assert.equal(inits.length, 1);
  assert.equal(inits[0] && inits[0].cache, 'no-cache');
});

test('缓存命中时立刻返回缓存，不等网络（首帧的 TTFB 必须消失）', async () => {
  // 首帧串行依赖 index.html → style.css（95KB，阻塞渲染）→ theme.js（head 里的同步脚本），
  // 实测单个请求的 TTFB 在 1～3.5 秒、偶发 12～31 秒，叠起来就是用户看到的白屏十几秒。
  // 命中缓存后这三份必须是本地读取：只要代码还在 await 网络，
  // 下面那个永不结算的 fetch 就会把这条用例挂到超时。
  let hang = false;
  const sw = loadSW(async () => {
    if (hang) return new Promise(() => {});
    return ok('v1');
  });
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html')).promise;

  hang = true;
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  assert.equal(await (await got.promise).text(), 'v1');
});

test('命中缓存后仍在后台回源刷新缓存（否则就是「旧缓存卡住」那个老 bug）', async () => {
  // 把缓存放前面，就意味着「当次可能拿到旧的」，那就必须保证旧的活不过一次加载：
  // 回源要每次都发生、结果要落进缓存，否则就又成了当初那个「cache-first 且从不回源」。
  let body = 'v1';
  const sw = loadSW(async () => ok(body));
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html')).promise;

  body = 'v2';
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  assert.equal(await (await got.promise).text(), 'v1', '当次仍回缓存里那份');
  // 后台刷新必须挂在 waitUntil 上：不挂的话这个 Promise 游离在事件之外，
  // SW 线程被回收就把这次更新静默丢了 —— 缓存再也不前进。
  await Promise.all(got.waits);
  assert.equal(await sw.stores.get('ca-shell').get(ORIGIN + '/').text(), 'v2', '下一次打开就是新的');
});

test('回源发现页面壳真的变了，立刻让页面重载（不用等下一次打开）', async () => {
  // 用户的要求：后台拿到新内容要**这次**就生效。只更新缓存的话，他得关掉再打开才看得到。
  let body = 'v1';
  const sw = loadSW(async () => ok(body));
  await fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html')).promise;

  body = 'v2';
  const got = fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html'));
  await got.promise;
  await Promise.all(got.waits);

  assert.deepEqual(sw.clients[0].messages, [{ type: 'ca-shell-updated' }]);
});

test('页面壳没变就不通知（否则每次打开都在刷用户的表单）', async () => {
  // 回源是每次命中缓存都会发生的，字节没变也通知的话，页面会跟着无差别重载 ——
  // 正在填的表单、MFA 验证码全被清掉。通知的语义必须是「拿到了新内容」。
  const sw = loadSW(async () => ok('same'));
  await fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html')).promise;

  const got = fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html'));
  await got.promise;
  await Promise.all(got.waits);

  assert.deepEqual(sw.clients[0].messages, []);
});

test('回源发现部署了，就把整个壳按清单重取一遍（issue #23）', async () => {
  // 以前「改了页面结构」要靠人记得把缓存版本号 +1，忘掉就是「新页面结构 + 旧样式」的混合壳。
  // 现在只要任何一个页面文档被发现变了（＝部署了），就把预热清单整体刷一遍 ——
  // 包括用户从没打开过的页面（例如管理页），而不是留着旧的等谁踩上去。
  let body = 'v1';
  const asked = [];
  const caches = [];
  // 回源那一支传进来的可能是 Request 对象（不是路径字符串），要按 .url 取路径
  const sw = loadSW(async (input, init) => {
    const path = typeof input === 'string' ? input : new URL(input.url).pathname;
    asked.push(path);
    caches.push(init && init.cache);
    return ok(path === '/index.html' ? body : '壳：' + path);
  });

  await fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html')).promise;

  body = 'v2';
  asked.length = 0;
  const got = fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html'));
  await got.promise;
  await Promise.all(got.waits);

  const refreshed = [...new Set(asked)];
  assert.ok(refreshed.includes('/notices'), '用户没打开的页面也要刷新，实际取了：' + refreshed.join(' '));
  assert.ok(refreshed.includes('/assets/js/admin.js'), '没进过管理页的用户，那份 admin.js 也得换新');
  assert.ok(caches.every((c) => c === 'no-cache'),
    '重刷必须绕开 CDN 那份 max-age=14400 的 HTTP 缓存，否则取回来的还是旧的');
  // 落缓存的键是规范地址（不带 .html）—— 与预热、与离线回退查找共用同一套键
  assert.equal(await sw.stores.get('ca-shell').get(ORIGIN + '/notices').text(), '壳：/notices');
});

test('只通知停在同一个页面的客户端', async () => {
  // 用户在通知页时，主页壳变了不该把他拽着重载（子页是 iframe 里的独立文档，
  // 各有各的客户端，正好各刷各的）。
  let body = 'v1';
  const sw = loadSW(async () => ok(body), {
    clients: [ORIGIN + '/notices', ORIGIN + '/?view=notices']
  });
  await fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html')).promise;

  body = 'v2';
  const got = fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/index.html'));
  await got.promise;
  await Promise.all(got.waits);

  assert.deepEqual(sw.clients[0].messages, [], '通知页不该被主页的更新牵连');
  assert.deepEqual(sw.clients[1].messages, [{ type: 'ca-shell-updated' }], '带查询串的首页也算首页');
});

test('样式/脚本变了不通知重载（下一次跳转自然拿到新的）', async () => {
  // 只有导航请求（HTML 文档）才算「换了一页」。CSS/JS 变了顺手刷会变成「刚打开就自己刷新」。
  let body = 'a';
  const sw = loadSW(async () => ok(body));
  await fire(sw.handlers.fetch, new Request(ORIGIN + '/assets/css/style.css')).promise;

  body = 'b';
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/assets/css/style.css'));
  await got.promise;
  await Promise.all(got.waits);

  assert.deepEqual(sw.clients[0].messages, []);
});

test('失败响应（500）不写入缓存', async () => {
  const sw = loadSW(async () => new Response('boom', { status: 500 }));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/index.html'));
  await got.promise;
  // 500 时压根不会 open 缓存，所以这里用可选链判断
  assert.equal(sw.stores.get('ca-shell')?.has(ORIGIN + '/') ?? false, false);
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

test('断网时带查询串的深链回退到去掉查询串的预缓存页面', async () => {
  // 深链天然带查询串：App 点提醒时把 iframe 的 src 指到 notices.html?id=123，推送载荷里的
  // data.url 同样是带 ?id= 的地址。而预热清单与落缓存用的键都不带查询串，
  // 只按 /notices?id=123 找必然落空 —— 现场就是断网时点通知直接进浏览器错误页。
  let online = true;
  const sw = loadSW(async (path) => {
    if (!online) throw new TypeError('Failed to fetch');
    return ok('壳：' + path);
  });
  // 照真实场景预热：断网前的那次安装已经把 /notices 存进去了
  let installWork = null;
  sw.handlers.install({ waitUntil(p) { installWork = p; } });
  await installWork;
  online = false;

  // 前提：缓存里压根没有带查询串的键，本条断言是用来固定这个前提的
  // （写缓存的键始终走 canonical()，带查询串的查找只用于**读取**，不参与写入）
  assert.equal(sw.stores.get('ca-shell').has(ORIGIN + '/notices?id=123'), false);

  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/notices.html?id=123'));
  const res = await got.promise;
  assert.equal(await res.text(), '壳：/notices');
});

test('断网导航到从没缓存过的地址时回退到主页壳，而不是把网络错误甩给用户', async () => {
  // 典型现场：从主屏图标装完就断网，然后点一条推送 —— 通知指向的详情页从没被访问过，
  // 缓存里自然没有。如实抛错的话用户看到的是浏览器错误页；回退主页壳则能跑起 app.js 的
  // renderOfflineNotice，把「当前无网络」说出来。
  let online = true;
  const sw = loadSW(async (path) => {
    if (!online) throw new TypeError('Failed to fetch');
    return ok('壳：' + path);
  });
  let installWork = null;
  sw.handlers.install({ waitUntil(p) { installWork = p; } });
  await installWork;
  online = false;

  const got = fire(sw.handlers.fetch, navigateRequest(ORIGIN + '/never-visited'));
  const res = await got.promise;
  assert.equal(await res.text(), '壳：/');
});

test('断网时非导航请求缺缓存仍如实失败，不会被主页壳顶替', async () => {
  // 主页壳兜底只对导航请求生效：脚本/样式缺了就得知趣地失败。
  // 拿一份 HTML 去顶替 JS 会让浏览器按脚本语法解析 HTML，报出一串与被改坏的代码
  // 毫无关系的语法错误 —— 比干脆的失败更难排查，所以这条边界必须钉住。
  let online = true;
  const sw = loadSW(async (path) => {
    if (!online) throw new TypeError('Failed to fetch');
    return ok('壳：' + path);
  });
  let installWork = null;
  sw.handlers.install({ waitUntil(p) { installWork = p; } });
  await installWork;
  online = false;

  // 主页壳确实在缓存里（上一个用例已证明它可用），这里要的正是「它在也不许顶替」
  assert.ok(sw.stores.get('ca-shell').has(ORIGIN + '/'));
  const got = fire(sw.handlers.fetch, new Request(ORIGIN + '/assets/js/missing.js'));
  await assert.rejects(() => got.promise, /Failed to fetch/);
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

  const entries = sw.stores.get('ca-shell');
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
  assert.equal(sw.stores.has('ca-shell'), false, '当前缓存不应被清掉（activate 只删别的）');
  assert.equal(sw.state.claimed, true);
});

// ===== 预热清单必须与真实路由对得上（issue #23）=====
// 清单里写错一个路径，只有用户断网打开那一页时才暴露 —— 线上完全没有信号，而那时才发现
// 等于当天没有离线壳。所以下面两条是拿着真实文件系统与页面 HTML 去核对，而不是把清单再抄一遍。

const WEB_ROOT = join(HERE, '../..');

/** sw.js 里 PRECACHE 那份字面量清单（先去掉注释行：注释里有 `'self'` 这种带引号的内容） */
function precacheList() {
  const at = SOURCE.indexOf('const PRECACHE');
  const src = SOURCE.slice(at, SOURCE.indexOf('];', at))
    .split('\n').filter((line) => !line.trim().startsWith('//')).join('\n');
  const list = [...src.matchAll(/'([^']+)'/g)].map((m) => m[1]);
  assert.ok(list.length >= 10, '预热清单没解析出来，正则要跟着 sw.js 走');
  return list;
}

test('预热清单里的每一条都对应仓库里真实存在的文件', () => {
  for (const path of precacheList()) {
    // 页面写的是规范地址（/notices），磁盘上那份叫 notices.html；'/' 对应 index.html
    const candidates = path === '/' ? ['index.html'] : [path.slice(1), path.slice(1) + '.html'];
    assert.ok(candidates.some((p) => existsSync(join(WEB_ROOT, p))),
      path + ' 在仓库里找不到对应文件：路由改了没同步清单，只有断网的用户会发现');
  }
});

test('每个页面自身、以及它引用的脚本与样式，都在预热清单里', () => {
  const list = precacheList();
  const pages = readdirSync(WEB_ROOT).filter((f) => f.endsWith('.html'));
  assert.ok(pages.length >= 6, '没扫到页面文件，测试的路径要跟着仓库结构走');

  for (const page of pages) {
    // 页面自身：缓存键、预热键、离线回退查找用的都是规范地址
    const canonicalPath = page === 'index.html' ? '/' : '/' + page.replace(/\.html$/, '');
    assert.ok(list.includes(canonicalPath), page + ' 不在预热清单里：断网打开它就是浏览器错误页');

    const html = readFileSync(join(WEB_ROOT, page), 'utf8');
    // 只核对脚本与样式：这两个缺了页面直接不可用（CSP 只放行 'self'，脚本全部外置）。
    // 图标、apple-touch-icon 不在此列 —— 那是系统「加到主屏」时取的，不影响离线可用性。
    const refs = [
      ...[...html.matchAll(/<script[^>]+src="([^"]+)"/g)].map((m) => m[1]),
      ...[...html.matchAll(/<link[^>]+rel="stylesheet"[^>]+href="([^"]+)"/g)].map((m) => m[1])
    ];
    assert.ok(refs.length > 0, page + ' 里没扫到脚本或样式引用，正则要跟着页面走');

    for (const ref of refs) {
      // 页面里写的是相对路径（assets/js/app.js），清单里是站内绝对路径
      const abs = ref.startsWith('/') ? ref : '/' + ref;
      assert.ok(list.includes(abs),
        page + ' 引用了 ' + ref + '，它却不在预热清单里：断网时这一页会缺' + (abs.endsWith('.css') ? '样式' : '脚本'));
    }
  }
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
      // addEventListener 是 app.js 注册「SW 通知页面刷新」那个监听时要用到的（真实浏览器里一定有）
      serviceWorker: { register: () => Promise.resolve(), addEventListener: noop }
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
function loadApp({ ua, standalone = false, maxTouchPoints = 0, inShell = false, inIframe = false, topStandalone = false, frames = [] }) {
  const noop = () => {};
  const card = { hidden: false, querySelector: () => null };
  const document = {
    readyState: 'complete',
    addEventListener: noop,
    getElementById: () => card,
    querySelector: () => null,
    // 壳里的 iframe 列表：验证「原生推回的数据要转发给子页面」时用
    querySelectorAll: () => frames,
    createElement: () => {
      // esc() 是 textContent→innerHTML 走真实 DOM 的转义，沙箱里得能跑：
      // 真实 div 也就只有 & < > 三条（引号不转义，那才另有 escAttr），照抄即可
      const el = { style: {}, setAttribute: noop, appendChild: noop, textContent: '' };
      Object.defineProperty(el, 'innerHTML', {
        get() {
          return String(el.textContent)
            .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;');
        }
      });
      return el;
    },
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
    APP_SOURCE + '\n;return { shouldOfferInstall: shouldOfferInstall, escAttr: escAttr, safeHref: safeHref, pushSubscribeError: pushSubscribeError, greetingFor: greetingFor, positionsChipsHTML: positionsChipsHTML, onApiData: onApiData, apiUpdated: window.__caApiUpdated };');
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

// ===== 主页欢迎文案的分档（issue #75）=====
// 分档左闭右开：6-11 早上、11-14 中午、14-18 下午、18-23 晚上、23-1 深夜、1-6 午夜。
// 24 个整点逐个对一遍：这张表是纯数据，错一个边界就有一段时间挂着不对的问候，而 23 点
// 跨零点那档最容易被写成 [23,1) 这种取不到值的区间（所以要拆成 23-24 与 0-6 两段）。
// 副标题也一并查空 —— 缺了就是主页白留一行，光看标题的断言发现不了。
//
// 下面这张期望表是照着 app.js 的 GREETING_BANDS 抄的，所以改文案时两边要一起改：
// 抄这一遍就是为了让「改了文案忘了同步」立刻红一次，而不是等到有人拿手机看到才发现。

test('主页问候：0-23 每个整点都在正确的档，且标题副标题都不为空', () => {
  const app = loadApp({ ua: UA_PC_CHROME });
  const want = [
    ...Array(6).fill('午夜时分'),              // 0-5
    ...Array(5).fill('早上好~'),               // 6-10
    ...Array(3).fill('中午好呀'),              // 11-13
    ...Array(4).fill('下午好w'),               // 14-17
    ...Array(5).fill('晚上好喵~'),             // 18-22
    '（哈欠）'                                 // 23
  ];
  assert.equal(want.length, 24, '期望表本身就写错了：六档合起来必须是 24 小时');

  for (let h = 0; h < 24; h++) {
    const band = app.greetingFor(h);
    assert.equal(band.title, want[h], h + ' 点的问候不对');
    assert.ok(band.desc, h + ' 点没有副标题，主页会白留一行');
  }
});

// ===== 属性转义与 href 白名单 =====
// esc() 走 textContent→innerHTML，只保证 & < > 安全、不转义引号，所以只能用于文本节点；
// 插进 ="..." 的属性值必须走 escAttr，否则成员姓名/职位名里的一个 " 就能闭合属性注入脚本。

test('escAttr 转义引号与尖括号，属性无法被闭合', () => {
  const app = loadApp({ ua: UA_PC_CHROME });
  assert.equal(app.escAttr('张" onmouseover="alert(1)'), '张&quot; onmouseover=&quot;alert(1)');
  assert.equal(app.escAttr("a'b"), 'a&#39;b');
  assert.equal(app.escAttr('<script>'), '&lt;script&gt;');
  assert.equal(app.escAttr('a&b'), 'a&amp;b');
  assert.equal(app.escAttr(null), '');
  assert.equal(app.escAttr(undefined), '');
});

// ===== 职务徽章 =====
// 「学生」不在职务选择器里（allPositionNames 排除了它），没勾任何职务的人存进来就是空的；
// 而库里新旧两种写法都有：注册走的是 '学生'，编辑成员那条路写的是 '[]'。徽章渲染原来对空值
// 直接 return 裸文本「学生」，成员列表于是变成一半徽章一半裸字 —— 三种形状都要落到同一个 chip。

test('职务徽章：没有职务的人也要出 chip，不能落成裸文本', () => {
  const app = loadApp({ ua: UA_PC_CHROME });
  const student = '<span class="pos-tag">学生</span>';
  for (const raw of ['', '[]', '[""]', [], null, undefined]) {
    assert.equal(app.positionsChipsHTML(raw), student, JSON.stringify(raw) + ' 应渲染成「学生」徽章');
  }
  assert.equal(app.positionsChipsHTML('班长'), '<span class="pos-tag">班长</span>');
  assert.equal(
    app.positionsChipsHTML('["班长","学习委员"]'),
    '<span class="pos-tag">班长</span><span class="pos-tag">学习委员</span>',
    '多职务仍逐个出 chip'
  );
  assert.equal(app.positionsChipsHTML('<b>'), '<span class="pos-tag">&lt;b&gt;</span>', '职务名照旧转义');
});

test('safeHref 只放行站内路径与 http(s)，挡掉伪协议', () => {
  const app = loadApp({ ua: UA_PC_CHROME });
  assert.equal(app.safeHref('/forms.html?id=1'), '/forms.html?id=1');
  assert.equal(app.safeHref('https://github.com/AJiang233/Class-Assistant'), 'https://github.com/AJiang233/Class-Assistant');
  assert.equal(app.safeHref('javascript:alert(1)'), '');
  assert.equal(app.safeHref('data:text/html,<script>alert(1)</script>'), '');
  assert.equal(app.safeHref('   '), '');
});

// ===== 开启通知失败时的提示 =====
// subscribe() 失败时浏览器抛的是英文 DOMException，最典型的一句就是
// "Registration failed - push service error"（Chrome / Edge 连不上 FCM，国内网络常见）。
// COPY.md 第 7 节要求这类原文只进 console.error，提示里只留「发生了什么 + 我该做什么」，
// 所以这里既测分支命中，也守住「英文原文一个字都不许漏出去」。

/** 造一个带指定 name 的异常，模拟浏览器抛出的各种 DOMException */
const pushError = (name, message) => Object.assign(new Error(message || ''), { name });

test('开启通知失败：按异常类型给出可读中文，且不出现异常原文', () => {
  const app = loadApp({ ua: UA_PC_CHROME });

  const denied = app.pushSubscribeError(pushError('NotAllowedError', 'Permission denied'));
  assert.match(denied, /通知权限/);

  const badKey = app.pushSubscribeError(pushError('InvalidAccessError', 'The provided applicationServerKey is not valid'));
  assert.match(badKey, /联系管理员/);

  const noService = app.pushSubscribeError(pushError('AbortError', 'Registration failed - push service error'));
  assert.match(noService, /推送服务/);

  for (const text of [denied, badKey, noService]) {
    assert.ok(!/Registration failed|AbortError|NotAllowedError|DOMException|push service|applicationServerKey/i.test(text),
      '英文异常原文不应出现在提示里：' + text);
  }
});

test('开启通知失败：认不出的异常也有兜底话术，不会把空值甩给用户', () => {
  const app = loadApp({ ua: UA_PC_CHROME });
  // undefined / 没有 name 的异常都要落到默认那句，而不是返回空串或抛错
  assert.ok(app.pushSubscribeError(undefined).length > 0);
  assert.ok(app.pushSubscribeError(new Error('莫名其妙')).length > 0);
});

// ===== 后台通知状态行（仅 App 壳） =====
// 状态行现在是两行：第一行「常驻 / 免电池优化」的现状，第二行「系统目前把本应用算作哪一档待机」。
// account.js 是带副作用的 IIFE（开头 requireAuth、结尾一串 delegate），测试取不出函数来跑，
// 所以这里只留一条有意义的源码断言：五档待机必须都能说出来 —— 漏一档，那一行就是空的，
// 而用户正是靠它判断「是不是被系统压制了」。

test('后台通知：系统待机档五档都能表达出来', () => {
  const src = readFileSync(join(HERE, '../../assets/js/account.js'), 'utf8');
  const at = src.indexOf('var STANDBY_LABEL');
  assert.ok(at >= 0, '找不到档位映射表：可能被改名或搬走了，这条断言需要跟着改');
  const map = src.slice(at, src.indexOf('function readBackgroundStatus', at));
  for (const bucket of ['active', 'working_set', 'frequent', 'rare', 'restricted']) {
    assert.ok(map.includes(bucket + ':'), '缺 ' + bucket + '：原生回这一档时第二行会空着');
  }
});

// ===== 日历日期展开必须有界 =====
// 通知/活动的起止时间来自自由填写（截止时间允许填到 9999 年），expand() 会把
// [开始日, 结束日] 逐天展开进 Set。没有上限时一个远期 expire_time 就是上百万次循环，
// 主页主线程直接卡死（列表还没渲染出来就先卡住）。expand 是 loadCalendar 里的内层函数，
// 页面又是带副作用的 IIFE，取不出来跑，所以按本文件既有做法留源码断言。

test('日历日期展开有上限，远期时间不会把主页卡死', () => {
  const src = readFileSync(join(HERE, '../../assets/js/index.js'), 'utf8');

  const decl = src.match(/var EXPAND_MAX_DAYS\s*=\s*(\d+)/);
  assert.ok(decl, '找不到展开上限常量：逐天展开的循环次数必须有界');
  const maxDays = Number(decl[1]);
  assert.ok(maxDays > 0 && maxDays <= 366 * 100, '展开上限应当是个现实的天数，而不是等于没设');

  // 光定义常量不算数：必须真的用它把 end 收窄，否则循环仍然是无界的
  assert.match(src, /end\s*=\s*new Date\(cur\.getTime\(\)\s*\+\s*EXPAND_MAX_DAYS/,
    '上限没有作用在结束日期上，展开仍是无界循环');
});

// ===== 职位卡：只有 content:write 的人不该看到增删改 =====
// 自定义职位的增 / 删 / 改在后端要 user:manage（routes/auth.js），前端若把它渲染出来，
// 对学委就是「点了必然 403」的按钮。admin.js 同样是带副作用的 IIFE（开头 requireAuth、
// 结尾一串 delegate），取不出函数来跑，所以按本文件既有做法读源码钉形状。

test('职位卡：只有 content:write 的人看不到「添加职位」与每行的编辑 / 删除（issue #79）', () => {
  const src = readFileSync(join(HERE, '../../assets/js/admin.js'), 'utf8');

  const del = src.indexOf('data-act="del-role"');
  assert.ok(del >= 0, '找不到删除按钮的渲染处：可能被改名或搬走了，这条断言需要跟着改');
  assert.match(src.slice(Math.max(0, del - 500), del), /canManage\s*\?/,
    '删除 / 编辑按钮没有挂在 canManage 上：只有 content:write 的人会看到一个点了必 403 的按钮');

  assert.match(src, /if \(canManage\)\s*\{[\s\S]{0,200}?addRoleCard/,
    '「添加职位」卡没有被 canManage 圈住：学委会看到一个提交必 403 的表单');

  assert.match(src, /getElementById\('manageRolesCard'\)\.hidden = false/,
    '「管理职位」列表不该跟着一起隐藏：读接口对登录用户开放，只读的那份要留着');
});

// ===== 提醒对象名单：加载失败不能当「没有成员」=====
// notices.js / activities.js 是带副作用的 IIFE（开头 requireAuth），取不出函数来跑，
// 所以照本文件既有做法读源码钉形状。这条是安全路径（issue #78）：名单加载失败时保存
// 会把定向通知/活动丢成 []（= 全班可见），拆掉任何一道闸都没有运行期症状，只能靠形状钉。

test('提醒对象：名单加载失败时不渲染空列表、保存被拦下（issue #78）', () => {
  const app = readFileSync(join(HERE, '../../assets/js/app.js'), 'utf8');
  const notices = readFileSync(join(HERE, '../../assets/js/notices.js'), 'utf8');
  const activities = readFileSync(join(HERE, '../../assets/js/activities.js'), 'utf8');

  for (const [name, src] of [['notices.js', notices], ['activities.js', activities]]) {
    assert.match(src, /remindLoadFailed\s*=\s*true/,
      name + '：加载失败没有置 remindLoadFailed，失败仍会被当成「没有成员」（issue #78）');
    assert.match(src, /renderRemindBox\([^)]*remindLoadFailed/,
      name + '：渲染时没把失败标记传给 renderRemindBox');
    assert.match(src, /if \(remindLoadFailed\)\s*loadRemindChoices/,
      name + '：打开编辑弹窗时没在失败后重取名单');
    assert.match(src, /if \(remindLoadFailed\)\s*\{[\s\S]{0,120}?return;/,
      name + '：submitEdit 没有在失败时拦下保存');
  }

  // renderRemindBox 要接 failed 参数，失败态渲染错误并禁用保存按钮；成功渲染要恢复按钮
  assert.match(app, /renderRemindBox\(boxId, members, checkedNames, failed\)/,
    'renderRemindBox 没接 failed 参数');
  assert.match(app, /if \(failed\)\s*\{[\s\S]{0,200}?disabled = true/,
    '失败态没有禁用保存按钮');
  assert.match(app, /if \(save\) save\.disabled = false/,
    '成功渲染时没有恢复保存按钮：上次失败禁掉后就再也点不动了');
});

// admin 的三个发布入口（通知 / 活动 / 表单）同样要在名单失败时拦截（issue #78，
// 吸收自 PR #86 的增量：新建时空名单虽是安全默认，但失败还显示「暂无成员」会误导人）
test('提醒对象：admin 的三个发布入口在名单失败时也拦截（issue #78）', () => {
  const src = readFileSync(join(HERE, '../../assets/js/admin.js'), 'utf8');

  assert.match(src, /remindLoadFailed\s*=\s*true;/, 'admin：名单失败时没有把标志置 true');
  assert.match(src, /renderRemindBox\([^)]*remindLoadFailed/,
    'admin：渲染时没把失败标记传给 renderRemindBox');

  for (const [name, marker] of [['通知', 'ntcSubmitBtn'], ['活动', 'actSubmitBtn'], ['表单', 'fcSubmitBtn']]) {
    const at = src.indexOf(marker);
    assert.ok(at >= 0, 'admin：找不到 ' + name + ' 的提交按钮');
    assert.match(src.slice(Math.max(0, at - 900), at), /remindLoadFailed/,
      'admin：' + name + ' 发布入口没有名单失败拦截，失败时会静默发成全班可见');
  }
});

// ===== 推送订阅：endpoint 轮换后的恢复路径 =====
// account.js 是带副作用的 IIFE（开头 requireAuth），取不出函数来跑，读源码钉形状。
// 这条是可达性路径（issue #80）：APNs/FCM 轮换 endpoint 后服务端库里那条旧订阅 404/410，
// 页面却只看本地 subscription、照常显示「已开启」，通知静默失效。pushsubscriptionchange
// 只有 Chromium 系派发、Safari 不派发，恢复只能靠每次打开重报（接口幂等 upsert）。

test('推送订阅：已订阅时打开个人中心会重报一次（issue #80）', () => {
  const src = readFileSync(join(HERE, '../../assets/js/account.js'), 'utf8');

  assert.match(src, /if \(pushSub && pushServerEnabled\)/,
    'refreshNotify 没在「本地已订阅」时走重报分支：轮换后服务端那条旧的 404/410，' +
    '页面仍显示「已开启」，通知静默失效（issue #80）');

  // 重报必须落在 refreshNotify（每次打开都跑），不能只在 enablePush（只跑一次）
  const refresh = src.substring(
    src.indexOf('function refreshNotify'),
    src.indexOf('async function enablePush')
  );
  assert.ok(refresh.indexOf('/api/push/subscribe') >= 0,
    'refreshNotify 里没有重报 /api/push/subscribe：轮换后的订阅没有恢复路径');
});

// ===== 教务手机端 CSS 的级联顺序（issue #83）=====
// 第 22 节（教务）的基础规则写在 21.x 手机端块**之后**，同特异度下按源码顺序反超，
// 于是 21.x 里那些教务声明等于没写（.ac-toolbar / .ac-select / 学分表小屏档都中过招）。
// 手机端声明必须住在第 22 节、排在对应基础规则后面 —— 这是没法用浏览器验证的纯级联问题。

test('教务手机端规则要排在基础规则之后，不被反超（issue #83）', () => {
  const css = readFileSync(join(HERE, '../../assets/css/style.css'), 'utf8');

  // .ac-select 基础规则（min-width:158px）在第 22 节，窄屏全宽声明必须出现在它之后
  const baseSelect = css.indexOf('.ac-select {');
  const mobileSelect = css.indexOf('.ac-select { min-width: 0; width: 100%; }');
  assert.ok(baseSelect >= 0, '找不到 .ac-select 基础规则，选择器可能改了');
  assert.ok(mobileSelect > baseSelect,
    '窄屏 .ac-select 全宽声明写在了基础规则前面：手机上筛选下拉还是 158px 宽（issue #83）');

  assert.ok(css.indexOf('.ac-toolbar { gap: 10px; }') > css.indexOf('.ac-toolbar {'),
    '.ac-toolbar 窄屏间距写在了基础规则前面，手机上工具栏还是 12px 间距');

  // 学分表 ≤400 档（34px 列）要在基础规则（52px 列）之后，SE 上才拿得到这一档
  const baseCredit = css.indexOf('.credit-row {');
  const smallCredit = css.indexOf('34px 34px 34px 34px 56px');
  assert.ok(baseCredit >= 0 && smallCredit > baseCredit,
    '学分表 ≤400 档（34px 列）写在了基础规则（52px 列）前面，SE 上还是 38px 档（issue #83）');

  // 21.x 手机端块里不该再残留会被反超的重复声明（它们现在都住第 22 节）
  const base = Math.max(baseSelect, baseCredit);
  for (const [snippet, why] of [
    ['.ac-toolbar { gap: 10px; }', 'ac-toolbar 窄屏间距'],
    ['34px 34px 34px 34px 56px', '学分表小屏档'],
    ['.credit-row-head { font-size: 0.7rem; }', '学分表表头小屏档']
  ]) {
    const idx = css.indexOf(snippet);
    assert.ok(idx >= 0 && idx > base,
      why + ' 应该住在第 22 节基础规则之后，而不是残留在 21.x 里等被反超（issue #83）');
  }
});

// ===== 原生推回的数据要转给 iframe 子页面 =====
// 原生那边是 webView.evaluateJavascript，只作用于顶层文档的 window；而通知/活动/教务/
// 个人中心/管理员这几个页面各自跑在 iframe 里、各自加载一份 app.js、各自一份 apiRenderers。
// 不转发的话它们的「后台新数据」会被静默丢掉，那几个页面就只看得见上一次会话留下的缓存。

test('原生推回的数据：本窗口照常重绘，并转发给同源 iframe', () => {
  const got = [];
  const app = loadApp({
    ua: UA_PC_CHROME,
    frames: [
      { contentWindow: { __caApiUpdated: (key, json) => got.push([key, json]) } },
      // 还没加载完 / 跨域（教务页是另一个域）：读 contentWindow 会抛，
      // 必须被吞掉，不能让它把这一次回填整体带崩
      { get contentWindow() { throw new Error('SecurityError'); } }
    ]
  });

  let rendered = null;
  app.onApiData('/api/auth/me', (data) => { rendered = data; });
  app.apiUpdated('/api/auth/me', JSON.stringify({ success: true, data: { name: '甲' } }));

  assert.deepEqual(rendered, { name: '甲' }, '顶层壳自己的渲染函数要照常调用');
  assert.equal(got.length, 1, 'iframe 子页面也得收到这一拍');
  assert.equal(got[0][0], '/api/auth/me');
  assert.equal(JSON.parse(got[0][1]).data.name, '甲');
});

test('原生推回的数据：本窗口没人注册也要照样转发（收件人在子页面）', () => {
  // 通知/活动这些键只注册在 iframe 里，顶层壳没有它们。转发不能跟着那个 early return
  // 一起被跳过 —— 跳了就是「推了，但没人重绘」。
  const got = [];
  const app = loadApp({
    ua: UA_PC_CHROME,
    frames: [{ contentWindow: { __caApiUpdated: (key, json) => got.push([key, json]) } }]
  });

  app.apiUpdated('/api/notices?scope=all', JSON.stringify({ success: true, data: { list: [] } }));
  assert.equal(got.length, 1);
  assert.equal(got[0][0], '/api/notices?scope=all');
});
