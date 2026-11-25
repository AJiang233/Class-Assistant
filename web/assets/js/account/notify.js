(function () {
// 个人中心 · 通知与提醒
// 内容：网页版通知（Web Push）、App 端通知、课程 / 待办提醒、后台通知、日历订阅、iOS 提醒说明。
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
    if (!document.hidden) { window.caRefreshAppStatus(); refreshBackgroundCard(); }
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

// ===== 事件绑定（本页）=====
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
})();
