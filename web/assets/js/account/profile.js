(function () {
// 个人中心 · 账号与资料
// 内容：联系方式、邮箱（绑定 / 验证 / 订阅）、修改密码、退出登录。
// ===== 修改联系方式（本人可改自己的） =====
function openContactEdit() {
    var err = document.getElementById('contactError');
    err.classList.remove('show');
    document.getElementById('contactInput').value = currentContact;
    document.getElementById('contactModal').classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeContactEdit() {
    document.getElementById('contactModal').classList.remove('show');
    document.body.style.overflow = '';
}
async function saveContact() {
    var err = document.getElementById('contactError');
    err.classList.remove('show');
    var value = document.getElementById('contactInput').value.trim();
    if (value.length > 60) {
        err.textContent = '联系方式最多 60 个字符';
        err.classList.add('show');
        return;
    }
    var btn = document.getElementById('contactSaveBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '保存中…';
    try {
        await api('/api/auth/profile', { method: 'PUT', body: JSON.stringify({ contact: value }) });
        // 同步本地会话缓存，避免其它页面读到旧的联系方式
        try {
            var u = getSession() || {};
            u.contact = value;
            localStorage.setItem(LS_USER, JSON.stringify(u));
        } catch (e) {}
        closeContactEdit();
        window.caLoadProfile();
    } catch (e) {
        err.textContent = e.message;
        err.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}
// 点遮罩 / 按 ESC 关闭；输入框回车即保存（空值守卫：节点漂移时别让这段把文件后半段绑定打死，issue #84 项 6）
(function bindContactModal() {
    var overlay = document.getElementById('contactModal');
    if (!overlay) return;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeContactEdit(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('show')) closeContactEdit();
    });
    document.getElementById('contactInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); saveContact(); }
    });
})();


// ===== 邮箱（绑定 / 验证 / 解绑）=====
// 两步：填邮箱 → 发验证码 → 填码。点「发送验证码」这一刻后端就把邮箱记成「已填未验证」，
// 只有验码通过才置为已验证 —— 所以弹窗标题要如实把这三种状态分开显示，别混成「已绑定」。
// 已验证的邮箱弹窗里只读（不发码、不给验证码区），想换邮箱得先解绑再绑。
// 忘记密码的重置接口（/api/auth/forgot/*）本期只有后端，页面没做流程（见 index.html 登录页的提示）。
var currentEmail = '';
var currentEmailVerified = false;

/**
 * 邮箱那一格的内容：只显示地址；验证状态徽章已挪到弹窗标题后（见 openEmailEdit），
 * 资料卡这行不再重复放徽章 —— 一行一个信息点，状态进弹窗里看。
 */
function emailCellHTML(u) {
    if (!u.email) return '<span>未绑定</span>';
    return '<span>' + esc(u.email) + '</span>';
}

function openEmailEdit() {
    var err = document.getElementById('emailError');
    err.classList.remove('show');
    err.textContent = '';
    // 状态徽章挂在弹窗标题后：已验证绿、未验证灰、未绑定不显示（没有状态可言）
    var badge = document.getElementById('emailTitleBadge');
    if (currentEmail && currentEmailVerified) {
        badge.className = 'badge badge-ok';
        badge.textContent = '已验证';
        badge.hidden = false;
    } else if (currentEmail) {
        badge.className = 'badge badge-muted';
        badge.textContent = '未验证';
        badge.hidden = false;
    } else {
        badge.hidden = true;
    }
    // 已验证 = 邮箱已锁定：输入框只读、不再给发码/验证码区（换邮箱先解绑再绑，见下）
    var verified = currentEmail && currentEmailVerified;
    var input = document.getElementById('emailInput');
    input.disabled = verified;
    input.value = currentEmail || '';
    // 未验证时重开弹窗，清掉上次的验证码输入（那个码可能已被用掉或过期，留着反而误导）
    var codeSection = document.getElementById('emailCodeSection');
    codeSection.hidden = verified;
    if (!verified) document.getElementById('emailCodeInput').value = '';
    // 底部「保存」两种状态下都在，所以这里不再按状态隐藏它：未验证＝验码完成绑定，
    // 已验证＝保存订阅开关（分发见 saveEmailCard）。已验证时下面没有码可提交，
    // 它就是这个弹窗里唯一的提交按钮，藏了就只剩「取消」。
    var unbindRow = document.getElementById('emailUnbindRow');
    if (unbindRow) unbindRow.hidden = !verified;
    // 订阅区只对已验证的邮箱开放；打开时拉一次最新订阅（别的端改过也能同步到）
    var subSection = document.getElementById('emailSubSection');
    if (subSection) {
        subSection.hidden = !verified;
        if (verified) loadEmailSubscriptions();
    }
    document.getElementById('emailModal').classList.add('show');
    // 锁住背后的页面（同联系方式弹窗）：弹窗是 fixed 覆盖层，不锁的话手指落在弹窗上滑动
    // 会把后面的卡片一起带着滚，看起来像「弹窗没盖住」
    document.body.style.overflow = 'hidden';
}

function closeEmailEdit() {
    document.getElementById('emailModal').classList.remove('show');
    document.body.style.overflow = '';
}

function emailError(msg) {
    var err = document.getElementById('emailError');
    err.textContent = msg;
    err.classList.add('show');
}

async function sendEmailCode() {
    var email = document.getElementById('emailInput').value.trim();
    if (!email) { emailError('请先填写邮箱地址'); return; }
    var btn = document.getElementById('emailSendCodeBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '发送中…';
    try {
        await api('/api/auth/email/send-code', { method: 'POST', body: JSON.stringify({ email: email }) });
        emailError('验证码已发送，请查收邮件（10 分钟内有效）');
    } catch (e) {
        // 服务端的 429（1 分钟内发过）/ 409（邮箱被占）/ 503（未配邮件服务）都在这儿如实显示
        emailError(e.message);
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

async function verifyEmail() {
    var email = document.getElementById('emailInput').value.trim();
    var code = document.getElementById('emailCodeInput').value.trim();
    if (!email) { emailError('请先填写邮箱地址'); return; }
    if (!/^\d{6}$/.test(code)) { emailError('请输入 6 位数字验证码'); return; }
    var btn = document.getElementById('emailSaveBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '保存中…';
    try {
        var res = await api('/api/auth/email/verify', { method: 'POST', body: JSON.stringify({ email: email, code: code }) });
        applyEmailUser(res);
        closeEmailEdit();
    } catch (e) {
        emailError(e.message);
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

async function unbindEmail() {
    if (!window.confirm('解绑后将无法用邮箱找回密码，确定解绑？')) return;
    try {
        var res = await api('/api/auth/email/unbind', { method: 'POST' });
        applyEmailUser(res);
        // 后端已把订阅清零；本地同步成全关，并关掉弹窗 —— 弹窗里那套「已验证」布局
        // 是基于旧状态排的，不重开的话会出现「徽章还绿着、邮箱其实已解绑」的错位
        currentSubs = { activities: false, notices: false, forms: false };
        closeEmailEdit();
    } catch (e) {
        alert(e.message);
    }
}

// ===== 邮箱订阅（活动 / 通知 / 表单）=====
// 只对「已绑且已验证」的邮箱开放，与后端接口的 409 校验同一口径。
// 「全部订阅」与三项分订阅联动：勾全部＝全勾；取消任一分项＝「全部订阅」取消（没全勾就不算全部）。
var currentSubs = { activities: false, notices: false, forms: false };

function subEl(id) { return document.getElementById(id); }
function subKindBox(kind) {
    return { activities: 'subActivities', notices: 'subNotices', forms: 'subForms' }[kind];
}

/** 从后端拉最新订阅，回填开关与「全部订阅」 */
async function loadEmailSubscriptions() {
    // 回填完成前禁用弹窗底部「保存」：currentSubs 还是上次的值（首次是初始全关），
    // 这时候点保存会把没回填的状态覆盖到后端。无论成败都要恢复按钮——
    // 失败时用户按当前开关保存也是自洽的（开关显示的就是当前 UI 状态）。
    var saveBtn = document.getElementById('emailSaveBtn');
    if (saveBtn) saveBtn.disabled = true;
    try {
        var res = await api('/api/auth/email/subscriptions', { method: 'GET' });
        var subs = res && res.data && res.data.subscriptions;
        if (!subs) return;
        currentSubs = {
            activities: !!subs.activities,
            notices: !!subs.notices,
            forms: !!subs.forms
        };
        subEl('subActivities').checked = currentSubs.activities;
        subEl('subNotices').checked = currentSubs.notices;
        subEl('subForms').checked = currentSubs.forms;
        subEl('subAll').checked = allSubsOn();
    } catch (e) {
        // 拉不到就先保持原值，不打断弹窗本身（订阅区本来就是附加信息）
        console.error('读取订阅设置失败:', e);
    } finally {
        if (saveBtn) saveBtn.disabled = false;
    }
}

function allSubsOn() {
    return currentSubs.activities && currentSubs.notices && currentSubs.forms;
}

/** 开了「全部订阅」：三项同步打开 / 关闭。只改本地状态，点弹窗底部「保存」才写后端 */
function applySubAll() {
    currentSubs.activities = subEl('subAll').checked;
    currentSubs.notices = subEl('subAll').checked;
    currentSubs.forms = subEl('subAll').checked;
    subEl('subActivities').checked = currentSubs.activities;
    subEl('subNotices').checked = currentSubs.notices;
    subEl('subForms').checked = currentSubs.forms;
}

/** 开了某一项分订阅：没全开时「全部订阅」跟着关闭。只改本地状态，点弹窗底部「保存」才写后端 */
function applySubOne(kind) {
    currentSubs[kind] = subEl(subKindBox(kind)).checked;
    subEl('subAll').checked = allSubsOn();
}

/**
 * 弹窗底部「保存」的分发：未验证＝提交验证码完成绑定，已验证＝保存订阅开关。
 * 两者共用一个按钮（见 openEmailEdit 里的注释），所以按当前验证状态分流。
 */
function saveEmailCard() {
    if (currentEmailVerified) saveEmailSubscriptions();
    else verifyEmail();
}

/**
 * 已验证态下由底部「保存」调用：把开关结果 POST 给后端；成功后按钮短暂显示「已保存」。
 * 失败要如实说 —— 底部「保存」现在是弹窗里唯一的提交出口，静默失败就等于「点了没反应」。
 */
async function saveEmailSubscriptions() {
    var btn = document.getElementById('emailSaveBtn');
    if (!btn || btn.disabled) return;
    btn.disabled = true;
    var t = btn.textContent;
    btn.textContent = '保存中…';
    try {
        await api('/api/auth/email/subscriptions', {
            method: 'POST',
            body: JSON.stringify(currentSubs)
        });
        btn.textContent = '已保存';
        setTimeout(function () {
            if (btn) { btn.disabled = false; btn.textContent = t; }
        }, 1500);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = t;
        console.error('保存订阅设置失败:', e);
        emailError('保存订阅失败，请稍后重试');
    }
}

/** 接口回的 user 同时刷两处：资料卡，以及本地会话（别的页面读的是后者） */
function applyEmailUser(res) {
    var u = res && res.data && res.data.user;
    if (!u) return;
    window.caRenderProfile(u);
    var s = getSession() || {};
    s.email = u.email;
    s.email_verified = u.email_verified;
    localStorage.setItem(LS_USER, JSON.stringify(s));
}

// 点遮罩 / 按 ESC 关闭；邮箱框回车＝发码，验证码框回车＝验证
(function bindEmailModal() {
    var overlay = document.getElementById('emailModal');
    if (!overlay) return;
    overlay.addEventListener('click', function (e) { if (e.target === overlay) closeEmailEdit(); });
    document.addEventListener('keydown', function (e) {
        if (e.key === 'Escape' && overlay.classList.contains('show')) closeEmailEdit();
    });
    document.getElementById('emailInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); sendEmailCode(); }
    });
    document.getElementById('emailCodeInput').addEventListener('keydown', function (e) {
        if (e.key === 'Enter') { e.preventDefault(); verifyEmail(); }
    });
})();


// ===== 修改密码 =====
var pwdForm = document.getElementById('pwdForm');
if (pwdForm) pwdForm.addEventListener('submit', async function (e) {
    e.preventDefault();
    var errBox = document.getElementById('pwdError');
    errBox.classList.remove('show');
    var old_password = document.getElementById('oldPassword').value;
    var new_password = document.getElementById('newPassword').value;
    var confirm = document.getElementById('confirmPassword').value;
    if (!old_password || !new_password || !confirm) { errBox.textContent = '请填写完整'; errBox.classList.add('show'); return; }
    if (new_password.length < 6) { errBox.textContent = '新密码长度至少 6 位'; errBox.classList.add('show'); return; }
    if (new_password !== confirm) { errBox.textContent = '两次输入的密码不一致'; errBox.classList.add('show'); return; }
    var btn = document.getElementById('pwdBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '提交中…';
    try {
        await api('/api/auth/change-password', { method: 'POST', body: JSON.stringify({ old_password: old_password, new_password: new_password }) });
        errBox.classList.add('show');
        errBox.textContent = '密码修改成功，请重新登录';
        setTimeout(function () { if (window.parent.logout) window.parent.logout(); else { clearSession(); } }, 1200);
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
});

// ===== 事件绑定（本页）=====
// CSP 的 script-src 只放行 'self'：静态按钮与动态生成的资料卡按钮统一用 data-act 标记 + 委托。
delegate(document, 'click', '[data-act="logout"]', function () { window.parent.logout(); });
delegate(document, 'click', '[data-act="open-contact-edit"]', function () { openContactEdit(); });
delegate(document, 'click', '[data-act="close-contact-edit"]', function () { closeContactEdit(); });
delegate(document, 'click', '[data-act="save-contact"]', function () { saveContact(); });
delegate(document, 'click', '[data-act="open-email-edit"]', function () { openEmailEdit(); });
delegate(document, 'click', '[data-act="close-email-edit"]', function () { closeEmailEdit(); });
delegate(document, 'click', '[data-act="send-email-code"]', function () { sendEmailCode(); });
delegate(document, 'click', '[data-act="save-email"]', function () { saveEmailCard(); });
delegate(document, 'click', '[data-act="unbind-email"]', function () { unbindEmail(); });
// 订阅开关：开「全部订阅」三项同步；开任一分项时「全部订阅」按是否全开联动。
// 开关只改本地状态（change），结果由弹窗底部「保存」一并写后端（click → saveEmailCard）
delegate(document, 'change', '[data-act="toggle-sub-all"]', function () { applySubAll(); });
delegate(document, 'change', '[data-act="toggle-sub-one"]', function (el) {
    applySubOne(el.getAttribute('data-kind'));
});
// 资料状态由 core.js 的 renderProfile 递过来（原来同一个文件里是共享变量）
var currentContact = '';
window.caOnProfile = function (u) {
    currentContact = u.contact || '';
    currentEmail = u.email || '';
    currentEmailVerified = !!u.email_verified;
};
// 资料卡上的「编辑 / 管理」按钮：只有本页有对应弹窗，所以由本页渲染（core.js 只在总览页渲染只读卡）
window.caContactBtn = function () {
    return '<button type="button" class="btn btn-outline btn-sm" data-act="open-contact-edit">编辑</button>';
};
window.caEmailBtn = function () {
    return '<button type="button" class="btn btn-outline btn-sm" data-act="open-email-edit">管理</button>';
};
// 资料卡里的邮箱行由这里渲染（core.js 通过 window 回调）
window.caEmailCellHTML = emailCellHTML;
})();
