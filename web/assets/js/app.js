// 共享前端逻辑：API 客户端 + 会话管理 + 工具函数
// 所有页面通过 <script src="assets/js/app.js"> 引用

// ===== 配置 =====
// 开发环境：本地 wrangler dev（后端 D1 模拟 + 本地数据）
// 生产环境：改为后端 API 域名（如 https://your-api.workers.dev 或你的子域）
const API_BASE = '';
const LS_TOKEN = 'ca_token';
const LS_USER = 'ca_user';

/**
 * 统一 API 请求：自动附带 Bearer token，401 统一处理，返回 data 结构
 * 后端响应格式：{ success, data } / { success:false, error, code }
 */
async function api(path, options = {}) {
  const headers = { 'Content-Type': 'application/json', ...(options.headers || {}) };
  const token = localStorage.getItem(LS_TOKEN);
  if (token) headers['Authorization'] = 'Bearer ' + token;
  let res;
  try {
    // 前端兜底超时：后端或网络挂起时也能拿到异常回显，而不是无限卡在加载态。
    // 构造放在 try 内，旧内核没有 AbortSignal.timeout 时也不会把 api() 整个打挂。
    res = await fetch(API_BASE + path, { ...withTimeout(options), headers });
  } catch (e) {
    // 超时/断网时 fetch 直接 reject，message 常为空，这里转成可读文案
    const timedOut = !(options.signal) && e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(timedOut ? '请求超时（>30s），请检查网络后重试' : ('网络错误：' + (e.message || '无法连接服务器')));
  }
  // raw 模式（导出二进制 / 需要自己消费 Response 的调用）直接给回 Response，不做 JSON 解析
  const data = options.raw ? res : await res.json().catch(() => ({}));
  if (!res.ok) {
    // 登录态失效（token 过期/无效）：清除本地会话，回主页引导页
    if (res.status === 401 && token) {
      clearSession();
      redirectToIndex();
    }
    // 透传后端错误码与 HTTP 状态，供前端按 code 精确分支（不再靠文案匹配）；
    // raw 模式下 data 就是 Response，没有 .error / .code，统一退化成状态码文案
    const err = new Error(data && data.error ? data.error : '请求失败（' + res.status + '）');
    err.code = data && data.code ? data.code : '';
    err.httpStatus = res.status;
    throw err;
  }
  return data;
}

/** 给请求补一个 30s 兜底超时；旧内核缺 AbortSignal.timeout 时退化为 AbortController */
function withTimeout(options) {
  if (options.signal) return options;   // 调用方自带 signal（手动取消）时不覆盖
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return { ...options, signal: AbortSignal.timeout(30000) };
    }
    if (typeof AbortController !== 'undefined') {
      const controller = new AbortController();
      setTimeout(function () { controller.abort(); }, 30000);
      return { ...options, signal: controller.signal };
    }
  } catch (e) { /* 特性探测或构造失败：退化成无超时请求，不影响请求本身 */ }
  return options;
}

// ===== 原生离线层的数据回填（App 壳专用）=====
/**
 * App 里 /api/ 的只读请求由原生层接管（见 android 的 sync/OfflineApi）：本地有一份够新鲜的
 * 缓存时，**先把缓存给页面**，首帧就不必等一次网络往返；紧接着它在后台去取最新的，
 * 内容变了再把新数据推回这里。页面只要把自己的渲染函数按「请求 URL」注册进来：
 *
 *   onApiData('/api/notices?scope=all&limit=200', function (data) { renderList(data.list); });
 *
 * 键必须与页面请求时的 URL 完全一致（原生那边缓存键就是「路径 + 查询串」）。带参数的请求
 * 尤其要注意：参数不同就是两份缓存、两个键，注册错了只会静默不生效。
 * 网页版没有这个入口（根本不经过原生层），注册了也不会被调用，所以页面里不用判断环境。
 */
const apiRenderers = {};
function onApiData(key, render) {
  if (typeof render === 'function') apiRenderers[key] = render;
}
/**
 * 原生推回的新数据：先喂给本窗口注册的渲染函数。
 *
 * 键必须与请求 URL 一字不差；注册在这儿的这一份属于**本窗口**，iframe 里那几个页面
 * 各自加载一份 app.js、各自一份 apiRenderers，所以还有一层转发（见 __caApiUpdated）。
 */
function renderApiUpdate(key, json) {
  const render = apiRenderers[key];
  if (!render) return;   // 这一份没人关心（比如页面已经切走）：静默跳过
  let payload;
  try {
    payload = JSON.parse(json);
  } catch (e) {
    console.warn('推回的数据解析失败：', key, e);
    return;
  }
  // 失败响应不回填：success:false 是后端用 200 包的错误，渲染函数按 data 展开会读到 undefined
  if (!payload || payload.success !== true) return;
  try {
    render(payload.data || {});
  } catch (e) {
    console.warn('回填渲染失败：', key, e);
  }
}

/**
 * 原生后台刷新的入口（见 android 的 MainActivity.pushApiUpdate）。两个动作缺一不可：
 *
 *   1) 本窗口自己重绘 —— 主页那几个键就注册在顶层壳里；
 *   2) **转发给同源的 iframe 子页面** —— 原生那边是 `webView.evaluateJavascript`，只作用于
 *      顶层文档的 window，而通知/活动/教务/个人中心/管理员这几个页面各自跑在 iframe 里、
 *      各自一份 app.js、各自一份 apiRenderers。不转发的话它们永远收不到「后台新数据」这一拍，
 *      只能一直显示上一次会话留下的那份缓存（同一个道理见下面 beforeinstallprompt 那处：
 *      iframe 收不到顶层的事件，只能主动递进去）。
 *
 * 转发用的是 contentWindow 直调，必须 try/catch：frame 还没加载完、或者内容跨域（教务页
 * 是另一个域）时读 contentWindow 会抛 SecurityError，不能让它把整次回填带崩。
 */
window.__caApiUpdated = function (key, json) {
  renderApiUpdate(key, json);

  var frames = document.querySelectorAll('iframe');
  for (var i = 0; i < frames.length; i++) {
    try {
      var win = frames[i].contentWindow;
      if (win && win.__caApiUpdated) win.__caApiUpdated(key, json);
    } catch (e) { /* 还没加载或跨域：忽略 */ }
  }
};

/** 保存登录会话 */
function saveSession(data) {
  // Safari 无痕模式或配额耗尽时 setItem 会抛 QuotaExceededError。
  // 不区分处理的话，服务端明明已经签发 token，用户却被提示登录失败。
  try {
    localStorage.setItem(LS_TOKEN, data.token);
    localStorage.setItem(LS_USER, JSON.stringify(data.user || {}));
  } catch (e) {
    console.warn('无法写入本地存储：', e);
    throw new Error('浏览器存储不可用，无法保持登录状态，请退出无痕模式后重试');
  }
}

/** 读取当前用户（无则 null） */
function getSession() {
  try {
    const u = localStorage.getItem(LS_USER);
    return u ? JSON.parse(u) : null;
  } catch {
    return null;
  }
}

/** 解析当前用户的职位列表（兼容 JSON 字符串 / 普通字符串） */
function userPositions() {
  const u = getSession();
  if (!u) return [];
  const p = u.positions;
  if (p == null || p === '') return [];
  const s = String(p);
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      return Array.isArray(arr) ? arr.filter(Boolean) : [s];
    } catch {
      return [s];
    }
  }
  return [s];
}

/** 职务字段为 JSON 字符串（如 ["班长","学习委员"]），解析为数组（兼容逗号·顿号·空格分隔） */
function parsePositionsList(p) {
  if (p == null) return [];
  const s = String(p).trim();
  if (!s) return [];
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map(String).filter(Boolean);
    } catch (e) { /* 非法 JSON 时按分隔符解析 */ }
  }
  return s.split(/[,，、\s]+/).filter(Boolean);
}

/** 职务标签（chip）样式展示，多个职务并列显示 */
function positionsChipsHTML(p) {
  const list = parsePositionsList(p);
  // 没有职务的人也要出同一个 chip。原来这里空值直接 return 裸文本「学生」，
  // 于是成员列表里就一半是徽章、一半是光秃秃的「学生」两个字。
  // 为什么会空：「学生」不在职务选择器里（allPositionNames 把它排除了），不勾任何职务
  // 的人存进来就是空的；而数据库里新旧两种写法都有（'学生' / '[]' / 空串），
  // 所以兜底只能放在这个所有调用点共用的渲染函数里，不能在写入端统一了事。
  const names = list.length ? list : ['学生'];
  return names.map(function (n) { return '<span class="pos-tag">' + esc(n) + '</span>'; }).join('');
}

/* ===== 事件委托 =====
   CSP 收紧后页面里不能再写内联 onclick（script-src 里没有 'unsafe-inline'），
   静态按钮与动态生成的列表行统一改成「属性标记 + 委托监听」：
   整页只挂一个监听，列表 innerHTML 重绘之后不用重新绑定。 */
function delegate(root, type, selector, handler) {
  root.addEventListener(type, function (e) {
    var el = e.target instanceof Element ? e.target.closest(selector) : null;
    if (el) handler(el, e);
  });
}

/** 取某个提醒选择区中「属于指定职位」的成员复选框 */
function _remindByPosition(boxId, pos) {
  const box = document.getElementById(boxId);
  if (!box) return [];
  return Array.prototype.filter.call(box.querySelectorAll('.remind-cb'), function (cb) {
    const label = cb.closest('label');
    return !!label && parsePositionsList(label.getAttribute('data-positions')).indexOf(pos) >= 0;
  });
}

/** 同步职位快捷标签的选中态（全选 / 部分 / 未选） */
function syncRemindQuick(boxId) {
  const box = document.getElementById(boxId);
  if (!box) return;
  Array.prototype.forEach.call(box.querySelectorAll('.pos-chip'), function (btn) {
    const list = _remindByPosition(boxId, btn.getAttribute('data-pos'));
    const on = list.filter(function (cb) { return cb.checked; }).length;
    btn.classList.toggle('on', on > 0);
    btn.classList.toggle('partial', on > 0 && on < list.length);
    btn.setAttribute('aria-pressed', on > 0 ? 'true' : 'false');
  });
}

/** 点击职位快捷标签：全选 / 取消该职位的所有成员（保存时快照为成员姓名） */
function toggleRemindPosition(boxId, btn) {
  const list = _remindByPosition(boxId, btn.getAttribute('data-pos'));
  const allOn = list.length > 0 && list.every(function (cb) { return cb.checked; });
  list.forEach(function (cb) { cb.checked = !allOn; });
  syncRemindQuick(boxId);
}

/**
 * 渲染「提醒对象」选择区：顶部按职位一键选择，下方成员多选。
 * @param failed 名单加载失败。失败与「真没有成员」必须分开处理（issue #78）：
 *               失败时保存会把已选对象丢成 []（= 全班可见），所以只显示错误提示并禁用保存，
 *               等下次打开编辑弹窗重取；真没有成员时 [] 就是正确的全班，照常可保存。
 */
function renderRemindBox(boxId, members, checkedNames, failed) {
  const box = document.getElementById(boxId);
  if (!box) return;
  box.className = 'remind-box';
  const save = document.getElementById('editSubmitBtn');
  if (failed) {
    box.innerHTML = '<span class="remind-hint">提醒对象名单加载失败，请关闭后重新打开</span>';
    if (save) save.disabled = true;
    return;
  }
  // 上一次打开可能失败禁掉了保存按钮：这次名单可用就要恢复，否则永远点不动
  if (save) save.disabled = false;
  if (!members || !members.length) {
    box.innerHTML = '<span class="remind-hint">暂无成员可提醒</span>';
    return;
  }
  const checked = {};
  (checkedNames || []).forEach(function (n) { checked[n] = true; });
  const positions = [], seen = {};
  members.forEach(function (m) {
    parsePositionsList(m.positions).forEach(function (p) {
      if (!seen[p]) { seen[p] = true; positions.push(p); }
    });
  });
  const quick = positions.map(function (p) {
    return '<button type="button" class="pos-chip" data-pos="' + escAttr(p) + '">' + esc(p) + '</button>';
  }).join('');
  const rows = members.map(function (m) {
    const ps = parsePositionsList(m.positions).join(',');
    const chk = checked[m.name] ? ' checked' : '';
    return '<label class="chip" data-positions="' + escAttr(ps) + '">'
      + '<input type="checkbox" class="remind-cb" value="' + escAttr(m.name) + '"' + chk + '>' + esc(m.name) + '</label>';
  }).join('');
  box.innerHTML = (positions.length ? '<div class="remind-quick"><span class="remind-quick-label">按职位选择</span>' + quick + '</div>' : '')
    + '<div class="mb-12"><input class="form-input" type="search" placeholder="搜索姓名 / 职位" autocomplete="off"></div>'
    + '<div class="remind-members">' + rows + '</div>'
    + '<div class="remind-empty" hidden>没有匹配的成员</div>';
  bindRemindBox(box, boxId);
  syncRemindQuick(boxId);
}

/**
 * 提醒选择区的委托监听。内容每次重绘都会换掉，但外层 .remind-box 容器不变，
 * 所以监听挂在容器上、只挂一次（挂内层节点的话重绘一次就全丢了）。
 */
function bindRemindBox(box, boxId) {
  if (box.__remindBound) return;
  box.__remindBound = true;
  box.addEventListener('click', function (e) {
    const chip = e.target instanceof Element ? e.target.closest('.pos-chip') : null;
    if (chip) toggleRemindPosition(boxId, chip);
  });
  box.addEventListener('change', function (e) {
    if (e.target && e.target.classList && e.target.classList.contains('remind-cb')) syncRemindQuick(boxId);
  });
  box.addEventListener('input', function (e) {
    const t = e.target;
    if (t && t.tagName === 'INPUT' && t.type === 'search') filterRemindMembers(t);
  });
}

/**
 * 提醒对象里按姓名 / 职务过滤成员（做法与「管理成员」的搜索一致）。
 * 只隐藏不删除：勾选状态留在 DOM 上，过滤期间不会把已勾的人丢掉；全被滤掉时显示空状态。
 */
function filterRemindMembers(input) {
  const box = input.closest('.remind-box');
  if (!box) return;
  const q = input.value.trim().toLowerCase();
  let shown = 0;
  box.querySelectorAll('.remind-members .chip').forEach(function (chip) {
    const text = (chip.textContent + ' ' + (chip.getAttribute('data-positions') || '')).toLowerCase();
    const hit = !q || text.indexOf(q) >= 0;
    chip.hidden = !hit;
    if (hit) shown++;
  });
  const empty = box.querySelector('.remind-empty');
  if (empty) empty.hidden = shown > 0;
}

/* ===== PWA：安装到桌面 =====
   安装入口在个人页（account.html）的「安装到桌面」卡片里，不再挂主页横幅。
   只有 iOS 与 PC 需要它 —— 安卓与鸿蒙都已有原生 App，装网页版只会让人困惑。
   个人页跑在 iframe 里，而 beforeinstallprompt 只在顶层窗口触发、
   display-mode / navigator.standalone 也以顶层为准（iframe 内未必反映真实状态），
   所以「是否已安装」与安装事件都统一读写顶层窗口。 */

/** display-mode 只要不是 browser，就说明是以应用方式在跑 */
const APP_DISPLAY_MODES = ['standalone', 'minimal-ui', 'fullscreen', 'window-controls-overlay'];

/** 这个窗口看起来是不是「已安装的应用窗口」 */
function looksInstalled(win) {
  try {
    const installed = APP_DISPLAY_MODES.some(function (mode) {
      return win.matchMedia && win.matchMedia('(display-mode: ' + mode + ')').matches;
    });
    if (installed) return true;
    // iOS 专用：加到主屏后为 true
    return !!(win.navigator && win.navigator.standalone === true);
  } catch (e) {
    return false;
  }
}

/**
 * 是否已以「已安装应用」方式运行（从主屏图标启动 / 独立窗口）。
 *
 * 必须先看顶层窗口：个人页在 iframe 里，iframe 自己问 display-mode / navigator.standalone
 * 可能答「不是」，于是装好的 App 里点开个人页又会被推一次安装 —— 就是这个坑。
 */
function isStandaloneMode() {
  const host = installHostWindow();
  if (host === window) return looksInstalled(window);
  return looksInstalled(host) || looksInstalled(window);
}

/** 是否 iOS / iPadOS（只有 Safari 分享菜单能加主屏，无法用代码触发安装） */
function isIOSDevice() {
  const ua = navigator.userAgent || '';
  // iPadOS 13+ 的 UA 伪装成 Mac，用触点数一并识别
  return /iPad|iPhone|iPod/.test(ua) || (/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);
}

/** 是否在原生壳里 —— 安卓 App 与鸿蒙 App 注入的是同名 CAHost 桥 */
function inNativeShell() {
  return !!window.CAHost;
}

/** 是否 PC 桌面浏览器 */
function isDesktopBrowser() {
  const ua = navigator.userAgent || '';
  // 认不出的移动端一律当移动端，宁可少提示也不要给安卓/鸿蒙用户推网页版安装
  if (/Android|iPhone|iPad|iPod|HarmonyOS|OpenHarmony|ArkWeb|Windows Phone|Mobile/i.test(ua)) return false;
  return !(/Macintosh/.test(ua) && navigator.maxTouchPoints > 1);   // iPadOS 伪装的 Mac 不算 PC
}

/** 这台设备要不要显示安装入口 */
function shouldOfferInstall() {
  if (inNativeShell()) return false;      // 已经在原生 App 里了
  if (isStandaloneMode()) return false;   // 已经装好了
  if (isIOSDevice()) return true;
  return isDesktopBrowser();
}

/** 安装事件只在顶层窗口触发；个人页在 iframe 里，统一读写顶层 */
function installHostWindow() {
  try {
    if (window.top && window.top !== window) return window.top;
  } catch (e) { /* 跨域时退回自身 */ }
  return window;
}

function getDeferredInstallPrompt() {
  const host = installHostWindow();
  return (host && host.__deferredInstallPrompt) || null;
}

/* 拦下浏览器自己的安装提示，等用户点「安装」再弹，避免弹两次 */
window.addEventListener('beforeinstallprompt', function (e) {
  e.preventDefault();
  window.__deferredInstallPrompt = e;
  renderInstallEntry();
  // 个人页在 iframe 里收不到这个事件，主动让它重画一次
  try {
    const frame = document.getElementById('frameAccount');
    if (frame && frame.contentWindow && frame.contentWindow.renderInstallEntry) {
      frame.contentWindow.renderInstallEntry();
    }
  } catch (err) { /* 还没加载或跨域，忽略 */ }
});

window.addEventListener('appinstalled', function () {
  window.__deferredInstallPrompt = null;
  renderInstallEntry();
});

/**
 * 渲染个人页的「安装到桌面」卡片：不需要就整块隐藏，而不是留一个点不动的按钮。
 * 页面里没有 #installCard 时静默跳过，所以放在 app.js 里对全部页面安全。
 */
function renderInstallEntry() {
  const card = document.getElementById('installCard');
  if (!card) return;

  if (!shouldOfferInstall()) {
    card.hidden = true;
    return;
  }

  const text = card.querySelector('.install-entry-text');
  const btn = card.querySelector('.install-entry-action');

  if (isIOSDevice()) {
    // iOS 无法用代码安装：说清怎么点，不做假的成功反馈
    if (text) text.textContent = '加到主屏幕后可以全屏使用，也是 iPhone 收到班级通知的前提：点底部「分享」按钮 →「添加到主屏幕」。';
    if (btn) btn.hidden = true;
  } else if (getDeferredInstallPrompt()) {
    if (text) text.textContent = '把「班级助理」装到桌面，打开更快，也能收到班级通知。';
    if (btn) btn.hidden = false;
  } else {
    // 桌面浏览器没给安装事件（Safari / Firefox，或时机还没到）：只给地址栏提示，不放死按钮
    if (text) text.textContent = '把「班级助理」装到桌面，打开更快，也能收到班级通知。Chrome / Edge 可点地址栏右侧的安装图标。';
    if (btn) btn.hidden = true;
  }
  card.hidden = false;
}

/** 触发浏览器原生安装流程（仅拿到 beforeinstallprompt 后可用，主要是 Chrome / Edge） */
async function installApp() {
  const prompt = getDeferredInstallPrompt();
  if (!prompt) return;
  // 同一个事件只能 prompt 一次，先清掉再弹
  try { installHostWindow().__deferredInstallPrompt = null; } catch (e) {}
  prompt.prompt();
  try { await prompt.userChoice; } catch (e) {}
  renderInstallEntry();
}

if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderInstallEntry);
else renderInstallEntry();

/* ===== 网页通知：开启失败时给用户看的话 =====
   为什么放在共享脚本里而不是 account.js：account.js 是带副作用的 IIFE（开头就 requireAuth、
   结尾就 refreshNotify），没法单独取出一个函数来测；放这里能被 pwa.test.js 的沙箱直接取到。

   COPY.md 第 7 节：浏览器抛的异常原文（subscribe 失败时是英文 DOMException）只进 console.error，
   不给用户看。所以下面把能对上号的失败原因翻成人话，其余一律走最后那句 ——
   浏览器还有一堆我们复现不了的失败原因，不逐个翻译。 */
function pushSubscribeError(e) {
  var name = (e && e.name) || '';
  // 权限在 requestPermission 那一关被拒时，上面已经拦掉并提示过了；
  // 这里兜住浏览器拖到 subscribe 才拒绝的情况（两条路都要给同一句话）
  if (name === 'NotAllowedError') {
    return '通知权限没拿到。请到系统设置里允许「班级助理」发通知后再试。';
  }
  // 公钥不合法：服务端 VAPID 密钥配错或换过密钥，用户在这台设备上做不了什么，指向管理员
  if (name === 'InvalidAccessError' || name === 'InvalidCharacterError') {
    return '推送服务配置有问题，这里开不了通知，请联系管理员。';
  }
  // 最典型的一种：Chrome / Edge 的推送服务是 Google 的 FCM，部分网络环境访问不到；
  // 被裁剪过的国产浏览器可能整个没有推送服务 —— 两者报的都是同一句英文的
  // "Registration failed - push service error"，用户在这台设备上无计可施，如实说明即可。
  return '这台设备连不上浏览器的推送服务，网页通知暂时开不了。换个网络或浏览器可以再试；其它功能不受影响。';
}

/* 注册 Service Worker：提供离线壳，也是可安装与推送的前提。
   注册失败只意味着没有离线与推送，页面本身照常可用，所以只提示不抛错。 */
if ('serviceWorker' in navigator) {
  window.addEventListener('load', function () {
    // updateViaCache: 'none' —— 连 sw.js 脚本本身也不走 HTTP 缓存。
    // 本域名的 CDN 会把 sw.js 的 Cache-Control 改写成 4 小时，不显式声明的话更新会被拖住。
    navigator.serviceWorker.register('sw.js', { updateViaCache: 'none' }).catch(function (e) {
      console.warn('Service Worker 注册失败：', e);
    });
  });

  /* SW 在后台回源时发现这一页的文档真的变了，会发消息过来（见 sw.js 的 notifyChanged），
     这里让当前这一份文档立刻换成新的 —— 也就是「后台拿到新内容就立刻刷新」。

     为什么可以直接重载：新的那份在发通知之前就已经写进 SW 缓存（先 store 再通知），
     重载读的是本地那一份，不会再等一次网络往返。

     为什么要挡「用户正在填东西」：重载会把表单、MFA 验证码清空。有未提交的输入就放弃
     这一次刷新 —— 用户手上的东西比「立刻看到新页面」值钱；页面可以是旧的，下一次跳页
     或者重开自然就是新的。 */
  navigator.serviceWorker.addEventListener('message', function (event) {
    if (!event.data) return;
    if (event.data.type === 'ca-shell-updated') {
      if (hasUnsavedInput()) return;
      location.reload();
    } else if (event.data.type === 'ca-shell-navigate' && event.data.url) {
      // 点通知的兜底路由（issue #84 项 11）：老 Safari 没有 client.navigate，SW 把目标地址
      // 交到这里自己跳。location.href 带查询串（如 /?view=notices&id=3），加载后由
      // index.js / 子页面按深链自行路由，与 client.navigate 的效果一致。
      location.href = event.data.url;
    }
  });
}

/**
 * 有没有「用户改了但还没提交」的输入 —— 决定后台拿到新页面时敢不敢自动重载。
 *
 * 拿原生的 defaultValue / defaultChecked 比对，而不是自己记一套「脏标记」：这些页面的表单都是
 * 各页面脚本动态渲染的，没有统一的脏状态，手写一套就得每个表单跟着改；而 defaultValue 天生
 * 就是「HTML 里的初值」，value 与它不等就是用户动过。
 *
 * 判定故意偏严（宁可少刷一次，不可清空一次）：复选框被点过、下拉被选过都算有输入。
 * 误判成「有输入」只是晚一次刷新，误判成「没输入」是用户白填一遍表单。
 */
function hasUnsavedInput() {
  var nodes = document.querySelectorAll('input, textarea, select');
  for (var i = 0; i < nodes.length; i++) {
    var el = nodes[i];
    if (el.disabled || el.readOnly) continue;
    var type = (el.type || '').toLowerCase();
    // 按钮与隐藏域没有「用户填的内容」可言；文件的 value 是假的路径，比不出用户动没动过
    if (type === 'hidden' || type === 'submit' || type === 'button' || type === 'reset' || type === 'file') continue;
    if (type === 'checkbox' || type === 'radio') {
      if (el.checked !== el.defaultChecked) return true;
    } else if (el.value !== el.defaultValue) {
      return true;
    }
  }
  return false;
}

/* ===== 离线提示 =====
   断网时两种情况不一样，不能共用一句话：
     App 里 —— 原生层把 /api/ 的只读响应缓存下来回放（见 android 的 OfflineApi），
              页面照常能看到课表、通知、活动，只是数据是上次同步的；
     浏览器里 —— 没有这一层。页面壳还能从 Service Worker 缓存里打开，但数据是真的取不到。
   注意 navigator.onLine 只管「有没有可用网络」，管不了「服务端是不是活着」，够用了。 */
function renderOfflineNotice() {
  var existing = document.getElementById('offlineNotice');
  if (navigator.onLine) {
    if (existing) existing.remove();
    return;
  }
  if (existing) return;

  // .main 在每个子页与主页视图里都有（主页视图是 index.html 自己渲染的，不是 iframe）
  var host = document.querySelector('.main');
  if (!host) return;

  var el = document.createElement('div');
  el.id = 'offlineNotice';
  el.className = 'offline-notice';
  el.textContent = inNativeShell()
    ? '当前无网络，显示的是缓存数据'
    : '当前无网络，部分内容可能无法加载';
  host.insertBefore(el, host.firstChild);
}

window.addEventListener('online', renderOfflineNotice);
window.addEventListener('offline', renderOfflineNotice);
if (document.readyState === 'loading') document.addEventListener('DOMContentLoaded', renderOfflineNotice);
else renderOfflineNotice();

/** 能否发布/取消 通知、活动，以及创建/管理表单（权限由后端按职位+自定义职位计算） */
function canContentWrite() {
  const u = getSession();
  if (u && Array.isArray(u.permissions)) return u.permissions.includes('content:write');
  // 兼容未含 permissions 的旧会话：按固定职位名兜底
  return userPositions().some(r => r === '班长' || r === '团支书' || r === '学习委员');
}

/** 能否注册账号、管理班级成员（权限由后端计算） */
function canManageUsers() {
  const u = getSession();
  if (u && Array.isArray(u.permissions)) return u.permissions.includes('user:manage');
  return userPositions().some(r => r === '班长' || r === '团支书');
}

/** 能否进入管理员面板：发布权限或成员管理权限任一即可（侧栏入口 / 个人页入口 / 管理页闸门三处共用） */
function canManagePanel() {
  return canContentWrite() || canManageUsers();
}

/** 卡片折叠（默认收起，点击标题行展开/收起）—— 个人页与管理员页各一份的旧实现已收敛到这里 */
function toggleCollapse(id) {
  const card = document.getElementById(id);
  if (!card) return;
  const open = card.classList.toggle('open');
  const head = card.querySelector('.collapse-head');
  if (head) head.setAttribute('aria-expanded', open ? 'true' : 'false');
}

/** 清除会话 */
function clearSession() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
}

/** 是否已经在跳转回主页的路上：并发多个 401 时避免反复触发顶层跳转 */
var redirectingToIndex = false;

/** 回到主页引导页（iframe 内则跳外层，避免套娃） */
function redirectToIndex() {
  if (redirectingToIndex) return;
  redirectingToIndex = true;
  // 由当前目录推导，而不是写死 'index.html'：换到子路径部署时后者会跳到站根
  var target = window.location.pathname.replace(/[^/]*$/, '') + 'index.html';
  if (window.self !== window.top) {
    window.top.location.href = target;
  } else {
    window.location.href = target;
  }
}

/** 退出登录：清会话并回主页引导页 */
function logout() {
  clearSession();
  redirectToIndex();
}

/** 需要登录的页面：加载时校验，未登录跳主页引导页 */
function requireAuth() {
  if (!localStorage.getItem(LS_TOKEN)) {
    redirectToIndex();
    return false;
  }
  return true;
}

/** XSS 转义：所有用户输入/后端内容经 esc() 后再用 innerHTML */
function esc(t) {
  if (t == null) return '';
  const d = document.createElement('div');
  d.textContent = String(t);
  return d.innerHTML;
}

/**
 * 属性值转义。
 * esc() 走 textContent→innerHTML，只保证 & < > 安全，**不会转义引号**；
 * 放进带引号的属性里时，一个 " 就能闭合属性并注入事件处理器。
 * 凡是插到 ="..." 里的值都必须走这里，而不是 esc()。
 */
function escAttr(t) {
  if (t == null) return '';
  return String(t)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * href 白名单：只放行站内相对路径与 http(s)，挡掉 javascript: / data: 这类伪协议。
 * 属性转义管不了协议型 XSS，两者要一起用。
 */
function safeHref(url) {
  const s = String(url == null ? '' : url).trim();
  if (!s) return '';
  if (/^https?:\/\//i.test(s)) return s;
  if (s.charAt(0) === '/' || s.charAt(0) === '#' || s.charAt(0) === '?') return s;
  if (/^[a-z][a-z0-9+.-]*:/i.test(s)) return '';
  return s;
}

/** 日期显示：空显示"时间未知" */
function fmtDate(d) {
  if (!d) return '时间未知';
  return d;
}

/** 加载中占位：骨架屏（匹配列表行形状，行数可指定） */
function skeletonHTML(rows) {
  var n = rows || 4;
  var out = '';
  for (var i = 0; i < n; i++) {
    out += '<div class="skeleton-row"><span class="skeleton-line w80"></span><span class="skeleton-line w35"></span></div>';
  }
  return '<div class="list">' + out + '</div>';
}

/**
 * 列表状态提示（空数据 / 错误 / 加载中）：各页面统一渲染。
 *
 * 图标按语义给：错误 = 三角感叹号，空数据 = 收件箱。加载中不属于这两类，由调用方
 * 传第三个参数指定（那几处 stateHTML('正在加载…', false, 'clock')）。
 * 形状与颜色全交给 CSS（style.css 的 .state svg / .state.error svg），这里只管挑哪个。
 */
function stateHTML(text, isError, iconName) {
  var cls = isError ? 'state error' : 'state';
  var name = iconName || (isError ? 'alert-triangle' : 'inbox');
  return '<div class="' + cls + '">' + icon(name) + '<p>' + esc(text || '暂无数据') + '</p></div>';
}

/** 通知来源显示名：手动发布 / 自动拉取 */
function sourceName(s) {
  if (s === 'manual' || !s) return '手动发布';
  return '自动拉取';
}

/** 行内描边图标：统一尺寸、线宽与基线对齐 —— 主力是详情弹窗那几处（14px）。
 *  空态 / 错误态 / 加载中的图标也从这里取，只是尺寸由 CSS 放大到 32px
 *  （见 style.css 里 .state svg 那条，本来就是为它留的）。 */
var DETAIL_ICONS = {
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>',
  // 收件箱：空态用。原来的空态是一个 52px 实心圆，形状不带信息又太像 iOS（issue #74）
  inbox: '<polyline points="22 12 16 12 14 15 10 15 8 12 2 12"/><path d="M5.45 5.11 2 12v6a2 2 0 0 0 2 2h16a2 2 0 0 0 2-2v-6l-3.45-6.89A2 2 0 0 0 16.76 4H7.24a2 2 0 0 0-1.79 1.11z"/>',
  // 三角感叹号：错误态用。刻意不用圆形的 alert-circle —— 要的就是脱离那个「圆」
  'alert-triangle': '<path d="M10.29 3.86 1.82 18a2 2 0 0 0 1.71 3h16.94a2 2 0 0 0 1.71-3L13.71 3.86a2 2 0 0 0-3.42 0z"/><line x1="12" y1="9" x2="12" y2="13"/><line x1="12" y1="17" x2="12.01" y2="17"/>'
};
function icon(name) {
  var p = DETAIL_ICONS[name] || '';
  return '<svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true">' + p + '</svg>';
}

/** 提醒对象字段为 JSON 字符串（如 ["张三","李四"]），展示时转为可读文本 */
function fmtRemind(p) {
  if (!p) return '';
  var s = String(p);
  if (s.charAt(0) === '[') {
    try { var a = JSON.parse(s); return Array.isArray(a) ? a.join('、') : s; } catch (e) { return s; }
  }
  return s;
}

/** datetime-local 默认值：当前本地时间 YYYY-MM-DDTHH:MM */
function nowLocal() {
  var d = new Date(); var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** datetime-local 默认结束值：当日 23:59（YYYY-MM-DDTHH:MM） */
function todayEnd() {
  var d = new Date(); var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
  return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T23:59';
}

/* ===== 主页欢迎文案（issue #75）=====
   主页那两行固定文案改成按时间段变的问候：标题是问候语，副标题是跟同一个语气的下一句。

   分档（左闭右开）：6-11 早上 / 11-14 中午 / 14-18 下午 / 18-23 晚上 / 23-1 深夜 / 1-6 午夜。
   深夜那档跨零点，所以在表里拆成 [23,24) 与 [0,6) 两段 —— 判定就退化成一句区间比较，
   不必为「跨零点」单写一个特例。

   口径是北京时间，不是浏览器本地时间：全站的课表 / 通知时间都按 +8 渲染（见 account.js
   的 fmtTs），主页要是跟着本地时区走，境外的同学会看到「午夜时分，zzzzzz……」配着一整
   天的课表。换算方式与 fmtTs 一致：先加 8 小时，再取 UTC 字段。

   文案：标题与副标题都按项目自己的语气写（6-11 那档的骨架来自 issue #75 的示例）。
   改文案就改这张表，同时把 pwa.test.js 里那张期望表一起改 —— 它是按整点逐个对字面量的，
   专门为了让「文案改了但忘了同步」这种事先红一次。 */
var GREETING_BANDS = [
  { from: 6,  to: 11, title: '早上好~',                  desc: '又是全新的一天~  今天要做些什么呢？' },
  { from: 11, to: 14, title: '中午好呀',                 desc: '饿了饿了，今天中午吃什么呢？  是啊，吃什么（' },
  { from: 14, to: 18, title: '下午好w',                  desc: '我还想再睡一会午觉……还是好困啊……' },
  { from: 18, to: 23, title: '晚上好喵~',                desc: '今天还剩什么没做完哎？趁现在收个尾，明天就轻松了吧？' },
  { from: 23, to: 24, title: '（哈欠）',                 desc: '这么晚了还不睡觉嘛？明天的事交给明天的自己吧……' },
  { from: 0,  to: 6,  title: '午夜时分',                 desc: '晚安~  ZZZZZZ ZZZZZZ……' }
];

/** 当前北京时间的小时数（0-23） */
function beijingHour() {
  return new Date(Date.now() + 8 * 3600 * 1000).getUTCHours();
}

/** 北京时间 hour 点对应的问候文案；六段合起来正好是 [0,24)，不会落空 */
function greetingFor(hour) {
  for (var i = 0; i < GREETING_BANDS.length; i++) {
    var b = GREETING_BANDS[i];
    if (hour >= b.from && hour < b.to) return b;
  }
  return GREETING_BANDS[0];   // 兜底：正常到不了，留着是为了别把 undefined 甩给调用方
}

/* ===== 移动端安全区转发（iframe 子页面，纯表现层） =====
   通知/活动/教务/个人中心/管理员这几个页面是作为 iframe 嵌在主页里的。
   iframe 内部 env(safe-area-inset-*) 恒为 0，父页面的底部安全区传不进来，
   结果内容会被底栏压住一截（尤其带 Home 指示条的机型）。
   同源时从父页面读取实测值，覆盖到本地 --safe-* 变量；
   跨域或读取失败则原样保留 env() 的结果。 */
(function () {
  if (window.self === window.top) return;
  try {
    var pcs = window.parent.getComputedStyle(window.parent.document.documentElement);
    ['top', 'bottom', 'left', 'right'].forEach(function (side) {
      var v = pcs.getPropertyValue('--safe-' + side).trim();
      if (v && v.indexOf('env(') === -1) {
        document.documentElement.style.setProperty('--safe-' + side, v);
      }
    });
  } catch (e) { /* 跨域或父页面未就绪：保留 env() 结果 */ }
})();

/* ===== 液态玻璃：指针跟随高光（纯表现层，与业务/接口无关） =====
   把指针在控件内的相对坐标写入 --mx / --my（px），由 CSS 的
   radial-gradient 渲染出「光随指尖移动」的镜面高光。
   性能约定：
   - 全程只在 document 上挂 1 个 passive 监听（事件委托），不侵入其它逻辑
   - pointermove 只记录坐标，样式写入合并到 requestAnimationFrame，一帧最多一次
   - 只对当前悬停的那 1 个元素写内联变量，不做批量遍历/重排
   - 系统开启「减少透明度」或触屏（无悬停）时不工作，省掉无谓重绘 */
(function () {
  if (!window.matchMedia || !window.requestAnimationFrame) return;
  var SEL = '.btn, .side-link, .tab, .bottom-nav-item, .icon-btn,'
    + '.chip, .pos-chip, .cal-today-btn, .modal-close';
  var FILLED = '.btn-primary, .btn-danger'; // 实心按钮不参与（与 CSS 保持一致，保文字对比度）
  var reduceTrans = window.matchMedia('(prefers-reduced-transparency: reduce)');
  var noHover = window.matchMedia('(hover: none)');
  var target = null, px = 0, py = 0, queued = false;

  function flush() {
    queued = false;
    if (!target || !target.isConnected) return;
    var r = target.getBoundingClientRect();
    target.style.setProperty('--mx', (px - r.left) + 'px');
    target.style.setProperty('--my', (py - r.top) + 'px');
  }

  document.addEventListener('pointermove', function (e) {
    if (e.pointerType === 'touch') return;
    if (document.hidden || reduceTrans.matches || noHover.matches) return;
    var el = e.target instanceof Element ? e.target.closest(SEL) : null;
    if (el && el.matches(FILLED)) el = null;
    target = el;
    if (!el) return;
    px = e.clientX; py = e.clientY;
    if (!queued) { queued = true; requestAnimationFrame(flush); }
  }, { passive: true });
})();
