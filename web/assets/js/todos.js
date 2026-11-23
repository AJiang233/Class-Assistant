(function () {
// ===== 需要登录 =====
if (!requireAuth()) return;

// ===== 常量（与后端 todoHandler.js 的限制保持一致，前端先拦一道，少一次白跑的请求） =====
var TAGS_MAX = 4;        // 每条待办最多 4 个标签
var TAG_MAX_LEN = 12;    // 每个标签 1–12 字
var PAGE_SIZE = 50;      // 一页 50 条（后端 limit 上限 100）
// 预置标签的兜底值：后端 GET /api/todos 会返回 data.tags，正常以那份为准
var DEFAULT_TAGS = ['作业', '考试', '班会', '活动', '材料', '缴费'];

// ===== 页面状态 =====
var state = {
    tab: 'open',          // open = 进行中；history = 历史
    tag: '',              // 标签筛选（空串 = 全部）
    list: [],
    total: 0,
    counts: { open: 0, history: 0, overdue: 0 },
    prefs: { urgent_hours: 24, warn_hours: 36 },
    tags: DEFAULT_TAGS.slice()
};

// ===== 编辑弹窗状态 =====
// 新建 / 编辑 / 代加 共用一个弹窗，靠 mode 区分：字段一样，差的只是标题、成员多选块和提交的接口
var editor = {
    mode: 'create',         // create | edit | delegate
    id: null,
    members: [],            // 代加模式的可选成员
    membersLoaded: false,   // 名单只取一次
    membersFailed: false
};

var todoModal = document.getElementById('todoModal');
var prefsModal = document.getElementById('prefsModal');

// ===== 时间处理 =====
/**
 * 库里与接口一律是北京时间的 "YYYY-MM-DD HH:mm:ss"（见后端 datetime.js），
 * 而 <input type="datetime-local"> 要的是 "YYYY-MM-DDTHH:mm"：这两个函数就是那两端的换算。
 */
function toApi(v) {
    if (!v) return '';
    return String(v).replace('T', ' ') + ':00';
}
function toInput(v) {
    if (!v) return '';
    return String(v).replace(' ', 'T').slice(0, 16);
}
/** 列表里展示的时间：今年省掉年份（MM-DD HH:mm），跨年才写全，免得一行里塞太多数字 */
function fmtWhen(v) {
    if (!v) return '—';
    var s = String(v).replace('T', ' ').slice(0, 16);
    var y = String(new Date().getFullYear());
    return s.slice(0, 4) === y ? s.slice(5) : s;
}
/** 截止时间转毫秒。按 +08:00 解析，不跟着浏览器所在时区跑（境外的同学也看得懂） */
function dueMs(v) {
    if (!v) return 0;
    var d = new Date(String(v).replace(' ', 'T') + '+08:00');
    return isNaN(d.getTime()) ? 0 : d.getTime();
}
/** 相对剩余时间：比一个红点更容易看懂「到底还剩多久」 */
function leftText(t) {
    var ms = dueMs(t.due_at) - Date.now();
    if (!ms) return '';
    if (ms <= 0) return '已到期';
    var mins = Math.round(ms / 60000);
    if (mins < 60) return '还剩 ' + mins + ' 分钟';
    var hours = Math.round(mins / 60);
    if (hours < 48) return '还剩 ' + hours + ' 小时';
    return '还剩 ' + Math.round(hours / 24) + ' 天';
}
/** 新建时的默认截止：今天 23:59；已经过了这个点就顺延到明天 23:59 */
function defaultDue() {
    var end = todayEnd();                 // app.js：当日 "YYYY-MM-DDTHH:MM"
    if (end > nowLocal()) return end;     // 同格式字符串直接比大小即可
    var d = new Date();
    d.setDate(d.getDate() + 1);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T23:59';
}

// ===== 小工具 =====
function findTodo(id) {
    for (var i = 0; i < state.list.length; i++) {
        if (String(state.list[i].id) === String(id)) return state.list[i];
    }
    return null;
}
/** 代加件：自己之外的班委创建、派到我名下（created_by 与 owner_id 不是同一个人） */
function isDelegated(t) {
    return !!t.created_by && String(t.created_by) !== String(t.owner_id);
}
function sourceBadge(t) {
    if (t.source === 'notice') return '<span class="badge badge-manual">通知</span>';
    if (t.source === 'activity') return '<span class="badge badge-crawler">活动</span>';
    if (t.source === 'academic') return '<span class="badge badge-crawler">学业</span>';
    if (isDelegated(t)) return '<span class="badge badge-policy">班委代加</span>';
    return '';
}
function statusBadge(t) {
    if (t.status === 'done') return '<span class="badge badge-ok">已完成</span>';
    if (t.status === 'expired') return '<span class="badge badge-danger">已超时</span>';
    return '';
}
function urgencyClass(t) {
    return t.urgency === 'overdue' || t.urgency === 'urgent' ? 'urgent'
        : t.urgency === 'warn' ? 'warn' : 'normal';
}
function positionsText(p) {
    try {
        if (typeof parsePositionsList === 'function') return parsePositionsList(p).join('、');
    } catch (e) { /* 名单字段坏了就当没有职务：不该让整块选择区崩掉 */ }
    return '';
}

// ===== 一次性提示条 =====
var flashTimer = 0;
function flash(text, isError) {
    var box = document.getElementById('todoFlash');
    if (!box) return;
    box.textContent = text;
    box.hidden = false;
    box.classList.toggle('error', !!isError);
    if (flashTimer) clearTimeout(flashTimer);
    flashTimer = setTimeout(function () { box.hidden = true; }, 4000);
}

// ===== 列表加载 =====
/**
 * @param more true = 追加下一页（「加载更多」），false = 从第一页重取
 */
async function loadList(more) {
    var el = document.getElementById('todoList');
    if (!more) {
        state.list = [];
        el.innerHTML = skeletonHTML(4);
    }
    var url = '/api/todos?status=' + encodeURIComponent(state.tab)
        + '&limit=' + PAGE_SIZE
        + '&offset=' + (more ? state.list.length : 0)
        + (state.tag ? '&tag=' + encodeURIComponent(state.tag) : '');
    try {
        var res = await api(url);
        var data = res.data || {};
        if (data.counts) state.counts = data.counts;
        if (data.prefs) state.prefs = data.prefs;
        if (data.tags && data.tags.length) state.tags = data.tags;
        state.total = typeof data.total === 'number' ? data.total : 0;
        var page = data.list || [];
        state.list = more ? state.list.concat(page) : page;
        render();
    } catch (err) {
        if (more) {
            flash(err.message, true);
        } else {
            // 列表整块失败：连「加载更多」一起收起，否则用户会对着一个永远没反应的按钮点
            el.innerHTML = stateHTML(err.message, true);
            document.getElementById('moreBtn').hidden = true;
            document.getElementById('tagFilter').innerHTML = '';
            document.getElementById('historyNote').hidden = true;
        }
    }
}

function render() {
    var el = document.getElementById('todoList');
    renderTagFilter();

    // 历史页顶部那句统计：「共 N 条历史待办，其中 M 条超时」
    var note = document.getElementById('historyNote');
    if (state.tab === 'history') {
        note.hidden = false;
        note.textContent = '共 ' + state.counts.history + ' 条历史待办，其中 ' + state.counts.overdue + ' 条超时';
    } else {
        note.hidden = true;
    }

    if (!state.list.length) {
        el.innerHTML = stateHTML(state.tab === 'history'
            ? '还没有完成或超时的待办'
            : '暂无待办，点上面「+ 新建待办」记一条');
    } else {
        el.innerHTML = '<div class="list">' + state.list.map(rowHTML).join('') + '</div>';
    }

    // 还有下一页才给「加载更多」
    var moreBtn = document.getElementById('moreBtn');
    moreBtn.hidden = state.list.length >= state.total;
}

function rowHTML(t) {
    var history = state.tab === 'history';
    var meta = [];
    if (history) {
        if (t.status === 'done' && t.completed_at) {
            meta.push('<span>' + icon('clock') + '完成于 ' + esc(fmtWhen(t.completed_at)) + '</span>');
        }
        meta.push('<span>' + icon('clock') + '截止 ' + esc(fmtWhen(t.due_at)) + '</span>');
    } else {
        meta.push('<span>' + icon('clock') + '截止 ' + esc(fmtWhen(t.due_at)) + '</span>');
        if (t.start_at) meta.push('<span>' + icon('calendar') + '开始 ' + esc(fmtWhen(t.start_at)) + '</span>');
        var left = leftText(t);
        if (left) meta.push('<span class="todo-left todo-' + urgencyClass(t) + '">' + esc(left) + '</span>');
    }

    var tags = (t.tags || []).map(function (tag) {
        return '<span class="todo-tag">' + esc(tag) + '</span>';
    }).join('');
    var desc = t.description
        ? '<div class="todo-desc">' + esc(t.description) + '</div>'
        : '';
    // 未超时的进行中件才给红点：已超时的已经挪进历史页，颜色在那儿由状态徽章表达
    var dot = history ? '' : '<span class="todo-dot todo-' + urgencyClass(t) + '" aria-hidden="true"></span>';

    return '<div class="list-row todo-row">'
        + dot
        + '<div class="list-row-main">'
        + '<div class="list-row-title">'
        + '<span class="list-row-name">' + esc(t.title) + '</span>'
        + sourceBadge(t)
        + statusBadge(t)
        + tags
        + '</div>'
        + '<div class="list-row-meta">' + meta.join('') + '</div>'
        + desc
        + '</div>'
        + rowActionsHTML(t, history)
        + '</div>';
}

function rowActionsHTML(t, history) {
    var btns = [];
    if (!history && t.status === 'open') {
        btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="done-todo" data-id="' + escAttr(t.id) + '">完成</button>');
        btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="edit-todo" data-id="' + escAttr(t.id) + '">编辑</button>');
    }
    // 代加件的「删除」对我和对班委是两件事：我用「撤回」这个词，说明它不是我自己的计划
    var label = (!history && isDelegated(t)) ? '撤回' : '删除';
    btns.push('<button type="button" class="btn btn-sm btn-danger" data-act="del-todo" data-id="' + escAttr(t.id) + '">' + label + '</button>');
    return '<div class="todo-actions">' + btns.join('') + '</div>';
}

// ===== 标签筛选 =====
function renderTagFilter() {
    var box = document.getElementById('tagFilter');
    if (!box) return;
    var tags = state.tags.slice();
    // 正在筛选的如果是自定义标签（不在预置列表里），也要给一个可点的当前项，否则用户没法退回全部
    if (state.tag && tags.indexOf(state.tag) < 0) tags.push(state.tag);
    var html = tags.map(function (tag) {
        var on = (state.tag || '') === tag;
        return '<button type="button" class="todo-filter' + (on ? ' on' : '') + '" data-act="filter-tag" data-tag="'
            + escAttr(tag) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(tag) + '</button>';
    }).join('');
    box.innerHTML = '<button type="button" class="todo-filter' + (state.tag ? '' : ' on') + '" data-act="filter-tag" data-tag="" aria-pressed="'
        + (state.tag ? 'false' : 'true') + '">全部</button>' + html;
}

function setTagFilter(tag) {
    state.tag = tag || '';
    loadList(false);
}

// ===== 分段控件（进行中 / 历史） =====
function moveSegPill() {
    var pill = document.getElementById('todoSegPill');
    if (!pill) return;
    var active = pill.parentNode.querySelector('.tab.active');
    // 隐藏 / 未布局时量出来是 0，先藏起滑块（与学业页 moveAcSegPill 同一套判断）
    if (!active || !active.offsetWidth) { pill.style.opacity = '0'; return; }
    pill.style.left = active.offsetLeft + 'px';
    pill.style.top = active.offsetTop + 'px';
    pill.style.width = active.offsetWidth + 'px';
    pill.style.height = active.offsetHeight + 'px';
    pill.style.opacity = '1';
}

function switchTab(name) {
    if (name !== 'open' && name !== 'history') return;
    if (state.tab === name) return;
    state.tab = name;
    var tabs = document.querySelectorAll('#todoSeg .tab');
    for (var i = 0; i < tabs.length; i++) {
        tabs[i].classList.toggle('active', tabs[i].getAttribute('data-tab') === name);
    }
    moveSegPill();
    loadList(false);
}

// ===== 编辑弹窗 =====
function showError(boxId, msg) {
    var box = document.getElementById(boxId);
    box.textContent = msg;
    box.classList.add('show');
}
function clearError(boxId) {
    var box = document.getElementById(boxId);
    box.textContent = '';
    box.classList.remove('show');
}
function openOverlay(overlay) {
    overlay.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeOverlay(overlay) {
    overlay.classList.remove('show');
    document.body.style.overflow = '';
}

function openTodoModal(mode, todo) {
    editor.mode = mode;
    editor.id = todo ? todo.id : null;
    document.getElementById('todoModalTitle').textContent =
        mode === 'edit' ? '编辑待办' : (mode === 'delegate' ? '代加待办' : '新建待办');
    document.getElementById('todoSubmitBtn').textContent = mode === 'delegate' ? '添加到所选同学' : '保存';
    // 成员多选只在代加模式出现，其余两种模式下整块不占位置
    document.getElementById('memberField').hidden = mode !== 'delegate';

    document.getElementById('tdTitle').value = todo ? (todo.title || '') : '';
    document.getElementById('tdDesc').value = todo ? (todo.description || '') : '';
    document.getElementById('tdStart').value = todo ? toInput(todo.start_at) : '';
    document.getElementById('tdDue').value = todo ? toInput(todo.due_at) : defaultDue();
    document.getElementById('tagInput').value = '';
    clearError('todoError');
    renderTagPicker(todo ? (todo.tags || []) : []);

    if (mode === 'delegate') loadMembers();
    openOverlay(todoModal);
}

function closeTodoModal() {
    closeOverlay(todoModal);
    editor.id = null;
}

// ===== 标签选择 =====
/** 预置标签 + 当前已选（含自定义），全部渲染成可勾选的芯片 */
function renderTagPicker(selected) {
    var sel = selected || [];
    var all = state.tags.slice();
    sel.forEach(function (tag) { if (all.indexOf(tag) < 0) all.push(tag); });
    document.getElementById('tagPicker').innerHTML = all.map(function (tag) {
        var on = sel.indexOf(tag) >= 0 ? ' checked' : '';
        return '<label class="chip"><input type="checkbox" class="tag-cb" value="'
            + escAttr(tag) + '"' + on + '>' + esc(tag) + '</label>';
    }).join('');
}

function collectTags() {
    var out = [];
    document.querySelectorAll('#tagPicker .tag-cb:checked').forEach(function (el) { out.push(el.value); });
    return out;
}

/** 勾选变化：超过 4 个就撤销这一次勾选（比等提交时再报错更早、更清楚） */
function onTagChange(e) {
    var el = e.target;
    if (!el || !el.classList || !el.classList.contains('tag-cb')) return;
    if (!el.checked) return;
    if (collectTags().length > TAGS_MAX) {
        el.checked = false;
        showError('todoError', '标签最多 4 个');
    }
}

function addCustomTag() {
    var input = document.getElementById('tagInput');
    var v = input.value.trim();
    if (!v) return;
    if (v.length > TAG_MAX_LEN) { showError('todoError', '每个标签不能超过 12 个字'); return; }
    var sel = collectTags();
    if (sel.indexOf(v) >= 0) { input.value = ''; return; }   // 已经有了，不重复加
    if (sel.length >= TAGS_MAX) { showError('todoError', '标签最多 4 个'); return; }
    sel.push(v);
    renderTagPicker(sel);
    clearError('todoError');
    input.value = '';
}

// ===== 代加模式的成员多选 =====
async function loadMembers() {
    var box = document.getElementById('memberBox');
    if (editor.membersLoaded) { renderMembers(); return; }
    box.innerHTML = '<span class="remind-hint">正在加载名单…</span>';
    try {
        var res = await api('/api/auth/members-pick');
        editor.members = (res.data && res.data.list) || [];
        editor.membersLoaded = true;
        editor.membersFailed = false;
    } catch (e) {
        // 失败与「班里真没有成员」必须分开：失败时提交会把待办发给 0 个人，用户却以为成功了
        editor.members = [];
        editor.membersFailed = true;
    }
    renderMembers();
}

function renderMembers() {
    var box = document.getElementById('memberBox');
    var hint = document.getElementById('memberHint');
    var submit = document.getElementById('todoSubmitBtn');
    if (editor.membersFailed) {
        box.innerHTML = '<span class="remind-hint remind-text-error">名单加载失败，请关闭弹窗重试</span>';
        hint.textContent = '';
        submit.disabled = true;
        return;
    }
    submit.disabled = false;
    if (!editor.members.length) {
        box.innerHTML = '<span class="remind-hint">暂无可选的班级成员</span>';
        hint.textContent = '';
        return;
    }
    box.innerHTML = editor.members.map(function (m) {
        var pos = positionsText(m.positions);
        return '<label class="chip"><input type="checkbox" class="member-cb" value="' + escAttr(m.id) + '">'
            + esc(m.name) + (pos ? ' · ' + esc(pos) : '') + '</label>';
    }).join('');
    updateMemberHint();
}

function collectMembers() {
    var out = [];
    document.querySelectorAll('#memberBox .member-cb:checked').forEach(function (el) { out.push(Number(el.value)); });
    return out;
}

function updateMemberHint() {
    var hint = document.getElementById('memberHint');
    if (!hint) return;
    var n = collectMembers().length;
    hint.textContent = n ? '已选 ' + n + ' 人' : '还没选人';
}

function toggleAllMembers() {
    var boxes = document.querySelectorAll('#memberBox .member-cb');
    if (!boxes.length) return;
    var allChecked = true;
    boxes.forEach(function (b) { if (!b.checked) allChecked = false; });
    boxes.forEach(function (b) { b.checked = !allChecked; });
    updateMemberHint();
}

// ===== 提交：新建 / 编辑 / 代加 =====
async function submitTodo() {
    clearError('todoError');
    var title = document.getElementById('tdTitle').value.trim();
    var description = document.getElementById('tdDesc').value.trim();
    var start = document.getElementById('tdStart').value;
    var due = document.getElementById('tdDue').value;
    var tags = collectTags();

    if (!title) { showError('todoError', '请填写待办标题'); return; }
    if (title.length > 100) { showError('todoError', '标题最多 100 字'); return; }
    if (!due) { showError('todoError', '请选择截止时间'); return; }
    var startAt = start ? toApi(start) : '';
    var dueAt = toApi(due);
    // 同格式字符串比较即可：'YYYY-MM-DD HH:mm:ss' 的字典序就是时间序
    if (startAt && dueAt <= startAt) { showError('todoError', '截止时间必须晚于开始时间'); return; }
    if (tags.length > TAGS_MAX) { showError('todoError', '标签最多 4 个'); return; }

    var memberIds = [];
    if (editor.mode === 'delegate') {
        memberIds = collectMembers();
        if (!memberIds.length) { showError('todoError', '请选择至少一位同学'); return; }
    }

    var body = { title: title, description: description, due_at: dueAt, tags: tags };
    // 新建时开始时间是可选字段，空着就别传；编辑时显式传空串才能把原来的开始时间清掉
    if (startAt || editor.mode === 'edit') body.start_at = startAt;

    var btn = document.getElementById('todoSubmitBtn');
    var label = btn.textContent;
    btn.disabled = true;
    btn.textContent = '提交中…';
    try {
        if (editor.mode === 'delegate') {
            var res = await api('/api/todos/delegate', {
                method: 'POST',
                body: JSON.stringify(Object.assign({ user_ids: memberIds }, body))
            });
            var msg = (res.data && res.data.message) || ('已给 ' + memberIds.length + ' 位同学添加待办');
            closeTodoModal();
            flash(msg);
        } else if (editor.mode === 'edit') {
            await api('/api/todos/' + editor.id, { method: 'PUT', body: JSON.stringify(body) });
            closeTodoModal();
            flash('已保存');
        } else {
            await api('/api/todos', { method: 'POST', body: JSON.stringify(body) });
            closeTodoModal();
            flash('已添加');
        }
        loadList(false);
    } catch (err) {
        showError('todoError', err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = label;
    }
}

// ===== 行内操作 =====
async function markDone(id) {
    try {
        await api('/api/todos/' + id + '/status', { method: 'POST', body: JSON.stringify({ status: 'done' }) });
        flash('已完成');
        loadList(false);
    } catch (err) {
        // 典型是「刚好在点之前超时了」（后端返回 TODO_EXPIRED）：提示 + 重取列表，两边状态就对齐了
        flash(err.message, true);
        loadList(false);
    }
}

function startEdit(id) {
    var t = findTodo(id);
    if (!t) { loadList(false); return; }
    openTodoModal('edit', t);
}

async function deleteTodo(id) {
    var t = findTodo(id);
    var label = (t && isDelegated(t) && t.status === 'open') ? '撤回' : '删除';
    if (!confirm('确定' + label + '这条待办？')) return;
    try {
        await api('/api/todos/' + id, { method: 'DELETE' });
        flash('已' + label);
        loadList(false);
    } catch (err) {
        flash(err.message, true);
    }
}

// ===== 提醒设置 =====
function openPrefs() {
    clearError('prefsError');
    document.getElementById('pfUrgent').value = state.prefs.urgent_hours;
    document.getElementById('pfWarn').value = state.prefs.warn_hours;
    openOverlay(prefsModal);
}
function closePrefsModal() {
    closeOverlay(prefsModal);
}

async function submitPrefs() {
    clearError('prefsError');
    var u = Number(document.getElementById('pfUrgent').value);
    var w = Number(document.getElementById('pfWarn').value);
    // 先按后端同一套规则校验一遍：文案也用后端那三句，用户看到的提示不会因为路径不同而变样
    if (!isFinite(u) || u !== Math.floor(u) || u < 1 || u > 168) { showError('prefsError', '红色提醒时间需为 1–168 小时'); return; }
    if (!isFinite(w) || w !== Math.floor(w) || w < 2 || w > 720) { showError('prefsError', '黄色提醒时间需为 2–720 小时'); return; }
    if (w <= u) { showError('prefsError', '黄色提醒时间必须晚于红色提醒时间'); return; }

    var btn = document.getElementById('prefsSubmitBtn');
    btn.disabled = true;
    try {
        var res = await api('/api/todos/prefs', {
            method: 'PUT',
            body: JSON.stringify({ urgent_hours: u, warn_hours: w })
        });
        if (res.data && res.data.prefs) state.prefs = res.data.prefs;
        else state.prefs = { urgent_hours: u, warn_hours: w };
        closePrefsModal();
        flash('提醒设置已保存');
        // 阈值一变，每条待办的红 / 黄档就跟着变，必须重取一遍（urgency 由服务端算）
        loadList(false);
    } catch (err) {
        showError('prefsError', err.message);
    } finally {
        btn.disabled = false;
    }
}

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 列表行由 innerHTML 反复重绘，所以统一用 data-act 标记 + document 上的委托（与通知页同一套写法）。
delegate(document, 'click', '[data-act="new-todo"]', function () { openTodoModal('create', null); });
delegate(document, 'click', '[data-act="open-delegate"]', function () { openTodoModal('delegate', null); });
delegate(document, 'click', '[data-act="open-prefs"]', function () { openPrefs(); });
delegate(document, 'click', '[data-act="cancel-todo"]', function () { closeTodoModal(); });
delegate(document, 'click', '[data-act="cancel-prefs"]', function () { closePrefsModal(); });
delegate(document, 'click', '[data-act="switch-tab"]', function (el) { switchTab(el.getAttribute('data-tab')); });
delegate(document, 'click', '[data-act="filter-tag"]', function (el) { setTagFilter(el.getAttribute('data-tag') || ''); });
delegate(document, 'click', '[data-act="done-todo"]', function (el) { markDone(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="edit-todo"]', function (el) { startEdit(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-todo"]', function (el) { deleteTodo(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="add-tag"]', function () { addCustomTag(); });
delegate(document, 'click', '[data-act="select-all-members"]', function () { toggleAllMembers(); });
delegate(document, 'click', '[data-act="load-more"]', function () { loadList(true); });
// 勾选变化：标签超过 4 个要立刻拦、成员数要实时报给用户
delegate(document, 'change', '#tagPicker .tag-cb', onTagChange);
delegate(document, 'change', '#memberBox .member-cb', updateMemberHint);

var todoSubmitBtn = document.getElementById('todoSubmitBtn');
if (todoSubmitBtn) todoSubmitBtn.addEventListener('click', submitTodo);
var prefsSubmitBtn = document.getElementById('prefsSubmitBtn');
if (prefsSubmitBtn) prefsSubmitBtn.addEventListener('click', submitPrefs);

// 自定义标签：回车等同「添加」，省得每次都要去点按钮
var tagInput = document.getElementById('tagInput');
if (tagInput) tagInput.addEventListener('keydown', function (e) {
    if (e.key === 'Enter') { e.preventDefault(); addCustomTag(); }
});

// 点遮罩空白处 / 按 ESC 关闭弹窗（空值守卫：节点改名时别把后半段的绑定打死）
if (todoModal) todoModal.addEventListener('click', function (e) {
    if (e.target === todoModal) closeTodoModal();
});
if (prefsModal) prefsModal.addEventListener('click', function (e) {
    if (e.target === prefsModal) closePrefsModal();
});
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    if (todoModal && todoModal.classList.contains('show')) closeTodoModal();
    else if (prefsModal && prefsModal.classList.contains('show')) closePrefsModal();
});

// 代加入口只给 content:write（班长 / 团支书 / 学习委员）。后端同样有权限门，这里只是不摆死按钮
if (canContentWrite()) {
    var delegateBtn = document.getElementById('delegateBtn');
    if (delegateBtn) delegateBtn.hidden = false;
}

// 滑块在布局完成后才有尺寸：首帧排一次，窗口变化再排一次
moveSegPill();
window.addEventListener('resize', moveSegPill);

loadList(false);
})();
