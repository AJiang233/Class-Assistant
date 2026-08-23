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
  const res = await fetch(API_BASE + path, { ...options, headers });
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

/** 空态占位 */
function emptyHTML(text) {
  return '<div class="state empty-state">'
    + '<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.5" stroke-linecap="round" stroke-linejoin="round"><path d="M21 15a2 2 0 0 1-2 2H7l-4 4V5a2 2 0 0 1 2-2h14a2 2 0 0 1 2 2z"/></svg>'
    + '<p>' + esc(text || '暂无数据') + '</p></div>';
}

/** 错误占位 */
function errorHTML(msg) {
  return '<div class="state error-msg"><p>' + esc(msg || '加载失败') + '</p></div>';
}

// ===== 导航栏滚动效果（滚动超过 40px 加深底色） =====
(function () {
  var nav = document.getElementById('navbar');
  if (!nav) return;
  function onScroll() { nav.classList.toggle('scrolled', window.scrollY > 40); }
  onScroll();
  window.addEventListener('scroll', onScroll, { passive: true });
})();
