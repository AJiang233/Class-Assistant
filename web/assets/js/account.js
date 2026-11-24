(function () {
// ===== 需要登录 =====
if (!requireAuth()) return;

// ===== 管理员面板入口（仅手机端显示；无权限则直接移除该卡片） =====
if (!canManagePanel()) {
    var adminEntry = document.getElementById('adminEntryCard');
    if (adminEntry) adminEntry.remove();
}
function openAdmin() {
    try { window.parent.switchView('admin'); } catch (e) {}
}

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
        loadProfile();
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
    renderProfile(u);
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

// ===== 通知（Web Push）=====
// 先做能力判定，再决定给不给按钮。iOS 只有「16.4+ 且已添加到主屏幕」的 PWA 才有推送：
//  - 系统版本过低 → 放弃推送这一项，如实说明（其余功能不受影响），不给死按钮
//  - 没加主屏     → 引导先添加，而不是弹一个必然失败的权限框
// 沿用本项目一贯原则：不支持就直说，不做假的成功反馈。
var pushSub = null;
var pushServerEnabled = false;

// isStandaloneMode() / isIOSDevice() / inNativeShell() 都来自 assets/js/app.js，这里不再重复定义

/** iOS 版本号压成整数比较：16.4 → 1604；iPadOS 13+ 的 UA 冻在 10_15，取不到就返回 null */
function iosVersionCode() {
    var m = /OS (\d+)[._](\d+)/.exec(navigator.userAgent || '');
    if (!m) return null;
    return parseInt(m[1], 10) * 100 + parseInt(m[2], 10);
}
/** 本机是否具备收推送的前提（不含服务端是否配置） */
function detectPushCapability() {
    if (!('serviceWorker' in navigator) || !('Notification' in window)) {
        return { ok: false, status: '此浏览器不支持通知。', hint: '班级消息请在群里查看。' };
    }
    if (isIOSDevice()) {
        var code = iosVersionCode();
        if (code !== null && code < 1604) {
            return {
                ok: false,
                status: '系统版本过低，收不到推送。',
                hint: 'Safari 从 iOS 16.4 起才支持网页通知，你的系统低于这个版本。其余功能不受影响，班级消息请在群里查看。'
            };
        }
        if (!isStandaloneMode()) {
            return {
                ok: false,
                status: '还没添加到主屏幕。',
                hint: 'iPhone 上只有「添加到主屏幕」之后才能收到通知：点底部「分享」按钮 →「添加到主屏幕」，再从桌面图标打开本页即可开启。'
            };
        }
    }
    if (!('PushManager' in window)) {
        return {
            ok: false,
            status: '本机没有可用的推送通道。',
            hint: '系统未提供网页推送能力（iOS / iPadOS 需 16.4 及以上）。其余功能不受影响。'
        };
    }
    return { ok: true, status: '', hint: '' };
}

/** serviceWorker.ready 在没有注册时会一直挂着，加超时避免界面卡在「正在检查」 */
function swRegistration(timeoutMs) {
    var ready = navigator.serviceWorker && navigator.serviceWorker.ready;
    if (!ready) return Promise.resolve(null);
    return Promise.race([
        ready,
        new Promise(function (resolve) { setTimeout(function () { resolve(null); }, timeoutMs || 4000); })
    ]);
}

function urlBase64ToUint8Array(base64) {
    var s = String(base64).replace(/-/g, '+').replace(/_/g, '/');
    var pad = s.length % 4 === 0 ? '' : '===='.slice(0, 4 - (s.length % 4));
    var bin = atob(s + pad);
    var out = new Uint8Array(bin.length);
    for (var i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
    return out;
}

function notifyEl(id) { return document.getElementById(id); }
function showNotifyBtn(id, visible) { var el = notifyEl(id); if (el) el.hidden = !visible; }

async function refreshNotify() {
    // App 壳（安卓 / 鸿蒙）的通知走本地通道，网页推送对它没有意义：
    // 壳里的 WebView 有 serviceWorker / Notification 却没有 PushManager，卡片会显示
    // 「本机没有可用的推送通道」并提 iOS 16.4 —— 对着一个明明能收通知的 App 用户说这话是错的。
    // 所以直接在 App 里撤掉通知这一节（#notifyCard 现在是「偏好设置」卡片里的一个 div，
    // 不是整张卡；App 自己的通知测试在同一个卡片下面的「App 端通知」块里，走 CAHost）。
    // 这段必须在第一个 await 之前：放在后面的话卡片会先画出来再消失。
    // 判定复用 app.js 的 inNativeShell()（只看有没有 CAHost 桥），
    // 这样没带 CAHost.platform 的旧版 App 也能被兜住。
    if (inNativeShell()) {
        var appCard = notifyEl('notifyCard');
        if (appCard) appCard.remove();
        return;
    }
    var statusEl = notifyEl('notifyStatus');
    var hintEl = notifyEl('notifyHint');
    if (!statusEl) return;

    var cap = detectPushCapability();
    pushSub = null;

    if (cap.ok) {
        var reg = await swRegistration();
        try { pushSub = reg ? await reg.pushManager.getSubscription() : null; } catch (e) { pushSub = null; }
    }

    var cfg = null;
    var cfgError = false;
    try { cfg = (await api('/api/push/config')).data; } catch (e) { cfgError = true; }
    pushServerEnabled = !!(cfg && cfg.enabled);

    // 订阅存在就顺手重报一次（issue #80）：endpoint 可能已被轮换 —— iOS 重装主屏 App、
    // 撤销后重新授权、系统清理等都会让 APNs/FCM 换 endpoint，服务端库里那条旧的变成
    // 404/410，页面却只看本地 subscription、照常显示「已开启」，通知就静默失效了。
    // /api/push/subscribe 按 endpoint upsert、天然幂等，代价一次请求；不能指望
    // pushsubscriptionchange（Chromium 系独有，Safari 不派发），只能每次打开重同步。
    // 失败静默：本地订阅仍然有效，下一次打开还会再试。
    if (pushSub && pushServerEnabled) {
        try { await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(pushSub.toJSON()) }); }
        catch (e) { console.warn('重报推送订阅失败（下次打开会再试）：', e); }
    }

    var usable = cap.ok && pushServerEnabled;
    showNotifyBtn('notifyEnableBtn', usable && !pushSub);
    showNotifyBtn('notifyDisableBtn', usable && !!pushSub);
    showNotifyBtn('notifyTestBtn', usable && !!pushSub);

    if (!cap.ok) {
        statusEl.textContent = cap.status;
        hintEl.textContent = cap.hint;
        return;
    }
    if (!pushServerEnabled) {
        statusEl.textContent = cfgError ? '暂时拿不到推送配置。' : '服务端还没开启推送。';
        hintEl.textContent = cfgError
            ? '请检查网络后刷新重试。'
            : '需要管理员在 Cloudflare 上配置 VAPID 密钥后才能使用通知。';
        return;
    }
    if (pushSub) {
        statusEl.textContent = '已开启：班级发布通知时会推送到这台设备。';
        hintEl.textContent = '收不到时，先点「发送测试通知」确认这台设备本身是否正常。';
    } else {
        statusEl.textContent = '未开启：开启后，班级发布通知时会推送到这台设备。';
        hintEl.textContent = '点「开启通知」后系统会弹一次权限询问，选择「允许」即可。';
    }
}

async function enablePush() {
    var hintEl = notifyEl('notifyHint');
    var btn = notifyEl('notifyEnableBtn');
    if (btn) btn.disabled = true;
    hintEl.textContent = '正在开启…';
    try {
        // iOS 要求权限申请必须发生在用户点击手势内，所以先申请权限，再发网络请求
        var perm = await Notification.requestPermission();
        if (perm !== 'granted') {
            hintEl.textContent = perm === 'denied'
                ? '你拒绝了通知权限。可在「设置 → 通知 → 班级助理」里重新允许后再试。'
                : '没有拿到通知权限，暂时无法开启。';
            return;
        }
        var cfg = (await api('/api/push/config')).data;
        if (!cfg || !cfg.enabled || !cfg.public_key) {
            hintEl.textContent = '服务端还没开启推送，请联系管理员。';
            return;
        }
        var reg = await swRegistration();
        if (!reg) {
            hintEl.textContent = '离线组件还没准备好，请刷新页面后重试。';
            return;
        }
        var sub = await reg.pushManager.subscribe({
            userVisibleOnly: true,
            applicationServerKey: urlBase64ToUint8Array(cfg.public_key)
        });
        await api('/api/push/subscribe', { method: 'POST', body: JSON.stringify(sub.toJSON()) });
    } catch (e) {
        // 异常原文（subscribe 失败时是英文 DOMException）只进日志，不给用户看：COPY.md 第 7 节。
        // 这里碰到的不是 api() 的错误 —— 那句是后端按 COPY.md 写好的中文，直接透传没问题；
        // subscribe() 抛的是浏览器自己的话，得翻一道。
        console.error('开启通知失败：', e);
        hintEl.textContent = pushSubscribeError(e);
        if (btn) btn.disabled = false;
        return;
    }
    if (btn) btn.disabled = false;
    await refreshNotify();
    refreshWebTodoStatusFromCache();
    hintEl.textContent = '已开启，建议点一次「发送测试通知」确认能收到。';
}

async function disablePush() {
    var hintEl = notifyEl('notifyHint');
    var btn = notifyEl('notifyDisableBtn');
    if (btn) btn.disabled = true;
    try {
        var reg = await swRegistration();
        var sub = reg ? await reg.pushManager.getSubscription() : null;
        if (sub) {
            await api('/api/push/unsubscribe', { method: 'POST', body: JSON.stringify({ endpoint: sub.endpoint }) });
            await sub.unsubscribe();
        }
    } catch (e) {
        hintEl.textContent = '关闭失败：' + (e && e.message ? e.message : e);
        if (btn) btn.disabled = false;
        return;
    }
    if (btn) btn.disabled = false;
    await refreshNotify();
    refreshWebTodoStatusFromCache();
    hintEl.textContent = '已关闭，这台设备不会再收到推送。';
}

async function testPushSelf() {
    var hintEl = notifyEl('notifyHint');
    var btn = notifyEl('notifyTestBtn');
    if (btn) btn.disabled = true;
    hintEl.textContent = '发送中…';
    try {
        var res = await api('/api/push/test', { method: 'POST' });
        hintEl.textContent = (res && res.data && res.data.message) || '已发送，请查看通知栏。';
    } catch (e) {
        hintEl.textContent = '发送失败：' + (e && e.message ? e.message : e);
    }
    if (btn) btn.disabled = false;
}
refreshNotify();

// ===== 推送通知测试 =====
// 网页本身发不了系统通知，只有 App 壳注入的 CAHost 桥能触发原生通知；
// 网页版（含 PWA）没有这个桥，点了就只给一句提示，不做假的成功反馈。
function pushHint(text) {
    document.getElementById('pushHint').textContent = text || '';
}
// kind（由按钮的 data-arg 传来）→ 对应的按钮 id：通知 / 活动 / 表单各一个
var TEST_PUSH_BTN = { notice: 'testNoticeBtn', activity: 'testActivityBtn', form: 'testFormBtn' };
function testPush(kind) {
    var btn = document.getElementById(TEST_PUSH_BTN[kind]);
    if (!btn) return;
    pushHint('');
    if (!window.CAHost || typeof CAHost.testNotification !== 'function') {
        pushHint('网页版没有系统通知通道，请安装安卓 App 后在本页测试。');
        return;
    }
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '推送中…';
    // 桥方法从「同步阻塞返回结果」改成「立刻返回、结果回调」：原生那边要发网络请求，
    // 同步等会让页面假死最多 35 秒（issue #84 项 17）。回调先挂好，再调桥。
    window.__caTestNotifyResult = function (msg) {
        btn.disabled = false;
        btn.textContent = label;
        pushHint(msg || '已发送，请查看通知栏。');
    };
    try {
        CAHost.testNotification(kind);
    } catch (e) {
        btn.disabled = false;
        btn.textContent = label;
        pushHint('推送失败：' + (e && e.message ? e.message : e));
    }
}

// ===== 本机状态：通知有没有被系统关掉 + 上次同步时间 =====
// 数据来自 App 壳的 CAHost.appStatus()，它返回一个 JSON 字符串：
//   {"notifications":true,"lastSyncAt":1789300000000}
// 用字符串传是刻意的 —— 桥的返回值类型在各端解释不完全一致，字符串最稳；
// 而且两个值一次取回，省掉一次桥调用。网页版没有这个桥 → 两处都不显示。
// 两个值落在两个位置：上次同步时间进资料卡的信息列表（回答「这份数据什么时候新鲜过」，
// 时间写法见 fmtBJTime），通知开关留在「偏好设置 → App 端通知」的两个测试按钮上面 ——
// 被系统关掉后本地提醒会被静默丢弃，用户点测试没反应时看的就是那儿，
// 得把真实原因说清而不是留白。

function readAppStatus() {
    if (!window.CAHost || typeof CAHost.appStatus !== 'function') return null;
    try { return JSON.parse(CAHost.appStatus() || '') || null; } catch (e) { return null; }
}

function refreshAppStatus() {
    var info = readAppStatus();
    // App 端通知整块（本机状态 + 两个测试按钮）默认 hidden：网页版没有桥，放出来点了也没反应，
    // 只有装了安卓 / 鸿蒙 App 才由这里放开。
    var block = notifyEl('appPushBlock');
    if (block) block.hidden = !info;
    // 资料卡里那行默认 hidden（没有桥的网页版就整行不出现）
    var row = notifyEl('appSyncRow');
    var val = notifyEl('appSyncValue');
    if (row) row.hidden = !info;
    if (val) val.textContent = (info && info.lastSyncAt) ? fmtBJTime(info.lastSyncAt) : '还没有成功同步过';
    // lastSyncAt 为 0 = 这台设备一次都没成功同步过（App 每次拉完数据才写）
    var line = notifyEl('appNotifyLine');
    if (line) {
        line.textContent = !info ? '' : (info.notifications
            ? '本机通知：已开启'
            : '本机通知：未开启，收不到任何提醒。请到「系统设置 → 通知」里允许「班级助理」发通知');
    }
}
refreshAppStatus();

// ===== 课程提醒（仅 App 壳）=====
// 上课提醒要到点弹出，网页版没有这个能力（本地排期靠原生的 AlarmManager），
// 设置也存在原生侧，这边只读写。桥返回 JSON 字符串：
//   {"lead":15,"atStart":true,"courseCount":23}
// courseCount 是为了分辨「今天没课」与「本机根本没有课表数据」——
// 用户把开关打开却什么都没发生，得能看出是哪一种，否则只会以为功能坏了。
var COURSE_LEAD_LABEL = {
    0: '不提前提醒', 5: '提前 5 分钟', 10: '提前 10 分钟', 15: '提前 15 分钟',
    20: '提前 20 分钟', 30: '提前 30 分钟', 60: '提前 60 分钟'
};

function readCourseSettings() {
    if (!window.CAHost || typeof CAHost.courseReminderSettings !== 'function') return null;
    try { return JSON.parse(CAHost.courseReminderSettings() || '') || null; } catch (e) { return null; }
}

function renderCourseStatus(info, saved) {
    var el = document.getElementById('courseStatus');
    if (!el) return;
    if (!info) { el.textContent = ''; return; }
    if (!info.courseCount) {
        el.textContent = '还没有课表：先到「学业」绑定教务系统，同步成功后才有可提醒的课。';
        return;
    }
    var lead = COURSE_LEAD_LABEL[info.lead] || ('提前 ' + info.lead + ' 分钟');
    el.textContent = (saved ? '已保存：' : '当前：') + lead
        + (info.atStart ? '，开课时也提醒' : '，开课时不提醒')
        + ' · 已同步 ' + info.courseCount + ' 门课';
}

function refreshCourseCard() {
    var card = document.getElementById('courseCard');
    if (!card) return;
    var info = readCourseSettings();
    if (!info) return;   // 网页版没有这个桥：整块保持隐藏，不给一个点了没反应的设置项
    var leadSel = document.getElementById('courseLead');
    var atStart = document.getElementById('courseAtStart');
    if (leadSel) leadSel.value = String(info.lead);
    if (atStart) atStart.checked = !!info.atStart;
    card.hidden = false;
    renderCourseStatus(info, false);
}

/** 改完即存（没有「保存」按钮）：原生侧会立刻重排闹钟，省一步操作 */
function saveCourseReminder() {
    if (!window.CAHost || typeof CAHost.saveCourseReminderSettings !== 'function') return;
    var leadSel = document.getElementById('courseLead');
    var atStart = document.getElementById('courseAtStart');
    var lead = parseInt(leadSel ? leadSel.value : '0', 10);
    if (isNaN(lead)) lead = 0;
    try {
        var info = JSON.parse(
            CAHost.saveCourseReminderSettings(lead, !!(atStart && atStart.checked)) || ''
        ) || null;
        renderCourseStatus(info, true);
    } catch (e) {
        // 存失败就退回「什么都没写」的状态，别让页面显示一个没生效的值
        refreshCourseCard();
    }
}
refreshCourseCard();

// ===== 待办到期提醒（仅 App 壳）=====
// 与课程提醒同一套路：到点提醒靠原生 AlarmManager，网页版没有这个能力；提前量也存在
// 原生侧（SharedPreferences），这边只读写。桥返回 JSON 字符串：
//   {"lead":60,"todoCount":3}
// todoCount 是本机快照里的「进行中待办」条数，用来分辨「确实没有待办」与
// 「本机还没同步到待办」—— 否则用户设了提醒却什么都没发生，看不出是哪一种。
var TODO_LEAD_LABEL = {
    0: '不提醒', 10: '提前 10 分钟', 30: '提前 30 分钟', 60: '提前 1 小时',
    120: '提前 2 小时', 180: '提前 3 小时', 360: '提前 6 小时',
    720: '提前 12 小时', 1440: '提前 1 天'
};

function readTodoSettings() {
    if (!window.CAHost || typeof CAHost.todoReminderSettings !== 'function') return null;
    try { return JSON.parse(CAHost.todoReminderSettings() || '') || null; } catch (e) { return null; }
}

function renderTodoStatus(info, saved) {
    var el = document.getElementById('todoStatus');
    if (!el) return;
    if (!info) { el.textContent = ''; return; }
    if (!info.todoCount) {
        el.textContent = '本机还没有进行中的待办：同步过一次后，新建的待办会自动排上提醒。';
        return;
    }
    var lead = TODO_LEAD_LABEL[info.lead] || ('提前 ' + info.lead + ' 分钟');
    el.textContent = (saved ? '已保存：' : '当前：') + lead
        + ' · 已同步 ' + info.todoCount + ' 条进行中待办';
}

function refreshTodoCard() {
    var card = document.getElementById('todoCard');
    if (!card) return;
    var info = readTodoSettings();
    if (!info) return;   // 网页版没有这个桥：整块保持隐藏，不给一个点了没反应的设置项
    var leadSel = document.getElementById('todoLead');
    if (leadSel) leadSel.value = String(info.lead);
    card.hidden = false;
    renderTodoStatus(info, false);
}

/** 改完即存（没有「保存」按钮）：原生侧会立刻重排闹钟 */
function saveTodoReminder() {
    if (!window.CAHost || typeof CAHost.saveTodoReminderSettings !== 'function') return;
    var leadSel = document.getElementById('todoLead');
    var lead = parseInt(leadSel ? leadSel.value : '0', 10);
    if (isNaN(lead)) lead = 0;
    try {
        var info = JSON.parse(CAHost.saveTodoReminderSettings(lead) || '') || null;
        renderTodoStatus(info, true);
    } catch (e) {
        // 存失败就退回实际生效的值，别让页面显示一个没写进去的数字
        refreshTodoCard();
    }
}
refreshTodoCard();

// ===== 网页版待办提醒（服务端推送，非 App 壳）=====
// 网页 / PWA 没有本地排期能力：页面一关，setTimeout 就不存在了。所以网页版改成
// 「服务端在截止前推送」—— App 没打开也能收到（iOS 16.4+ 的主屏 PWA 同样适用）。
// 设置存服务端 todo_reminder_prefs：
//   GET /api/todos/reminder-prefs → {success:true,data:{prefs:{enabled,lead_minutes}}}
//   PUT 同路径 body {enabled,lead_minutes}    → 返回同样的 prefs；lead 为 0–10080 的整数
// 与 #todoCard 的分工：App 壳里的待办提醒走原生 AlarmManager（#todoCard，经 CAHost 读写），
// 网页版走这一张；两张卡互斥显示，不会同时出现让人不知道该信哪个。
var webTodoPrefs = null;   // 最近一次读到的设置；保存后与推送开关变化时用它重绘状态行

/** 状态行措辞（TODO_LEAD_LABEL 是「提前 1 小时」，拼进句子会重复「提前」，所以另起一套） */
var WEB_TODO_LEAD_TEXT = {
    0: '不提醒', 10: '10 分钟前', 30: '30 分钟前', 60: '1 小时前',
    120: '2 小时前', 180: '3 小时前', 360: '6 小时前', 720: '12 小时前', 1440: '1 天前'
};

/** 这张卡只在网页 / PWA 里出现：原生壳有自己的本地提醒，没有推送通道的浏览器提示了也做不到 */
function webTodoCardSupported() {
    if (inNativeShell()) return false;
    if (!('PushManager' in window)) return false;
    return !!getSession();
}

function applyWebTodoPrefs(prefs) {
    webTodoPrefs = prefs || null;
    var enabledEl = document.getElementById('webTodoEnabled');
    if (enabledEl) enabledEl.checked = !!(prefs && prefs.enabled);
    var leadSel = document.getElementById('webTodoLead');
    if (!leadSel) return;
    var lead = prefs && typeof prefs.lead_minutes === 'number' ? prefs.lead_minutes : 60;
    lead = Math.max(0, Math.round(lead));
    var value = String(lead);
    // 服务端允许 0–10080，界面只列常用档位；遇到别的值补一个选项，别把用户设好的值悄悄改掉
    if (!leadSel.querySelector('option[value="' + value + '"]')) {
        var opt = document.createElement('option');
        opt.value = value;
        opt.textContent = '提前 ' + lead + ' 分钟';
        leadSel.appendChild(opt);
    }
    leadSel.value = value;
}

/** 推送通道就绪度：权限没给 / 没订阅 / 就绪。状态行据此提示先开上方「网页通知」 */
function webPushReadiness() {
    if (!('Notification' in window)) return Promise.resolve('unsupported');
    if (Notification.permission !== 'granted') return Promise.resolve('permission');
    return swRegistration(3000).then(function (reg) {
        if (!reg) return 'nosub';
        return reg.pushManager.getSubscription().then(function (sub) {
            return sub ? 'ready' : 'nosub';
        }, function () { return 'nosub'; });
    });
}

async function renderWebTodoStatus(prefs, saved) {
    var el = document.getElementById('webTodoStatus');
    if (!el) return;
    var enabled = !!(prefs && prefs.enabled);
    var lead = prefs && typeof prefs.lead_minutes === 'number' ? prefs.lead_minutes : 60;
    var text;
    if (!enabled) {
        text = '未开启：待办到期不会推送。';
    } else if (lead > 0) {
        text = (saved ? '已保存：' : '当前：') + '截止时间 ' + (WEB_TODO_LEAD_TEXT[lead] || (lead + ' 分钟前')) + '推送。';
    } else {
        text = '已开启，但提前量是「不提醒」：把提前量调大才会真的收到。';
    }
    var ready = await webPushReadiness();
    if (ready === 'unsupported') text += '本机不支持网页通知。';
    else if (ready === 'permission') text += '还没允许通知：请先在上方「网页通知」里点「开启通知」。';
    else if (ready === 'nosub') text += '网页通知还没订阅成功：请先在上方「网页通知」里开启。';
    el.textContent = text;
}

function refreshWebTodoCard() {
    var card = document.getElementById('webTodoCard');
    if (!card) return;
    card.hidden = !webTodoCardSupported();
    if (card.hidden) return;
    loadWebTodoReminder();
}

function loadWebTodoReminder() {
    var statusEl = document.getElementById('webTodoStatus');
    if (statusEl) statusEl.textContent = '正在读取提醒设置…';
    api('/api/todos/reminder-prefs').then(function (res) {
        var prefs = (res && res.data && res.data.prefs) || { enabled: false, lead_minutes: 60 };
        applyWebTodoPrefs(prefs);
        renderWebTodoStatus(prefs, false);
    }, function (err) {
        // 后端还没部署这个接口时是 404 —— 如实说读不到，不假装成「未开启」骗用户去点保存
        if (statusEl) statusEl.textContent = '读取提醒设置失败：' + ((err && err.message) || '请稍后刷新重试');
    });
}

/** 保存设置。服务端推送与原生提醒无关：不用 notifyTodoChanged()，也不用通知 CAHost */
async function saveWebTodoReminder() {
    var btn = document.getElementById('webTodoSaveBtn');
    var statusEl = document.getElementById('webTodoStatus');
    var enabledEl = document.getElementById('webTodoEnabled');
    var leadSel = document.getElementById('webTodoLead');
    var enabled = !!(enabledEl && enabledEl.checked);
    var lead = parseInt(leadSel ? leadSel.value : '60', 10);
    if (isNaN(lead) || lead < 0) lead = 0;
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '保存中…'; }
    try {
        var res = await api('/api/todos/reminder-prefs', {
            method: 'PUT',
            body: JSON.stringify({ enabled: enabled, lead_minutes: lead })
        });
        var prefs = (res && res.data && res.data.prefs) || { enabled: enabled, lead_minutes: lead };
        applyWebTodoPrefs(prefs);
        await renderWebTodoStatus(prefs, true);
    } catch (err) {
        if (statusEl) statusEl.textContent = '保存失败：' + ((err && err.message) || '请稍后重试');
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

/** 上方「网页通知」开关后权限 / 订阅会变，状态行要跟着说对，否则会一直提示「还没允许通知」 */
function refreshWebTodoStatusFromCache() {
    if (!webTodoPrefs) return;
    if (!document.getElementById('webTodoStatus')) return;
    renderWebTodoStatus(webTodoPrefs, false);
}
refreshWebTodoCard();

// ===== 后台通知（仅 App 壳） =====
// 状态全部来自 CAHost.backgroundStatus()，它返回：
//   {"enabled":true,"running":true,"ignoringBattery":false,"standbyBucket":"active"}
// 这几项都是 AOSP 公开 API 能如实回答的。厂商的「自启动」读不到，所以**不在**这个 JSON 里，
// 页面上只能写一句「要你自己去确认」—— 编一个值显示给用户，比承认看不到更糟。
// 系统给应用的待机档（AOSP StandbyBucket）五档都要能说出来：
// 这一行要如实回答「目前被系统视作什么」，漏一档就会在该档上开天窗。
var STANDBY_LABEL = {
    active: '目前被系统视作「活跃应用」',
    working_set: '目前被系统视作「常用应用」',
    frequent: '目前被系统视作「较常用应用」',
    rare: '目前被系统视作「很少用的应用」，后台任务会被压制',
    restricted: '目前被系统视作「受限应用」，后台任务基本跑不动'
};

function readBackgroundStatus() {
    if (!window.CAHost || typeof CAHost.backgroundStatus !== 'function') return null;
    try { return JSON.parse(CAHost.backgroundStatus() || '') || null; } catch (e) { return null; }
}

/**
 * 后台通知状态行：分两行。
 *   第一行 —— 常驻开没开；
 *   第二行 —— 系统目前把本应用算作哪一档待机（`standbyBucket`），五档都如实写出来。
 *
 * 「有没有允许后台运行」不在这里，它挂在按钮行下面（`#batteryStatus`）：那条只有点完系统弹窗、
 * 切回页面时才有意义，用户的眼睛就在按钮旁边，别挪回来。
 *
 * 换行用 \n、由 .profile-sub-lines 的 white-space: pre-line 落地。不拆成两个 <p> 是因为
 * .profile-sub-lead 的 14px 下边距会把两行拽成两段不相关的话（相邻兄弟的外边距会取最大值，
 * 给第二行单独压 margin 也压不掉）—— 这两行本来就是同一段信息。
 */
function renderBackgroundStatus(info) {
    var status = document.getElementById('backgroundStatus');
    var battery = document.getElementById('batteryStatus');
    var hint = document.getElementById('backgroundHint');
    var toggle = document.getElementById('backgroundAlwaysOn');
    if (toggle) toggle.checked = !!info.enabled;

    if (battery) {
        battery.textContent = info.ignoringBattery
            ? '已允许后台运行。'
            : '未允许后台运行，手机放着不动时会收不到通知。';
    }

    if (!status) return;

    var lines = (info.enabled
        ? (info.running
            ? '后台常驻运行中'
            : '后台常驻已开启，但没在跑 —— 重新打开一次 App 可恢复')
        : '后台常驻已关闭') + '。';
    var bucket = STANDBY_LABEL[info.standbyBucket];
    if (bucket) lines += '\n' + bucket + '。';
    status.textContent = lines;

    var btn = document.getElementById('batteryBtn');
    if (btn) btn.textContent = info.ignoringBattery ? '查看电池设置' : '允许后台运行';
    if (hint) {
        hint.textContent = info.ignoringBattery
            ? '「自启动」「后台管理」各家不对外开放，我们读不到 —— 点「自启动设置」进去把这类开关打开。'
            : '先点「允许后台运行」，在系统弹窗里选允许；再点「自启动设置」打开自启动。两件都做完，App 没打开也能收到通知。';
    }
}

function refreshBackgroundCard() {
    var card = document.getElementById('backgroundCard');
    if (!card) return;
    var info = readBackgroundStatus();
    if (!info) return;   // 网页版没有这个桥：整块保持隐藏，不给一个点了没反应的设置项
    card.hidden = false;
    renderBackgroundStatus(info);
}

/** 改完即存：原生侧会立刻启停前台服务，退回最新状态用来刷新这一块 */
function saveBackgroundAlwaysOn() {
    if (!window.CAHost || typeof CAHost.setBackgroundAlwaysOn !== 'function') return;
    var toggle = document.getElementById('backgroundAlwaysOn');
    try {
        var info = JSON.parse(CAHost.setBackgroundAlwaysOn(!!(toggle && toggle.checked)) || '') || null;
        if (info) renderBackgroundStatus(info);
    } catch (e) {
        refreshBackgroundCard();   // 存失败就退回真实状态，别让页面停在一个没生效的值上
    }
}

/** 一个按钮两种用途：还没免电池优化就去申请，已经有了就打开设置页让用户自己看 */
function openBatteryAction() {
    if (!window.CAHost) return;
    var info = readBackgroundStatus();
    if (info && info.ignoringBattery) {
        if (typeof CAHost.openBatterySettings === 'function') CAHost.openBatterySettings();
    } else if (typeof CAHost.requestIgnoreBatteryOptimizations === 'function') {
        CAHost.requestIgnoreBatteryOptimizations();
    }
}

function openAutoStart() {
    if (window.CAHost && typeof CAHost.openAutoStartSettings === 'function') {
        CAHost.openAutoStartSettings();
    }
}

refreshBackgroundCard();

// 重取一次的两个时机：页面重新可见时（用户去「系统设置 → 通知」改完开关再切回来，
// 而 WebView 不会自己重载这个页面，不重取就会一直显示旧状态），
// 以及资料卡重绘之后（loadProfile 会重建 DOM，那行元素是新的）。
// 后台通知那张卡尤其依赖这个时机：用户是「点按钮 → 跳到系统设置 → 授权 → 切回来」的，
// 不在这里重取就看不到「已允许后台运行」。
document.addEventListener('visibilitychange', function () {
    if (!document.hidden) { refreshAppStatus(); refreshBackgroundCard(); }
});

// ===== 关于软件：版本号 + 检查更新 =====
// App 内取原生版本号（安卓回传 BuildConfig.VERSION_NAME，鸿蒙回传 app.json5 的 versionName）；
// 网页版没有桥，显示「网页版」
var appVersion = '';
(function loadAppVersion() {
    try {
        if (window.CAHost && typeof CAHost.appVersion === 'function') appVersion = CAHost.appVersion() || '';
    } catch (e) {}
    var el = document.getElementById('aboutVersion');
    if (el) el.textContent = appVersion ? 'v' + appVersion : '网页版';
})();

/** 逐段按数字比较：0.10.0 > 0.9.0，直接比字符串会判反 */
function isNewer(latest, current) {
    var a = String(latest).split('.'), b = String(current).split('.');
    for (var i = 0; i < Math.max(a.length, b.length); i++) {
        var x = parseInt(a[i], 10) || 0, y = parseInt(b[i], 10) || 0;
        if (x !== y) return x > y;
    }
    return false;
}

/**
 * 自己是什么端，就只读 version.json 里哪一段。
 * 没有原生桥（纯网页版）返回空串 —— 那就不读任何一段，网页自己不需要更新。
 */
function platformKey() {
    try {
        if (window.CAHost && typeof CAHost.platform === 'function') {
            var p = String(CAHost.platform() || '').trim();
            // 只认 version.json 里真有的段。将来真发 iOS 版时要在这里补回 'ios'，
            // 否则 iOS 壳内会落进「没桥」那一支，提示「当前是网页版，网页不需要更新」。
            if (p === 'android' || p === 'harmony') return p;
        }
    } catch (e) {}
    return '';
}

// 「最新版本」写在站点根目录的 version.json，按端分段（发版时改对应那段，
// 与该端安装包的版本号保持一致）；带时间戳 + no-store 是绕开 Cloudflare 与
// Service Worker 的缓存，否则检查更新永远看到旧值
async function checkUpdate() {
    var btn = document.getElementById('updateBtn');
    var hint = document.getElementById('updateHint');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '检查中…';
    hint.textContent = '';
    try {
        var res = await fetch('version.json?_=' + Date.now(), { cache: 'no-store' });
        if (!res.ok) throw new Error('HTTP ' + res.status);
        var data = (await res.json()) || {};
        var key = platformKey();
        var section = key ? (data[key] || {}) : {};
        var latest = String(section.version || '').trim();
        // 只认自己那段里写的 url：没桥（纯网页版）或缺 version / url 都算失败，
        // 不猜地址、也不退回 Actions 构建产物页 —— 那页不是版本下载入口
        var link = String(section.url || '').trim();
        if (!key) {
            hint.textContent = '当前是网页版，网页不需要更新。';
        } else if (!latest || !link) {
            hint.textContent = '检查更新失败';
        } else if (isNewer(latest, appVersion)) {
            hint.innerHTML = '发现新版本：v' + esc(latest) + '，<a href="' + escAttr(safeHref(link)) + '" target="_blank" rel="noopener">前往下载</a>';
        } else {
            hint.textContent = '已是最新版本：v' + appVersion;
        }
    } catch (e) {
        hint.textContent = '检查更新失败';
    }
    btn.disabled = false;
    btn.textContent = label;
}

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
    var el = document.getElementById('consentSummary');
    if (el) el.textContent = consentSummaryText(data);
    var hint = document.getElementById('consentHint');
    if (hint) { hint.textContent = ''; hint.hidden = true; }
}

async function loadConsentSummary() {
    try {
        var res = await api('/api/auth/consent');
        consentData = (res && res.data) || null;
        renderConsentSummary(consentData);
    } catch (e) {
        // 取不到状态不影响这一页其它功能；打开弹窗时会再取一次，那里才把错误显示出来
        var el = document.getElementById('consentSummary');
        if (el) el.textContent = '获取失败，点「查看与修改」重试';
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

// ===== 加载我的资料 =====
var currentContact = '';
/**
 * 北京时间 `YYYY-MM-DD HH:MM:SS`，给资料卡的「上次同步时间」用。
 * 入参是毫秒时间戳（App 壳经桥回传的 lastSyncAt，本身就是绝对时刻）：
 * 取到绝对时刻后 +8 小时、再按 UTC 字段读出来，得到的就是北京墙上时间。
 *
 * 它原先还兼着格式化「更新时间」那个字符串（后端存的 UTC，形如 "2026-09-13 06:32:07"，
 * 必须拼上 Z 才按 UTC 解析）—— 那行删掉之后这个分支就成了死代码，一并去掉。
 */
function fmtBJTime(ms) {
    var t = Number(ms);
    if (isNaN(t)) return '时间未知';
    var bj = new Date(t + 8 * 3600 * 1000);
    var p = function (n) { return (n < 10 ? '0' : '') + n; };
    return bj.getUTCFullYear() + '-' + p(bj.getUTCMonth() + 1) + '-' + p(bj.getUTCDate())
        + ' ' + p(bj.getUTCHours()) + ':' + p(bj.getUTCMinutes()) + ':' + p(bj.getUTCSeconds());
}
async function loadProfile() {
    var card = document.getElementById('profileCard');
    card.innerHTML = stateHTML('正在加载…', false, 'clock');
    try {
        var res = await api('/api/auth/me');
        renderProfile(res.data || {});
    } catch (err) {
        card.innerHTML = stateHTML(err.message, true);
    }
}

/** 资料卡渲染。首次加载与「原生后台刷新推回」共用这一个入口（网页版不会被推） */
function renderProfile(u) {
    var card = document.getElementById('profileCard');
    currentContact = u.contact || '';
    currentEmail = u.email || '';
    currentEmailVerified = !!u.email_verified;
    card.innerHTML =
        '<div class="profile-head">'
        + '<div class="profile-avatar">' + esc((u.name || '?').charAt(0)) + '</div>'
        + '<div>'
        + '<div class="profile-name">' + esc(u.name || '') + '</div>'
        + '<div class="profile-sub">学号 ' + esc(u.student_id || '') + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="info-list">'
        + '<div class="info-row"><span class="k">我的职位</span><span class="v">' + positionsChipsHTML(u.positions) + '</span></div>'
        + '<div class="info-row"><span class="k">联系方式</span>'
        + '<span class="v v-actions">'
        + '<span id="contactValue">' + esc(u.contact || '未填写') + '</span>'
        + '<button type="button" class="btn btn-outline btn-sm" data-act="open-contact-edit">编辑</button>'
        + '</span></div>'
        // 邮箱：与联系方式同一行的形状（标签 + 值 + 右侧动作）。验证状态徽章在弹窗标题后，
        // 这一行不再重复放。绑定 / 更换 / 解绑都收进弹窗，行上只留一个「管理」—— 全摊在行上会随状态
        // 变出三四种按钮，既不整齐，也让「要改邮箱去哪」这件事没有唯一入口。
        + '<div class="info-row"><span class="k">邮箱&订阅</span>'
        + '<span class="v v-actions">'
        + emailCellHTML(u)
        + '<button type="button" class="btn btn-outline btn-sm" data-act="open-email-edit">管理</button>'
        + '</span></div>'
        // 「上次同步时间」= App 上次成功拉完数据的时刻（安卓 WorkManager / 鸿蒙 workScheduler，
        // 由桥 CAHost.appStatus() 读回），只在 App 里有意义：网页版没有这个桥，整行 hidden
        // 不出现，值由 refreshAppStatus() 填。
        // 这行旁边原有一条「更新时间」（u.update_time = 这份资料存进后端的时刻），已按需求删除；
        // 那两个时刻通常只差几分钟，并排放着反而让人分不清哪个才代表「我的数据有多新」。
        + '<div class="info-row" id="appSyncRow" hidden><span class="k">上次同步时间</span><span class="v" id="appSyncValue"></span></div>'
        + '</div>';
    // 上面这段是新造的 DOM，行内元素要重新取值
    refreshAppStatus();
    // 填了 QQ 邮箱就换成 WeAvatar 头像（不是 QQ 邮箱、或取不到头像都保持上面的首字母）
    applyEmailAvatar(card.querySelector('.profile-avatar'), u.email, 112);
}

// App 壳：原生层先给缓存（首帧不必等网络），后台刷新完把新数据推回这里重绘
onApiData('/api/auth/me', function (data) { renderProfile(data || {}); });
loadProfile();

// ===== 偏好设置：主题外观 =====
function currentThemeChoice() {
    try { var v = localStorage.getItem('theme'); return (v === 'dark' || v === 'light') ? v : 'system'; } catch (e) { return 'system'; }
}
function applyTheme(choice) {
    var resolved = choice === 'system'
        ? (window.matchMedia('(prefers-color-scheme: dark)').matches ? 'dark' : 'light')
        : choice;
    document.documentElement.setAttribute('data-theme', resolved);
    try {
        if (choice === 'system') localStorage.removeItem('theme');
        else localStorage.setItem('theme', choice);
    } catch (e) {}
    // 同步到应用壳（父窗口），保持一致
    try {
        if (window.parent && window.parent !== window && window.parent.document) {
            window.parent.document.documentElement.setAttribute('data-theme', resolved);
        }
    } catch (e) {}
}
function markThemeSeg() {
    var seg = document.getElementById('themeSeg');
    if (!seg) return;
    var cur = currentThemeChoice();
    var btns = seg.querySelectorAll('.tab');
    for (var i = 0; i < btns.length; i++) {
        btns[i].classList.toggle('active', btns[i].getAttribute('data-theme-choice') === cur);
    }
    moveThemeSegPill();
}
// 滑动滑块：与移动端底栏同款，位置与尺寸按激活项实测写入
function moveThemeSegPill() {
    var pill = document.getElementById('themeSegPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.tab.active');
    if (!active) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.opacity = '1';
}
(function bindThemeSeg() {
    var seg = document.getElementById('themeSeg');
    if (!seg) return;
    seg.addEventListener('click', function (e) {
        var btn = e.target;
        while (btn && btn !== seg && !btn.getAttribute('data-theme-choice')) btn = btn.parentNode;
        if (!btn || btn === seg) return;
        applyTheme(btn.getAttribute('data-theme-choice'));
        markThemeSeg();
    });
    window.addEventListener('storage', function (e) { if (e.key === 'theme') markThemeSeg(); });
    markThemeSeg();
    // 首帧布局稳定后再定位一次；旋屏/尺寸变化时重算
    setTimeout(moveThemeSegPill, 0);
    window.addEventListener('resize', moveThemeSegPill);
    // 这一页是预载的，初始化时还在 display:none 里，滑块的宽度量不到；
    // 外壳把个人中心显示出来时会通知一次（见 app.js 的 onFrameShown）。
    onFrameShown(moveThemeSegPill);
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

// ===== 日历订阅 =====
var calUrlEl = document.getElementById('calUrl');
var calOpenBtn = document.getElementById('calOpenBtn');
var calCopyBtn = document.getElementById('calCopyBtn');
var calResetBtn = document.getElementById('calResetBtn');
// 后端 /api/calendar/token 同时返回 https 的 url 与 webcal 的 webcal（同一个地址换协议）；
// 「复制链接」用 https，「打开订阅」用 webcal —— iOS 上 webcal 会直接唤起系统日历的添加订阅。
var calBaseUrl = '';
var calBaseWebcal = '';

/** 读选项值；HTML 被旧版 Service Worker 缓存时元素可能不存在，给个默认值兜底，别让整页脚本中断 */
function calVal(id, fallback) {
    var el = document.getElementById(id);
    return el ? el.value : fallback;
}
function calOn(id, fallback) {
    var el = document.getElementById(id);
    return el ? !!el.checked : !!fallback;
}

/** 选项拼成查询串（不含 key）：课程 / 待办总是显式写入；其余与服务端默认值相同就不写，链接保持简洁 */
function calOptionQuery() {
    var p = new URLSearchParams();
    var remind = calVal('calRemind', '30');
    var past = calVal('calPast', '30');
    var future = calVal('calFuture', '365');
    if (remind !== '30') p.set('remind', remind);
    if (past !== '30') p.set('past', past);
    if (future !== '365') p.set('future', future);
    if (calOn('calNotices', false)) p.set('notices', '1');
    // courses / todos 后端默认都是 1，这里显式写 1/0：用户复制出去的链接自带完整配置，
    // 换设备重新订阅的结果与当前开关一致（改完选项要重新复制链接，见卡片说明）。
    p.set('courses', calOn('calCourses', true) ? '1' : '0');
    p.set('todos', calOn('calTodos', true) ? '1' : '0');
    return p.toString();
}

function calWithQuery(base, qs) {
    if (!base) return '';
    if (!qs) return base;
    return base + (base.indexOf('?') === -1 ? '?' : '&') + qs;
}

/**
 * 「打开订阅」用 webcal 还是 https。
 *
 * webcal 只有 Apple 平台（iOS / macOS）才稳定有处理器：iOS 直接弹系统日历的「添加订阅」。
 * 安卓 / Windows 上没有这个协议处理器，点了很可能毫无反应 —— 那里仍给 https，让浏览器
 * 下载 .ics 自行导入（这也是改造前的行为，不能为了 iOS 把其它平台弄回归）。
 */
function calPrefersWebcal() {
    if (isIOSDevice()) return true;
    var ua = navigator.userAgent || '';
    return /Macintosh/.test(ua) && navigator.maxTouchPoints <= 1;
}

function calRefresh() {
    var qs = calBaseUrl ? calOptionQuery() : '';
    var url = calWithQuery(calBaseUrl, qs);
    var webcal = '';
    if (url) {
        // 优先用后端给的 webcal 地址；后端没给就按协议替换兜底
        webcal = calBaseWebcal ? calWithQuery(calBaseWebcal, qs) : url.replace(/^https?:/, 'webcal:');
    }
    calUrlEl.value = url;
    calOpenBtn.href = (calPrefersWebcal() ? webcal : url) || '#';
}

['calRemind', 'calPast', 'calFuture', 'calNotices', 'calCourses', 'calTodos'].forEach(function (id) {
    var el = document.getElementById(id);
    if (el) el.addEventListener('change', calRefresh);
});

/** 把 /api/calendar/token、/reset 返回的 data 落到本地状态；两个接口的返回结构相同 */
function calApplyToken(data) {
    data = data || {};
    calBaseUrl = data.url || '';
    calBaseWebcal = data.webcal || (calBaseUrl ? calBaseUrl.replace(/^https?:/, 'webcal:') : '');
    if (!calBaseUrl && calBaseWebcal) calBaseUrl = calBaseWebcal.replace(/^webcal:/, 'https:');
    calRefresh();
}

(async function loadCalendarToken() {
    try {
        var res = await api('/api/calendar/token');
        calApplyToken(res.data);
    } catch (err) {
        var box = document.getElementById('calError');
        box.textContent = err.message || '获取订阅地址失败';
        box.classList.add('show');
    }
})();

calResetBtn.addEventListener('click', async function () {
    if (!window.confirm('重置后旧订阅链接立即失效，已订阅的日历需要重新订阅。确定重置？')) return;
    var errBox = document.getElementById('calError');
    errBox.classList.remove('show');
    var label = calResetBtn.textContent;
    calResetBtn.disabled = true;
    calResetBtn.textContent = '重置中…';
    try {
        var res = await api('/api/calendar/reset', { method: 'POST' });
        calApplyToken(res.data);
    } catch (err) {
        errBox.textContent = err.message || '重置失败';
        errBox.classList.add('show');
    } finally {
        calResetBtn.disabled = false;
        calResetBtn.textContent = label;
    }
});

calCopyBtn.addEventListener('click', function () {
    if (!calUrlEl.value) return;
    function done() {
        calCopyBtn.textContent = '已复制';
        setTimeout(function () { calCopyBtn.textContent = '复制链接'; }, 1500);
    }
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(calUrlEl.value).then(done, function () {
            calUrlEl.select();
            document.execCommand('copy');
            done();
        });
    } else {
        calUrlEl.select();
        document.execCommand('copy');
        done();
    }
});

// ===== iOS 主屏提醒说明（仅 iOS standalone）=====
// 个人页常常嵌在壳的 iframe 里，所以复用 app.js 的两个判定（它们都先看顶层窗口），
// 比在这里直接 matchMedia('(display-mode: standalone)') 更可靠：isStandaloneMode() 内部
// 同时看 display-mode: standalone 与 navigator.standalone。
// App 壳有原生提醒通道，这张卡没有意义，整块不出现。
(function refreshIosPwaCard() {
    var card = document.getElementById('iosPwaCard');
    if (!card) return;
    if (inNativeShell()) return;
    if (!isIOSDevice() || !isStandaloneMode()) return;
    card.hidden = false;
})();

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
        if (isFinite(n) && n > 0) return fmtBJTime(n < 100000000000 ? n * 1000 : n);
    }
    var d = new Date(value);
    if (!isNaN(d.getTime())) return fmtBJTime(d.getTime());
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
        var name = data.realName || '中国大学MOOC账号';
        var count = Number(data.courseCount) || 0;
        bindBadge('moocBindBadge', paused ? '已暂停' : (expired ? '已过期' : '已绑定'),
            (paused || expired) ? 'muted' : 'ok');
        body.innerHTML = ''
            + '<div class="bind-identity">'
            + '<span class="bind-avatar" aria-hidden="true">' + esc(name.charAt(0)) + '</span>'
            + '<div class="bind-identity-main"><p class="bind-name">' + esc(name) + '</p>'
            + '<p class="bind-id">' + (data.account
                ? '账号 ' + esc(data.account)
                : (data.memberId ? 'ID ' + esc(data.memberId) : '已绑定中国大学MOOC')) + '</p></div>'
            + '</div>'
            + '<div class="info-list bind-meta">'
            + '<div class="info-row"><span class="k">状态</span><span class="v">'
            + (paused ? '已暂停自动同步' : (expired ? '登录态已过期' : '正常')) + '</span></div>'
            + '<div class="info-row"><span class="k">课程数</span><span class="v">' + count + ' 门</span></div>'
            + '<div class="info-row"><span class="k">绑定时间</span><span class="v">' + esc(fmtBindTime(data.boundAt)) + '</span></div>'
            + '<div class="info-row"><span class="k">最近校验</span><span class="v">' + esc(fmtBindTime(data.checkedAt)) + '</span></div>'
            + '</div>'
            + (paused ? '<p class="bind-warn">MOOC 登录态连续失效，已自动暂停同步'
                + (data.paused_until ? '到 ' + esc(fmtBindTime(data.paused_until)) : '')
                + '，重新登录后可恢复。</p>' : '')
            + (expired && !paused ? '<p class="bind-warn">MOOC 登录态已过期，需要'
                + (native ? '在 App 内重新登录' : '重新登录 www.icourse163.org 并粘贴新的 Cookie')
                + '。</p>' : '')
            + '<div class="bind-actions">'
            + (native ? '<button class="btn btn-primary" type="button" data-act="begin-mooc-bind" data-arg="app">App 重新登录</button>' : '')
            + '<button class="btn ' + (native ? 'btn-outline' : 'btn-primary') + '" type="button" data-act="begin-mooc-bind" data-arg="cookie">'
            + (expired ? '重新粘贴 Cookie' : '换 Cookie') + '</button>'
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

// ===== 页内 tab =====
function moveAccountTabPill() {
    var pill = bindById('accountTabPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.tab.active');
    if (!active) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.opacity = '1';
}

function switchAccountPane(pane) {
    var binding = pane === 'binding';
    var profilePane = bindById('paneProfile');
    var bindingPane = bindById('paneBinding');
    if (!profilePane || !bindingPane) return;
    profilePane.hidden = binding;
    bindingPane.hidden = !binding;
    var tabs = bindById('accountTabs');
    if (tabs) {
        var btns = tabs.querySelectorAll('.tab');
        for (var i = 0; i < btns.length; i++) {
            var on = btns[i].getAttribute('data-arg') === pane;
            btns[i].classList.toggle('active', on);
            btns[i].setAttribute('aria-selected', on ? 'true' : 'false');
        }
    }
    moveAccountTabPill();
    if (binding) {
        loadAcademicBinding();
        loadChaoxingBinding();
        loadMoocBinding();
    }
    try { window.scrollTo({ top: 0, behavior: 'smooth' }); } catch (e) { window.scrollTo(0, 0); }
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
    switchAccountPane('binding');
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
    switchAccountPane('binding');
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
    switchAccountPane('binding');
    openBindModal('正在绑定中国大学MOOC', ''
        + '<div class="form-error" id="bindModalError"></div>'
        + '<p class="bind-hint">正在验证中国大学MOOC登录态，并读取课程列表…</p>');
    try {
        await api('/api/mooc/bind', { method: 'POST', body: JSON.stringify({ cookies: cookies }) });
        closeBindModal();
        await loadMoocBinding();
        bindFlash('中国大学MOOC绑定成功');
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
    if (!bindById('accountTabs')) return;
    var pending = '';
    try {
        pending = localStorage.getItem(BIND_PENDING_KEY) || '';
        if (pending) localStorage.removeItem(BIND_PENDING_KEY);
    } catch (e) {}
    var wantBinding = pending === 'academic' || location.hash === '#binding';
    moveAccountTabPill();
    setTimeout(moveAccountTabPill, 0);
    window.addEventListener('resize', moveAccountTabPill);
    // 预载的个人中心在 display:none 里初始化，两个滑块的宽度都量不到；
    // 外壳显示这一页时会通知一次（见 app.js 的 onFrameShown）。
    // 主题分段的滑块在它自己的 IIFE 里已经登记过，这里只补这两个页签的。
    onFrameShown(moveAccountTabPill);
    if (wantBinding) {
        switchAccountPane('binding');
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

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 静态按钮与动态生成的资料卡按钮统一用 data-act 标记 + 委托（重绘也不用重新绑）。
delegate(document, 'click', '[data-act="enable-push"]', function () { enablePush(); });
delegate(document, 'click', '[data-act="test-push-self"]', function () { testPushSelf(); });
delegate(document, 'click', '[data-act="disable-push"]', function () { disablePush(); });
delegate(document, 'click', '[data-act="test-push"]', function (el) { testPush(el.getAttribute('data-arg')); });
delegate(document, 'change', '[data-act="save-course-reminder"]', function () { saveCourseReminder(); });
delegate(document, 'change', '[data-act="save-todo-reminder"]', function () { saveTodoReminder(); });
delegate(document, 'click', '[data-act="save-web-todo-reminder"]', function () { saveWebTodoReminder(); });
delegate(document, 'change', '[data-act="save-background-always-on"]', function () { saveBackgroundAlwaysOn(); });
delegate(document, 'click', '[data-act="open-battery-action"]', function () { openBatteryAction(); });
delegate(document, 'click', '[data-act="open-auto-start"]', function () { openAutoStart(); });
delegate(document, 'click', '[data-act="toggle-collapse"]', function (el) { toggleCollapse(el.getAttribute('data-arg')); });
delegate(document, 'click', '[data-act="open-admin"]', function () { openAdmin(); });
delegate(document, 'click', '[data-act="install-app"]', function () { installApp(); });
delegate(document, 'click', '[data-act="logout"]', function () { window.parent.logout(); });
delegate(document, 'click', '[data-act="check-update"]', function () { checkUpdate(); });
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

// 账号绑定：页签切换、状态刷新、教务/学习通各步骤、解绑确认
delegate(document, 'click', '[data-act="switch-account-pane"]', function (el) { switchAccountPane(el.getAttribute('data-arg')); });
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
