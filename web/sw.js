/**
 * 班级助理 · Service Worker
 *
 * 只做三件事：离线壳、让应用可安装、接收推送（阶段三加）。
 *
 * 缓存策略：**缓存先出首帧，网络在后台追**（stale-while-revalidate）：
 *   /api/*          完全不拦截，直接走网络（登录态与数据绝不缓存，断网就该报错）
 *   页面导航         cache-first + 后台回源，**文档真的变了就立刻让页面重载**
 *   静态资源         cache-first + 后台回源
 *   其他方法/跨域    不拦截
 *
 * 为什么又敢把缓存放前面了：这个项目以前出现过「用户被旧缓存卡住、完全刷新也不生效」，
 * 根因是 **cache-first 且从不回源** —— 缓存一进去就再也出不来。这里每次都照常回源，
 * 网络那份会覆盖缓存，所以陈旧最多只影响**当次**加载；而且回源时一发现文档变了，
 * 就顺手让页面自己重载（见 notifyChanged），不用等下一次打开。
 * （回源这件事有测试钉着，见 pwa.test.js 的「命中缓存后仍在后台回源刷新缓存」。）
 *
 * 换来的收益是首帧不再等网络。实测这条链路的单个请求 TTFB 在 1～3.5 秒、偶发 12～31 秒
 * （上海到 Cloudflare 的 LAX 边缘），而首帧串行依赖 index.html → style.css（95KB，阻塞渲染）
 * → theme.js（head 里的同步脚本，同样阻塞）三个来回，叠起来就是用户看到的白屏十几秒。
 * 走缓存后这三份都是本地读取，白屏消失；后台回源该慢还是慢，但不挡人。
 *
 * ponytail: 缓存名是固定的、文件名里也没有内容哈希，所以**同一次加载里可能拿到
 *   「新 HTML + 旧 CSS/JS」**（前一个的后台刷新先落地了）。现在这个窗口只存在于
 *   「发现部署的那一刻正在加载的那一页」：一发现文档真的变了就把整个壳重取一遍
 *   （见 revalidate），下一次加载起就是整份新的。要彻底消掉这个窗口，得上构建期给
 *   文件名加内容哈希 —— 这个仓库没有构建步骤，先不动。
 *
 * 注意：sw.js 由 _headers 声明为 no-cache，保证脚本本身不会被缓存住。
 */

/**
 * 缓存名。**不带版本号，也不需要按发版手改**（issue #23）—— 以前靠人记得把 `-v2` 改成 `-v3`，
 * 忘掉就是「新页面结构 + 旧样式」的混合壳，全靠人肉纪律。现在有两件事各自兜住它：
 *   1) 每条缓存在被用到的时候都会回源刷新（stale-while-revalidate，见 fetch 处理器）；
 *   2) 一旦发现文档真的变了（等于「部署了」），就把整个壳按清单重新取一遍（见 revalidate）。
 * 真要强制全量重来（比如缓存被写坏），改一下这个名字就行：sw.js 的字节一变，install /
 * activate 会重跑，旧缓存由 activate 清掉。
 */
const CACHE = 'ca-shell';

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

/**
 * 回源时的 fetch 参数。`cache: 'no-cache'` 是必须的，不是可选的优化：
 * 本域名的 CDN 会把 /assets/*、/sw.js 的 Cache-Control 改写成 max-age=14400（4 小时），
 * 而 fetch(request) 默认吃浏览器的 HTTP 缓存 —— 那样「回源」会退化成「拿最多 4 小时前的
 * 旧 CSS/JS」，出现「新页面结构 + 旧样式」。带上 no-cache 强制回源校验：没变就是 304，代价很小。
 */
const REFETCH = { cache: 'no-cache' };

/**
 * 按三级顺序找缓存：
 *   1) 请求原样命中：静态资源就是按原地址存的（/assets/js/*.js 等）
 *   2) 规范地址：页面请求的是 .html，缓存里存的是去扩展名的那份
 *   3) 去掉查询串的规范地址：深链带 ?id= / ?view=，缓存键里没有查询串
 *
 * 第 3 级只用于**查找**、不参与写入（理由见 canonicalPath）。命中任一级都算命中：
 * 这三个地址指向的是同一份文档，交给页面的 HTML 是同一份，路由由 app.js 读 location 决定。
 */
async function matchShell(request, url) {
  return await caches.match(request)
    || await caches.match(canonical(url))
    || await caches.match(canonicalPath(url));
}

/** 落缓存：键归到规范地址、响应去掉跳转标记（理由见 canonical / plain 的注释） */
async function store(request, response) {
  if (!cacheable(request, response)) return;
  const cache = await caches.open(CACHE);
  await cache.put(canonical(new URL(request.url)), plain(response));
}

/**
 * 把清单里的资源取一遍存进缓存：安装时预热、以及发现部署后整壳重刷，都走这里。
 *
 * 用 REFETCH 而不是 cache.add()：默认 fetch 会吃 CDN 那份 max-age=14400 的 HTTP 缓存，
 * 「重新取一遍」会取出 4 小时前的旧文件，等于没刷 —— 而重刷的全部意义就在于拿到新的。
 *
 * 单个资源失败不影响其它（某页临时取不到、中途断网），但必须留痕：某个路由被改坏
 * 只会在用户断网打开那一页时暴露，线上完全没有信号。清单与真实路由对不对得上，
 * pwa.test.js 里另有断言钉着。
 */
async function precache(paths) {
  const cache = await caches.open(CACHE);
  await Promise.all(paths.map(function (path) {
    return fetch(path, REFETCH).then(function (res) {
      if (res.ok) return cache.put(path, plain(res));
    }).catch(function (e) {
      console.warn('应用壳预热失败：' + path, e);
    });
  }));
}

/**
 * 后台回源刷新缓存。成功就覆盖，失败（断网等）安静收场 ——
 * 缓存里那份已经交给页面了，刷新失败不该惊动任何人，更不该冒泡成未处理的 rejection。
 *
 * cached 是刚交给页面那一份的**副本**（原件的 body 已经被页面吃掉，读不了了）。
 * 它只做一件事：和网络那份比一比，看这次回源有没有拿到真正的新内容。
 */
async function revalidate(request, cached) {
  try {
    const fresh = await fetch(request, REFETCH);
    // 失败响应（500 等）既不覆盖缓存，也谈不上「拿到了新内容」
    if (!cacheable(request, fresh)) return;

    // 比对必须在 store() 之前留副本：store() 会把 fresh 的 body 交出去，
    // 之后再读它就是 "body already used"。
    const probe = fresh.clone();
    await store(request, fresh);

    // 只有导航请求（HTML 文档）才谈得上「换了一页」：CSS/JS 变了不需要重载页面，
    // 下一次跳转自然拿到新的，在这里顺手刷反而会变成「刚打开就自己刷新」的鬼畜。
    if (cached && request.mode === 'navigate' && await changed(cached, probe)) {
      await notifyChanged(request);
      // 文档变了 = 部署了：顺手把**整个壳**按清单重取一遍（issue #23）。
      // 这是「改了页面结构不必手改缓存版本号」的落点：清单里的资源平时只在被请求到时才
      // 回源刷新，没人打开的页面（比如管理页）会一直留着旧的，靠人手记得版本号 +1 又不可靠。
      // 顺序是先通知、后重刷：通知会让页面立刻重载，不能被这十几次抓取拖住 —— 万一有一次
      // fetch 卡住，等在它后面的通知就永远发不出去。所以这次重载仍可能拿到旧 CSS/JS
      // （就是文件开头那条 ponytail 的窗口），重刷完成后下一次加载起才是整份新的。
      await precache(PRECACHE);
    }
  } catch (e) { /* 断网/失败：保留缓存里那份 */ }
}

/**
 * 两份响应内容是否不同。读不出内容（流已锁 / 老内核）时一律当「没变」：宁可漏刷一次，不可误刷。
 *
 * 比字节这件事只在**静态文件**上发生：会变的内容全在 /api/* 下，而那个前缀在本文件开头
 * 就被放行了、根本不进这条链路。所以「同一地址 = 同一份字节」是站点的性质，不是假设。
 * 万一哪天页面改成一请求一变，这里会退化成反复催页面重载 —— 那时候该改成按 ETag 比较。
 */
async function changed(a, b) {
  try {
    return (await a.text()) !== (await b.text());
  } catch (e) {
    return false;
  }
}

/**
 * 一个客户端（窗口或 iframe 文档）当前所在页面的规范地址；取不到（about:blank 之类）返回 null。
 *
 * 刻意复用 canonical()：缓存键、离线回退查找、以及「该不该让这个客户端重载」必须用同一套
 * 地址规则，否则会出现「缓存里明明是新壳、通知却发不到该发的人」这种要查半天的问题。
 */
function pagePath(url) {
  try {
    return new URL(canonical(new URL(url)).url).pathname;
  } catch (e) {
    return null;
  }
}

/**
 * 回源拿到了新文档：让**正停在同一个页面**的客户端立刻重载。
 *
 * 只更新缓存的话，用户得关掉再打开一次才看得到新壳 —— 这就是「后台拿到新内容要立刻生效」
 * 落地的地方。重载读的是本地缓存（store 在通知之前就完成了），不会再等一次网络往返。
 *
 * 为什么按页面路径筛客户端：用户在通知页时，主页壳变了不该把他拽着重载；子页是嵌在 iframe 里
 * 的独立文档，各自算一个客户端，正好各刷各的。同页面开两个窗口则一起刷新。
 *
 * 页面那边还有一道闸：有未提交的输入就放弃这次重载（见 app.js 的 hasUnsavedInput），
 * 这里不替它做决定。
 */
async function notifyChanged(request) {
  const path = pagePath(request.url);
  if (!path) return;

  const list = await self.clients.matchAll({ type: 'window', includeUncontrolled: true });
  await Promise.all(list.map(function (client) {
    if (pagePath(client.url) !== path) return;
    try {
      client.postMessage({ type: 'ca-shell-updated' });
    } catch (e) { /* 客户端刚好关掉了：忽略 */ }
  }));
}

self.addEventListener('install', function (event) {
  event.waitUntil((async function () {
    // 预热清单：失败的资源在 precache 里各自留痕，不影响整体安装
    await precache(PRECACHE);
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
    // 先看缓存：命中就把本地那份立刻交出去，不等网络。白屏就是在这里消掉的。
    const cached = await matchShell(request, url);
    if (cached) {
      // 回源刷新放后台，不 await —— 页面已经拿到缓存了，不用陪它等网络。
      // 必须挂到 waitUntil 上：不挂的话这个 Promise 游离在事件之外，SW 线程随时可能被回收，
      // 缓存就再也不更新了 —— 那就退回到「旧缓存卡住、完全刷新也不生效」那个老 bug。
      // 传进去的是**副本**：原件马上要交给页面，body 会被吃掉，回源那边就没得比对了。
      event.waitUntil(revalidate(request, cached.clone()));
      return cached;
    }

    try {
      const fresh = await fetch(request, REFETCH);
      // 必须 await：不 await 的话这个 Promise 游离在 respondWith 之外，
      // SW 线程随时可能被回收，写入被静默丢弃 —— 离线缓存就会「有时有、有时没有」
      await store(request, fresh.clone());
      return fresh;
    } catch (err) {
      // 走到这里意味着「缓存没有 + 网络也失败」，也就是真正的断网首访。
      // 统一离线兜底：回退到预缓存的应用壳 '/'。
      // 为什么兜底而不是如实报错：最典型的是「点通知 → 打开一个从没访问过的页面」
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

      let navigated = false;
      if (typeof client.navigate === 'function') {
        try { await client.navigate(target); navigated = true; } catch (e) { /* 继续走兜底 */ }
      }
      if (!navigated) {
        // 没有 client.navigate 的老内核（旧版 Safari）或导航失败：把目标地址交给页面自己跳
        // （postMessage 路由，见 app.js 的 message 监听；issue #84 项 11），否则只会 focus、
        // 页面停在旧页不跳详情
        try { client.postMessage({ type: 'ca-shell-navigate', url: target }); } catch (e) {}
      }
      if (typeof client.focus === 'function') {
        try { await client.focus(); return; } catch (e) { /* 继续试下一个窗口 */ }
      }
    }

    if (self.clients.openWindow) await self.clients.openWindow(target);
  })());
});

