(function () {
// 个人中心 · 共用（每个二级页都要加载，且必须排在页面脚本之前）
// 内容：登录校验、管理员入口、资料读取与资料卡渲染、App 壳桥的状态读取（上次同步时间等）。
// 从原来的 account.js 拆出来，按行区间搬运，逻辑一行未改。
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


// 本文件自己的小工具（页面脚本里同名的那个是各自的局部副本）
function coreEl(id) { return document.getElementById(id); }

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
    var block = coreEl('appPushBlock');
    if (block) block.hidden = !info;
    // 资料卡里那行默认 hidden（没有桥的网页版就整行不出现）
    var row = coreEl('appSyncRow');
    var val = coreEl('appSyncValue');
    if (row) row.hidden = !info;
    if (val) val.textContent = (info && info.lastSyncAt) ? fmtBJTime(info.lastSyncAt) : '还没有成功同步过';
    // lastSyncAt 为 0 = 这台设备一次都没成功同步过（App 每次拉完数据才写）
    var line = coreEl('appNotifyLine');
    if (line) {
        line.textContent = !info ? '' : (info.notifications
            ? '本机通知：已开启'
            : '本机通知：未开启，收不到任何提醒。请到「系统设置 → 通知」里允许「班级助理」发通知');
    }
}
refreshAppStatus();


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
    // 总览页只读：编辑按钮由资料页提供的回调渲染（资料页才有对应弹窗），
    // 所以按钮的 data-act 字面量只出现在 account/profile.js 里。
    var editBtn = function (which) {
        var fn = window['ca' + which + 'Btn'];
        return typeof fn === 'function' ? fn() : '';
    };
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
        + editBtn('Contact')
        + '</span></div>'
        // 邮箱：与联系方式同一行的形状（标签 + 值 + 右侧动作）。验证状态徽章在弹窗标题后，
        // 这一行不再重复放。绑定 / 更换 / 解绑都收进弹窗，行上只留一个「管理」—— 全摊在行上会随状态
        // 变出三四种按钮，既不整齐，也让「要改邮箱去哪」这件事没有唯一入口。
        + '<div class="info-row"><span class="k">邮箱</span>'
        + '<span class="v v-actions">'
        + (window.caEmailCellHTML ? window.caEmailCellHTML(u) : '')
        + editBtn('Email')
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
// 供其它页面脚本使用的入口（各脚本都是 IIFE，只能显式挂上去）
window.caFmtBJTime = fmtBJTime;
window.caRefreshAppStatus = refreshAppStatus;
window.caLoadProfile = loadProfile;
window.caRenderProfile = renderProfile;
window.caOpenAdmin = openAdmin;
})();
