// ===== 日历状态变量（提前声明，避免初始化时因 var 提升导致 eventDates 为 undefined 而崩溃） =====
var calYear, calMonth;
var eventDates = new Set();
var noticeDates = new Set();
var activeDate = null;

// 视图 → iframe 映射。switchView / slideShownView 在下面的初始化里就要读它，
// 所以必须声明在初始化之前：靠 var 提升拿到的是 undefined，会导致 ?view=xxx 抛错、白屏。
var FRAME_KEYS = { academic: 'frameAcademic', activities: 'frameActivities', notices: 'frameNotices', account: 'frameAccount', admin: 'frameAdmin' };

// ===== 初始化 =====
(function () {
    var authed = !!localStorage.getItem(LS_TOKEN);
    var user = getSession();
    document.body.classList.add('app-mode');
    var sb = document.getElementById('sidebar');
    try { if (localStorage.getItem('sidebarCollapsed') === '1') sb.classList.add('collapsed'); } catch (e) {}
    bindAppThemeToggle();
    fillAuthArea(authed, user);
    // 有发布权限或成员管理权限者可见"管理员"入口（仅侧边栏；手机端底栏不放，改由个人中心进入）
    if (canManagePanel()) {
        document.getElementById('navAdmin').hidden = false;
    }
    if (authed) {
        loadCalendar().then(function () {
            // 默认选中今天，加载今日活动与通知
            if (!activeDate) activeDate = todayKey();
            refreshDay();
        }).catch(function (e) {
            // 日历自己出错不该变成未处理的 rejection：当日列表各有各的错误态，这里只留痕
            console.warn('日历加载失败：', e);
        });
    } else {
        // 未登录：主页只显示框架，不加载活动
        var now = new Date();
        calYear = now.getFullYear();
        calMonth = now.getMonth();
        renderCalendar();
        document.getElementById('noticeList').innerHTML = stateHTML('登录后查看班级通知');
        document.getElementById('activityList').innerHTML = stateHTML('登录后查看班级活动');
        document.getElementById('formList').innerHTML = stateHTML('登录后查看表单');
    }
    // 支持 ?view=xxx 直达（App 内绑定教务系统后会跳回课表页）
    var target = 'home';
    var deepId = '';
    try {
        var params = new URLSearchParams(window.location.search);
        var v = params.get('view');
        if (v && ['academic', 'activities', 'notices', 'account', 'admin'].indexOf(v) >= 0) target = v;
        deepId = params.get('id') || '';
    } catch (e) {}
    // ?view=notices&id=123 深链（App 点提醒会带过来）：先把 iframe 的 src 指到带 id 的地址，
    // 再切视图；标记 data-loaded 是为了让 switchView 不要再覆盖 src。子页自己读 ?id= 开详情。
    if (authed && deepId && (target === 'notices' || target === 'activities')) {
        var deepFrame = document.getElementById(FRAME_KEYS[target]);
        deepFrame.src = target + '.html?id=' + encodeURIComponent(deepId);
        deepFrame.setAttribute('data-loaded', '1');
    }
    switchView(target);
})();

// 侧边栏底部用户区：未登录=登录按钮，已登录=头像+名字+学号（仅展示，不可点击）
function fillAuthArea(authed, user) {
    var area = document.getElementById('authArea');
    if (authed) {
        area.innerHTML =
            '<div class="sidebar-user" id="userEntry">'
            + '<span class="user-avatar">' + esc((user && user.name) ? user.name.charAt(0) : '?') + '</span>'
            + '<span class="user-info">'
            + '<span class="user-name">' + esc((user && user.name) || '同学') + '</span>'
            + '<span class="user-sub">' + esc(user && user.student_id ? user.student_id : '') + '</span>'
            + '</span>'
            + '</div>';
        // 填了 QQ 邮箱就换成 WeAvatar 头像（不是 QQ 邮箱、或取不到头像都保持上面的首字母）。
        // 这里读的是登录时缓存的会话，所以在个人页刚填好邮箱的话，要等下次加载本页才换过来。
        applyEmailAvatar(area.querySelector('.user-avatar'), user && user.email, 68);
    } else {
        area.innerHTML = '<button type="button" class="btn btn-primary" data-view="login">登录</button>';
    }
}

// ===== 侧边栏折叠 =====
function toggleSidebar() {
    var sb = document.getElementById('sidebar');
    var collapsed = sb.classList.toggle('collapsed');
    try { localStorage.setItem('sidebarCollapsed', collapsed ? '1' : '0'); } catch (e) {}
}

// 应用壳内主题切换（侧栏 / 底部导航共用）
function toggleTheme() {
    var root = document.documentElement;
    var next = root.getAttribute('data-theme') === 'dark' ? 'light' : 'dark';
    root.setAttribute('data-theme', next);
    try { localStorage.setItem('theme', next); } catch (e) {}
    // 同标签页里写 localStorage 不会触发 storage 事件（它只发给别的文档），而 theme.js 的
    // apply()（含 theme-color meta 同步，Safari 顶部工具栏读它）只在 storage / 系统变化时
    // 重跑 —— 这里补一发，让工具栏跟着站内主题变（issue #84 项 2）。
    try { window.dispatchEvent(new StorageEvent('storage', { key: 'theme' })); } catch (e) {}
}
function bindAppThemeToggle() {
    var btn = document.getElementById('appThemeToggle');
    if (!btn) return;
    btn.addEventListener('click', toggleTheme);
}

// ===== 视图切换 =====
var currentView = 'home';   // 当前视图（供移动端左右滑动判断相邻页）
function switchView(key, slideDir) {
    var authed = !!localStorage.getItem(LS_TOKEN);
    // 未登录访问受保护视图 → 显示登录视图
    if (!authed && key !== 'home' && key !== 'login') key = 'login';
    currentView = key;
    // 当前应高亮的导航项：未登录显示登录视图时，"个人中心"保持高亮
    var navKey = key === 'login' ? 'account' : key;
    // 侧边栏 active 状态
    ['home', 'academic', 'activities', 'notices', 'account', 'admin'].forEach(function (k) {
        var el = document.getElementById('nav' + k.charAt(0).toUpperCase() + k.slice(1));
        if (el) el.classList.toggle('active', k === navKey);
    });
    // 移动端底部导航 active 状态（管理员面板由个人中心进入，高亮留在"个人中心"）
    var mobileKey = navKey === 'admin' ? 'account' : navKey;
    var mItems = document.querySelectorAll('.bottom-nav-item');
    for (var mi = 0; mi < mItems.length; mi++) {
        mItems[mi].classList.toggle('active', mItems[mi].getAttribute('data-nav') === mobileKey);
    }
    moveBottomNavPill();
    // 显示对应视图（隐藏/显示统一走 hidden 属性，样式在 style.css 的 [hidden] 规则里）
    var isHome = key === 'home';
    var isLogin = key === 'login';
    document.getElementById('homeView').hidden = !isHome;
    document.getElementById('loginView').hidden = !isLogin;
    for (var fk in FRAME_KEYS) {
        var f = document.getElementById(FRAME_KEYS[fk]);
        var show = !isHome && !isLogin && fk === key;
        f.hidden = !show;
        if (show && f.getAttribute('data-loaded') !== '1') {
            f.src = fk + '.html';
            f.setAttribute('data-loaded', '1');
        }
        // iframe 内的触摸不会冒泡到主壳，同源下挂到其文档上才能收到手势
        if (show && f.getAttribute('data-swipe') !== '1') {
            f.setAttribute('data-swipe', '1');
            f.addEventListener('load', function () { bindFrameSwipe(this); });
        }
    }
    if (isHome) {
        document.getElementById('homeView').scrollTop = 0;
        // 问候语每次切回主页都重算：安卓壳里的 WebView 会常驻过夜，切回来时不该还挂着「早上好」
        // （不做定时器 —— 停在主页不动时文案不会自己变，这个代价比常驻一个 interval 划算）
        renderGreeting();
    }
    slideShownView(isHome, isLogin, key, slideDir);
}

// ===== 主页欢迎文案（文案表见 app.js 的 GREETING_BANDS）=====
/** 把当下时段对应的问候填进主页那两行。切到主页视图时由 switchView 调用，
 *  首屏（switchView('home')）也走这条路径，不需要在初始化里另调一次。 */
function renderGreeting() {
    var g = greetingFor(beijingHour());
    document.getElementById('homeTitle').textContent = g.title;
    document.getElementById('homeDesc').textContent = g.desc;
}

// ===== 移动端左右滑动切页 =====
// 顺序与底部导航一致。教务页（课表）同样可划入划出：课表的横向滚动
// 由 isHorizontallyScrollable 单独让位，不需要在页级再拦一道。
var SWIPE_PAGES = ['home', 'notices', 'activities', 'academic', 'account'];
var SWIPE_THRESHOLD = 35;
// 屏幕左缘约 20px 是 iOS 系统「返回上一层」手势的判定区。
// 我们的监听是 passive 的、无法 preventDefault，若不在起点就放手，
// 从该区域右滑会同时触发系统返回与本应用的上一页，导致一次手势跳两级。
var SWIPE_EDGE_GUARD = 20;
var swipeMq = window.matchMedia('(max-width: 768px), (max-height: 500px) and (pointer: coarse)');

/** 手指起点是否落在可横向滚动的区域（如课表）——是则本次手势不切页，交给滚动 */
function isHorizontallyScrollable(el, win) {
    var doc = win.document;
    while (el && el.nodeType === 1 && el !== doc.body && el !== doc.documentElement) {
        var ox = win.getComputedStyle(el).overflowX;
        if ((ox === 'auto' || ox === 'scroll') && el.scrollWidth > el.clientWidth + 2) return true;
        el = el.parentElement;
    }
    return false;
}

function swipeTo(dir) {
    var i = SWIPE_PAGES.indexOf(currentView);
    if (i < 0) return;
    var j = i + dir;
    if (j < 0 || j >= SWIPE_PAGES.length) return;   // 两端停住，不循环
    switchView(SWIPE_PAGES[j], dir);
}

/** 给一个文档（主壳或同源 iframe 内文档）挂横向滑动监听；只监听不拦截，滚动不受影响 */
function bindSwipe(doc, win) {
    if (!doc || doc.__swipeBound) return;
    doc.__swipeBound = true;
    var startX = 0, startY = 0, tracking = false;
    doc.addEventListener('touchstart', function (e) {
        tracking = false;
        if (!swipeMq.matches || e.touches.length !== 1) return;
        // 主壳里落在 iframe 上的触摸由 iframe 自己处理，避免重复切页
        if (win === window && e.target && e.target.tagName === 'IFRAME') return;
        var t = e.touches[0];
        // 左缘判定区留给系统手势。移动端布局下侧栏已隐藏、iframe 占满整宽，
        // 所以这里的 clientX 就等同于屏幕横向位置（无需再补 iframe 偏移）。
        if (t.clientX <= SWIPE_EDGE_GUARD) return;
        startX = t.clientX; startY = t.clientY;
        tracking = !isHorizontallyScrollable(e.target, win);
    }, { passive: true });
    doc.addEventListener('touchend', function (e) {
        if (!tracking || e.changedTouches.length !== 1) return;
        tracking = false;
        var t = e.changedTouches[0];
        var dx = t.clientX - startX, dy = t.clientY - startY;
        if (Math.abs(dx) < SWIPE_THRESHOLD || Math.abs(dx) < Math.abs(dy) * 1.5) return;
        swipeTo(dx < 0 ? 1 : -1);
    }, { passive: true });
    // 系统手势/来电等打断时收尾，避免 tracking 与起点坐标残留到下一次手势
    doc.addEventListener('touchcancel', function () { tracking = false; }, { passive: true });
}

function bindFrameSwipe(frame) {
    try { bindSwipe(frame.contentDocument, frame.contentWindow); } catch (e) {}
}

/** 切页入场：手势切页时新视图从对应一侧滑入；非手势切换则清掉残留类，保持原淡入 */
function slideShownView(isHome, isLogin, key, dir) {
    var el = isHome ? document.getElementById('homeView')
        : (isLogin ? document.getElementById('loginView') : document.getElementById(FRAME_KEYS[key]));
    if (!el) return;
    el.classList.remove('slide-in-next', 'slide-in-prev');
    if (!dir) return;
    void el.offsetWidth;   // 强制回流，确保动画重放
    el.classList.add(dir > 0 ? 'slide-in-next' : 'slide-in-prev');
}

bindSwipe(document, window);

// ===== 移动端底部导航：胶囊滑块平滑移动到当前激活项 =====
function moveBottomNavPill() {
    var pill = document.getElementById('bottomNavPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.bottom-nav-item.active');
    if (!active) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.opacity = '1';
}
// 小屏首次进入时也要定位滑块（默认激活项）
(function () {
    var pill = document.getElementById('bottomNavPill');
    if (pill) { setTimeout(moveBottomNavPill, 0); }
})();

// ===== 输入法弹出时收起底栏 =====
// Android 键盘弹出会压缩视口，position:fixed 的底栏会被顶到键盘上方。
// 这里以「视口高度相对基线明显变矮」判定键盘弹出，把底栏滑下去。
(function () {
    var nav = document.getElementById('bottomNav');
    if (!nav) return;
    var vv = window.visualViewport;
    var baseH = 0, baseW = 0;
    function sync() {
        var h = vv ? vv.height : window.innerHeight;
        var w = vv ? vv.width : window.innerWidth;
        if (w !== baseW) { baseW = w; baseH = h; }   // 横竖屏切换 → 重置基线
        else if (h > baseH) { baseH = h; }            // 记录键盘收起时的高度
        nav.classList.toggle('kb-hidden', (baseH - h) > 140);
    }
    sync();
    if (vv) vv.addEventListener('resize', sync);
    window.addEventListener('resize', sync);
    window.addEventListener('orientationchange', function () { baseW = 0; setTimeout(sync, 250); });
})();

// ===== 日历 =====
// 逐天展开的上限：起止时间来自自由填写（截止时间允许填到 9999 年），
// 不设上限时一个远期 expire_time 就是几百万次循环，主页主线程直接卡死
var EXPAND_MAX_DAYS = 366 * 5;

async function loadCalendar() {
    // 把 [开始日, 结束日] 逐天展开进集合（按天、两端都含；结束为空或早于开始时按单日）
    function expand(set, rawStart, rawEnd) {
        var s = String(rawStart || '').slice(0, 10);
        if (!s) return;
        var e = String(rawEnd || '').slice(0, 10);
        if (!e || e < s) e = s;
        var cur = new Date(s + 'T00:00:00');
        var end = new Date(e + 'T00:00:00');
        // 超出上限只标到上限那天为止：再远的月份事实上也翻不到，但循环次数必须有界
        if (isNaN(cur.getTime()) || isNaN(end.getTime())) return;
        if ((end - cur) / 86400000 > EXPAND_MAX_DAYS) {
            end = new Date(cur.getTime() + EXPAND_MAX_DAYS * 86400000);
        }
        while (cur <= end) {
            set.add(dateKey(cur.getFullYear(), cur.getMonth(), cur.getDate()));
            cur.setDate(cur.getDate() + 1);
        }
    }
    // 先清再做：失败时旧标记不得残留（issue #84 项 7）—— 否则加载失败后日历上还挂着
    // 上一轮的圆点，用户会以为那些日子今天真有活动
    eventDates.clear();
    try {
        var res = await api('/api/activities?scope=all&limit=200');
        var list = (res.data && res.data.list) || [];
        // 只标「提醒当前账户（含全班）」的日子，与当日列表口径一致
        list.filter(function (a) { return remindMe(a.remind_people); })
            .forEach(function (a) { expand(eventDates, a.start_time, a.end_time); });
    } catch (e) {}
    noticeDates.clear();
    try {
        var nres = await api('/api/notices?scope=all&limit=200');
        var nlist = (nres.data && nres.data.list) || [];
        nlist.filter(function (n) { return remindMe(n.remind_people); })
            .forEach(function (n) { expand(noticeDates, n.publish_time, n.expire_time); });
    } catch (e) {}
    var now = new Date();
    calYear = now.getFullYear();
    calMonth = now.getMonth();
    renderCalendar();
}

function pad2(n) { return n < 10 ? '0' + n : '' + n; }
function dateKey(y, m, d) { return y + '-' + pad2(m + 1) + '-' + pad2(d); }
function todayKey() { var t = new Date(); return dateKey(t.getFullYear(), t.getMonth(), t.getDate()); }

function renderCalendar() {
    document.getElementById('calTitle').textContent = calYear + ' 年 ' + (calMonth + 1) + ' 月';
    var first = new Date(calYear, calMonth, 1);
    var start = (first.getDay() + 6) % 7; // 周一开头
    var days = new Date(calYear, calMonth + 1, 0).getDate();
    var prevDays = new Date(calYear, calMonth, 0).getDate();
    var today = todayKey();
    var html = '';
    for (var i = 0; i < 42; i++) {
        var n = i - start + 1;
        var y = calYear, m = calMonth, other = false;
        if (n < 1) { other = true; m = calMonth - 1; n = prevDays + n; }
        else if (n > days) { other = true; m = calMonth + 1; n = n - days; }
        if (m < 0) { m = 11; y = calYear - 1; }
        if (m > 11) { m = 0; y = calYear + 1; }
        var k = dateKey(y, m, n);
        var cls = 'cal-day' + (other ? ' other' : '') + ((eventDates.has(k) || noticeDates.has(k)) ? ' has-event' : '') + (k === today ? ' today' : '') + (k === activeDate ? ' active' : '');
        var dateAttr = ' data-date="' + k + '"';
        html += '<div class="' + cls + '"' + dateAttr + '>' + n + '</div>';
    }
    document.getElementById('calGrid').innerHTML = html;
}

function selectDate(k) {
    activeDate = k;
    // 若点击的是相邻月日期，日历跳转到该日期所在月份
    var parts = k.split('-');
    var y = parseInt(parts[0]), m = parseInt(parts[1]) - 1;
    if (y !== calYear || m !== calMonth) { calYear = y; calMonth = m; }
    renderCalendar();
    refreshDay();
}
function calPrev() { calMonth--; if (calMonth < 0) { calMonth = 11; calYear--; } renderCalendar(); }
function calNext() { calMonth++; if (calMonth > 11) { calMonth = 0; calYear++; } renderCalendar(); }
function calToday() {
    var t = new Date();
    calYear = t.getFullYear();
    calMonth = t.getMonth();
    activeDate = todayKey();
    refreshDay();
}

// 今日/某日期格式化标题
function dayTitle(k) {
    if (!k) return '今日活动';
    var t = todayKey();
    if (k === t) return '今日活动';
    var p = k.split('-');
    return parseInt(p[1]) + ' 月 ' + parseInt(p[2]) + ' 日 · 活动';
}
function dayNoticeTitle(k) {
    if (!k) return '当前通知';
    var t = todayKey();
    if (k === t) return '今日通知';
    var p = k.split('-');
    return parseInt(p[1]) + ' 月 ' + parseInt(p[2]) + ' 日 · 通知';
}

// ===== 加载指定日期活动/通知（默认今天） =====
function refreshDay() {
    if (!activeDate) activeDate = todayKey();
    document.getElementById('scheduleDateTitle').textContent = dayTitle(activeDate);
    document.getElementById('noticeDateTitle').textContent = dayNoticeTitle(activeDate);
    renderCalendar();
    loadActivities(activeDate);
    loadNotices(activeDate);
    loadForms();
}

// 当前账户是否在提醒名单内：remind_people 为空视为「全班」（提醒所有人）
function remindMe(raw) {
    if (!raw) return true;
    var s = String(raw).trim();
    var arr;
    if (s.charAt(0) === '[') {
        try { var parsed = JSON.parse(s); if (Array.isArray(parsed)) arr = parsed; } catch (e) { return true; }
    } else {
        arr = s.split(',');
    }
    arr = (arr || []).map(function (x) { return String(x).trim(); }).filter(Boolean);
    if (!arr.length) return true;
    var u = getSession();
    var meName = (u && u.name) ? String(u.name) : '';
    var meId = (u && u.id != null) ? String(u.id) : '';
    return (meName !== '' && arr.indexOf(meName) >= 0) || (meId !== '' && arr.indexOf(meId) >= 0);
}

async function loadNotices(date) {
    var el = document.getElementById('noticeList');
    el.innerHTML = skeletonHTML(3);
    var key = '/api/notices?limit=50' + (date ? '&date=' + encodeURIComponent(date) : '');
    var render = function (data) { renderNotices(date, (data && data.list) || []); };
    // App 壳：原生层先给缓存、后台刷新完把新数据推回这个键上（网页版注册了也不会被调用）
    onApiData(key, render);
    try {
        var res = await api(key);
        render(res.data || {});
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/**
 * 当日通知列表渲染。首次加载与「原生后台刷新推回」共用它。
 * 先按下 `activeDate` 对一遍：用户切到别的日期后，早先那次请求的刷新结果不该再盖上来。
 */
function renderNotices(date, list) {
    if (date && activeDate !== date) return;
    var el = document.getElementById('noticeList');
    // 主页展示提醒当前账户（含「全班」）的通知，当天全部（不限条数）
    list = list.filter(function (n) { return remindMe(n.remind_people); });
    if (!list.length) { el.innerHTML = stateHTML('暂无提醒你的通知'); return; }
    list.sort(function (a, b) { return String(b.publish_time || '').localeCompare(String(a.publish_time || '')); });
    el.innerHTML = list.map(function (n) {
        var pub = n.publisher ? '<span>' + icon('user') + esc(n.publisher) + '</span>' : '';
        var formBadge = n.link ? '<span class="badge badge-form">表单</span>' : '';
        return '<button type="button" class="list-row" data-act="notice-detail" data-id="' + escAttr(n.id) + '">'
            + '<div class="list-row-main">'
            + '<div class="list-row-title">'
            + '<span class="list-row-name">' + esc(n.title) + '</span>'
            + '<span class="badge badge-' + escAttr(n.source || 'manual') + '">' + esc(sourceName(n.source)) + '</span>'
            + formBadge
            + '</div>'
            + '<div class="list-row-meta">'
            + pub
            + '<span>' + icon('clock') + esc(fmtDate(n.publish_time)) + '</span>'
            + '</div>'
            + '</div>'
            + '<svg class="list-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
            + '</button>';
    }).join('');
}

// ===== 我的表单（首页待办；含待填与已提交，没有独立导航入口，靠这里与通知里的按钮进入） =====
async function loadForms() {
    var el = document.getElementById('formList');
    el.innerHTML = skeletonHTML(2);
    try {
        var res = await api('/api/forms/mine');
        var pending = (res.data && res.data.pending) || [];
        var editable = (res.data && res.data.editable) || [];
        if (!pending.length && !editable.length) { el.innerHTML = stateHTML('暂无表单'); return; }
        el.innerHTML = pending.map(function (f) { return formRowHTML(f, false); }).join('')
            + editable.map(function (f) { return formRowHTML(f, true); }).join('');
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/** 编辑策略 → 徽章文案，与管理端「编辑方式」下拉的三个选项逐字一致 */
var EDIT_POLICY_LABEL = {
    always: '随时可修改',
    before_deadline: '截止前可修改',
    none: '提交后不可修改'
};

/** 表单待办条目：第一个徽章写填写状态，第二个写编辑策略 */
function formRowHTML(f, submitted) {
    var meta = '';
    if (f.deadline) meta += '<span>' + icon('clock') + esc(fmtDate(f.deadline)) + '</span>';
    if (f.creator_name) meta += '<span>' + icon('user') + esc(f.creator_name) + '</span>';
    var stateBadge = submitted
        ? '<span class="badge badge-manual">已提交</span>'
        : '<span class="badge badge-form">待填写</span>';
    // 映射表命中才渲染：后端将来加了新策略而这里没跟上时，宁可不显示，也别露出英文原值
    var policy = EDIT_POLICY_LABEL[f.edit_policy];
    var policyBadge = policy ? '<span class="badge badge-policy">' + esc(policy) + '</span>' : '';
    return '<a class="list-row" href="forms.html?id=' + encodeURIComponent(f.id) + '">'
        + '<div class="list-row-main">'
        + '<div class="list-row-title">'
        + '<span class="list-row-name">' + esc(f.title) + '</span>'
        + stateBadge
        + policyBadge
        + '</div>'
        + '<div class="list-row-meta">' + meta + '</div>'
        + '</div>'
        + '<svg class="list-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
        + '</a>';
}

async function loadActivities(date) {
    var el = document.getElementById('activityList');
    el.innerHTML = skeletonHTML(3);
    var key = '/api/activities' + (date ? '?date=' + encodeURIComponent(date) + '&limit=50' : '?limit=50');
    var render = function (data) { renderActivities(date, (data && data.list) || []); };
    // App 壳：原生层先给缓存、后台刷新完把新数据推回这个键上（网页版注册了也不会被调用）
    onApiData(key, render);
    try {
        var res = await api(key);
        render(res.data || {});
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/** 当日活动列表渲染。同 renderNotices：切了日期之后，早先那次请求的刷新结果不该再盖上来 */
function renderActivities(date, list) {
    if (date && activeDate !== date) return;
    var el = document.getElementById('activityList');
    // 主页展示提醒当前账户（含「全班」）的活动，当天全部（不限条数）
    list = list.filter(function (a) { return remindMe(a.remind_people); });
    if (!list.length) { el.innerHTML = stateHTML('暂无提醒你的活动'); return; }
    list.sort(function (a, b) { return String(b.start_time || '').localeCompare(String(a.start_time || '')); });
    el.innerHTML = list.map(function (a) {
        var meta = '<span>' + icon('clock') + esc(fmtDate(a.start_time)) + '</span>';
        if (a.location) meta += '<span>' + icon('pin') + esc(a.location) + '</span>';
        return '<button type="button" class="list-row" data-act="activity-detail" data-id="' + escAttr(a.id) + '">'
            + '<div class="list-row-main">'
            + '<div class="list-row-title"><span class="list-row-name">' + esc(a.title) + '</span></div>'
            + '<div class="list-row-meta">' + meta + '</div>'
            + '</div>'
            + '<svg class="list-row-arrow" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="9 18 15 12 9 6"/></svg>'
            + '</button>';
    }).join('');
}

// ===== 详情弹窗（点击"当日活动/当日通知"行弹出） =====
function openDetail() {
    var ov = document.getElementById('detailModal');
    if (ov) ov.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeDetail() {
    var ov = document.getElementById('detailModal');
    if (ov) ov.classList.remove('show');
    document.body.style.overflow = '';
}
(function () {
    var ov = document.getElementById('detailModal');
    if (!ov) return;
    // 点遮罩空白处关闭
    ov.addEventListener('click', function (e) { if (e.target === ov) closeDetail(); });
    // ESC 关闭
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && ov.classList.contains('show')) closeDetail();
    });
})();

async function showDetail(id) {
    var card = document.getElementById('detailCard');
    document.getElementById('detailModalTitle').textContent = '活动详情';
    card.innerHTML = stateHTML('正在加载…', false, 'clock');
    openDetail();
    try {
        var res = await api('/api/activities/' + id);
        var a = res.data;
        var meta = '<span>' + icon('clock') + '开始 ' + esc(fmtDate(a.start_time)) + '</span>'
            + '<span>' + icon('clock') + '结束 ' + esc(fmtDate(a.end_time)) + '</span>';
        if (a.location) meta += '<span>' + icon('pin') + esc(a.location) + '</span>';
        var byline = '<div class="detail-byline"><span>' + icon('user') + '发布人 ' + esc(a.publisher || '未知') + '</span></div>';
        var remind = fmtRemind(a.remind_people);
        var remindLine = remind ? '<div class="detail-remind"><span>' + icon('bell') + '提醒对象 ' + esc(remind) + '</span></div>' : '';
        card.innerHTML =
            '<div class="detail-head"><div class="detail-title">' + esc(a.title) + '</div></div>'
            + '<div class="detail-meta">' + meta + '</div>'
            + '<div class="detail-body">' + esc(a.content || '暂无活动说明') + '</div>'
            + byline
            + remindLine;
    } catch (err) {
        card.innerHTML = stateHTML(err.message, true);
    }
}

async function showNoticeDetail(id) {
    var card = document.getElementById('detailCard');
    document.getElementById('detailModalTitle').textContent = '通知详情';
    card.innerHTML = stateHTML('正在加载…', false, 'clock');
    openDetail();
    try {
        var res = await api('/api/notices/' + id);
        var n = res.data;
        var badge = '<span class="badge badge-' + escAttr(n.source || 'manual') + '">' + esc(sourceName(n.source)) + '</span>'
            + (n.link ? '<span class="badge badge-form">表单</span>' : '');
        var meta = '<span>' + icon('clock') + '发布 ' + esc(fmtDate(n.publish_time)) + '</span>';
        if (n.expire_time) meta += '<span>' + icon('clock') + '截止 ' + esc(fmtDate(n.expire_time)) + '</span>';
        var byline = '<div class="detail-byline"><span>' + icon('user') + '发布人 ' + esc(n.publisher || '未知') + '</span></div>';
        var remind = fmtRemind(n.remind_people);
        var remindLine = remind ? '<div class="detail-remind"><span>' + icon('bell') + '提醒对象 ' + esc(remind) + '</span></div>' : '';
        card.innerHTML =
            '<div class="detail-head"><div class="detail-title">' + esc(n.title) + '</div>' + badge + '</div>'
            + '<div class="detail-meta">' + meta + '</div>'
            + '<div class="detail-body">' + esc(n.content || '暂无通知内容') + '</div>'
            + byline
            + remindLine
            + (n.link ? '<a class="btn btn-primary btn-block mt-12" href="' + escAttr(safeHref(n.link)) + '">去填写</a>' : '');
    } catch (err) {
        card.innerHTML = stateHTML(err.message, true);
    }
}

// ===== 登录（应用壳内） =====
var loginForm = document.getElementById('loginForm');
if (loginForm) {
    loginForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var errBox = document.getElementById('loginError');
        errBox.classList.remove('show');
        var student_id = document.getElementById('loginStudentId').value.trim();
        var password = document.getElementById('loginPassword').value;
        if (!student_id || !password) {
            errBox.textContent = '请填写学号和密码';
            errBox.classList.add('show');
            return;
        }
        var btn = document.getElementById('loginBtn');
        btn.disabled = true; btn.textContent = '登录中…';
        try {
            var res = await api('/api/auth/login', { method: 'POST', body: JSON.stringify({ student_id: student_id, password: password }) });
            saveSession(res.data);
            window.location.reload(); // 重载后进入已登录状态
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.add('show');
        } finally {
            btn.disabled = false; btn.textContent = '登录';
        }
    });
}

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 带参数的（视图名、日期、条目 id）统一用 data-* 标记 + 委托，无参数的按 id 直接绑。
delegate(document, 'click', '[data-view]', function (el) { switchView(el.getAttribute('data-view')); });
delegate(document, 'click', '[data-date]', function (el) { selectDate(el.getAttribute('data-date')); });
delegate(document, 'click', '[data-act="cal-today"]', function () { calToday(); });
delegate(document, 'click', '[data-act="cal-prev"]', function () { calPrev(); });
delegate(document, 'click', '[data-act="cal-next"]', function () { calNext(); });
delegate(document, 'click', '[data-act="close-detail"]', function () { closeDetail(); });
delegate(document, 'click', '[data-act="notice-detail"]', function (el) { showNoticeDetail(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="activity-detail"]', function (el) { showDetail(el.getAttribute('data-id')); });
// 空值守卫：id 漂移时别让这一句在加载期抛错（issue #84 项 6）
var collapseBtn = document.getElementById('collapseBtn');
if (collapseBtn) collapseBtn.addEventListener('click', toggleSidebar);
