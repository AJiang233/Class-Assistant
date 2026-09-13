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

const CACHE = 'ca-shell-v1';

/** 首次安装时预热的应用壳，保证从主屏图标打开即离线可用（不依赖用户是否访问过某个页面） */
const PRECACHE = [
  '/',
  '/index.html',
  '/notices.html',
  '/activities.html',
  '/academic.html',
  '/forms.html',
  '/admin.html',
  '/account.html',
  '/assets/css/style.css',
  '/assets/js/app.js',
  '/manifest.json'
];

/** 只缓存同源 GET 的成功响应，避免把错误页或跨域响应塞进缓存 */
function cacheable(request, response) {
  return request.method === 'GET'
    && !!response && response.ok
    && new URL(request.url).origin === self.location.origin;
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    const cache = await caches.open(CACHE);
    // 逐个预热：单个资源失败不影响整体安装（例如某页临时取不到）
    await Promise.all(PRECACHE.map(function (path) {
      return cache.add(path).catch(function () {});
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
        cache.put(request, fresh.clone());
      }
      return fresh;
    } catch (err) {
      // 断网：命中缓存就回退（离线壳），否则把网络错误如实抛回去
      const cached = await caches.match(request);
      if (cached) return cached;
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

