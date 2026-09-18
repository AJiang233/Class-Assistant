(function () {
// ===== 需要登录 =====
if (!requireAuth()) return;

var modalOverlay = document.getElementById('detailModal');

// ===== 编辑入口：仅 content:write 权限者可用 =====
if (canContentWrite()) loadRemindChoices();

// ===== 提醒对象选择 =====
var remindChoices = [];
// 「名单没加载出来」与「真没有成员」必须分开记：前者若被当成空名单保存，
// 会把定向内容静默发成全班可见（见 renderRemindBox 的 failed 分支与 submitEdit 的拦截）。
var remindLoadFailed = false;

async function loadRemindChoices() {
    try {
        var res = await api('/api/auth/members-pick');
        remindChoices = (res.data && res.data.list) || [];
        remindLoadFailed = false;
        return true;
    } catch (e) {
        remindLoadFailed = true;
        return false;
    }
}

function renderRemindChoices(checkedNames) {
    renderRemindBox('editRemind', remindChoices, checkedNames, remindLoadFailed);
}

function collectRemind() {
    var names = [];
    document.querySelectorAll('#editRemind .remind-cb:checked').forEach(function (el) { names.push(el.value); });
    return names;
}

var editingNoticeId = null;

// ===== 时间比较：与数据库一致的 "YYYY-MM-DD HH:MM:SS" 本地时间 =====
function nowKey() {
    var d = new Date(); var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}

function statusOf(n) {
    var p = String(n.publish_time || '');
    var e = String(n.expire_time || '');
    var now = nowKey();
    if (p && p > now) return 'upcoming';
    if (e && e <= now) return 'ended';
    return 'ongoing';
}

function byPublishAsc(a, b) { return String(a.publish_time || '').localeCompare(String(b.publish_time || '')); }
function byPublishDesc(a, b) { return String(b.publish_time || '').localeCompare(String(a.publish_time || '')); }

function rowHTML(n) {
    var pub = n.publisher ? '<span>' + icon('user') + esc(n.publisher) + '</span>' : '';
    // 带跳转的通知（如表单填写页）在列表上给个标记；行本身是 button，
    // 里面不能再塞可点元素，实际入口放在详情弹窗
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
}

function groupHTML(title, rows, open) {
    return '<details class="section-block"' + (open ? ' open' : '') + '>'
        + '<summary class="section-head">'
        + '<h2 class="section-title">' + title + '</h2>'
        + '<span class="section-right">'
        + '<span class="section-count">共 ' + rows.length + ' 条</span>'
        + '<svg class="section-chevron" width="16" height="16" viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="2" stroke-linecap="round" stroke-linejoin="round"><polyline points="6 9 12 15 18 9"/></svg>'
        + '</span>'
        + '</summary>'
        + '<div class="list">' + rows.map(rowHTML).join('') + '</div>'
        + '</details>';
}

// ===== 加载列表（按 正在进行 / 将要开始 / 已经结束 分组） =====
async function loadList() {
    var el = document.getElementById('noticeListView');
    el.innerHTML = skeletonHTML(5);
    try {
        var res = await api('/api/notices?scope=all');
        renderList((res.data && res.data.list) || []);
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/** 列表渲染。首次加载与「App 壳里原生后台刷新完推回新数据」共用这一个入口 */
function renderList(list) {
    var el = document.getElementById('noticeListView');
    if (!list.length) { el.innerHTML = stateHTML('暂无通知'); return; }
    var groups = { ongoing: [], upcoming: [], ended: [] };
    list.forEach(function (n) { groups[statusOf(n)].push(n); });
    groups.ongoing.sort(byPublishAsc);
    groups.upcoming.sort(byPublishAsc);
    groups.ended.sort(byPublishDesc);
    var html = '';
    if (groups.ongoing.length) html += groupHTML('正在进行', groups.ongoing, true);
    if (groups.upcoming.length) html += groupHTML('将要开始', groups.upcoming, false);
    if (groups.ended.length) html += groupHTML('已经结束', groups.ended, false);
    el.innerHTML = html;
}

// App 壳：原生层先把缓存给页面（首帧不必等网络），后台取到新数据再推回这里重绘。
// 键必须与上面 api() 的 URL 一字不差 —— 原生那边的缓存键就是它。网页版不会被调用。
onApiData('/api/notices?scope=all', function (data) { renderList((data && data.list) || []); });

loadList();

// ===== 详情弹窗 =====
function openDetail() {
    modalOverlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeDetail() {
    modalOverlay.classList.remove('show');
    document.body.style.overflow = '';
}
// 点遮罩空白处关闭
modalOverlay.addEventListener('click', function (e) {
    if (e.target === modalOverlay) closeDetail();
});
// ESC 关闭
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && modalOverlay.classList.contains('show')) closeDetail();
});

// ===== 编辑弹窗 =====
var editOverlay = document.getElementById('editModal');
function openEdit() {
    editOverlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeEdit() {
    editOverlay.classList.remove('show');
    document.body.style.overflow = '';
}
editOverlay.addEventListener('click', function (e) {
    if (e.target === editOverlay) cancelEdit();
});
document.addEventListener('keydown', function (e) {
    if (e.key === 'Escape' && editOverlay.classList.contains('show')) cancelEdit();
});

async function showDetail(id) {
    var card = document.getElementById('detailCard');
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
        // canManage 由服务端算（创建者本人或 user:manage）：不是自己能改的就不显示按钮，
        // 否则点下去只会拿到 403
        var actBtns = canContentWrite() && n.canManage
            ? '<div class="modal-foot">'
              + '<button type="button" class="btn btn-outline" data-act="edit-notice" data-id="' + escAttr(n.id) + '">编辑</button>'
              + '<button type="button" class="btn btn-danger" data-act="del-notice" data-id="' + escAttr(n.id) + '">删除</button>'
              + '</div>'
            : '';
        // 站内跳转用 target="_top"：通知页是嵌在主页 iframe 里的，跳外层才不会被套住
        var formBtn = n.link
            ? '<a class="btn btn-primary btn-block mt-12" href="' + escAttr(safeHref(n.link)) + '" target="_top">去填写</a>'
            : '';
        card.innerHTML =
            '<div class="detail-head"><div class="detail-title">' + esc(n.title) + '</div>' + badge + '</div>'
            + '<div class="detail-meta">' + meta + '</div>'
            + '<div class="detail-body">' + esc(n.content || '暂无通知内容') + '</div>'
            + byline
            + remindLine
            + formBtn
            + actBtns;
    } catch (err) {
        card.innerHTML = stateHTML(err.message, true);
    }
}

async function deleteNotice(id) {
    if (!confirm('确定删除该通知？')) return;
    try {
        await api('/api/notices/' + id, { method: 'DELETE' });
        closeDetail();
        loadList();
    } catch (err) {
        alert(err.message);
    }
}

function startEdit(id) {
    closeDetail();
    api('/api/notices/' + id).then(function (res) {
        var n = res.data;
        editingNoticeId = id;
        document.getElementById('editError').classList.remove('show');
        document.getElementById('editTitle').value = n.title || '';
        document.getElementById('editContent').value = n.content || '';
        document.getElementById('editPublish').value = (n.publish_time || '').replace(' ', 'T').slice(0, 16);
        document.getElementById('editExpire').value = (n.expire_time || '').replace(' ', 'T').slice(0, 16);
        var names = [];
        if (n.remind_people) { try { var arr = JSON.parse(n.remind_people); if (Array.isArray(arr)) names = arr; } catch (e) {} }
        // 打开编辑前若上次名单加载失败，先重拉一次再进 —— 否则只显示「名单加载失败」
        // 且保存被拦，连把既有定向对象改回去都做不到
        function apply() { renderRemindChoices(names); openEdit(); }
        if (remindLoadFailed) loadRemindChoices().then(apply); else apply();
    }).catch(function (err) { alert(err.message); });
}

function cancelEdit() {
    closeEdit();
    editingNoticeId = null;
}

async function submitEdit() {
    var errBox = document.getElementById('editError');
    errBox.classList.remove('show');
    // 名单没加载出来时绝不能保存：`remind_people: collectRemind()` 会是空数组，
    // 后端把空名单当默认全班，定向内容就静默发成全班可见（issue #78）
    if (remindLoadFailed) {
        errBox.textContent = '提醒对象名单加载失败：为避免把定向内容误发成全班可见，保存已被禁止，请重试';
        errBox.classList.add('show'); return;
    }
    var title = document.getElementById('editTitle').value.trim();
    var content = document.getElementById('editContent').value.trim();
    var publish_time = document.getElementById('editPublish').value;
    var expire_time = document.getElementById('editExpire').value || null;
    if (!title || !publish_time) {
        errBox.textContent = '标题、发布时间为必填';
        errBox.classList.add('show'); return;
    }
    var btn = document.getElementById('editSubmitBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '保存中…';
    try {
        var body = { title: title, content: content, publish_time: publish_time, expire_time: expire_time, remind_people: collectRemind() };
        await api('/api/notices/' + editingNoticeId, { method: 'PUT', body: JSON.stringify(body) });
        cancelEdit();
        loadList();
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 动态列表行用 data-act 标记 + 委托（列表重绘也不用重新绑），静态按钮直接按 id 绑。
document.getElementById('editSubmitBtn').addEventListener('click', submitEdit);
delegate(document, 'click', '[data-act="close-detail"]', function () { closeDetail(); });
delegate(document, 'click', '[data-act="cancel-edit"]', function () { cancelEdit(); });
delegate(document, 'click', '[data-act="edit-notice"]', function (el) { startEdit(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-notice"]', function (el) { deleteNotice(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="notice-detail"]', function (el) { showDetail(el.getAttribute('data-id')); });

var deepNoticeId = new URLSearchParams(location.search).get('id');
if (deepNoticeId) showDetail(deepNoticeId);
})();
