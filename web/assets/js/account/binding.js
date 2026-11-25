(function () {
// 个人中心 · 绑定与授权
// 内容：教务 / 学习通 / 中国大学MOOC 三种绑定、解绑，以及用户协议与授权管理。
// ===== 用户协议与授权（关于软件 → 用户协议）=====
// 后端契约：GET /api/auth/consent 给 { version, agreed, consent:{version,terms,chaoxing,academic,mooc,*_agreed_at} }；
// POST 同形状。terms 必须为 true —— 撤回《用户协议》就连登录都过不去，后端直接 400 CANNOT_REVOKE_TERMS，
// 所以这里只有学习通 / 教务 / 中国大学MOOC 三个开关可改，协议那行固定显示「已同意」。
var consentData = null;

/** 关于软件那一行的摘要：已同意 · 学习通已授权 · 教务未授权 · 中国大学MOOC未授权 */
function consentSummaryText(data) {
    if (!data || !data.agreed || !data.consent) return '未同意（请退出后重新登录并同意）';
    return '已同意 · ' + (data.consent.chaoxing ? '学习通已授权' : '学习通未授权')
        + ' · ' + (data.consent.academic ? '教务已授权' : '教务未授权')
        + ' · ' + (data.consent.mooc ? '中国大学MOOC已授权' : '中国大学MOOC未授权');
}

function renderConsentSummary(data) {
    var agreed = !!(data && data.agreed);
    var c = (data && data.consent) || {};
    // 每项一行：协议必选，三项授权各自独立（学习通 / 教务 / 中国大学MOOC）
    var setLine = function (id, text, on) {
        var el = document.getElementById(id);
        if (!el) return;
        el.textContent = text;
        el.classList.toggle('consent-on', !!on);
        el.classList.toggle('consent-off', !on);
    };
    setLine('consentTermsLine', agreed ? '已同意' : '未同意', agreed);
    setLine('consentChaoxingLine', c.chaoxing ? '已授权' : '未授权', !!c.chaoxing);
    setLine('consentAcademicLine', c.academic ? '已授权' : '未授权', !!c.academic);
    setLine('consentMoocLine', c.mooc ? '已授权' : '未授权', !!c.mooc);
    // 兼容：如果页面还是老的「一句摘要」节点，也写一份
    var summary = document.getElementById('consentSummary');
    if (summary) summary.textContent = consentSummaryText(data);
    var hint = document.getElementById('consentHint');
    if (hint) {
        hint.textContent = agreed ? '' : '当前协议未同意，请退出后重新登录并勾选同意';
        hint.hidden = agreed;
    }
}

async function loadConsentSummary() {
    try {
        var res = await api('/api/auth/consent');
        consentData = (res && res.data) || null;
        renderConsentSummary(consentData);
    } catch (e) {
        // 取不到状态不影响这一页其它功能；打开弹窗时会再取一次，那里才把错误显示出来
        var ids = ['consentTermsLine', 'consentChaoxingLine', 'consentAcademicLine', 'consentMoocLine'];
        for (var i = 0; i < ids.length; i++) {
            var el = document.getElementById(ids[i]);
            if (el) el.textContent = '获取失败，点「查看与修改」重试';
        }
        var summary = document.getElementById('consentSummary');
        if (summary) summary.textContent = '获取失败，点「查看与修改」重试';
    }
}

/** 用最新数据填充弹窗：协议版本 / 最近同意时间 / 三个开关 */
function fillConsentModal(data) {
    var version = data && data.version ? data.version : '';
    var c = data && data.consent ? data.consent : null;
    var agreed = !!(data && data.agreed);
    var versionLine = document.getElementById('consentVersionLine');
    if (versionLine) {
        versionLine.textContent = '协议版本 ' + (version || '—')
            + ' · 最近同意 ' + (c && c.updated_at ? c.updated_at : '—');
    }
    var termsLine = document.getElementById('consentTermsStatus');
    if (termsLine) {
        termsLine.textContent = agreed
            ? '已同意（' + (version || '—') + '）'
            : '尚未同意：请退出登录后重新登录并勾选同意';
    }
    var ch = document.getElementById('consentChaoxingSwitch');
    var ac = document.getElementById('consentAcademicSwitch');
    var mo = document.getElementById('consentMoocSwitch');
    if (ch) { ch.checked = !!(c && c.chaoxing); ch.disabled = !agreed; }
    if (ac) { ac.checked = !!(c && c.academic); ac.disabled = !agreed; }
    if (mo) { mo.checked = !!(c && c.mooc); mo.disabled = !agreed; }
    var saveBtn = document.getElementById('consentSaveBtn');
    if (saveBtn) { saveBtn.disabled = !agreed; saveBtn.textContent = '保存'; }
}

async function openConsentManage() {
    var ov = document.getElementById('consentModal');
    if (!ov) return;
    var err = document.getElementById('consentManageError');
    if (err) { err.textContent = ''; err.classList.remove('show'); }
    // 先用手上那份渲染，打开后再取一次最新值：别的设备 / 标签页可能刚改过
    fillConsentModal(consentData);
    ov.classList.add('show');
    document.body.style.overflow = 'hidden';
    try {
        var res = await api('/api/auth/consent');
        consentData = (res && res.data) || null;
        renderConsentSummary(consentData);
        fillConsentModal(consentData);
    } catch (e) {
        if (err) { err.textContent = e.message; err.classList.add('show'); }
    }
}

function closeConsentManage() {
    var ov = document.getElementById('consentModal');
    if (ov) ov.classList.remove('show');
    document.body.style.overflow = '';
}

async function saveConsent() {
    var err = document.getElementById('consentManageError');
    if (err) { err.textContent = ''; err.classList.remove('show'); }
    var ch = document.getElementById('consentChaoxingSwitch');
    var ac = document.getElementById('consentAcademicSwitch');
    var mo = document.getElementById('consentMoocSwitch');
    var btn = document.getElementById('consentSaveBtn');
    var label = btn ? btn.textContent : '保存';
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
        var res = await api('/api/auth/consent', {
            method: 'POST',
            body: JSON.stringify({
                terms: true,
                chaoxing: !!(ch && ch.checked),
                academic: !!(ac && ac.checked),
                mooc: !!(mo && mo.checked)
            })
        });
        consentData = (res && res.data) || null;
        renderConsentSummary(consentData);
        // 弹窗关掉后按钮要回到可再次打开的状态：成功时没有 finally，这里手动复位
        if (btn) { btn.disabled = false; btn.textContent = '保存'; }
        closeConsentManage();
        var hint = document.getElementById('consentHint');
        if (hint) { hint.textContent = '授权设置已保存。'; hint.hidden = false; }
    } catch (e) {
        if (err) { err.textContent = e.message; err.classList.add('show'); }
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

// 空值守卫：节点漂移时别让这段把后面的委托绑定打死（同 bindContactModal 的写法）
(function bindConsentModal() {
    var ov = document.getElementById('consentModal');
    if (!ov) return;
    ov.addEventListener('click', function (e) { if (e.target === ov) closeConsentManage(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && ov.classList.contains('show')) closeConsentManage();
    });
    var openBtn = document.getElementById('openConsentBtn');
    if (openBtn) openBtn.addEventListener('click', openConsentManage);
    var closeBtn = document.getElementById('consentManageCloseBtn');
    if (closeBtn) closeBtn.addEventListener('click', closeConsentManage);
    var cancelBtn = document.getElementById('consentManageCancelBtn');
    if (cancelBtn) cancelBtn.addEventListener('click', closeConsentManage);
    var saveBtn = document.getElementById('consentSaveBtn');
    if (saveBtn) saveBtn.addEventListener('click', saveConsent);
})();
loadConsentSummary();


// ===== 个人中心：账号绑定（教务 / 学习通 / 中国大学MOOC） =====
// 交互约定：
//   - 页内 tab 切换，所有账号操作走 #accountBindModal 一个弹窗（CSP 无内联脚本，按钮用 data-act 委托）；
//   - 教务、学习通与中国大学MOOC 都先读 /status，再按状态渲染「未绑定选项」或「身份 + 解绑」；
//   - App 内的登录由原生小窗打开真实登录页，原生把 Cookie 回传给本页（__caChaoxingCookies）；
//   - 学习通按 issue #107：先 /bind/preview 预览身份，用户确认后才 /bind 落库；
//   - 中国大学MOOC 没有账号密码代登录（后端 /login 恒 501 MOOC_LOGIN_UNSUPPORTED）：
//     icourse163 的登录页是 reg.icourse163.org 的 SPA iframe，服务端拿不到表单。所以 App 内
//     由原生小窗打开真实登录页，登录完把 Cookie 回传给本页（__caMoocCookies）；网页版没有桥，
//     只能浏览器登录后粘贴整条 Cookie。两条路最后都落到 /api/mooc/bind，由服务端读一次课程
//     列表验证登录态后才落库。
var BIND_PENDING_KEY = 'ca_account_pending_bind';
var BIND_RISK_ACK_KEY = 'ca_academic_risk_ack';
var bindAcademic = null;
var bindChaoxing = null;
var bindMooc = null;
var bindMfaToken = '';
var bindMfaTimer = null;
var bindCxPreview = null;
var bindFlashTimer = null;

function bindById(id) { return document.getElementById(id); }

function bindToggleError(msg) {
    var el = bindById('bindModalError');
    if (!el) return;
    if (!msg) { el.textContent = ''; el.classList.remove('show'); return; }
    el.textContent = msg;
    el.classList.add('show');
}

/** 绑定时间可能是毫秒数、秒数或 ISO 字符串，统一按北京时间展示 */
function fmtBindTime(value) {
    if (value === null || value === undefined || value === '') return '—';
    if (typeof value === 'number' || /^\d+$/.test(String(value))) {
        var n = Number(value);
        if (isFinite(n) && n > 0) return window.caFmtBJTime(n < 100000000000 ? n * 1000 : n);
    }
    var d = new Date(value);
    if (!isNaN(d.getTime())) return window.caFmtBJTime(d.getTime());
    return String(value);
}

function bindBadge(id, text, kind) {
    var el = bindById(id);
    if (!el) return;
    el.textContent = text;
    el.className = 'badge ' + (kind === 'ok' ? 'badge-ok' : 'badge-muted');
}

function bindFlash(msg) {
    var el = bindById('bindFlash');
    if (!el) return;
    el.textContent = msg;
    el.hidden = false;
    if (bindFlashTimer) clearTimeout(bindFlashTimer);
    bindFlashTimer = setTimeout(function () { el.hidden = true; }, 5000);
}

function bindNativeAcademic() {
    try {
        return !!(window.CAHost && (typeof window.CAHost.startAcademicLogin === 'function'
            || typeof window.CAHost.startAcademicLoginFor === 'function'));
    } catch (e) { return false; }
}
function bindNativeChaoxing() {
    try { return !!(window.CAHost && typeof window.CAHost.startChaoxingLogin === 'function'); } catch (e) { return false; }
}
/**
 * App 内是否有中国大学MOOC 的原生登录小窗。
 *
 * 与学习通同一个前提：icourse163 的登录页是 reg.icourse163.org 的 SPA（登录表单在一个
 * 跨域 iframe 里），网页端拿不到表单字段，也没法跨域读它的 Cookie。所以网页版只能让用户
 * 自己在浏览器登录后粘 Cookie；只有 App 的原生 WebView 才能「打开真实登录页 → 登录完成后
 * 读回 Cookie」。桥不存在就说明是网页版或旧版 App，入口退回粘贴。
 */
function bindNativeMooc() {
    try { return !!(window.CAHost && typeof window.CAHost.startMoocLogin === 'function'); } catch (e) { return false; }
}

/** 教务登录前的风险告知；勾选状态与学业页共用同一个 localStorage 键 */
function bindRiskAcked() {
    try { return localStorage.getItem(BIND_RISK_ACK_KEY) === '1'; } catch (e) { return false; }
}

function bindRiskAckHTML() {
    var checked = false;
    try { checked = localStorage.getItem(BIND_RISK_ACK_KEY) === '1'; } catch (e) {}
    return '<label class="consent-check bind-risk"><input type="checkbox" id="acBindRisk"' + (checked ? ' checked' : '')
        + '><span>我已了解：登录由教务系统完成，本应用只代为读取课表、学分与成绩等只读信息。</span></label>';
}

function bindTermText(terms) {
    return (terms && terms.length) ? '已同步 ' + terms.length + ' 个学期' : '—';
}

/** 教务卡：未绑定给三条登录入口；已绑定展示身份、时间与解绑 */
function renderAcademicBinding(data) {
    var body = bindById('academicBindBody');
    if (!body) return;
    bindAcademic = data || {};
    if (data && data.bound === true) {
        var paused = !!data.paused;
        var name = data.realName || '教务账号';
        var nativeAcademicBound = bindNativeAcademic();
        bindBadge('academicBindBadge', paused ? '已暂停' : '已绑定', paused ? 'muted' : 'ok');
        body.innerHTML = ''
            + '<div class="bind-identity">'
            + '<span class="bind-avatar" aria-hidden="true">' + esc(name.charAt(0)) + '</span>'
            + '<div class="bind-identity-main"><p class="bind-name">' + esc(name) + '</p>'
            + '<p class="bind-id">' + (data.studentNo ? '学号 ' + esc(data.studentNo) : '已绑定教务账号') + '</p></div>'
            + '</div>'
            + '<div class="info-list bind-meta">'
            + '<div class="info-row"><span class="k">状态</span><span class="v">' + (paused ? '已暂停' : '正常') + '</span></div>'
            + '<div class="info-row"><span class="k">绑定时间</span><span class="v">' + esc(fmtBindTime(data.boundAt)) + '</span></div>'
            + '<div class="info-row"><span class="k">最近校验</span><span class="v">' + esc(fmtBindTime(data.checkedAt)) + '</span></div>'
            + '<div class="info-row"><span class="k">可用学期</span><span class="v">' + esc(bindTermText(data.terms)) + '</span></div>'
            + '</div>'
            + (paused && data.paused_until ? '<p class="bind-warn">连续登录失败，已暂停到 ' + esc(fmtBindTime(data.paused_until)) + '，可重新登录恢复。</p>' : '')
            + '<div class="bind-actions">'
            + (nativeAcademicBound ? '<button class="btn btn-primary" type="button" data-act="begin-academic-bind" data-arg="app">App 重新登录</button>' : '')
            + '<button class="btn btn-outline" type="button" data-act="begin-academic-bind" data-arg="password">' + (nativeAcademicBound ? '账号密码' : '重新登录') + '</button>'
            + '<button class="btn btn-outline" type="button" data-act="begin-academic-bind" data-arg="cookie">换 Cookie</button>'
            + '<button class="btn btn-danger" type="button" data-act="academic-unbind">解绑</button>'
            + '</div>';
        return;
    }
    bindBadge('academicBindBadge', '未绑定', 'muted');
    var native = bindNativeAcademic();
    body.innerHTML = ''
        + '<p class="bind-text">绑定后，课表、学业达成与成绩会在「学业」页自动同步。登录由学校统一身份认证完成，本应用只读取数据。</p>'
        + '<div class="bind-actions">'
        + (native ? '<button class="btn btn-primary" type="button" data-act="begin-academic-bind" data-arg="app">App 内登录</button>' : '')
        + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-academic-bind" data-arg="password">学号密码</button>'
        + '<button class="btn btn-outline" type="button" data-act="begin-academic-bind" data-arg="cookie">粘贴 Cookie</button>'
        + '</div>'
        + '<p class="bind-hint">' + (native
            ? '「App 内登录」会打开学校真实登录页，登录完成自动读回 Cookie。'
            : '网页版无法读取教务站点的 Cookie，请用学号密码登录，或粘贴浏览器里的 Cookie。') + '</p>';
}

/** 学习通卡：已绑定时展示姓名/账号/课程数；未绑定给 App 登录、密码、Cookie 三条路 */
function renderChaoxingBinding(data) {
    var body = bindById('chaoxingBindBody');
    if (!body) return;
    bindChaoxing = data || {};
    if (data && data.bound === true) {
        var paused = !!data.paused;
        var name = data.realName || '学习通账号';
        var count = Number(data.courseCount) || 0;
        bindBadge('chaoxingBindBadge', paused ? '已暂停' : '已绑定', paused ? 'muted' : 'ok');
        // App 内用户可以走原生小窗重登；网页端没有桥，主按钮直接给账号密码（否则点了只弹提示）。
        var nativeBound = bindNativeChaoxing();
        body.innerHTML = ''
            + '<div class="bind-identity">'
            + '<span class="bind-avatar" aria-hidden="true">' + esc(name.charAt(0)) + '</span>'
            + '<div class="bind-identity-main"><p class="bind-name">' + esc(name) + '</p>'
            + '<p class="bind-id">' + (data.account ? '账号 ' + esc(data.account) : '已绑定学习通') + '</p></div>'
            + '</div>'
            + '<div class="info-list bind-meta">'
            + '<div class="info-row"><span class="k">状态</span><span class="v">' + (paused ? '已暂停' : '正常') + '</span></div>'
            + '<div class="info-row"><span class="k">课程数</span><span class="v">' + count + ' 门</span></div>'
            + '<div class="info-row"><span class="k">绑定时间</span><span class="v">' + esc(fmtBindTime(data.boundAt)) + '</span></div>'
            + '<div class="info-row"><span class="k">最近校验</span><span class="v">' + esc(fmtBindTime(data.checkedAt)) + '</span></div>'
            + '</div>'
            + (paused ? '<p class="bind-warn">学习通登录态连续失效，已自动暂停同步'
                + (data.paused_until ? '到 ' + esc(fmtBindTime(data.paused_until)) : '')
                + '，重新登录后可恢复。</p>' : '')
            + '<div class="bind-actions">'
            + (nativeBound ? '<button class="btn btn-primary" type="button" data-act="begin-chaoxing-bind" data-arg="app">App 重新登录</button>' : '')
            + '<button class="btn ' + (nativeBound ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-chaoxing-bind" data-arg="password">' + (nativeBound ? '账号密码' : '重新登录') + '</button>'
            + '<button class="btn btn-outline" type="button" data-act="begin-chaoxing-bind" data-arg="cookie">换 Cookie</button>'
            + '<button class="btn btn-danger" type="button" data-act="chaoxing-unbind">解绑</button>'
            + '</div>';
        return;
    }
    bindBadge('chaoxingBindBadge', '未绑定', 'muted');
    var native = bindNativeChaoxing();
    body.innerHTML = ''
        + '<p class="bind-text">绑定后，学习通课程、作业与考试会在 App 内同步。登录交给你自己完成，服务端只接管 Cookie。</p>'
        + '<div class="bind-actions">'
        + (native ? '<button class="btn btn-primary" type="button" data-act="begin-chaoxing-bind" data-arg="app">App 内登录</button>' : '')
        + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-chaoxing-bind" data-arg="password">账号密码</button>'
        + '<button class="btn btn-outline" type="button" data-act="begin-chaoxing-bind" data-arg="cookie">粘贴 Cookie</button>'
        + '</div>'
        + '<p class="bind-hint">学习通登录有时需要人机验证，网页端无法完成时请改用「App 内登录」，或从浏览器复制 Cookie。</p>';
}

/**
 * 中国大学MOOC 卡：App 内「App 内登录 / App 重新登录」，网页版只有「粘贴 Cookie / 解绑」。
 *
 * 两条路最后都落到 POST /api/mooc/bind：App 内由原生小窗打开 icourse163 真实登录页，登录
 * 完成原生把整条 Cookie 回传（__caMoocCookies）；网页版读不到 icourse163 的 Cookie，只能让
 * 用户自己在浏览器登录后粘贴。桥是否可用只决定「哪条路是主按钮」，不影响后端契约。
 *
 * 后端状态有三种：ok、expired（登录态失效，需要重新登录）、paused（连续硬失败，
 * 暂停自动同步直到 paused_until）。expired / paused 都保留身份信息，因为用户要靠
 * 它确认「解绑前看到的是哪个账号」，重新登录也会覆盖同一个账号。
 */
function renderMoocBinding(data) {
    var body = bindById('moocBindBody');
    if (!body) return;
    bindMooc = data || {};
    var native = bindNativeMooc();
    if (data && data.bound === true) {
        var paused = !!data.paused;
        var expired = data.status === 'expired';
        // 账号与成员 ID 都空：只可能是把未登录的访客会话存了下来（1.4.5 的坑）。
        // 按「需要重新登录」渲染，不能显示成正常已绑定 —— 否则用户以为有数据、实际一门课都读不到。
        var missingIdentity = !data.account && !data.memberId;
        var needLogin = expired || missingIdentity;
        var name = data.realName || (missingIdentity ? '未知账号' : '中国大学MOOC账号');
        var count = Number(data.courseCount) || 0;
        var account = String(data.account || '');
        // STUDY_INFO 里的账号是网易内部别名（yd.<hash>@163.com），不是用户本人的邮箱。
        // 服务端会顺手换成真实姓名 + 学号，但登录态过期/暂停时不会出网纠正，仍可能拿到别名。
        var aliasLike = /@163\.com$/i.test(account) || /@163\.com$/i.test(String(data.realName || ''));
        var idLine = account
            ? (/^\d{4,}$/.test(account) ? '学号 ' + esc(account) : '账号 ' + esc(account))
            : (data.memberId ? 'ID ' + esc(data.memberId) : '没有账号信息');
        // 课程名比「课程数」有用得多：用户要靠它确认读到的确实是自己的课（0 门 = 没读到）。
        var courses = (data.courses && data.courses.length) ? data.courses : [];
        bindBadge('moocBindBadge', paused ? '已暂停' : (needLogin ? '需要重新登录' : '已绑定'),
            (paused || needLogin) ? 'muted' : 'ok');
        body.innerHTML = ''
            + '<div class="bind-identity">'
            + '<span class="bind-avatar" aria-hidden="true">' + esc(name.charAt(0)) + '</span>'
            + '<div class="bind-identity-main"><p class="bind-name">' + esc(name) + '</p>'
            + '<p class="bind-id">' + idLine + '</p></div>'
            + '</div>'
            + '<div class="info-list bind-meta">'
            + '<div class="info-row"><span class="k">状态</span><span class="v">'
            + (paused ? '已暂停自动同步'
                : (missingIdentity ? '绑定信息不完整' : (expired ? '登录态已过期' : '正常'))) + '</span></div>'
            + '<div class="info-row"><span class="k">课程数</span><span class="v">' + count + ' 门</span></div>'
            + '<div class="info-row"><span class="k">绑定时间</span><span class="v">' + esc(fmtBindTime(data.boundAt)) + '</span></div>'
            + '<div class="info-row"><span class="k">最近校验</span><span class="v">' + esc(fmtBindTime(data.checkedAt)) + '</span></div>'
            + '</div>'
            + (courses.length
                ? '<div class="bind-courses"><p class="bind-courses-title">已读取课程</p><ul class="bind-course-list">'
                    + courses.map(function (c) {
                        var label = esc(c.name || c.courseId || '未命名课程');
                        var meta = Number(c.lessons)
                            ? (Number(c.learned) || 0) + '/' + Number(c.lessons) + ' 节'
                            : '';
                        return '<li>' + label
                            + (meta ? '<span class="bind-course-meta"> ' + esc(meta) + '</span>' : '')
                            + '</li>';
                    }).join('')
                    + '</ul></div>'
                : '')
            + (paused ? '<p class="bind-warn">MOOC 登录态连续失效，已自动暂停同步'
                + (data.paused_until ? '到 ' + esc(fmtBindTime(data.paused_until)) : '')
                + '，重新登录后可恢复。</p>' : '')
            + (needLogin && !paused ? '<p class="bind-warn">'
                + (missingIdentity
                    ? '绑定记录里没有账号信息，可能把未登录的访客会话误存了，请重新登录后再绑定。'
                    : 'MOOC 登录态已过期，需要'
                        + (native ? '在 App 内重新登录' : '重新登录 www.icourse163.org 并粘贴新的 Cookie')
                        + '。')
                + '</p>' : '')
            // 登录态过期/暂停时服务端不会出网纠正身份，别名仍可能出现，说明白免得用户以为登错号
            + (aliasLike && !needLogin ? '<p class="bind-hint">这个账号显示的是中国大学MOOC的内部别名；重新登录一次后会换成真实姓名和学号。</p>' : '')
            + '<div class="bind-actions">'
            + (native ? '<button class="btn btn-primary" type="button" data-act="begin-mooc-bind" data-arg="app">App 重新登录</button>' : '')
            + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-mooc-bind" data-arg="cookie">'
            + (needLogin ? '重新粘贴 Cookie' : '换 Cookie') + '</button>'
            + '<button class="btn btn-danger" type="button" data-act="mooc-unbind">解绑</button>'
            + '</div>';
        return;
    }
    bindBadge('moocBindBadge', '未绑定', 'muted');
    body.innerHTML = ''
        + '<p class="bind-text">绑定后，中国大学MOOC 的作业与测验截止时间会自动并进「我的待办」。'
        + (native
            ? '点「App 内登录」会打开中国大学MOOC真实登录页，登录完成后自动读回 Cookie，服务端只接管 Cookie。'
            : '网页版读不到 icourse163 的 Cookie，请在浏览器登录 www.icourse163.org 后把 Cookie 整条粘贴过来。')
        + '</p>'
        + '<div class="bind-actions">'
        + (native ? '<button class="btn btn-primary" type="button" data-act="begin-mooc-bind" data-arg="app">App 内登录</button>' : '')
        + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-mooc-bind" data-arg="cookie">'
        + (native ? '粘贴 Cookie' : '绑定 MOOC 账号') + '</button>'
        + '</div>'
        + '<p class="bind-hint">'
        + (native
            ? '登录交给你在 App 内自己完成，服务端只接管 Cookie；需要时也可以用粘贴 Cookie 兜底。'
            : '服务端会先读一次课程列表验证登录态，验证通过才保存。')
        + 'Cookie 只用于读课程 / 作业 / 测验，不保存账号密码。</p>';
}

function renderBindLoadError(kind, err) {
    // kind → 该卡片的 body / badge id。三张卡共用一份失败渲染（文案 + 重试 + 授权入口），
    // 只是节点不同；用表而不是嵌套三元，新增来源时不需要再动判断逻辑。
    var nodes = {
        academic: { body: 'academicBindBody', badge: 'academicBindBadge' },
        chaoxing: { body: 'chaoxingBindBody', badge: 'chaoxingBindBadge' },
        mooc: { body: 'moocBindBody', badge: 'moocBindBadge' }
    }[kind] || { body: 'academicBindBody', badge: 'academicBindBadge' };
    var body = bindById(nodes.body);
    bindBadge(nodes.badge, '读取失败', 'muted');
    var msg = (err && err.message) || '暂时无法读取绑定状态';
    var extra = '';
    if (err && (err.code === 'ACADEMIC_CONSENT_REQUIRED'
        || err.code === 'CHAOXING_CONSENT_REQUIRED'
        || err.code === 'MOOC_CONSENT_REQUIRED')) {
        extra = '<button class="btn btn-primary btn-block" type="button" data-act="open-consent">去开启授权</button>';
    }
    if (body) {
        body.innerHTML = '<p class="bind-text">' + esc(msg) + '</p>' + extra
            + '<div class="bind-actions"><button class="btn btn-outline" type="button" data-act="refresh-account-bindings">重试</button></div>';
    }
}

async function loadAcademicBinding() {
    var body = bindById('academicBindBody');
    if (!body) return;
    try {
        var res = await api('/api/academic/status');
        renderAcademicBinding(res.data || {});
    } catch (err) {
        renderBindLoadError('academic', err);
    }
}

async function loadChaoxingBinding() {
    var body = bindById('chaoxingBindBody');
    if (!body) return;
    try {
        var res = await api('/api/chaoxing/status');
        renderChaoxingBinding(res.data || {});
    } catch (err) {
        renderBindLoadError('chaoxing', err);
    }
}

async function loadMoocBinding() {
    var body = bindById('moocBindBody');
    if (!body) return;
    try {
        // GET status 不校验 MOOC 授权（只读状态），所以未授权时也能正常显示「未绑定」；
        // 功能开关关掉时后端回 503 FEATURE_DISABLED，这里按失败卡片展示并给重试。
        var res = await api('/api/mooc/status');
        renderMoocBinding(res.data || {});
    } catch (err) {
        renderBindLoadError('mooc', err);
    }
}

// ===== 绑定弹窗 =====
function openBindModal(title, html) {
    bindById('accountBindTitle').textContent = title;
    bindById('accountBindBody').innerHTML = html;
    bindById('accountBindModal').classList.add('show');
    document.body.style.overflow = 'hidden';
}

function closeBindModal() {
    var modal = bindById('accountBindModal');
    if (modal) modal.classList.remove('show');
    document.body.style.overflow = '';
    bindMfaToken = '';
    if (bindMfaTimer) { clearInterval(bindMfaTimer); bindMfaTimer = null; }
}

// ===== 教务绑定 =====
function beginAcademicBind(mode) {
    if (mode === 'app') { startAcademicAppLogin(); return; }
    if (mode === 'cookie') { openAcademicCookieStep(); return; }
    openAcademicPasswordStep();
}

function startAcademicAppLogin() {
    if (!bindNativeAcademic()) {
        bindFlash('当前不在 App 内（或 App 版本过旧），请改用学号密码或粘贴 Cookie。');
        return;
    }
    if (bindRiskAcked()) { launchAcademicAppLogin(); return; }
    // 与学业页保持同一道风险告知：没勾过就先给用户看，避免从个人中心绕过。
    openBindModal('教务登录前的风险告知', ''
        + '<p class="bind-text">「App 内登录」会打开学校统一身份认证的真实登录页，登录完成后由 App 读取 Cookie 交给本应用。</p>'
        + '<div class="form-error" id="bindModalError"></div>'
        + bindRiskAckHTML()
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="academic-app-login-continue">继续登录</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>');
}

function launchAcademicAppLogin() {
    try { localStorage.setItem(BIND_PENDING_KEY, 'academic'); } catch (e) {}
    try {
        if (typeof window.CAHost.startAcademicLoginFor === 'function') {
            window.CAHost.startAcademicLoginFor('account');
        } else {
            window.CAHost.startAcademicLogin();
        }
    } catch (err) {
        bindFlash('无法打开 App 内登录，请改用学号密码。');
    }
}

function openAcademicPasswordStep() {
    var sid = '';
    try {
        var session = getSession();
        sid = (session && session.student_id) || '';
    } catch (e) {}
    openBindModal('绑定教务系统', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<div class="form-field"><label class="form-label" for="acBindStudentId">学号</label>'
        + '<input class="form-input" id="acBindStudentId" type="text" inputmode="numeric" autocomplete="username" value="' + esc(sid) + '" placeholder="你的学号"></div>'
        + '<div class="form-field"><label class="form-label" for="acBindPassword">密码</label>'
        + '<input class="form-input" id="acBindPassword" type="password" autocomplete="current-password" placeholder="统一身份认证密码"></div>'
        + bindRiskAckHTML()
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="academic-bind-password">登录并绑定</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">密码只用于这一次登录，不会保存在本机；勾选告知后会直接提交给学校统一身份认证。</p>');
}

async function submitAcademicPassword() {
    bindToggleError('');
    var risk = bindById('acBindRisk');
    if (!risk || !risk.checked) { bindToggleError('请先勾选风险告知'); return; }
    var sidEl = bindById('acBindStudentId');
    var pwdEl = bindById('acBindPassword');
    var sid = (sidEl && sidEl.value || '').trim();
    var pwd = pwdEl ? pwdEl.value : '';
    if (!sid || !pwd) { bindToggleError('请填写学号和密码'); return; }
    try { localStorage.setItem(BIND_RISK_ACK_KEY, '1'); } catch (e) {}
    var btn = document.querySelector('#accountBindBody [data-act="academic-bind-password"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    try {
        var res = await api('/api/academic/login', {
            method: 'POST',
            body: JSON.stringify({ student_id: sid, password: pwd })
        });
        var d = res.data || {};
        if (pwdEl) pwdEl.value = '';
        if (d.mfaRequired) { enterAcademicMfaStep(d); return; }
        closeBindModal();
        await loadAcademicBinding();
        bindFlash('教务系统绑定成功');
    } catch (err) {
        if (err && err.code === 'ACADEMIC_CONSENT_REQUIRED') {
            bindToggleError('尚未开启教务授权，请先在「用户协议与授权」中开启');
        } else {
            bindToggleError((err && err.message) || '登录失败');
        }
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '登录并绑定'; }
    }
}

function enterAcademicMfaStep(d) {
    bindMfaToken = d.token || '';
    var tip = '统一身份认证要求二次验证（' + (d.method || '验证码') + '）';
    if (d.contact) tip += '，验证码将发送到 ' + d.contact;
    tip += '。点下面的「获取验证码」即可收到。';
    openBindModal('二次验证', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-text" id="acBindMfaStatus" hidden></p>'
        + '<p class="bind-text">' + esc(tip) + '</p>'
        + '<div class="form-field"><label class="form-label" for="acBindMfaCode">验证码</label>'
        + '<input class="form-input" id="acBindMfaCode" type="text" inputmode="numeric" autocomplete="one-time-code" placeholder="短信验证码"></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-outline" type="button" id="acBindMfaSendBtn" data-act="academic-mfa-send">获取验证码</button>'
        + '<button class="btn btn-primary" type="button" data-act="academic-mfa-verify">完成绑定</button>'
        + '</div>'
        + '<button class="btn btn-outline btn-block" type="button" data-act="academic-bind-back">返回上一步</button>');
    var code = bindById('acBindMfaCode');
    if (code) code.focus();
}

async function sendAcademicMfa() {
    if (!bindMfaToken) { bindToggleError('二次验证已超时，请返回上一步重新输入'); return; }
    var btn = bindById('acBindMfaSendBtn');
    if (btn) { btn.disabled = true; btn.textContent = '发送中…'; }
    try {
        var res = await api('/api/academic/mfa/send', { method: 'POST', body: JSON.stringify({ token: bindMfaToken }) });
        var d = res.data || {};
        // 提示要出现在弹窗里：bindFlash 在页面卡片上，弹窗打开时用户看不到。
        var status = bindById('acBindMfaStatus');
        if (status) {
            status.hidden = false;
            status.textContent = '验证码已发送' + (d.mobile ? '至 ' + d.mobile : '') + '，请查收';
        }
        startBindMfaCountdown(60);
    } catch (err) {
        bindToggleError((err && err.message) || '发送失败');
        if (btn) { btn.disabled = false; btn.textContent = '获取验证码'; }
    }
}

function startBindMfaCountdown(seconds) {
    var btn = bindById('acBindMfaSendBtn');
    var left = seconds;
    if (bindMfaTimer) clearInterval(bindMfaTimer);
    if (!btn) return;
    btn.disabled = true;
    btn.textContent = left + 's 后重发';
    bindMfaTimer = setInterval(function () {
        left -= 1;
        if (left <= 0) {
            clearInterval(bindMfaTimer);
            bindMfaTimer = null;
            if (btn) { btn.disabled = false; btn.textContent = '重新获取'; }
            return;
        }
        if (btn) btn.textContent = left + 's 后重发';
    }, 1000);
}

async function verifyAcademicMfa() {
    bindToggleError('');
    var codeEl = bindById('acBindMfaCode');
    var code = (codeEl && codeEl.value || '').trim();
    if (!code) { bindToggleError('请填写验证码'); return; }
    if (!bindMfaToken) { bindToggleError('二次验证已超时，请返回上一步重新输入'); return; }
    var btn = document.querySelector('#accountBindBody [data-act="academic-mfa-verify"]');
    if (btn) { btn.disabled = true; btn.textContent = '验证中…'; }
    try {
        await api('/api/academic/mfa/verify', { method: 'POST', body: JSON.stringify({ token: bindMfaToken, code: code }) });
        closeBindModal();
        await loadAcademicBinding();
        bindFlash('教务系统绑定成功');
    } catch (err) {
        bindToggleError((err && err.message) || '验证失败');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '完成绑定'; }
    }
}

/** 从用户粘贴内容里提取 Cookie：裸串 / Cookie: 头 / curl -H·-b 三种都支持 */
function extractBindCookie(text) {
    var raw = String(text || '').replace(/\r/g, '').trim();
    if (!raw) return '';
    var m = raw.match(/(?:-H|--header)\s+['"]Cookie:\s*([^'"]+)['"]/i)
        || raw.match(/(?:-b|--cookie)\s+['"]([^'"]+)['"]/i);
    if (m) return m[1].trim();
    m = raw.match(/^\s*cookie:\s*(.+)$/im);
    if (m) return m[1].trim();
    return raw;
}

function openAcademicCookieStep() {
    openBindModal('粘贴教务 Cookie', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-text">在已登录教务系统的浏览器里打开开发者工具 → Network，任选一个请求，复制请求头里的 Cookie 整行粘贴到这里。</p>'
        + '<div class="form-field"><label class="form-label" for="acBindCookie">Cookie</label>'
        + '<textarea class="form-input" id="acBindCookie" rows="5" placeholder="JSESSIONID=...; route=..."></textarea></div>'
        + bindRiskAckHTML()
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="academic-bind-cookie">提交绑定</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">Cookie 只用于读取数据；如果教务登录态过期，需要重新获取。</p>');
}

async function submitAcademicCookie() {
    bindToggleError('');
    var risk = bindById('acBindRisk');
    if (!risk || !risk.checked) { bindToggleError('请先勾选风险告知'); return; }
    var input = bindById('acBindCookie');
    var cookies = extractBindCookie(input && input.value);
    if (!cookies) { bindToggleError('请先粘贴教务系统的 Cookie'); return; }
    var btn = document.querySelector('#accountBindBody [data-act="academic-bind-cookie"]');
    if (btn) { btn.disabled = true; btn.textContent = '绑定中…'; }
    try { localStorage.setItem(BIND_RISK_ACK_KEY, '1'); } catch (e) {}
    try {
        await api('/api/academic/bind', { method: 'POST', body: JSON.stringify({ cookies: cookies }) });
        closeBindModal();
        await loadAcademicBinding();
        bindFlash('教务系统绑定成功');
    } catch (err) {
        bindToggleError((err && err.message) || '绑定失败');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '提交绑定'; }
    }
}

// ===== 学习通绑定 =====
function beginChaoxingBind(mode) {
    if (mode === 'app') { startChaoxingAppLogin(); return; }
    if (mode === 'cookie') { openChaoxingCookieStep(); return; }
    openChaoxingPasswordStep();
}

function startChaoxingAppLogin() {
    if (!bindNativeChaoxing()) {
        bindFlash('当前不在 App 内（或 App 版本过旧），请改用账号密码或粘贴 Cookie。');
        return;
    }
    try { window.CAHost.startChaoxingLogin(); } catch (err) { bindFlash('无法打开学习通登录小窗。'); }
}

function openChaoxingPasswordStep() {
    openBindModal('学习通账号登录', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<div class="form-field"><label class="form-label" for="cxAccount">学习通账号</label>'
        + '<input class="form-input" id="cxAccount" type="text" autocomplete="username" placeholder="手机号或学习通账号"></div>'
        + '<div class="form-field"><label class="form-label" for="cxPassword">密码</label>'
        + '<input class="form-input" id="cxPassword" type="password" autocomplete="current-password" placeholder="学习通密码"></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="chaoxing-bind-password">登录并绑定</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">学习通触发人机验证时，网页端无法完成，请改用「App 内登录」或粘贴 Cookie。</p>');
}

async function submitChaoxingPassword() {
    bindToggleError('');
    var accEl = bindById('cxAccount');
    var pwdEl = bindById('cxPassword');
    var account = (accEl && accEl.value || '').trim();
    var password = pwdEl ? pwdEl.value : '';
    if (!account || !password) { bindToggleError('请填写学习通账号和密码'); return; }
    var btn = document.querySelector('#accountBindBody [data-act="chaoxing-bind-password"]');
    if (btn) { btn.disabled = true; btn.textContent = '登录中…'; }
    try {
        await api('/api/chaoxing/login', { method: 'POST', body: JSON.stringify({ account: account, password: password }) });
        closeBindModal();
        await loadChaoxingBinding();
        bindFlash('学习通绑定成功');
    } catch (err) {
        if (err && err.code === 'CHAOXING_NEED_CAPTCHA') {
            openBindModal('学习通需要人机验证', ''
                + '<div class="form-error show" id="bindModalError">学习通要求人机验证，网页端无法完成。</div>'
                + '<p class="bind-text">请改用 App 内登录（真实登录页可完成验证码/滑块），或粘贴浏览器里的 Cookie。</p>'
                + '<div class="bind-actions">'
                + '<button class="btn btn-primary" type="button" data-act="begin-chaoxing-bind" data-arg="app">App 内登录</button>'
                + '<button class="btn btn-outline" type="button" data-act="begin-chaoxing-bind" data-arg="cookie">粘贴 Cookie</button>'
                + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
                + '</div>');
            return;
        }
        bindToggleError((err && err.message) || '登录失败');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '登录并绑定'; }
    }
}

function openChaoxingCookieStep() {
    openBindModal('粘贴学习通 Cookie', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-text">在已登录学习通的浏览器里复制 i.chaoxing.com 的 Cookie 整行。粘贴后先预览身份，确认无误才会保存。</p>'
        + '<div class="form-field"><label class="form-label" for="cxCookie">Cookie</label>'
        + '<textarea class="form-input" id="cxCookie" rows="5" placeholder="_uid=...; _d=...; fid=1433; ..."></textarea></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="chaoxing-bind-cookie">预览身份</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">学习通 Cookie 会先经服务端校验并返回姓名与课程数，预览阶段不会写入绑定。</p>');
}

async function submitChaoxingCookie() {
    bindToggleError('');
    var input = bindById('cxCookie');
    var cookies = extractBindCookie(input && input.value);
    if (!cookies) { bindToggleError('请先粘贴学习通 Cookie'); return; }
    await previewChaoxingBind(cookies, '');
}

async function previewChaoxingBind(cookies, account) {
    bindCxPreview = { cookies: cookies, account: account || '', realName: '', courseCount: 0, matched: null };
    openBindModal('确认学习通身份', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-hint">正在读取学习通身份…</p>');
    try {
        var res = await api('/api/chaoxing/bind/preview', {
            method: 'POST',
            body: JSON.stringify({ cookies: cookies, account: account || '' })
        });
        var d = res.data || {};
        bindCxPreview = {
            cookies: cookies,
            account: d.account || account || '',
            realName: d.realName || '',
            courseCount: d.courseCount || 0,
            matched: (d.matched === undefined ? null : d.matched)
        };
        renderChaoxingPreview(bindCxPreview);
    } catch (err) {
        if (err && err.code === 'CHAOXING_CONSENT_REQUIRED') {
            openBindModal('需要开启学习通授权', ''
                + '<p class="bind-text">还没有开启「学习通」授权。开启后才能预览与保存学习通绑定。</p>'
                + '<div class="form-error" id="bindModalError"></div>'
                + '<div class="bind-actions">'
                + '<button class="btn btn-primary" type="button" data-act="open-consent">去开启授权</button>'
                + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
                + '</div>');
            return;
        }
        openBindModal('无法读取学习通身份', ''
            + '<div class="form-error show" id="bindModalError">' + esc((err && err.message) || '预览失败') + '</div>'
            + '<div class="bind-actions">'
            + '<button class="btn btn-primary" type="button" data-act="chaoxing-preview-retry">重试</button>'
            + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
            + '</div>');
    }
}

function renderChaoxingPreview(d) {
    var matched = d.matched;
    var canConfirm = matched !== false;
    var identity = ''
        + '<div class="bind-identity bind-identity-preview">'
        + '<span class="bind-avatar" aria-hidden="true">' + esc(d.realName ? String(d.realName).charAt(0) : '通') + '</span>'
        + '<div class="bind-identity-main"><p class="bind-name">' + (d.realName ? esc(d.realName) : '未读取到姓名') + '</p>'
        + '<p class="bind-id">' + (d.account ? '账号 ' + esc(d.account) + ' · ' : '')
        + '识别到 ' + (Number(d.courseCount) || 0) + ' 门课程</p></div>'
        + '</div>';
    var warn = '';
    if (matched === false) {
        warn = '<p class="bind-warn">识别到的姓名与你的班级账号姓名不一致，绑定会被拒绝。请确认登录的是自己的学习通账号。</p>';
    } else if (!d.realName) {
        warn = '<label class="consent-check bind-risk"><input type="checkbox" id="cxRiskWarn">'
            + '<span>没有读取到姓名，无法自动核对身份。我确认这是我本人的学习通账号。</span></label>';
    }
    openBindModal('确认学习通身份', ''
        + '<p class="bind-text">请确认这是你本人的学习通账号，确认后才会保存绑定。</p>'
        + identity
        + '<div class="info-list bind-meta"><div class="info-row"><span class="k">姓名比对</span><span class="v">'
        + (matched === true ? '一致' : (matched === false ? '不一致' : '未取到姓名，需手动确认'))
        + '</span></div></div>'
        + warn
        + '<div class="form-error" id="bindModalError"></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="chaoxing-bind-confirm"' + (canConfirm ? '' : ' disabled') + '>确认绑定</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">姓名比对是弱校验：学习通可能不返回姓名，或返回的姓名与班级账号不完全一致。绑定后随时可解绑。</p>');
}

async function confirmChaoxingBind() {
    bindToggleError('');
    var warn = bindById('cxRiskWarn');
    if (warn && !warn.checked) { bindToggleError('请先勾选确认'); return; }
    if (!bindCxPreview || !bindCxPreview.cookies) { bindToggleError('登录信息已失效，请重新登录学习通'); return; }
    var btn = document.querySelector('#accountBindBody [data-act="chaoxing-bind-confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = '绑定中…'; }
    try {
        await api('/api/chaoxing/bind', {
            method: 'POST',
            body: JSON.stringify({ cookies: bindCxPreview.cookies, account: bindCxPreview.account })
        });
        closeBindModal();
        await loadChaoxingBinding();
        bindFlash('学习通绑定成功');
    } catch (err) {
        bindToggleError((err && err.message) || '绑定失败');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = '确认绑定'; }
    }
}

// App 原生小窗登录完成后的回传入口（顶层壳里 app.js 会转发到本 iframe）
function handleChaoxingCookies(cookies) {
    if (!cookies || typeof cookies !== 'string') return;
    previewChaoxingBind(cookies.trim(), '');
}
window.__caChaoxingCookies = handleChaoxingCookies;
window.__caChaoxingCancel = function () {
    closeBindModal();
    bindFlash('已取消学习通登录');
};

// 中国大学MOOC 的原生回传入口：App 内的登录小窗成功后，原生把整条 Cookie 交给这里。
// 与学习通同一套转发链（原生 evaluateJavascript 只执行顶层文档，个人页在 #frameAccount
// iframe 里，app.js 先转到本 iframe 再落到这个函数），所以两个挂在同一处方便对照。
function handleMoocCookies(cookies) {
    if (!cookies || typeof cookies !== 'string') return;
    var trimmed = cookies.trim();
    if (!trimmed) return;
    bindMoocWithCookies(trimmed);
}
window.__caMoocCookies = handleMoocCookies;
window.__caMoocCancel = function () {
    closeBindModal();
    bindFlash('已取消中国大学MOOC登录');
};

// ===== 中国大学MOOC 绑定 =====
// 与学习通不同，MOOC 没有账号密码接口（后端 /login 恒 501），绑定只有一条落库路径：
// POST /api/mooc/bind { cookies }，由服务端读一次课程列表验证登录态。Cookie 从哪来分两种：
//   - App 内：原生小窗打开 icourse163 真实登录页（CAHost.startMoocLogin），登录完成后原生
//     把整条 Cookie 回传本页（__caMoocCookies）；
//   - 网页版：跨域读不到 icourse163 的 Cookie（登录页在 reg.icourse163.org 的 SPA iframe 里），
//     只能让用户自己在浏览器登录后粘贴。
// 两条路共用 bindMoocWithCookies，失败文案也只写一份，避免「App 内」和「粘贴」两种入口
// 各说一套、改一处漏一处。
//
// 这里不学学习通的「先预览身份、再确认落库」（issue #107）：MOOC 的 /bind 本身就要读课程
// 列表，成功即证明登录态有效；失败的 /bind 不落库，也就不存在「预览通过、确认时已失效」的
// 中间窗口，多一步只会让 App 内登录回传之后还要用户再点一次确认。
function beginMoocBind(mode) {
    var c = consentData && consentData.consent;
    // 本地已知没开 MOOC 授权时先拦一下，省一次必然 403 的请求；状态没取到就不拦，
    // 交给服务端判定（保证「取不到授权状态」不会把绑定入口锁死）。两条路都要先过这一关：
    // 授权关着时连原生登录页都不该打开 —— 用户登录完照样会拿到 403。
    if (c && !c.mooc) { openMoocConsentPrompt(''); return; }
    if (mode === 'app') { startMoocAppLogin(); return; }
    openMoocCookieStep();
}

function startMoocAppLogin() {
    if (!bindNativeMooc()) {
        // 网页版没有这个桥、旧版 App 也没有：明确告诉用户退回粘贴，而不是点了没反应。
        bindFlash('当前不在 App 内（或 App 版本过旧），请改用粘贴 Cookie。');
        return;
    }
    try { window.CAHost.startMoocLogin(); } catch (err) { bindFlash('无法打开中国大学MOOC登录小窗。'); }
}

/** 授权被关时的统一提示：入口预检查与 /bind 回 403 都走这里，文案只维护一份 */
function openMoocConsentPrompt(message) {
    openBindModal('需要开启中国大学MOOC授权', ''
        + '<p class="bind-text">' + esc(message || '还没有开启「使用身份登录中国大学MOOC」授权。开启后才能绑定 MOOC 账号、读取课程与作业。') + '</p>'
        + '<div class="form-error" id="bindModalError"></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="open-consent">去开启授权</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>');
}

/** /bind 失败的统一文案：服务端 message + 仅在凭据失效时补一句行动指引 */
function moocBindErrorText(err) {
    // MOOC_EXPIRED / MISSING_COOKIES：Cookie 不是有效登录态，提示重新登录再复制；
    // 错误文案已由服务端写清，这里只在末尾补一句行动指引，不重复整段解释。
    var suffix = (err && (err.code === 'MOOC_EXPIRED' || err.code === 'MISSING_COOKIES'))
        ? '请重新登录后再试，或重新粘贴新的 Cookie。' : '';
    return ((err && err.message) || '绑定失败') + (suffix ? '（' + suffix + '）' : '');
}

/**
 * 两条路共用：拿到整条 Cookie（原生回传 / 用户粘贴）后落库。
 *
 * 先切到绑定页并开一个「正在绑定」弹窗：原生登录窗关闭后焦点已经回到本页，如果什么都不
 * 显示，用户会以为按钮没生效；/bind 要真出网读一次课程列表，通常要几秒。
 *
 * 失败后不复用旧 Cookie 重试：MOOC_EXPIRED 说明这份凭据已经不可用，再点只会重复同一个
 * 错误；直接给「App 重新登录 / 重新粘贴」入口，让用户换一份。授权类失败单独走授权弹窗，
 * 因为那不是 Cookie 的问题，换十份 Cookie 也没用。
 */
async function bindMoocWithCookies(cookies) {
    openBindModal('正在绑定中国大学MOOC', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-hint">正在验证中国大学MOOC登录态，并读取课程列表…</p>');
    try {
        var res = await api('/api/mooc/bind', { method: 'POST', body: JSON.stringify({ cookies: cookies }) });
        var bound = (res && res.data) || {};
        closeBindModal();
        await loadMoocBinding();
        // 把服务端读出来的账号带进提示：App 内登录时用户可能没看清小窗里提示的是哪个账号，
        // 绑定成功后至少能在页面上确认一次（1.4.5 的教训是绑错号用户完全无感）。
        bindFlash('中国大学MOOC绑定成功' + (bound.realName || bound.account ? '：' + (bound.realName || bound.account) : ''));
    } catch (err) {
        if (err && err.code === 'MOOC_CONSENT_REQUIRED') { openMoocConsentPrompt(err && err.message); return; }
        var native = bindNativeMooc();
        openBindModal('无法绑定中国大学MOOC', ''
            + '<div class="form-error show" id="bindModalError">' + esc(moocBindErrorText(err)) + '</div>'
            + '<div class="bind-actions">'
            + (native ? '<button class="btn btn-primary" type="button" data-act="begin-mooc-bind" data-arg="app">App 重新登录</button>' : '')
            + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-mooc-bind" data-arg="cookie">重新粘贴 Cookie</button>'
            + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
            + '</div>');
    }
}

function openMoocCookieStep() {
    openBindModal('绑定中国大学MOOC', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-text">请先在浏览器打开 <strong>www.icourse163.org</strong> 并登录，'
        + '再打开开发者工具 → Network，任选一个请求，把请求头里的 Cookie 整行粘贴到这里。</p>'
        + '<div class="form-field"><label class="form-label" for="moocCookie">Cookie</label>'
        + '<textarea class="form-input" id="moocCookie" rows="5" placeholder="NTESSTUDYSI=...; P_INFO=...; ..."></textarea></div>'
        + '<div class="bind-actions">'
        + '<button class="btn btn-primary" type="button" data-act="mooc-bind-cookie">验证并绑定</button>'
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>'
        + '<p class="bind-hint">服务端会用这份 Cookie 读一次课程列表来验证登录态，验证通过才保存；'
        + 'Cookie 过期时会提示重新登录，不会拿旧凭据反复重试。</p>');
}

async function submitMoocCookie() {
    bindToggleError('');
    var input = bindById('moocCookie');
    var cookies = extractBindCookie(input && input.value);
    if (!cookies) { bindToggleError('请先粘贴中国大学MOOC的 Cookie'); return; }
    // 按钮不必自己 disabled：bindMoocWithCookies 会立刻把弹窗内容换成「正在绑定」，
    // 原来的「验证并绑定」按钮已经从 DOM 里消失，点不出第二次。
    await bindMoocWithCookies(cookies);
}

// ===== 解绑 =====
function askUnbind(kind) {
    var academic = kind === 'academic';
    var mooc = kind === 'mooc';
    var title = academic ? '解绑教务系统' : (mooc ? '解绑中国大学MOOC' : '解绑学习通');
    var desc = academic
        ? '解绑后会清除本机缓存的课表、学分与成绩数据。'
        : (mooc
            ? '解绑后会清除服务端保存的 MOOC 登录凭据与课程缓存，MOOC 作业不再自动进待办。'
            : '解绑后会清除服务端保存的学习通登录凭据与课程缓存。');
    // data-act 必须写成字面量：CSP 测试会静态扫描页面/脚本里的 data-act 与委托注册是否双向对齐，
    // 拼出来的动作名它认不出来（会报「没有委托注册」），所以三个分支各写一条完整按钮。
    var confirmBtn = academic
        ? '<button class="btn btn-danger" type="button" data-act="academic-unbind-confirm">确认解绑</button>'
        : (mooc
            ? '<button class="btn btn-danger" type="button" data-act="mooc-unbind-confirm">确认解绑</button>'
            : '<button class="btn btn-danger" type="button" data-act="chaoxing-unbind-confirm">确认解绑</button>');
    openBindModal(title, ''
        + '<p class="bind-text">' + desc + '</p>'
        + '<div class="form-error" id="bindModalError"></div>'
        + '<div class="bind-actions">'
        + confirmBtn
        + '<button class="btn btn-outline" type="button" data-act="close-account-bind">取消</button>'
        + '</div>');
}

async function doUnbindAcademic() {
    bindToggleError('');
    var btn = document.querySelector('#accountBindBody [data-act="academic-unbind-confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = '解绑中…'; }
    try {
        await api('/api/academic/bind', { method: 'DELETE' });
        closeBindModal();
        await loadAcademicBinding();
        bindFlash('教务系统已解绑');
    } catch (err) {
        bindToggleError((err && err.message) || '解绑失败');
        if (btn) { btn.disabled = false; btn.textContent = '确认解绑'; }
    }
}

async function doUnbindChaoxing() {
    bindToggleError('');
    var btn = document.querySelector('#accountBindBody [data-act="chaoxing-unbind-confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = '解绑中…'; }
    try {
        await api('/api/chaoxing/bind', { method: 'DELETE' });
        closeBindModal();
        await loadChaoxingBinding();
        bindFlash('学习通已解绑');
    } catch (err) {
        bindToggleError((err && err.message) || '解绑失败');
        if (btn) { btn.disabled = false; btn.textContent = '确认解绑'; }
    }
}

async function doUnbindMooc() {
    bindToggleError('');
    var btn = document.querySelector('#accountBindBody [data-act="mooc-unbind-confirm"]');
    if (btn) { btn.disabled = true; btn.textContent = '解绑中…'; }
    try {
        await api('/api/mooc/bind', { method: 'DELETE' });
        closeBindModal();
        await loadMoocBinding();
        bindFlash('中国大学MOOC已解绑');
    } catch (err) {
        bindToggleError((err && err.message) || '解绑失败');
        if (btn) { btn.disabled = false; btn.textContent = '确认解绑'; }
    }
}

// ===== 初始化：App 登录返回后自动落到「账号绑定」 =====
(function initAccountBinding() {
    var pending = '';
    try {
        pending = localStorage.getItem(BIND_PENDING_KEY) || '';
        if (pending) localStorage.removeItem(BIND_PENDING_KEY);
    } catch (e) {}
    var wantBinding = pending === 'academic' || location.hash === '#binding';
    // 预载的个人中心在 display:none 里初始化，两个滑块的宽度都量不到；
    // 外壳显示这一页时会通知一次（见 app.js 的 onFrameShown）。
    // 主题分段的滑块在它自己的 IIFE 里已经登记过，这里只补这两个页签的。
    if (wantBinding) {
    } else {
        loadAcademicBinding();
        loadChaoxingBinding();
        loadMoocBinding();
    }
    var modal = bindById('accountBindModal');
    if (modal) {
        modal.addEventListener('click', function (e) { if (e.target === modal) closeBindModal(); });
        document.addEventListener('keydown', function (e) {
            if (e.key === 'Escape' && modal.classList.contains('show')) closeBindModal();
        });
    }
})();

// ===== 事件绑定（本页）=====
delegate(document, 'click', '[data-act="refresh-account-bindings"]', function () {
    loadAcademicBinding();
    loadChaoxingBinding();
    loadMoocBinding();
});
delegate(document, 'click', '[data-act="begin-academic-bind"]', function (el) { beginAcademicBind(el.getAttribute('data-arg')); });
delegate(document, 'click', '[data-act="academic-app-login-continue"]', function () {
    var risk = bindById('acBindRisk');
    if (!risk || !risk.checked) { bindToggleError('请先勾选风险告知'); return; }
    try { localStorage.setItem(BIND_RISK_ACK_KEY, '1'); } catch (e) {}
    closeBindModal();
    launchAcademicAppLogin();
});
delegate(document, 'click', '[data-act="begin-chaoxing-bind"]', function (el) { beginChaoxingBind(el.getAttribute('data-arg')); });
delegate(document, 'click', '[data-act="close-account-bind"]', function () { closeBindModal(); });
delegate(document, 'click', '[data-act="academic-bind-password"]', function () { submitAcademicPassword(); });
delegate(document, 'click', '[data-act="academic-mfa-send"]', function () { sendAcademicMfa(); });
delegate(document, 'click', '[data-act="academic-mfa-verify"]', function () { verifyAcademicMfa(); });
delegate(document, 'click', '[data-act="academic-bind-back"]', function () { openAcademicPasswordStep(); });
delegate(document, 'click', '[data-act="academic-bind-cookie"]', function () { submitAcademicCookie(); });
delegate(document, 'click', '[data-act="chaoxing-bind-password"]', function () { submitChaoxingPassword(); });
delegate(document, 'click', '[data-act="chaoxing-bind-cookie"]', function () { submitChaoxingCookie(); });
delegate(document, 'click', '[data-act="chaoxing-preview-retry"]', function () {
    if (bindCxPreview && bindCxPreview.cookies) previewChaoxingBind(bindCxPreview.cookies, bindCxPreview.account);
});
delegate(document, 'click', '[data-act="chaoxing-bind-confirm"]', function () { confirmChaoxingBind(); });
delegate(document, 'click', '[data-act="academic-unbind"]', function () { askUnbind('academic'); });
delegate(document, 'click', '[data-act="chaoxing-unbind"]', function () { askUnbind('chaoxing'); });
delegate(document, 'click', '[data-act="mooc-unbind"]', function () { askUnbind('mooc'); });
delegate(document, 'click', '[data-act="academic-unbind-confirm"]', function () { doUnbindAcademic(); });
delegate(document, 'click', '[data-act="chaoxing-unbind-confirm"]', function () { doUnbindChaoxing(); });
delegate(document, 'click', '[data-act="mooc-unbind-confirm"]', function () { doUnbindMooc(); });
delegate(document, 'click', '[data-act="begin-mooc-bind"]', function (el) { beginMoocBind(el.getAttribute('data-arg')); });
delegate(document, 'click', '[data-act="mooc-bind-cookie"]', function () { submitMoocCookie(); });
delegate(document, 'click', '[data-act="open-consent"]', function () {
    closeBindModal();
    openConsentManage();
});
})();
