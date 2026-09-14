// ===== 状态 =====
// 注意：这个变量不能叫 status —— window.status 是遗留的 DOMString 属性，
// 顶层 var 会被它接管，赋对象会被强制转成 "[object Object]"，导致 bound 恒为 undefined
var bindStatus = null;      // /api/academic/status 返回
var timetable = null;       // 课表数据
var credits = null;         // 学分数据
var activeTerm = '';        // 当前选中的学期

// 上次看的学期：退出重进沿用（把选过的学期带回去问后端；那个学期已不在教务列表里时，
// 后端会回落到按日期推算的当前学期，返回的 xnxqId 又会把这里覆盖掉）
var TERM_KEY = 'ca_term';
function savedTerm() {
    try { return localStorage.getItem(TERM_KEY) || ''; } catch (e) { return ''; }
}
function rememberTerm(id) {
    try { if (id) localStorage.setItem(TERM_KEY, id); } catch (e) {}
}

var WEEKDAY_NAMES = ['周一', '周二', '周三', '周四', '周五', '周六', '周日'];

(function init() {
    // 全局兜底：任何未捕获异常都不再静默卡骨架屏，直接显示在加载区
    window.addEventListener('error', function (e) {
        var lv = document.getElementById('loadingView');
        if (lv && !lv.hidden) {
            lv.innerHTML = stateHTML('脚本错误：' + (e.message || '未知错误'), true);
        }
    });
    window.addEventListener('unhandledrejection', function (e) {
        var lv = document.getElementById('loadingView');
        var msg = e && e.reason && e.reason.message ? e.reason.message : String(e.reason || '未知错误');
        if (lv && !lv.hidden) {
            lv.innerHTML = stateHTML('加载失败：' + msg, true);
        }
    });
    try {
        if (!requireAuth()) return;
        var me = getSession();
        if (me && me.student_id) {
            document.getElementById('acStudentId').value = me.student_id;
        }
        // App 内才有 JS 桥；有桥才显示「一键绑定」
        if (window.CAHost && typeof CAHost.startAcademicLogin === 'function') {
            document.getElementById('appBindBox').hidden = false;
            document.getElementById('appBindBtn').addEventListener('click', function () {
                try { CAHost.startAcademicLogin(); } catch (e) {}
            });
        }
        document.getElementById('bindBtn').addEventListener('click', doBind);
        document.getElementById('pwdLoginBtn').addEventListener('click', doPasswordLogin);
        document.getElementById('mfaSendBtn').addEventListener('click', doMfaSend);
        document.getElementById('mfaVerifyBtn').addEventListener('click', doMfaVerify);
        document.getElementById('mfaBackBtn').addEventListener('click', function () {
            mfaToken = '';
            document.getElementById('mfaStep').hidden = true;
            document.getElementById('pwdStep').hidden = false;
        });
        document.getElementById('mfaCode').addEventListener('keydown', function (e) {
            if (e.key === 'Enter') doMfaVerify();
        });
        document.getElementById('unbindBtn').addEventListener('click', doUnbind);
        document.getElementById('refreshBtn').addEventListener('click', function () {
            loadTimetable(activeTerm, true);
            loadCredits(true);
        });
        document.getElementById('termSelect').addEventListener('change', function () {
            loadTimetable(this.value, false);
        });
        initAcSeg();
        loadStatus();
    } catch (e) {
        var lv = document.getElementById('loadingView');
        if (lv) lv.innerHTML = stateHTML('页面初始化失败：' + (e.message || e), true);
    }
})();

// ===== 绑定状态 =====
function setLoadingTip(text) {
    var tip = document.getElementById('loadingTip');
    if (tip) tip.textContent = text;
}
async function loadStatus() {
    setLoadingTip('正在查询教务绑定状态…');
    try {
        var res = await api('/api/academic/status');
        bindStatus = res.data || {};
    } catch (err) {
        showOnly('bindView');
        showFormError('bindError', err.message);
        return;
    }
    if (!bindStatus.bound) { showOnly('bindView'); return; }
    setLoadingTip('已绑定，正在拉取课表与学分…');
    showOnly('dataView');
    // 分段控件在隐藏状态下量不到尺寸（滑块宽高为 0），显示出来后补量一次
    moveAcSegPill();
    // 不再因为 status=expired 就在这里拉红横幅「请重新绑定」：课表接口会把上次的缓存
    // 给回来，提示交给 loadTimetable 按「为什么给的是缓存」出一行小字（见 cacheHintText）。
    // 否则用户还没看到课表，就先被告知「出事了、去重新绑定」。
    loadTimetable(savedTerm(), false);
    loadCredits(false);
}

/** 三个面板只留一个（默认都靠 hidden 属性切换，样式在 style.css 的 [hidden] 里） */
function showOnly(id) {
    ['loadingView', 'bindView', 'dataView'].forEach(function (k) {
        var el = document.getElementById(k);
        if (el) el.hidden = k !== id;
    });
}

/**
 * 从粘贴内容里提取 Cookie：支持裸 Cookie 串、`Cookie: ...` 整行、整段 cURL
 */
function extractCookie(text) {
    var raw = String(text || '').replace(/\r/g, '').trim();
    if (!raw) return '';
    var m = raw.match(/(?:-H|--header)\s+['"]Cookie:\s*([^'"]+)['"]/i)
        || raw.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/i);
    if (m) return m[1].trim();
    m = raw.match(/^\s*cookie:\s*(.+)$/im);
    if (m) return m[1].trim();
    return raw;
}

var mfaToken = '';
var mfaTimer = null;

/** 路径一 · 第一步：学号 + 密码，后端代登录统一身份认证 */
async function doPasswordLogin() {
    var studentId = document.getElementById('acStudentId').value.trim();
    var password = document.getElementById('acPassword').value;
    if (!studentId || !password) { showFormError('bindError', '请填写学号和密码'); return; }

    var btn = document.getElementById('pwdLoginBtn');
    btn.disabled = true; btn.textContent = '登录中…';
    document.getElementById('bindError').classList.remove('show');
    try {
        var res = await api('/api/academic/login', {
            method: 'POST',
            body: JSON.stringify({ student_id: studentId, password: password })
        });
        document.getElementById('acPassword').value = '';
        var d = res.data || {};
        // 账号开了多因子认证：切到第二步回填验证码
        if (d.mfaRequired) { enterMfaStep(d); return; }
        showFormSuccess('bindSuccess', '绑定成功，正在加载数据…');
        await loadStatus();
    } catch (err) {
        showFormError('bindError', err.message);
    } finally {
        btn.disabled = false; btn.textContent = '登录并绑定';
    }
}

/** 切到多因子认证步骤 */
function enterMfaStep(d) {
    mfaToken = d.token || '';
    var tip = '统一身份认证要求二次验证（' + (d.method || '验证码') + '）';
    if (d.contact) tip += '，验证码将发送到 ' + d.contact;
    tip += '。点下面的「获取验证码」即可收到。';
    document.getElementById('mfaTip').textContent = tip;
    document.getElementById('pwdStep').hidden = true;
    document.getElementById('mfaStep').hidden = false;
    document.getElementById('mfaCode').value = '';
    document.getElementById('bindError').classList.remove('show');
    document.getElementById('mfaCode').focus();
}

/** 重置多因子认证步骤 */
function resetMfaStep() {
    mfaToken = '';
    if (mfaTimer) { clearInterval(mfaTimer); mfaTimer = null; }
    var send = document.getElementById('mfaSendBtn');
    send.disabled = false; send.textContent = '获取验证码';
    document.getElementById('mfaStep').hidden = true;
    document.getElementById('pwdStep').hidden = false;
}

/** 第二步：下发验证码（带 60 秒倒计时，避免连点） */
async function doMfaSend() {
    if (!mfaToken) { showFormError('bindError', '二次验证已超时，请返回上一步重新输入'); return; }
    var btn = document.getElementById('mfaSendBtn');
    btn.disabled = true; btn.textContent = '发送中…';
    try {
        var res = await api('/api/academic/mfa/send', { method: 'POST', body: JSON.stringify({ token: mfaToken }) });
        var d = res.data || {};
        showFormSuccess('bindSuccess', '验证码已发送' + (d.mobile ? '至 ' + d.mobile : '') + '，请查收');
        startMfaCountdown(60);
    } catch (err) {
        showFormError('bindError', err.message);
        btn.disabled = false; btn.textContent = '获取验证码';
    }
}

function startMfaCountdown(seconds) {
    var btn = document.getElementById('mfaSendBtn');
    var left = seconds;
    if (mfaTimer) clearInterval(mfaTimer);
    btn.disabled = true;
    btn.textContent = left + 's 后重发';
    mfaTimer = setInterval(function () {
        left -= 1;
        if (left <= 0) {
            clearInterval(mfaTimer); mfaTimer = null;
            btn.disabled = false; btn.textContent = '重新获取';
            return;
        }
        btn.textContent = left + 's 后重发';
    }, 1000);
}

/** 第二步：提交验证码完成绑定 */
async function doMfaVerify() {
    var code = document.getElementById('mfaCode').value.trim();
    if (!code) { showFormError('bindError', '请填写验证码'); return; }
    if (!mfaToken) { showFormError('bindError', '二次验证已超时，请返回上一步重新输入'); return; }

    var btn = document.getElementById('mfaVerifyBtn');
    btn.disabled = true; btn.textContent = '验证中…';
    document.getElementById('bindError').classList.remove('show');
    try {
        await api('/api/academic/mfa/verify', { method: 'POST', body: JSON.stringify({ token: mfaToken, code: code }) });
        resetMfaStep();
        showFormSuccess('bindSuccess', '绑定成功，正在加载数据…');
        await loadStatus();
    } catch (err) {
        showFormError('bindError', err.message);
    } finally {
        btn.disabled = false; btn.textContent = '完成绑定';
    }
}

async function doBind() {
    var input = document.getElementById('cookieInput');
    var cookies = extractCookie(input.value);
    if (!cookies) { showFormError('bindError', '请先粘贴教务系统的 Cookie'); return; }
    var btn = document.getElementById('bindBtn');
    btn.disabled = true; btn.textContent = '绑定中…';
    document.getElementById('bindError').classList.remove('show');
    try {
        await api('/api/academic/bind', { method: 'POST', body: JSON.stringify({ cookies: cookies }) });
        showFormSuccess('bindSuccess', '绑定成功，正在加载数据…');
        input.value = '';
        await loadStatus();
    } catch (err) {
        showFormError('bindError', err.message);
    } finally {
        btn.disabled = false; btn.textContent = '绑定';
    }
}

async function doUnbind() {
    if (!window.confirm('解绑后会清除本地缓存的课表与学分数据，确定解绑吗？')) return;
    try {
        await api('/api/academic/bind', { method: 'DELETE' });
        timetable = null; credits = null; activeTerm = '';
        try { localStorage.removeItem(TERM_KEY); } catch (e) {}
        showOnly('bindView');
    } catch (err) {
        showNotice(err.message);
    }
}

function showFormError(id, msg) {
    var el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
}
function showFormSuccess(id, msg) {
    var el = document.getElementById(id);
    el.textContent = msg;
    el.classList.add('show');
}
/** 顶部提示条。默认是红底横幅（真出错了才用）；quiet=true 走一行小字，只是提醒 */
function showNotice(msg, quiet) {
    var el = document.getElementById('noticeBox');
    el.classList.toggle('ac-hint', !!quiet);
    el.textContent = msg;
    el.hidden = false;
}
function hideNotice() {
    document.getElementById('noticeBox').hidden = true;
}

/**
 * 显示的是缓存课表时的那行小字。
 *
 * 不用红横幅：「教务登录态过期」大概一天就会来一次，为它拉一条红底提示，
 * 用户会以为课表坏了 —— 实际上课表好好的，只是没法去教务那儿拿最新的。
 * 所以这里只说清两件事：这是哪来的数据、想要最新的该按哪儿。
 */
function cacheHintText(reason) {
    var why = reason === 'expired'
        ? '教务登录态已过期，当前显示的是上次同步的课表'
        : '教务系统暂时不可用，当前显示的是上次同步的课表';
    return why + ' · 课表有变动时请点「刷新」';
}

/**
 * 手动刷新没拿到新数据时问一句要不要重新登录教务。
 *
 * 只在这一种场景问：用户主动点了「刷新」就是想拿最新的，拉不到只能重新登录。
 * 自动加载时不问 —— 登录态一天左右就过期一次，每次打开都弹窗没人受得了，
 * 那种情况下面的小字已经说清了。
 */
function askReLogin() {
    return window.confirm('教务登录态已过期，需要重新登录教务系统才能拉取最新数据。\n\n现在去重新登录？');
}

// ===== 子标签：课表 / 学业达成 =====
// 两块内容原来纵向堆叠，手机上要滚很久才看得到学分；拆成子标签后一次只看一块。
// 「学年学期」与「更新于」只对课表有意义，切到学业达成时收起，免得放一个不生效的筛选。
function initAcSeg() {
    var seg = document.getElementById('acSeg');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
        // 被点的可能是按钮里的文字，往上找到带 data-ac-tab 的那个按钮
        var btn = e.target;
        while (btn && btn !== seg && !btn.getAttribute('data-ac-tab')) btn = btn.parentNode;
        if (!btn || btn === seg) return;
        switchAcTab(btn.getAttribute('data-ac-tab'));
    });
    switchAcTab('timetable');
    window.addEventListener('resize', moveAcSegPill);
}

function switchAcTab(name) {
    [['timetable', 'paneTimetable'], ['credits', 'paneCredits']].forEach(function (pair) {
        var pane = document.getElementById(pair[1]);
        if (pane) pane.hidden = (pair[0] !== name);
    });
    var termTools = document.getElementById('termTools');
    if (termTools) termTools.hidden = (name !== 'timetable');
    var seg = document.getElementById('acSeg');
    if (seg) {
        var btns = seg.querySelectorAll('.tab');
        for (var i = 0; i < btns.length; i++) {
            btns[i].classList.toggle('active', btns[i].getAttribute('data-ac-tab') === name);
        }
    }
    moveAcSegPill();
}

/** 滑块：与个人页主题分段、移动端底栏同一套弹簧动画，位置与尺寸按激活项实测写入 */
function moveAcSegPill() {
    var pill = document.getElementById('acSegPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.tab.active');
    // 还在加载 / 未绑定（dataView 隐藏）时量出来是 0，此时先藏起滑块，等显示后 loadStatus 再补量
    if (!active || !active.offsetWidth) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.opacity = '1';
}

// ===== 课表 =====
async function loadTimetable(term, refresh) {
    var view = document.getElementById('timetableView');
    view.innerHTML = skeletonHTML(4);
    var path = '/api/academic/timetable';
    var query = [];
    if (term) query.push('xnxq=' + encodeURIComponent(term));
    if (refresh) query.push('refresh=1');
    if (query.length) path += '?' + query.join('&');
    try {
        var res = await api(path);
        timetable = res.data;
        activeTerm = timetable.xnxqId;
        rememberTerm(activeTerm);
        renderTermSelect(timetable.terms, activeTerm);
        renderSyncMeta(timetable);
        renderTimetable(timetable);
        renderUnscheduled(timetable.unscheduled);
        if (timetable.stale) {
            showNotice(cacheHintText(timetable.cacheReason), true);
            // 手动刷新仍然只拿到缓存：说明教务那边已经拉不动了，问一句要不要重新登录。
            // 自动加载走到这一支是常态（登录态一天左右就会被重置），小字说明就够了
            if (refresh && timetable.cacheReason === 'expired' && askReLogin()) {
                showOnly('bindView');
            }
        } else {
            hideNotice();
        }
    } catch (err) {
        // 会话过期/未绑定用错误码精确判断（不再靠文案匹配，避免误伤渲染错误）
        if (err.code === 'NOT_BOUND') {
            showOnly('bindView');
            showFormError('bindError', err.message);
            return;
        }
        if (err.code === 'ACADEMIC_EXPIRED' || err.code === 'ACADEMIC_DECRYPT_FAILED') {
            // 走到这儿说明连缓存都没有（有的话上面那一支已经把课表给出来了）。
            // 自动加载时直接引导去重新登录 —— 页面上什么都没有，留着也是白留；
            // 手动刷新时先问一句，用户可能只是顺手点了一下、并不想现在重新登录
            if (refresh && !askReLogin()) {
                view.innerHTML = stateHTML(err.message, true);
                return;
            }
            showOnly('bindView');
            showFormError('bindError', err.message);
            return;
        }
        view.innerHTML = stateHTML(err.message, true);
    }
}

function renderTermSelect(terms, current) {
    var sel = document.getElementById('termSelect');
    var list = terms || [];
    sel.innerHTML = list.map(function (t) {
        return '<option value="' + escAttr(t.id) + '"' + (t.id === current ? ' selected' : '') + '>'
            + esc(t.name) + (t.current ? '（当前学期）' : '') + '</option>';
    }).join('');
}

function renderSyncMeta(data) {
    var parts = [];
    if (data.fetchedAt) parts.push('更新于 ' + fmtTime(data.fetchedAt));
    if (data.fromCache) parts.push('缓存');
    document.getElementById('syncMeta').textContent = parts.join(' · ');
}

/** ISO 时间 → 本地「MM-DD HH:mm」 */
function fmtTime(iso) {
    var d = new Date(iso);
    if (isNaN(d.getTime())) return iso;
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes());
}

/** 已开学第几周（不在学期内返回 0） */
function currentWeek(data) {
    if (!data.firstDate) return 0;
    var start = new Date(data.firstDate + 'T00:00:00');
    if (isNaN(start.getTime())) return 0;
    var today = new Date();
    var todayStart = new Date(today.getFullYear(), today.getMonth(), today.getDate());
    var days = Math.floor((todayStart - start) / 86400000);
    if (days < 0) return 0;
    var week = Math.floor(days / 7) + 1;
    return week <= (data.weekCount || 0) ? week : 0;
}

/** 课程在课表里的起始/结束节次行号（按起止时间与节次配置对齐） */
function periodRange(periods, course) {
    var start = -1, end = -1;
    for (var i = 0; i < periods.length; i++) {
        if (start < 0 && periods[i].start && periods[i].start === course.start) start = i;
        if (periods[i].end && periods[i].end === course.end) end = i;
    }
    if (start < 0) {
        // 时间对不上（教务改过作息）时，退化为按时间区间覆盖
        for (var j = 0; j < periods.length; j++) {
            if (periods[j].start >= course.start) { start = j; break; }
        }
        if (start < 0) start = 0;
    }
    if (end < start) end = start;
    return { start: start, end: end };
}

function renderTimetable(data) {
    var view = document.getElementById('timetableView');
    var periods = data.periods || [];
    var courses = data.courses || [];
    if (!periods.length || !courses.length) {
        view.innerHTML = stateHTML(courses.length ? '暂无节次配置，无法渲染课表' : '本学期暂无已排课程');
        document.getElementById('weekHint').textContent = '';
        return;
    }

    var week = currentWeek(data);
    document.getElementById('weekHint').textContent = week
        ? ('第 ' + week + ' / ' + (data.weekCount || '?') + ' 周')
        : (data.firstDate ? '学期未开始或已结束' : '');

    // 每列（周一~周日）逐行扫描，被 rowspan 占用的行跳过
    var cells = [];   // cells[weekday][row]
    for (var w = 1; w <= 7; w++) {
        cells[w] = [];
        for (var r = 0; r < periods.length; r++) cells[w][r] = null;
    }
    courses.forEach(function (c) {
        if (c.weekday < 1 || c.weekday > 7) return;
        var range = periodRange(periods, c);
        for (var r = range.start; r <= range.end; r++) {
            if (cells[c.weekday][r] === null) cells[c.weekday][r] = { course: c, range: range, anchor: r === range.start };
        }
    });

    var html = '<div class="tt-wrap"><table class="tt-table"><thead><tr><th class="tt-time-col"></th>';
    for (var d = 0; d < 7; d++) {
        html += '<th' + (week && week > 0 && isTodayWeekday(d + 1) ? ' class="tt-today"' : '') + '>' + WEEKDAY_NAMES[d] + '</th>';
    }
    html += '</tr></thead><tbody>';

    for (var row = 0; row < periods.length; row++) {
        var p = periods[row];
        var isBlockStart = row === 0 || periods[row - 1].block !== p.block;
        html += '<tr' + (isBlockStart && row > 0 ? ' class="tt-block-start"' : '') + '>';
        html += '<td class="tt-time-col"><span class="tt-period">' + esc(p.name) + '</span>'
            + '<span class="tt-time">' + esc(p.start) + '<br>' + esc(p.end) + '</span></td>';
        for (var day = 1; day <= 7; day++) {
            var cell = cells[day][row];
            if (cell === null) {
                html += '<td class="tt-cell"></td>';
            } else if (!cell.anchor) {
                continue; // 被上方 rowspan 覆盖
            } else {
                var span = cell.range.end - cell.range.start + 1;
                var c = cell.course;
                var inWeek = week > 0 && c.weeks.indexOf(week) >= 0;
                html += '<td class="tt-cell" rowspan="' + span + '">' + courseCellHTML(c, inWeek, week > 0) + '</td>';
            }
        }
        html += '</tr>';
    }
    html += '</tbody></table></div>';
    view.innerHTML = html;
}

function isTodayWeekday(weekday) {
    var jsDay = new Date().getDay();       // 0=周日
    return (jsDay === 0 ? 7 : jsDay) === weekday;
}

function courseCellHTML(c, inWeek, hasWeek) {
    var cls = 'tt-course' + (hasWeek ? (inWeek ? ' now' : ' dim') : '');
    var weeks = c.weeks.length ? (c.weeks.length > 1 ? c.weeks[0] + '-' + c.weeks[c.weeks.length - 1] + '周' : c.weeks[0] + '周') : (c.weekText || '');
    return '<div class="' + cls + '">'
        + '<div class="tt-course-name">' + esc(c.name) + '</div>'
        + (c.room ? '<div class="tt-course-meta">' + esc(c.room) + '</div>' : '')
        + (c.teacher ? '<div class="tt-course-meta">' + esc(c.teacher) + '</div>' : '')
        + (weeks ? '<div class="tt-course-week">' + esc(weeks) + '</div>' : '')
        + '</div>';
}

function renderUnscheduled(list) {
    var block = document.getElementById('unscheduledBlock');
    var view = document.getElementById('unscheduledView');
    var rows = list || [];
    if (!rows.length) { block.hidden = true; return; }
    block.hidden = false;
    document.getElementById('unscheduledCount').textContent = rows.length + ' 门';
    view.innerHTML = '<div class="list">' + rows.map(function (c) {
        var meta = [];
        if (c.code) meta.push(c.code);
        if (c.credit) meta.push(c.credit + ' 学分');
        if (c.teacher) meta.push(c.teacher);
        if (c.className) meta.push(c.className);
        return '<div class="list-row"><div class="list-row-main">'
            + '<div class="list-row-title">' + esc(c.name) + '</div>'
            + '<div class="list-row-meta"><span>' + esc(meta.join(' · ')) + '</span></div>'
            + '</div></div>';
    }).join('') + '</div>';
}

// ===== 学业达成 / 学分 =====
async function loadCredits(refresh) {
    var view = document.getElementById('creditsView');
    view.innerHTML = skeletonHTML(3);
    var path = '/api/academic/credits' + (refresh ? '?refresh=1' : '');
    try {
        var res = await api(path);
        credits = res.data;
        renderCredits(credits);
    } catch (err) {
        view.innerHTML = stateHTML(err.message, true);
    }
}

function renderCredits(data) {
    var view = document.getElementById('creditsView');
    var rows = data.rows || [];
    var summary = data.summary || {};
    var profile = data.profile || {};
    if (!rows.length) { view.innerHTML = stateHTML('暂无学业达成数据'); return; }

    var rate = summary.required > 0 ? Math.round((summary.obtained / summary.required) * 100) : 0;
    document.getElementById('creditHint').textContent = summary.required > 0
        ? ('已获 ' + summary.obtained + ' / ' + summary.required + ' 学分')
        : '';

    var profileLine = [profile.college, profile.major, profile.className].filter(Boolean).join(' · ');
    var html = '<div class="ac-card">';
    html += '<div class="credit-head">'
        + '<div><div class="credit-plan">' + esc(profile.plan || '当前培养方案') + '</div>'
        + '<div class="credit-sub">' + esc(profileLine) + (profile.matchRate ? ' · 匹配度 ' + esc(profile.matchRate) : '') + '</div></div>'
        + '<div class="credit-rate">' + rate + '<span>%</span></div>'
        + '</div>';
    html += '<div class="credit-bar"><span></span></div>';
    html += '<div class="credit-stats">'
        + statBox('要求学分', summary.required)
        + statBox('已获学分', summary.obtained, 'ok')
        + statBox('在修学分', summary.current)
        + statBox('还需学分', summary.remaining, summary.remaining > 0 ? 'warn' : 'ok')
        + '</div>';
    html += '</div>';

    html += '<div class="ac-card credit-table">';
    html += '<div class="credit-row credit-row-head">'
        + '<span class="cr-name">课程体系</span>'
        + '<span class="cr-num">要求</span>'
        + '<span class="cr-num">已获</span>'
        + '<span class="cr-num">在修</span>'
        + '<span class="cr-num">还需</span>'
        + '<span class="cr-state">状态</span>'
        + '</div>';
    html += rows.map(function (r) {
        var isLeaf = r.leaf;
        var cls = 'credit-row' + (r.level === 1 ? ' lv1' : (r.level === 2 ? ' lv2' : ' lv3'));
        var name = '<span class="cr-name" data-indent="' + ((r.level - 1) * 14) + '">' + esc(r.name) + '</span>';
        var nums = isLeaf
            ? '<span class="cr-num">' + r.required + '</span>'
                + '<span class="cr-num">' + r.obtained + '</span>'
                + '<span class="cr-num">' + r.current + '</span>'
                + '<span class="cr-num">' + r.remaining + '</span>'
                + '<span class="cr-state"><span class="badge ' + (r.achieved ? 'badge-crawler' : 'badge-danger') + '">'
                + (r.achieved ? '已达成' : '未达成') + '</span></span>'
            : '<span class="cr-num">—</span><span class="cr-num">—</span><span class="cr-num">—</span><span class="cr-num">—</span><span class="cr-state"></span>';
        return '<div class="' + cls + '">' + name + nums + '</div>';
    }).join('');
    html += '</div>';

    view.innerHTML = html;
    // 进度条宽度与层级缩进原来是内联 style，CSP 收紧后会被整条丢掉，
    // 改成建好 DOM 后用 CSSOM 写 —— CSSOM 不受 style-src 限制。
    var bar = view.querySelector('.credit-bar > span');
    if (bar) bar.style.width = Math.min(rate, 100) + '%';
    view.querySelectorAll('.cr-name[data-indent]').forEach(function (el) {
        el.style.paddingLeft = el.getAttribute('data-indent') + 'px';
    });
}

function statBox(label, value, tone) {
    return '<div class="credit-stat' + (tone ? ' ' + tone : '') + '">'
        + '<span class="credit-stat-value">' + value + '</span>'
        + '<span class="credit-stat-label">' + esc(label) + '</span>'
        + '</div>';
}
