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
function testPush(kind) {
    var btn = document.getElementById(kind === 'activity' ? 'testActivityBtn' : 'testNoticeBtn');
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
    card.innerHTML =
        '<div class="profile-head">'
        + '<div class="profile-avatar">' + esc((u.name || '?').charAt(0)) + '</div>'
        + '<div>'
        + '<div class="profile-name">' + esc(u.name || '') + '</div>'
        + '<div class="profile-sub">学号 ' + esc(u.student_id || '') + '</div>'
        + '</div>'
        + '</div>'
        + '<div class="info-list">'
        + '<div class="info-row"><span class="k">职位</span><span class="v">' + positionsChipsHTML(u.positions) + '</span></div>'
        + '<div class="info-row"><span class="k">联系方式</span>'
        + '<span class="v v-actions">'
        + '<span id="contactValue">' + esc(u.contact || '未填写') + '</span>'
        + '<button type="button" class="btn btn-outline btn-sm" data-act="open-contact-edit">编辑</button>'
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
var calBaseUrl = '';

function calRefresh() {
    var url = '';
    if (calBaseUrl) {
        var u = new URL(calBaseUrl);
        var remind = document.getElementById('calRemind').value;
        var past = document.getElementById('calPast').value;
        var future = document.getElementById('calFuture').value;
        // 与服务端默认值相同的就不写进链接，保持简洁
        if (remind !== '30') u.searchParams.set('remind', remind);
        if (past !== '30') u.searchParams.set('past', past);
        if (future !== '365') u.searchParams.set('future', future);
        if (document.getElementById('calNotices').checked) u.searchParams.set('notices', '1');
        url = u.toString();
    }
    calUrlEl.value = url;
    calOpenBtn.href = url || '#';
}

['calRemind', 'calPast', 'calFuture', 'calNotices'].forEach(function (id) {
    document.getElementById(id).addEventListener('change', calRefresh);
});

(async function loadCalendarToken() {
    try {
        var res = await api('/api/calendar/token');
        calBaseUrl = (res.data && res.data.url) || '';
        calRefresh();
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
        calBaseUrl = (res.data && res.data.url) || '';
        calRefresh();
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

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 静态按钮与动态生成的资料卡按钮统一用 data-act 标记 + 委托（重绘也不用重新绑）。
delegate(document, 'click', '[data-act="enable-push"]', function () { enablePush(); });
delegate(document, 'click', '[data-act="test-push-self"]', function () { testPushSelf(); });
delegate(document, 'click', '[data-act="disable-push"]', function () { disablePush(); });
delegate(document, 'click', '[data-act="test-push"]', function (el) { testPush(el.getAttribute('data-arg')); });
delegate(document, 'change', '[data-act="save-course-reminder"]', function () { saveCourseReminder(); });
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
})();
