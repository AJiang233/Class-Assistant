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
  // 前端兜底超时：后端或网络挂起时也能拿到异常回显，而不是无限卡在加载态。
  // providers 若已带 signal（供手动取消复用）则不覆盖。
  const init = options.signal ? options : { ...options, signal: AbortSignal.timeout(30000) };
  let res;
  try {
    res = await fetch(API_BASE + path, { ...init, headers });
  } catch (e) {
    // 超时/断网时 fetch 直接 reject，message 常为空，这里转成可读文案
    const timedOut = !(options.signal) && e && (e.name === 'TimeoutError' || e.name === 'AbortError');
    throw new Error(timedOut ? '请求超时（>30s），请检查网络后重试' : ('网络错误：' + (e.message || '无法连接服务器')));
  }
  const data = await res.json().catch(() => ({}));
  if (!res.ok) {
    // 登录态失效（token 过期/无效）：清除本地会话，回主页引导页
    if (res.status === 401 && token) {
      clearSession();
      redirectToIndex();
    }
    throw new Error(data.error || '请求失败 (' + res.status + ')');
  }
  return data;
}

/** 保存登录会话 */
function saveSession(data) {
  localStorage.setItem(LS_TOKEN, data.token);
  localStorage.setItem(LS_USER, JSON.stringify(data.user || {}));
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

/** 职务字段为 JSON 字符串（如 ["班长","学习委员"]），展示时转为可读文本 */
function fmtPositions(p) {
  if (!p) return '学生';
  const s = String(p);
  if (s.charAt(0) === '[') {
    try { return JSON.parse(s).join('、') || '学生'; } catch { return s; }
  }
  return s;
}

/** 能否发布/取消 通知、活动（权限由后端按职位+自定义职位计算） */
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

/** 清除会话 */
function clearSession() {
  localStorage.removeItem(LS_TOKEN);
  localStorage.removeItem(LS_USER);
}

/** 回到主页引导页（iframe 内则跳外层，避免套娃） */
function redirectToIndex() {
  if (window.self !== window.top) {
    window.top.location.href = 'index.html';
  } else {
    window.location.href = 'index.html';
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

/** 列表状态提示（空数据/错误）：各页面统一渲染 */
function stateHTML(text, isError) {
  var cls = isError ? 'state error' : 'state';
  return '<div class="' + cls + '"><p>' + esc(text || '暂无数据') + '</p></div>';
}

/** 通知来源显示名：手动发布 / 自动拉取 */
function sourceName(s) {
  if (s === 'manual' || !s) return '手动发布';
  return '自动拉取';
}

/** 详情弹窗小图标（14px 描边风格）：统一图标尺寸、线宽与文字基线对齐 */
var DETAIL_ICONS = {
  clock: '<circle cx="12" cy="12" r="10"/><polyline points="12 6 12 12 16 14"/>',
  pin: '<path d="M21 10c0 7-9 13-9 13s-9-6-9-13a9 9 0 0 1 18 0z"/><circle cx="12" cy="10" r="3"/>',
  user: '<path d="M20 21v-2a4 4 0 0 0-4-4H8a4 4 0 0 0-4 4v2"/><circle cx="12" cy="7" r="4"/>',
  bell: '<path d="M18 8A6 6 0 0 0 6 8c0 7-3 9-3 9h18s-3-2-3-9"/><path d="M13.73 21a2 2 0 0 1-3.46 0"/>',
  calendar: '<rect x="3" y="4" width="18" height="18" rx="2"/><line x1="16" y1="2" x2="16" y2="6"/><line x1="8" y1="2" x2="8" y2="6"/><line x1="3" y1="10" x2="21" y2="10"/>'
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
