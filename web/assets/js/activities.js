(function () {
// ===== 需要登录 =====
if (!requireAuth()) return;

var modalOverlay = document.getElementById('detailModal');

// ===== 编辑入口：仅 content:write 权限者可用 =====
if (canContentWrite()) loadRemindChoices();

// ===== 提醒对象选择 =====
var remindChoices = [];

async function loadRemindChoices() {
    try {
        var res = await api('/api/auth/members-pick');
        remindChoices = (res.data && res.data.list) || [];
    } catch (e) {}
}

function renderRemindChoices(checkedNames) {
    renderRemindBox('editRemind', remindChoices, checkedNames);
}

function collectRemind() {
    var names = [];
    document.querySelectorAll('#editRemind .remind-cb:checked').forEach(function (el) { names.push(el.value); });
    return names;
}

var editingActivityId = null;

// ===== 时间比较：与数据库一致的 "YYYY-MM-DD HH:MM:SS" 本地时间 =====
function nowKey() {
    var d = new Date(); var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + ' ' + pad(d.getHours()) + ':' + pad(d.getMinutes()) + ':00';
}

function statusOf(a) {
    var s = String(a.start_time || '');
    var e = String(a.end_time || '');
    var now = nowKey();
    if (s && s > now) return 'upcoming';
    if (e && e <= now) return 'ended';
    return 'ongoing';
}

function byStartAsc(a, b) { return String(a.start_time || '').localeCompare(String(b.start_time || '')); }
function byStartDesc(a, b) { return String(b.start_time || '').localeCompare(String(a.start_time || '')); }

function rowHTML(a) {
    var meta = '<span>' + icon('clock') + esc(fmtDate(a.start_time)) + '</span>';
    if (a.location) meta += '<span>' + icon('pin') + esc(a.location) + '</span>';
    return '<button type="button" class="list-row" data-act="activity-detail" data-id="' + escAttr(a.id) + '">'
        + '<div class="list-row-main">'
        + '<div class="list-row-title"><span class="list-row-name">' + esc(a.title) + '</span></div>'
        + '<div class="list-row-meta">' + meta + '</div>'
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
    var el = document.getElementById('activityListView');
    el.innerHTML = skeletonHTML(5);
    try {
        var res = await api('/api/activities?scope=all');
        renderList((res.data && res.data.list) || []);
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/** 列表渲染。首次加载与「App 壳里原生后台刷新完推回新数据」共用这一个入口 */
function renderList(list) {
    var el = document.getElementById('activityListView');
    if (!list.length) { el.innerHTML = stateHTML('暂无活动'); return; }
    var groups = { ongoing: [], upcoming: [], ended: [] };
    list.forEach(function (a) { groups[statusOf(a)].push(a); });
    groups.ongoing.sort(byStartAsc);
    groups.upcoming.sort(byStartAsc);
    groups.ended.sort(byStartDesc);
    var html = '';
    if (groups.ongoing.length) html += groupHTML('正在进行', groups.ongoing, true);
    if (groups.upcoming.length) html += groupHTML('将要开始', groups.upcoming, false);
    if (groups.ended.length) html += groupHTML('已经结束', groups.ended, false);
    el.innerHTML = html;
}

// App 壳：原生层先把缓存给页面（首帧不必等网络），后台取到新数据再推回这里重绘。
// 键必须与上面 api() 的 URL 一字不差 —— 原生那边的缓存键就是它。网页版不会被调用。
onApiData('/api/activities?scope=all', function (data) { renderList((data && data.list) || []); });

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
    card.innerHTML = stateHTML('正在加载…');
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
        // canManage 由服务端算（创建者本人或 user:manage）：不是自己能改的就不显示按钮，
        // 否则点下去只会拿到 403
        var actBtns = canContentWrite() && a.canManage
            ? '<div class="modal-foot">'
              + '<button type="button" class="btn btn-outline" data-act="edit-activity" data-id="' + escAttr(a.id) + '">编辑</button>'
              + '<button type="button" class="btn btn-danger" data-act="del-activity" data-id="' + escAttr(a.id) + '">删除</button>'
              + '</div>'
            : '';
        card.innerHTML =
            '<div class="detail-head"><div class="detail-title">' + esc(a.title) + '</div></div>'
            + '<div class="detail-meta">' + meta + '</div>'
            + '<div class="detail-body">' + esc(a.content || '暂无活动说明') + '</div>'
            + byline
            + remindLine
            + actBtns;
    } catch (err) {
        card.innerHTML = stateHTML(err.message, true);
    }
}

async function deleteActivity(id) {
    if (!confirm('确定删除该活动？')) return;
    try {
        await api('/api/activities/' + id, { method: 'DELETE' });
        closeDetail();
        loadList();
    } catch (err) {
        alert(err.message);
    }
}

function startEdit(id) {
    closeDetail();
    api('/api/activities/' + id).then(function (res) {
        var a = res.data;
        editingActivityId = id;
        document.getElementById('editError').classList.remove('show');
        document.getElementById('editTitle').value = a.title || '';
        document.getElementById('editContent').value = a.content || '';
        document.getElementById('editLocation').value = a.location || '';
        document.getElementById('editStart').value = (a.start_time || '').replace(' ', 'T').slice(0, 16);
        document.getElementById('editEnd').value = (a.end_time || '').replace(' ', 'T').slice(0, 16);
        var names = [];
        if (a.remind_people) { try { var arr = JSON.parse(a.remind_people); if (Array.isArray(arr)) names = arr; } catch (e) {} }
        renderRemindChoices(names);
        openEdit();
    }).catch(function (err) { alert(err.message); });
}

function cancelEdit() {
    closeEdit();
    editingActivityId = null;
}

async function submitEdit() {
    var errBox = document.getElementById('editError');
    errBox.classList.remove('show');
    var title = document.getElementById('editTitle').value.trim();
    var content = document.getElementById('editContent').value.trim();
    var location = document.getElementById('editLocation').value.trim();
    var start_time = document.getElementById('editStart').value;
    var end_time = document.getElementById('editEnd').value;
    if (!title || !start_time) {
        errBox.textContent = '标题、开始时间为必填';
        errBox.classList.add('show'); return;
    }
    var btn = document.getElementById('editSubmitBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '保存中…';
    try {
        var body = { title: title, content: content, location: location, start_time: start_time, end_time: end_time, remind_people: collectRemind() };
        await api('/api/activities/' + editingActivityId, { method: 'PUT', body: JSON.stringify(body) });
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
delegate(document, 'click', '[data-act="edit-activity"]', function (el) { startEdit(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-activity"]', function (el) { deleteActivity(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="activity-detail"]', function (el) { showDetail(el.getAttribute('data-id')); });

var deepActivityId = new URLSearchParams(location.search).get('id');
if (deepActivityId) showDetail(deepActivityId);
})();
