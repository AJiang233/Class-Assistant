/**
 * 班级助理 · Service Worker
 *
 * 只做三件事：离线壳、让应用可安装、接收推送（阶段三加）。
 *
 * 缓存策略刻意保守 —— 这个项目出现过「用户被旧缓存卡住、完全刷新也不生效」的问题，
 * 所以除了断网兜底，一律不把缓存当首选：
 *   /api/*          完全不拦截，直接走网络（登录态与数据绝不缓存，断网就该报错）
 *   页面导航         network-first，断网时回退到缓存的页面壳
 *   静态资源         network-first，成功就更新缓存（不用 cache-first，避免样式/脚本改动不生效）
 *   其他方法/跨域    不拦截
 *
 * 注意：sw.js 由 _headers 声明为 no-cache，保证脚本本身不会被缓存住。
 */

const CACHE = 'ca-shell-v2';

/**
 * 首次安装时预热的应用壳，保证从主屏图标打开即离线可用（不依赖用户是否访问过某个页面）。
 *
 * 写的是**规范地址**（去扩展名），不是 .html：站点把 /notices.html 308 跳到 /notices，
 * 跟着这个跳转取回来的响应会带上 redirected 标记，而规范禁止把这种响应交给导航请求
 * （页面与 iframe 的加载都算导航）—— 浏览器直接判成网络错误，用户看到的就是
 * 「网页无法打开」。写规范地址压根不产生跳转，存下来的就是能用的那一份。
 */
const PRECACHE = [
  '/',
  '/notices',
  '/activities',
  '/academic',
  '/forms',
  '/admin',
  '/account',
  '/assets/css/style.css',
  // 脚本按页面拆分（CSP 的 script-src 只放行 'self'，内联脚本全部外置），
  // 每一个都得进预热清单，否则某页断网打开时缺脚本、按钮点不动。
  '/assets/js/theme.js',
  '/assets/js/app.js',
  '/assets/js/index.js',
  '/assets/js/notices.js',
  '/assets/js/activities.js',
  '/assets/js/academic.js',
  '/assets/js/forms.js',
  '/assets/js/account.js',
  '/assets/js/admin.js',
  '/manifest.json'
];

/**
 * 规范地址：/notices.html → /notices，/index.html → /。
 *
 * 页面里的 iframe、链接、以及后端下发的表单链接写的都是 .html 写法（在线时靠站点的 308 纠正），
 * 而缓存里存的是规范地址 —— 两边对不上就会「在线能打开、断网打不开」。所以离线回退时按规范地址再找一次。
 */
function canonical(url) {
  const path = url.pathname === '/index' || url.pathname === '/index.html'
    ? '/'
    : url.pathname.replace(/\.html$/, '');
  return new Request(url.origin + path + url.search);
}

/**
 * 连查询串也去掉的规范地址：/notices.html?id=123 → /notices（/ 页面带 ?view= 同理 → /）。
 *
 * 深链天然带查询串：App 点提醒时 iframe 的地址就是 notices.html?id=123，推送载荷里的
 * data.url 也是 /?view=notices&id=3。而预热清单与落缓存用的都是不带查询串的键，
 * 所以只按 canonical() 再找一次仍然落空 —— 断网时点通知直接进浏览器错误页。
 *
 * 只用于**回退查找**，不参与写缓存：带查询串的地址代表另一份内容（同一路径不同 id），
 * 拿它当键存会把规范地址那份覆盖掉，反而让普通离线访问失效。
 */
function canonicalPath(url) {
  const trimmed = new URL(canonical(url).url);
  trimmed.search = '';
  return new Request(trimmed.href);
}

/**
 * 去掉 redirected 标记的副本。
 *
 * 这是上面那条规范限制的兜底：在线访问 /notices.html 时网络返回的是「跟过跳转」的响应，
 * 原样塞进缓存的话，断网回放时又会踩同一个坑。所以落缓存前复制一份干净的。
 */
function plain(response) {
  if (!response.redirected) return response;
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: response.headers
  });
}

/** 只缓存同源 GET 的成功响应，避免把错误页或跨域响应塞进缓存 */
function cacheable(request, response) {
  return request.method === 'GET'
    && !!response && response.ok
    && new URL(request.url).origin === self.location.origin;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // 逐个预热：单个资源失败不影响整体安装（例如某页临时取不到），
    // 但必须留痕 —— 否则某次部署把路由改坏，只在用户断网时才暴露，线上完全无信号
    await Promise.all(PRECACHE.map(function (path) {
      return cache.add(path).catch(function (e) {
        console.warn('应用壳预热失败：' + path, e);
      });
    }));
    // 立即接管，避免用户长期停在旧版本
    await self.skipWaiting();
  })());
});

self.addEventListener('activate', function (event) {
  event.waitUntil((async function () {
    const keys = await caches.keys();
    await Promise.all(keys
      .filter(function (key) { return key !== CACHE; })
      .map(function (key) { return caches.delete(key); }));
    await self.clients.claim();
  })());
});

self.addEventListener('fetch', function (event) {
  const request = event.request;
  let url;
  try {
    url = new URL(request.url);
  } catch (e) {
    return;
  }

  // 接口一律不碰：数据与登录态必须走网络，断网就该如实报错，不能拿旧数据糊弄
  if (url.origin !== self.location.origin) return;
  if (url.pathname.indexOf('/api/') === 0) return;
  if (request.method !== 'GET') return;

  event.respondWith((async function () {
    try {
      // cache: 'no-cache' 是必须的，不是可选的优化：
      // 本域名的 CDN 会把 /assets/*、/sw.js 的 Cache-Control 改写成 max-age=14400（4 小时），
      // 而 fetch(request) 默认吃浏览器的 HTTP 缓存 —— 那样这里的「network-first」会退化成
      // 「拿最多 4 小时前的旧 CSS/JS」，出现「新页面结构 + 旧样式」。
      // 带上 no-cache 强制回源校验：没变就是 304，代价很小。
      const fresh = await fetch(request, { cache: 'no-cache' });
      if (cacheable(request, fresh)) {
        const cache = await caches.open(CACHE);
        // 键归到规范地址、响应去掉跳转标记：缓存里始终是「能用于导航」的那一份。
        // 必须 await：不 await 的话这个 Promise 游离在 respondWith 之外，
        // SW 线程随时可能被回收，写入被静默丢弃 —— 离线缓存就会「有时有、有时没有」
        await cache.put(canonical(new URL(request.url)), plain(fresh.clone()));
      }
      return fresh;
    } catch (err) {
      // 断网：按三级顺序找缓存（离线壳），都没命中再决定要不要兜底。
      //   1) 请求原样命中：静态资源就是按原地址存的（/assets/js/*.js 等）
      //   2) 规范地址：页面请求的是 .html，缓存里存的是去扩展名的那份
      //   3) 去掉查询串的规范地址：深链带 ?id= / ?view=，缓存键里没有查询串
      const url = new URL(request.url);
      const cached = await caches.match(request)
        || await caches.match(canonical(url))
        || await caches.match(canonicalPath(url));
      if (cached) return cached;

      // 统一离线兜底：导航请求三级都没命中时，回退到预缓存的应用壳 '/'。
      // 为什么兜底而不是如实报错：走到这里最典型的是「点通知 → 打开一个从没访问过的页面」
      // （主屏图标装完就断网），如实抛错用户看到的是浏览器错误页；而主页壳本身跑得起来，
      // 它里面的 app.js 会自己调 renderOfflineNotice 渲染「当前无网络」——至少是人话。
      // 为什么只对 navigate 生效：只有页面与 iframe 的加载才是导航，它们拿到 HTML 壳是正常的；
      // 脚本、样式、图标、manifest 这些非导航请求缺了就该如实失败 —— 拿主页壳顶替的话，
      // 浏览器会把一份 HTML 当 JS/CSS 解析，报出一串与被改坏的代码毫无关系的语法错误，
      // 比干脆的失败更难排查。（/api/ 与跨域请求在本函数开头就放行了，不会走到这里。）
      if (request.mode === 'navigate') {
        const shell = await caches.match('/');
        if (shell) return shell;
      }
      throw err;
    }
  })());
});

/**
 * 收到推送。
 *
 * Safari 不允许「隐形推送」：收到推送必须立刻 showNotification，否则系统会撤销通知权限。
 * 所以这里没有「不展示」的分支 —— 载荷解析失败也要弹一条兜底文案。
 */
self.addEventListener('push', function (event) {
  let data = {};
  try {
    if (event.data) data = event.data.json() || {};
  } catch (e) {
    data = {};
  }

  const options = {
    body: data.body || '有一条新消息，打开应用查看',
    icon: '/assets/icons/icon-192.png',
    badge: '/assets/icons/icon-192.png',
    data: { url: data.url || '/' }
  };
  if (data.tag) options.tag = data.tag;

  event.waitUntil(self.registration.showNotification(data.title || '班级助理', options));
});

/** 点通知：优先把已打开的窗口导航过去并聚焦，没有就新开一个 */
self.addEventListener('notificationclick', function (event) {
  event.notification.close();
  const url = (event.notification.data && event.notification.data.url) || '/';

  event.waitUntil((async function () {
    let target = url;
    try {
      target = new URL(url, self.location.origin).href;
    } catch (e) { /* 用原始值兜底 */ }

    const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
    for (const client of list) {
      let sameOrigin = false;
      try {
        sameOrigin = new URL(client.url).origin === self.location.origin;
      } catch (e) { /* client.url 为空时跳过 */ }
      if (!sameOrigin) continue;

      if (typeof client.navigate === 'function') {
        try { await client.navigate(target); } catch (e) { /* Safari 可能不支持，退回 focus */ }
      }
      if (typeof client.focus === 'function') {
        try { await client.focus(); return; } catch (e) { /* 继续试下一个窗口 */ }
      }
    }

    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

