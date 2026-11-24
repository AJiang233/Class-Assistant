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
    hidden: false,        // 历史页是否在看「已隐藏」视图
    list: [],
    total: 0,
    // 详情展开状态：key 是待办 id，value 是 true。列表重绘（刷新 / 同步 / 切页签）后仍保留，
    // 用户展开看说明时不会被一次后台刷新又收回去。
    expanded: {},
    counts: { open: 0, history: 0, overdue: 0, hidden: 0 },
    prefs: { urgent_hours: 24, warn_hours: 36 },
    tags: DEFAULT_TAGS.slice(),
    sync: null,           // 服务端共享的同步状态（见 GET /api/todos 的 data.sync，两个来源共用这一条）
    autoSynced: false     // 每次进页面最多自动同步一次，避免失败后无限重试
};

// ===== 同步按钮的各自状态 =====
// 服务端只有一条 todo_sync_state（60 秒冷却也是共用的），但两个按钮的「同步中 / 冷却」
// 必须各存一份：点学习通不该把 MOOC 按钮一起锁住，否则用户会以为 MOOC 同步也失败了。
// readyAt 是本地的冷却截止时刻；进入页面时会用服务端 last_attempt_at 播种（见 seedSyncCooldown），
// 换设备 / 刷新页面也能续上同一条服务端冷却。
var syncUi = {
    chaoxing: { busy: false, progress: null, readyAt: 0 },
    mooc: { busy: false, progress: null, readyAt: 0 }
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
/** 把一份列表响应落到 state 并重绘（首屏与「后台刷新推回」共用） */
function applyListData(data, more) {
    data = data || {};
    if (data.counts) state.counts = data.counts;
    if (data.prefs) state.prefs = data.prefs;
    if (data.tags && data.tags.length) state.tags = data.tags;
    if (data.sync !== undefined) state.sync = data.sync;
    seedSyncCooldown();
    state.total = typeof data.total === 'number' ? data.total : 0;
    var page = data.list || [];
    state.list = more ? state.list.concat(page) : page;
    render();
}

/**
 * @param more true = 追加下一页（「加载更多」），false = 从第一页重取
 * @param force true = 带 refresh=1 绕过本地缓存首帧（刚改完待办时用，避免先闪回旧列表）
 */
async function loadList(more, force) {
    var el = document.getElementById('todoList');
    if (!more) {
        state.list = [];
        el.innerHTML = skeletonHTML(4);
    }
    var url = '/api/todos?status=' + encodeURIComponent(state.tab)
        + '&limit=' + PAGE_SIZE
        + '&offset=' + (more ? state.list.length : 0)
        + (state.tag ? '&tag=' + encodeURIComponent(state.tag) : '')
        + (state.tab === 'history' && state.hidden ? '&hidden=1' : '');
    var reqTab = state.tab;
    var reqTag = state.tag || '';
    var reqHidden = state.hidden;
    if (!more) {
        // App 壳：本地有缓存时原生先回一帧，随后把后台刷新的新数据推到「不带 refresh=1」
        // 的键上（缓存键就是 URL）。不注册的话页面会一直停在旧数据上，直到用户手动操作。
        // 推回来时已经切了页签 / 标签 / 隐藏视图的，直接丢掉 —— 别把上一个筛选的结果画到当前列表里。
        onApiData(url, function (data) {
            if (state.tab !== reqTab || (state.tag || '') !== reqTag || state.hidden !== reqHidden) return;
            applyListData(data, false);
        });
    }
    try {
        var res = await api(force ? url + '&refresh=1' : url);
        applyListData(res.data, more);
        if (!more) maybeAutoSync();
    } catch (err) {
        if (more) {
            flash(err.message, true);
        } else {
            // 列表整块失败：连「加载更多」一起收起，否则用户会对着一个永远没反应的按钮点
            el.innerHTML = stateHTML(err.message, true);
            // 旧版应用壳（Service Worker 里的 HTML 还没换新）可能缺这几个节点：
            // 逐个判空，别让一个缺失的按钮把整页脚本打断。
            var moreBtn = document.getElementById('moreBtn');
            if (moreBtn) moreBtn.hidden = true;
            var tagFilter = document.getElementById('tagFilter');
            if (tagFilter) tagFilter.innerHTML = '';
            var historyNote = document.getElementById('historyNote');
            if (historyNote) historyNote.hidden = true;
            var hiddenToggle = document.getElementById('hiddenToggle');
            if (hiddenToggle) hiddenToggle.hidden = true;
        }
    }
}

function render() {
    var el = document.getElementById('todoList');
    renderTagFilter();

    // 历史页顶部那句统计：「共 N 条历史待办，其中 M 条超时」；
    // 右侧「查看已隐藏」只在真的有隐藏项时出现，隐藏视图里变成「返回历史」。
    var note = document.getElementById('historyNote');
    var hiddenToggle = document.getElementById('hiddenToggle');
    var bar = document.querySelector('.todo-history-bar');
    if (bar) bar.classList.toggle('show', state.tab === 'history');
    // 旧版应用壳可能没有历史栏节点（升级当次「新脚本 + 旧 HTML」），判空后再写：
    // 这里在首屏 render() 的必经路径上，少一个判空就是整页脚本中断。
    var hiddenCount = (state.counts && state.counts.hidden) || 0;
    if (state.tab === 'history') {
        if (note) {
            note.hidden = false;
            note.textContent = state.hidden
                ? '已隐藏 ' + hiddenCount + ' 条学业待办'
                : '共 ' + state.counts.history + ' 条历史待办，其中 ' + state.counts.overdue + ' 条超时';
        }
        // 隐藏视图里即使已经全部取消隐藏也要保留「返回历史」，
        // 否则用户会把最后一条放出来之后被困在一个空的隐藏视图里。
        if (hiddenToggle) {
            hiddenToggle.hidden = !hiddenCount && !state.hidden;
            hiddenToggle.textContent = state.hidden ? '返回历史' : '查看已隐藏（' + hiddenCount + '）';
        }
    } else {
        if (note) note.hidden = true;
        if (hiddenToggle) hiddenToggle.hidden = true;
    }

    if (!state.list.length) {
        el.innerHTML = stateHTML(state.tab === 'history'
            ? (state.hidden ? '没有隐藏的待办' : '还没有完成或超时的待办')
            : '暂无待办，点上面「+ 新建待办」记一条');
    } else {
        el.innerHTML = '<div class="list">' + state.list.map(rowHTML).join('') + '</div>';
    }

    // 还有下一页才给「加载更多」
    var moreBtn = document.getElementById('moreBtn');
    if (moreBtn) moreBtn.hidden = state.list.length >= state.total;
    renderSyncUI();
}

function rowHTML(t) {
    var history = state.tab === 'history';
    var sid = String(t.id);
    var expanded = !!state.expanded[sid];
    var uc = urgencyClass(t);

    // 收起时只留「标题 + 截止时间」；开始时间、剩余时间、标签、说明、操作全部放进详情。
    // 详情展开状态按 id 记在 state.expanded 里，后台刷新 / 同步重绘后不会又收回去。
    var meta = [];
    if (history) {
        if (t.status === 'done' && t.completed_at) {
            meta.push('<span>' + icon('clock') + '完成于 ' + esc(fmtWhen(t.completed_at)) + '</span>');
        }
    } else {
        if (t.start_at) meta.push('<span>' + icon('calendar') + '开始 ' + esc(fmtWhen(t.start_at)) + '</span>');
        var left = leftText(t);
        if (left) meta.push('<span class="todo-left todo-' + uc + '">' + esc(left) + '</span>');
    }

    var tags = (t.tags || []).map(function (tag) {
        return '<span class="todo-tag">' + esc(tag) + '</span>';
    }).join('');
    var badges = sourceBadge(t) + statusBadge(t);
    var desc = t.description
        ? '<div class="todo-desc">' + esc(t.description) + '</div>'
        : '';

    var detail = '<div class="todo-detail" id="todoDetail-' + escAttr(sid) + '"' + (expanded ? '' : ' hidden') + '>'
        + (badges || tags ? '<div class="todo-detail-tags">' + badges + tags + '</div>' : '')
        + (meta.length ? '<div class="list-row-meta">' + meta.join('') + '</div>' : '')
        + desc
        + rowActionsHTML(t, history)
        + '</div>';

    // 整行按紧急度铺一层「左深右浅」的提示色：绿 = 还早，黄 = 该留神，红 = 临期 / 已超时。
    // 圆点与左侧渐变同色，扫一眼不看字也能分出三档。
    return '<div class="list-row todo-row todo-row-' + uc + (expanded ? ' expanded' : '') + '" data-id="' + escAttr(sid) + '">'
        + '<div class="todo-head" data-act="toggle-todo">'
        + '<span class="todo-dot todo-' + uc + '" aria-hidden="true"></span>'
        + '<span class="todo-head-main">'
        + '<span class="todo-head-title">' + esc(t.title) + '</span>'
        + '<span class="todo-head-due">截止 ' + esc(fmtWhen(t.due_at)) + '</span>'
        + '</span>'
        + '<button type="button" class="todo-toggle" data-act="toggle-todo" aria-expanded="' + (expanded ? 'true' : 'false') + '"'
        + ' aria-controls="todoDetail-' + escAttr(sid) + '" aria-label="' + (expanded ? '收起详情' : '展开详情') + '">'
        + '<svg class="todo-caret" width="18" height="18" viewBox="0 0 24 24" fill="currentColor" aria-hidden="true"><path d="M7 10l5 5 5-5z"/></svg>'
        + '</button>'
        + '</div>'
        + detail
        + '</div>';
}

/** 展开 / 收起一条待办的详情：只改这一行，不重绘整个列表（滚动位置不会跳）。 */
function toggleTodo(el) {
    var row = el && el.closest ? el.closest('.todo-row') : null;
    if (!row) return;
    var id = row.getAttribute('data-id');
    if (id == null) return;
    var open = !state.expanded[id];
    state.expanded[id] = open;
    row.classList.toggle('expanded', open);
    var detail = row.querySelector('.todo-detail');
    if (detail) detail.hidden = !open;
    var btn = row.querySelector('.todo-toggle');
    if (btn) {
        btn.setAttribute('aria-expanded', open ? 'true' : 'false');
        btn.setAttribute('aria-label', open ? '收起详情' : '展开详情');
    }
}

function rowActionsHTML(t, history) {
    var btns = [];
    if (!history && t.status === 'open') {
        btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="done-todo" data-id="' + escAttr(t.id) + '">完成</button>');
        btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="edit-todo" data-id="' + escAttr(t.id) + '">编辑</button>');
    }
    // 历史页里，学习通同步来的待办可以收进「已隐藏」；手动 / 通知 / 活动待办不提供这个入口。
    if (history && t.source === 'academic') {
        if (state.hidden) {
            btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="unhide-todo" data-id="' + escAttr(t.id) + '">取消隐藏</button>');
        } else {
            btns.push('<button type="button" class="btn btn-sm btn-outline" data-act="hide-todo" data-id="' + escAttr(t.id) + '">隐藏</button>');
        }
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
    state.hidden = false;   // 换页签回到「进行中 / 全部历史」，别把上一次的隐藏视图带过去
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
        notifyTodoChanged();
        loadList(false, true);
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
        notifyTodoChanged();
        loadList(false, true);
    } catch (err) {
        // 典型是「刚好在点之前超时了」（后端返回 TODO_EXPIRED）：提示 + 重取列表，两边状态就对齐了
        flash(err.message, true);
        notifyTodoChanged();
        loadList(false, true);
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
        notifyTodoChanged();
        loadList(false, true);
    } catch (err) {
        flash(err.message, true);
    }
}

// ===== 学习通 / 中国大学MOOC 同步 =====
// 前端只负责「分批把服务端跑完」和「把冷却画出来」：
// 拉哪些课、怎么判定完成、什么时候并进历史，全部在 handleSyncChaoxingTodos / handleSyncMoocTodos 里。
// 两个来源共用服务端同一条 todo_sync_state（60 秒冷却也共用），按钮状态按 kind 分开存。
var SYNC_COOLDOWN_MS = 60 * 1000;
var syncClock = 0;
var SYNC_DEFS = {
    chaoxing: {
        btn: 'syncBtn',
        endpoint: '/api/todos/sync-chaoxing',
        label: '同步学习通',
        name: '学习通',
        boot: '正在从学习通拉取未交作业和未考考试，第一次同步可能要一会儿…',
        progress: function (p) {
            return '正在同步学习通：第 ' + Math.min(p.processed, p.total) + '/' + p.total + ' 门课…';
        },
        notBound: '还没绑定学习通，绑定后每天会自动同步。'
    },
    mooc: {
        btn: 'moocSyncBtn',
        endpoint: '/api/todos/sync-mooc',
        label: '同步中国大学MOOC',
        name: '中国大学MOOC',
        boot: '正在从中国大学MOOC拉取未交作业与测验，第一次同步可能要一会儿…',
        progress: function (p) {
            return '正在同步中国大学MOOC：第 ' + Math.min(p.processed, p.total) + '/' + p.total + ' 门课程…';
        },
        notBound: '还没绑定中国大学MOOC，绑定后每天会自动同步。'
    }
};

/** 某个来源本地剩余冷却毫秒（只读自己那份 readyAt，不读服务端共享状态）。 */
function syncCooldownLeft(kind) {
    var ui = syncUi[kind];
    if (!ui || !ui.readyAt) return 0;
    return Math.max(0, ui.readyAt - Date.now());
}

/**
 * 用服务端那份共享的 last_attempt_at 给两个按钮各播一次冷却。
 * 服务端 60 秒窗口是共用的：刚同步过学习通，MOOC 按钮也应显示冷却，
 * 否则点了必然 429 —— 显示真实状态比「让按钮看起来可点」更有用。
 * 取 max 是为了不让一次较早的响应把本地刚点出来的冷却缩短。
 */
function seedSyncCooldown() {
    if (!state.sync || !state.sync.last_attempt_at) return;
    var ms = dueMs(state.sync.last_attempt_at);
    if (!ms) return;
    var until = ms + SYNC_COOLDOWN_MS;
    if (until <= Date.now()) return;
    Object.keys(syncUi).forEach(function (kind) {
        if (until > syncUi[kind].readyAt) syncUi[kind].readyAt = until;
    });
}

function stopSyncClock() {
    if (syncClock) { clearInterval(syncClock); syncClock = 0; }
}

/**
 * 补齐旧版应用壳缺失的节点。
 *
 * 升级当次可能拿到「新脚本 + Service Worker 里的旧 HTML」：旧壳没有同步按钮、
 * 没有同步状态行，历史统计也还是单独一个 <p>。这些节点缺了不会让脚本报错，
 * 但用户会找不到入口、已隐藏的待办也放不出来。这里按需重建，保证功能在旧壳上可用。
 * 新壳走一遍只会命中已有的 id，不会重复插入。
 */
function ensureTodoShell() {
    var toolbar = document.querySelector('.todo-toolbar');

    if (toolbar && !document.getElementById('syncBtn')) {
        var btn = document.createElement('button');
        btn.type = 'button';
        btn.className = 'btn btn-outline';
        btn.id = 'syncBtn';
        btn.setAttribute('data-act', 'sync-chaoxing');
        btn.textContent = '同步学习通';
        var delegateBtn = document.getElementById('delegateBtn');
        if (delegateBtn && delegateBtn.parentNode === toolbar) toolbar.insertBefore(btn, delegateBtn);
        else toolbar.appendChild(btn);
    }

    // MOOC 按钮同理：旧壳里没有它，也要补出来，否则升级当次用户看不到新入口。
    if (toolbar && !document.getElementById('moocSyncBtn')) {
        var moocBtn = document.createElement('button');
        moocBtn.type = 'button';
        moocBtn.className = 'btn btn-outline';
        moocBtn.id = 'moocSyncBtn';
        moocBtn.setAttribute('data-act', 'sync-mooc');
        moocBtn.textContent = '同步中国大学MOOC';
        toolbar.appendChild(moocBtn);
    }

    if (toolbar && !document.getElementById('syncNote')) {
        var note = document.createElement('p');
        note.className = 'todo-sync-note';
        note.id = 'syncNote';
        note.hidden = true;
        toolbar.insertAdjacentElement('afterend', note);
    }

    // 工具栏顺序统一成「代加 / 同步学习通 / 同步 MOOC / 提醒 / 新建」：整体靠右后，从右往左读依次是
    // 新建、提醒、MOOC、学习通、代加，最常用的新建落在右手拇指最容易够到的位置。
    // 旧壳里同步按钮是补进来的，位置会落在末尾；这里按 data-act 重排一次，新旧壳都对齐。
    if (toolbar) {
        ['open-delegate', 'sync-chaoxing', 'sync-mooc', 'open-prefs', 'new-todo'].forEach(function (act) {
            var node = toolbar.querySelector('[data-act="' + act + '"]');
            if (node) toolbar.appendChild(node);
        });
    }

    var historyNote = document.getElementById('historyNote');
    if (historyNote && !document.querySelector('.todo-history-bar')) {
        var bar = document.createElement('div');
        bar.className = 'todo-history-bar';
        historyNote.parentNode.insertBefore(bar, historyNote);
        bar.appendChild(historyNote);
    }
    if (document.querySelector('.todo-history-bar') && !document.getElementById('hiddenToggle')) {
        var toggle = document.createElement('button');
        toggle.type = 'button';
        toggle.className = 'todo-hidden-toggle';
        toggle.id = 'hiddenToggle';
        toggle.hidden = true;
        toggle.setAttribute('data-act', 'toggle-hidden');
        toggle.textContent = '查看已隐藏';
        document.querySelector('.todo-history-bar').appendChild(toggle);
    }
}

function renderSyncUI() {
    var note = document.getElementById('syncNote');
    var ticking = false;

    Object.keys(SYNC_DEFS).forEach(function (kind) {
        var def = SYNC_DEFS[kind];
        var btn = document.getElementById(def.btn);
        if (!btn) return;
        var ui = syncUi[kind];
        var left = syncCooldownLeft(kind);
        if (ui.busy) {
            btn.disabled = true;
            btn.textContent = '同步中…';
        } else if (left > 0) {
            btn.disabled = true;
            btn.textContent = def.label + '（' + Math.ceil(left / 1000) + ' 秒）';
            ticking = true;
        } else {
            btn.disabled = false;
            btn.textContent = def.label;
        }
    });

    if (ticking) {
        if (!syncClock) syncClock = setInterval(function () {
            renderSyncUI();
            var any = Object.keys(SYNC_DEFS).some(function (k) { return syncCooldownLeft(k) > 0; });
            if (!any) stopSyncClock();
        }, 1000);
    } else {
        // 两个按钮都没冷却了就把定时器停掉，别让一个空转的 1s interval 常驻页面。
        stopSyncClock();
    }

    if (!note) return;
    var text = '';
    var busyKind = null;
    Object.keys(SYNC_DEFS).some(function (kind) {
        if (syncUi[kind].busy) { busyKind = kind; return true; }
        return false;
    });
    var s = state.sync;
    if (busyKind) {
        var def = SYNC_DEFS[busyKind];
        var p = syncUi[busyKind].progress;
        text = p && p.total ? def.progress(p) : def.boot;
    } else if (s && s.last_result === 'not_bound') {
        // 这一行是两种同步共用的服务端状态，只记最后一次结果；
        // 不点名具体来源，免得出「学习通同步失败」却让用户以为 MOOC 也坏了。
        text = '有同步来源还没绑定账号，绑定后每天会自动同步。';
    } else if (s && s.last_result === 'error') {
        text = s.last_message || '上次同步失败，可以稍后手动重试。';
    } else if (s && s.last_synced_at) {
        text = '上次同步 ' + fmtWhen(s.last_synced_at) + (s.synced_today ? '（今天已同步）' : '');
    } else {
        // 从没同步过（sync 为 null）也要给一句提示，否则按钮旁边是空的。
        text = '今天还没同步，进入本页时会自动同步学习通。';
    }
    note.textContent = text;
    note.hidden = !text;
}

/** 每天第一次进页面自动同步一次；页面内失败不反复重试，交给手动按钮。 */
function maybeAutoSync() {
    if (state.autoSynced || syncUi.chaoxing.busy) return;
    state.autoSynced = true;
    var s = state.sync;
    // s 为 null 表示这个账号从没同步过（还没有 todo_sync_state 行），同样应该自动跑第一次。
    if (s && s.synced_today) return;
    if (s && s.last_result === 'not_bound') return;
    if (syncCooldownLeft('chaoxing') > 0) return;
    // 只自动同步学习通：两个来源共用服务端 60 秒窗口，进页面同时跑 MOOC 会立刻撞 429；
    // MOOC 作业量小、也可能没绑，交给用户手动点更可控。
    syncNow('chaoxing');
}

async function syncNow(kind) {
    var def = SYNC_DEFS[kind] || SYNC_DEFS.chaoxing;
    var ui = syncUi[kind];
    if (!ui) return;
    // 只拦自己这一份：学习通在同步时，MOOC 按钮仍然可点（服务端若是同一冷却窗口，
    // 会用 429 + retry_after 告诉用户还剩多久，比前端硬锁住更透明）。
    if (ui.busy || syncCooldownLeft(kind) > 0) { renderSyncUI(); return; }
    ui.busy = true;
    ui.progress = null;
    renderSyncUI();

    var cursor = 0;
    var guard = 0;
    var message = '';
    // 服务端一批 4 门课，每门还要补作业详情页；同步请求单独放宽到 90s，
    // 别再被 api() 默认的 30s 抢先掐断（服务端其实还在写库，前端却以为失败）。
    var timeoutMs = 90000;
    try {
        while (guard < 20) {
            guard += 1;
            var res;
            try {
                res = await api(def.endpoint, {
                    method: 'POST',
                    timeoutMs: timeoutMs,
                    body: JSON.stringify({ cursor: cursor, batch: 4, refresh: cursor === 0 })
                });
            } catch (err) {
                // 非第一批遇到网络抖动可以原样重试一次；第一批不能重试，否则会撞 60s 冷却。
                if (!err.code && cursor > 0) {
                    res = await api(def.endpoint, {
                        method: 'POST',
                        timeoutMs: timeoutMs,
                        body: JSON.stringify({ cursor: cursor, batch: 4, refresh: false })
                    });
                } else {
                    throw err;
                }
            }
            // 第一批真的打到服务端了，服务端已记下这次尝试：本地立刻点亮这一次的冷却。
            // 后面几批失败也不该让按钮马上又能点（再点也是 429），等 finally 的刷新校正。
            // bound===false 不算一次有效尝试（服务端可能不记 last_attempt_at），
            // 放到下面判断之后再点冷却，免得用户刚绑好账号却要白等 60 秒。
            var data = res.data || {};
            if (data.bound === false) {
                // 服务端 NOT_BOUND 的 message 是两种同步共用、写死了「学习通」；
                // MOOC 这里用本地文案，避免出现「还没绑定学习通」而用户点的是 MOOC。
                message = kind === 'mooc' ? def.notBound : (data.message || def.notBound);
                break;
            }
            if (guard === 1) ui.readyAt = Date.now() + SYNC_COOLDOWN_MS;
            if (typeof data.total_courses === 'number') {
                ui.progress = { processed: data.processed || 0, total: data.total_courses };
                renderSyncUI();
            }
            if (data.done) {
                message = data.message || (kind === 'mooc' ? '中国大学MOOC同步完成' : '同步完成');
                break;
            }
            var next = typeof data.next_cursor === 'number' ? data.next_cursor : cursor;
            // next_cursor 没前进说明服务端没有更多可抓的了：宁可停下报「完成」，也别原地打转。
            if (next <= cursor) { message = data.message || '同步完成'; break; }
            cursor = next;
        }
        if (message) flash(message);
    } catch (err) {
        // 429 说明服务端刚记过一次尝试（例如另一个标签页刚点过）：提示并靠刷新拿回冷却状态。
        var suffix = cursor > 0 ? '（已处理的前 ' + cursor + ' 项已保存，稍后可继续）' : '';
        flash(err.message + suffix, true);
    } finally {
        ui.busy = false;
        ui.progress = null;
        await loadList(false, true);
    }
}

function toggleHidden() {
    if (state.tab !== 'history') return;
    state.hidden = !state.hidden;
    loadList(false);
}

async function setTodoHidden(id, hidden) {
    try {
        var res = await api('/api/todos/' + id + '/hide', {
            method: 'POST',
            body: JSON.stringify({ hidden: hidden })
        });
        flash((res.data && res.data.message) || (hidden ? '已隐藏' : '已取消隐藏'));
        loadList(false, true);
    } catch (err) {
        flash(err.message, true);
    }
}

// ===== 提醒设置 =====
/** 原生侧的待办提醒设置；网页版没有桥，返回 null */
function readTodoRemindSettings() {
    if (!window.CAHost || typeof CAHost.todoReminderSettings !== 'function') return null;
    try { return JSON.parse(CAHost.todoReminderSettings() || '') || null; } catch (e) { return null; }
}

function openPrefs() {
    clearError('prefsError');
    document.getElementById('pfUrgent').value = state.prefs.urgent_hours;
    document.getElementById('pfWarn').value = state.prefs.warn_hours;
    // 到期前提醒只对 App 壳有意义（网页版没有本地到点通知），没桥就整块不显示
    var field = document.getElementById('pfRemindField');
    var info = readTodoRemindSettings();
    if (field && info) {
        var sel = document.getElementById('pfRemind');
        if (sel) sel.value = String(info.lead);
        var status = document.getElementById('pfRemindStatus');
        if (status) {
            status.textContent = info.todoCount
                ? '已同步 ' + info.todoCount + ' 条进行中待办；到点提醒由手机本地排期。'
                : '本机还没有进行中的待办；同步过一次后，新待办会自动排上提醒。';
        }
        field.hidden = false;
    }
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
        // App 壳：到期提前量存在原生侧，存完由原生立刻重排闹钟；网页版没有这个能力
        var remindField = document.getElementById('pfRemindField');
        var remindSel = document.getElementById('pfRemind');
        if (remindField && !remindField.hidden && remindSel
            && window.CAHost && typeof CAHost.saveTodoReminderSettings === 'function') {
            try { CAHost.saveTodoReminderSettings(parseInt(remindSel.value, 10) || 0); } catch (e) {}
        }
        closePrefsModal();
        flash('提醒设置已保存');
        // 阈值一变，每条待办的红 / 黄档就跟着变，必须重取一遍（urgency 由服务端算）
        loadList(false, true);
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
delegate(document, 'click', '[data-act="toggle-todo"]', function (el) { toggleTodo(el); });
delegate(document, 'click', '[data-act="done-todo"]', function (el) { markDone(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="edit-todo"]', function (el) { startEdit(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-todo"]', function (el) { deleteTodo(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="add-tag"]', function () { addCustomTag(); });
delegate(document, 'click', '[data-act="select-all-members"]', function () { toggleAllMembers(); });
delegate(document, 'click', '[data-act="load-more"]', function () { loadList(true); });
delegate(document, 'click', '[data-act="sync-chaoxing"]', function () { syncNow('chaoxing'); });
delegate(document, 'click', '[data-act="sync-mooc"]', function () { syncNow('mooc'); });
delegate(document, 'click', '[data-act="toggle-hidden"]', function () { toggleHidden(); });
delegate(document, 'click', '[data-act="hide-todo"]', function (el) { setTodoHidden(el.getAttribute('data-id'), true); });
delegate(document, 'click', '[data-act="unhide-todo"]', function (el) { setTodoHidden(el.getAttribute('data-id'), false); });
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

// 先补齐旧壳缺失的节点，再进入首屏渲染：后面的 render() 会直接读写这些入口。
ensureTodoShell();

// 滑块在布局完成后才有尺寸：首帧排一次，窗口变化再排一次
moveSegPill();
window.addEventListener('resize', moveSegPill);

loadList(false);
})();
