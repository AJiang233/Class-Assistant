(function () {
// ===== 需要登录 + 至少一项管理/发布权限 =====
if (!requireAuth()) return;
var canWrite = canContentWrite();
var canManage = canManageUsers();
if (!canManagePanel()) {
    document.querySelector('.container').innerHTML = stateHTML('无权访问该页面', true);
    return;
}

// ===== 提醒对象选择（发布 通知、活动共用） =====
var remindChoices = [];
// 「名单没加载出来」与「真没有成员」必须分开记：前者若被当成空名单提交，
// 会把定向内容静默发成全班可见（renderRemindBox 的 failed 分支 + 三个发布函数的拦截，
// 见 PR #86 吸收的增量 —— 新建时空名单虽是安全默认，但名单挂了还显示「暂无成员」
// 会让人误以为班里没人可定向）
var remindLoadFailed = false;

async function loadRemindChoices() {
    remindLoadFailed = false;
    try {
        var res = await api('/api/auth/members-pick');
        remindChoices = (res.data && res.data.list) || [];
    } catch (e) {
        remindLoadFailed = true;
    }
    renderRemindChoices('actRemind', []);
    renderRemindChoices('ntcRemind', []);
    renderRemindChoices('fcRemind', []);
    // 代加待办用自己的盒子，跟着这份名单一起画（卡片没渲染时内部会直接返回）
    renderDelegateMembers();
}

function renderRemindChoices(boxId, checkedNames) {
    renderRemindBox(boxId, remindChoices, checkedNames, remindLoadFailed);
}

function collectRemind(boxId) {
    var names = [];
    document.querySelectorAll('#' + boxId + ' .remind-cb:checked').forEach(function (el) { names.push(el.value); });
    return names;
}

// ===== 编辑弹窗：打开 / 关闭（成员） =====
var MODAL_IDS = ['editMemberModal', 'formResultModal', 'formTimeModal'];
function openModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.add('show');
    document.body.style.overflow = 'hidden';
}
function closeModal(id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.classList.remove('show');
    document.body.style.overflow = '';
}
MODAL_IDS.forEach(function (id) {
    var el = document.getElementById(id);
    if (!el) return;
    el.addEventListener('click', function (e) { if (e.target === el) closeModal(id); });
});
document.addEventListener('keydown', function (e) {
    if (e.key !== 'Escape') return;
    MODAL_IDS.forEach(function (id) {
        var el = document.getElementById(id);
        if (el && el.classList.contains('show')) closeModal(id);
    });
});

// ===== 发布时附带待办（#99） =====
// 通知 / 活动共用一套：勾选「同时加入大家的待办」才展开字段，且只有勾选后才在请求体里
// 带 todo 字段（未勾选绝不传空对象，否则后端会当成「要建待办但没给截止时间」而拒发）。
var TODO_TAG_PRESETS = ['作业', '考试', '班会', '活动', '材料', '缴费'];
var TODO_TAG_MAX = 4;
var TODO_TAG_LEN = 12;
var todoTags = { notice: [], activity: [], delegate: [] };

function todoRefs(kind) {
    // 代加待办：整块功能从待办页搬到管理面板后，自带一套字段 id（dlg 前缀），
    // 但与通知/活动那两套共用同一份标签逻辑（renderTodoTags / toggleTodoTag / addTodoCustomTag）。
    if (kind === 'delegate') {
        return {
            check: null, fields: null, title: 'dlgTitle', due: 'dlgDue',
            tagsBox: 'dlgTagBox', tagInput: 'dlgTagInput', err: 'dlgError'
        };
    }
    return kind === 'notice'
        ? {
            check: 'ntcTodo', fields: 'ntcTodoFields', title: 'ntcTodoTitle', due: 'ntcTodoDue',
            tagsBox: 'ntcTodoTagBox', tagInput: 'ntcTodoTagInput', err: 'ntcError'
        }
        : {
            check: 'actTodo', fields: 'actTodoFields', title: 'actTodoTitle', due: 'actTodoDue',
            tagsBox: 'actTodoTagBox', tagInput: 'actTodoTagInput', err: 'actError'
        };
}

// 发布失败/标签超限等统一走各卡片已有的 .form-error 提示，保持和原有校验一致的观感
function showTodoError(kind, msg) {
    var errBox = document.getElementById(todoRefs(kind).err);
    if (!errBox) return;
    errBox.textContent = msg;
    errBox.classList.add('show');
}

function renderTodoTags(kind) {
    var r = todoRefs(kind);
    var box = document.getElementById(r.tagsBox);
    if (!box) return;
    var tags = todoTags[kind];
    // 动作名必须写成字面量：csp.test.js 会扫源码做「标记 ↔ 委托」双向核对，
    // 用变量拼出来的动作名会被当成一个从未注册过的动作而报错。
    var actAttr = kind === 'delegate' ? 'data-act="toggle-delegate-tag"'
        : (kind === 'notice' ? 'data-act="toggle-notice-tag"' : 'data-act="toggle-activity-tag"');
    // 预置标签常驻；自定义标签只在被选中时出现，取消勾选后就从列表里消失
    var all = TODO_TAG_PRESETS.slice();
    tags.forEach(function (t) { if (all.indexOf(t) < 0) all.push(t); });
    box.innerHTML = all.map(function (t) {
        var on = tags.indexOf(t) >= 0;
        return '<button type="button" class="pos-chip' + (on ? ' on' : '') + '" ' + actAttr
            + ' data-tag="' + escAttr(t) + '" aria-pressed="' + (on ? 'true' : 'false') + '">' + esc(t) + '</button>';
    }).join('');
}

function toggleTodoTag(kind, tag) {
    var tags = todoTags[kind];
    var i = tags.indexOf(tag);
    if (i >= 0) { tags.splice(i, 1); renderTodoTags(kind); return; }
    if (!tag || tag.length > TODO_TAG_LEN) { showTodoError(kind, '标签需为 1–' + TODO_TAG_LEN + ' 个字'); return; }
    if (tags.length >= TODO_TAG_MAX) { showTodoError(kind, '待办标签最多 ' + TODO_TAG_MAX + ' 个'); return; }
    tags.push(tag);
    renderTodoTags(kind);
}

function addTodoCustomTag(kind, input) {
    var tag = String(input.value || '').trim();
    if (!tag) return;
    if (tag.length > TODO_TAG_LEN) { showTodoError(kind, '标签需为 1–' + TODO_TAG_LEN + ' 个字'); return; }
    var tags = todoTags[kind];
    if (tags.indexOf(tag) >= 0) { input.value = ''; return; }
    if (tags.length >= TODO_TAG_MAX) { showTodoError(kind, '待办标签最多 ' + TODO_TAG_MAX + ' 个'); return; }
    tags.push(tag);
    input.value = '';
    renderTodoTags(kind);
}

function bindTodoTagInput(id, kind) {
    var input = document.getElementById(id);
    if (!input) return;
    input.addEventListener('keydown', function (e) {
        if (e.key !== 'Enter') return;
        e.preventDefault();   // 回车只加标签，不触发表单默认行为
        addTodoCustomTag(kind, input);
    });
}

function toggleTodoFields(kind, on) {
    var fields = document.getElementById(todoRefs(kind).fields);
    if (fields) fields.hidden = !on;
}

// datetime-local 的 "YYYY-MM-DDTHH:MM" → 后端要的 "YYYY-MM-DD HH:MM:SS"
function todoDueValue(kind) {
    return localDateTimeOf(todoRefs(kind).due);
}

/** 按元素 id 取 datetime-local 值并转成后端格式；空值返回空串 */
function localDateTimeOf(id) {
    var el = document.getElementById(id);
    var raw = el ? String(el.value || '').trim() : '';
    if (!raw) return '';
    raw = raw.replace('T', ' ');
    if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(raw)) raw += ':00';
    return raw;
}

// ===== 代加待办（整块功能从待办页搬来） =====
// 成员多选直接复用发布内容那套 remind-box（按职位快选 + 搜索，值就是成员 id），
// 标签复用上面 notice / activity 的同一套芯片逻辑（kind 传 'delegate'）。

/** 默认截止：今天 23:59；已经过点就顺延到明天 23:59 */
function defaultDelegateDue() {
    var end = todayEnd();
    if (end > nowLocal()) return end;
    var d = new Date();
    d.setDate(d.getDate() + 1);
    var pad = function (n) { return n < 10 ? '0' + n : '' + n; };
    return d.getFullYear() + '-' + pad(d.getMonth() + 1) + '-' + pad(d.getDate()) + 'T23:59';
}

function collectDelegateMembers() {
    var ids = [];
    document.querySelectorAll('#dlgMemberBox .remind-cb:checked').forEach(function (el) {
        var n = Number(el.value);
        if (n > 0) ids.push(n);
    });
    return ids;
}

function updateDelegateHint() {
    var hint = document.getElementById('dlgMemberHint');
    if (!hint) return;
    var n = collectDelegateMembers().length;
    hint.textContent = n ? '已选 ' + n + ' 人' : '还没选人';
}

function renderDelegateMembers() {
    renderRemindBox('dlgMemberBox', remindChoices, [], remindLoadFailed);
    updateDelegateHint();
}

function clearDelegateError() {
    var box = document.getElementById('dlgError');
    if (!box) return;
    box.textContent = '';
    box.classList.remove('show');
}

/** 提交成功后把表单恢复成「下一件事」的状态，成员与标签清空、截止顺延到默认值 */
function resetDelegateForm() {
    ['dlgTitle', 'dlgDesc', 'dlgStart'].forEach(function (id) {
        var el = document.getElementById(id);
        if (el) el.value = '';
    });
    var due = document.getElementById('dlgDue');
    if (due) due.value = defaultDelegateDue();
    todoTags.delegate = [];
    renderTodoTags('delegate');
    // 成员：只取消勾选，不重画整个 remind-box —— 那个盒子每次 render 都会重新绑定一次
    // 委托，重画多了会把「按职位快选」变成点一次触发两次（净效果就是不选）。
    document.querySelectorAll('#dlgMemberBox .remind-cb').forEach(function (cb) { cb.checked = false; });
    document.querySelectorAll('#dlgMemberBox .pos-chip').forEach(function (chip) {
        chip.classList.remove('on');
        chip.setAttribute('aria-pressed', 'false');
    });
    updateDelegateHint();
    clearDelegateError();
}

function initDelegateTodo() {
    if (!document.getElementById('delegateTodoCard')) return;
    // 成员盒子由 loadRemindChoices() 拿到名单后统一画（避免这里先画一次「暂无成员」）
    renderTodoTags('delegate');
    bindTodoTagInput('dlgTagInput', 'delegate');
    var due = document.getElementById('dlgDue');
    if (due && !due.value) due.value = defaultDelegateDue();
}

async function submitDelegateTodo(btn) {
    clearDelegateError();
    var memberIds = collectDelegateMembers();
    // 名单加载失败时 remind-box 显示的是错误提示，这里必须拦住，否则会把待办发给 0 个人
    if (!memberIds.length) { showTodoError('delegate', remindLoadFailed ? '成员名单加载失败，请刷新后重试' : '请先勾选至少一位同学'); return; }

    var titleEl = document.getElementById('dlgTitle');
    var title = titleEl ? titleEl.value.trim() : '';
    if (!title) { showTodoError('delegate', '请填写待办标题'); return; }
    if (title.length > 100) { showTodoError('delegate', '标题最多 100 字'); return; }

    var dueAt = localDateTimeOf('dlgDue');
    if (!dueAt) { showTodoError('delegate', '请选择截止时间'); return; }
    var startAt = localDateTimeOf('dlgStart');
    // 同格式字符串比较即可：'YYYY-MM-DD HH:MM:SS' 的字典序就是时间序
    if (startAt && dueAt <= startAt) { showTodoError('delegate', '截止时间必须晚于开始时间'); return; }

    var tags = todoTags.delegate.slice();
    if (tags.length > TODO_TAG_MAX) { showTodoError('delegate', '标签最多 ' + TODO_TAG_MAX + ' 个'); return; }

    var descEl = document.getElementById('dlgDesc');
    var body = {
        user_ids: memberIds,
        title: title,
        description: descEl ? descEl.value.trim() : '',
        due_at: dueAt,
        tags: tags
    };
    if (startAt) body.start_at = startAt;

    var hint = document.getElementById('dlgHint');
    var label = btn ? btn.textContent : '';
    if (btn) { btn.disabled = true; btn.textContent = '提交中…'; }
    try {
        var res = await api('/api/todos/delegate', { method: 'POST', body: JSON.stringify(body) });
        var msg = (res.data && res.data.message) || ('已给 ' + memberIds.length + ' 位同学添加待办');
        resetDelegateForm();
        if (hint) hint.textContent = msg;
    } catch (e) {
        showTodoError('delegate', e.message);
    } finally {
        if (btn) { btn.disabled = false; btn.textContent = label; }
    }
}

// 返回 { value: todo|null } 或 { error }：只有勾选才产出 todo，未勾选返回 value:null
function buildTodoPayload(kind) {
    var r = todoRefs(kind);
    var cb = document.getElementById(r.check);
    if (!cb || !cb.checked) return { value: null };
    var due = todoDueValue(kind);
    if (!due) return { error: '请填写待办截止时间' };
    var tags = todoTags[kind];
    if (tags.length > TODO_TAG_MAX) return { error: '待办标签最多 ' + TODO_TAG_MAX + ' 个' };
    var bad = tags.filter(function (t) { return !t || t.length > TODO_TAG_LEN; });
    if (bad.length) return { error: '标签需为 1–' + TODO_TAG_LEN + ' 个字' };
    var titleEl = document.getElementById(r.title);
    var title = titleEl ? titleEl.value.trim() : '';
    // 标题留空就不传，交给后端用内容标题兜底
    return { value: { title: title || undefined, due_at: due, tags: tags.slice() } };
}

function resetTodoForm(kind) {
    var r = todoRefs(kind);
    todoTags[kind] = [];
    var cb = document.getElementById(r.check);
    if (cb) cb.checked = false;
    var fields = document.getElementById(r.fields);
    if (fields) fields.hidden = true;
    var title = document.getElementById(r.title);
    if (title) title.value = '';
    var due = document.getElementById(r.due);
    if (due) due.value = '';
    var input = document.getElementById(r.tagInput);
    if (input) input.value = '';
    renderTodoTags(kind);
}

// ===== 添加通知 =====
async function submitNotice() {
    var errBox = document.getElementById('ntcError');
    errBox.classList.remove('show');
    var title = document.getElementById('ntcTitle').value.trim();
    var content = document.getElementById('ntcContent').value.trim();
    var publish_time = document.getElementById('ntcPublish').value;
    var expire_time = document.getElementById('ntcExpire').value || null;
    if (!title || !content || !publish_time) {
        errBox.textContent = '标题、内容、发布时间为必填';
        errBox.classList.add('show'); return;
    }
    // 名单没加载出来时绝不能发布：collectRemind('ntcRemind') 会是空数组，后端把空名单
    // 当默认全班，定向内容就静默发成全班可见（issue #78）
    if (remindLoadFailed) {
        errBox.textContent = '提醒对象名单加载失败：为避免把定向内容误发成全班可见，发布已被禁止，请重试';
        errBox.classList.add('show'); return;
    }
    // 附带待办：勾选后必须填截止时间；标签数量/长度前端先拦一道（后端同样会校验）
    var todoRes = buildTodoPayload('notice');
    if (todoRes.error) { errBox.textContent = todoRes.error; errBox.classList.add('show'); return; }
    var btn = document.getElementById('ntcSubmitBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '提交中…';
    try {
        var body = { title: title, content: content, publish_time: publish_time, expire_time: expire_time, remind_people: collectRemind('ntcRemind') };
        if (todoRes.value) body.todo = todoRes.value;
        await api('/api/notices', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('ntcTitle').value = '';
        document.getElementById('ntcContent').value = '';
        document.getElementById('ntcPublish').value = nowLocal();
        document.getElementById('ntcExpire').value = todayEnd();
        refreshDateHints();
        renderRemindChoices('ntcRemind', []);
        resetTodoForm('notice');
        errBox.textContent = '发布成功';
        errBox.classList.add('show');
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

// ===== 添加活动 =====
async function submitActivity() {
    var errBox = document.getElementById('actError');
    errBox.classList.remove('show');
    var title = document.getElementById('actTitle').value.trim();
    var content = document.getElementById('actContent').value.trim();
    var location = document.getElementById('actLocation').value.trim();
    var start_time = document.getElementById('actStart').value;
    var end_time = document.getElementById('actEnd').value;
    if (!title || !start_time) {
        errBox.textContent = '标题、开始时间为必填';
        errBox.classList.add('show'); return;
    }
    // 名单没加载出来时绝不能发布：collectRemind('actRemind') 会是空数组（issue #78，同上）
    if (remindLoadFailed) {
        errBox.textContent = '提醒对象名单加载失败：为避免把定向内容误发成全班可见，发布已被禁止，请重试';
        errBox.classList.add('show'); return;
    }
    // 附带待办：与通知同一套校验（勾选才组装，未勾选不传 todo）
    var todoRes = buildTodoPayload('activity');
    if (todoRes.error) { errBox.textContent = todoRes.error; errBox.classList.add('show'); return; }
    var btn = document.getElementById('actSubmitBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '提交中…';
    try {
        var body = { title: title, content: content, location: location, start_time: start_time, end_time: end_time, remind_people: collectRemind('actRemind') };
        if (todoRes.value) body.todo = todoRes.value;
        await api('/api/activities', { method: 'POST', body: JSON.stringify(body) });
        document.getElementById('actTitle').value = '';
        document.getElementById('actContent').value = '';
        document.getElementById('actLocation').value = '';
        document.getElementById('actStart').value = nowLocal();
        document.getElementById('actEnd').value = todayEnd();
        refreshDateHints();
        renderRemindChoices('actRemind', []);
        resetTodoForm('activity');
        errBox.textContent = '发布成功';
        errBox.classList.add('show');
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

// ===== 管理成员（列表 + 编辑/删除） =====
var membersCache = [];
var editingMemberId = null;

async function loadMembers() {
    var el = document.getElementById('memberList');
    el.innerHTML = stateHTML('正在加载…', false, 'clock');
    try {
        var res = await api('/api/auth/users');
        membersCache = (res.data && res.data.list) || [];
        filterMembers();
        renderRegPosPicker();   // 成员新增岗位后同步可选项
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

// 纯前端按关键词过滤成员（姓名 / 学号 / 职务）
function filterMembers() {
    var el = document.getElementById('memberList');
    var box = document.getElementById('memberSearch');
    var q = box ? box.value.trim().toLowerCase() : '';
    var list = !q ? membersCache : membersCache.filter(function (m) {
        var pos = parsePositionsList(m.positions).join('、');
        return String(m.name || '').toLowerCase().indexOf(q) >= 0
            || String(m.student_id || '').toLowerCase().indexOf(q) >= 0
            || String(pos).toLowerCase().indexOf(q) >= 0;
    });
    if (!list.length) { el.innerHTML = stateHTML(q ? '没有匹配的成员' : '暂无成员'); return; }
    el.innerHTML = list.map(function (m) {
        return '<div class="info-row member-row">'
            + '<div class="member-main">'
            + '<div class="member-line">'
            + '<span class="member-name">' + esc(m.name) + '</span>'
            + '<span class="member-pos">' + positionsChipsHTML(m.positions) + '</span>'
            + '</div>'
            + '<div class="member-sub">学号 ' + esc(m.student_id) + '</div>'
            + '</div>'
            + '<div class="member-actions">'
            + '<button type="button" class="btn btn-outline" data-act="edit-member" data-id="' + escAttr(m.id) + '">编辑</button>'
            + '<button type="button" class="btn btn-danger" data-act="del-member" data-id="' + escAttr(m.id) + '">删除</button>'
            + '</div>'
            + '</div>';
    }).join('');
}

// 预设职务（可多选）
var POSITION_PRESETS = ['班长', '团支书', '学习委员'];
// 默认职位的权限来自后端 /api/auth/roles 的 presets（ROLE_PERMISSIONS 的投影），
// 前端不再手抄一份 —— 否则后端改权限这里就漂了（issue #84 项 9）
var presetPerms = {};
var rolesCache = [];   // roles 表：已定义的自定义职位

// 汇总可选职务：预设 + roles 表已定义 + 成员已在用 + 当前已选（去重，排除「学生」）
function allPositionNames(selected) {
    var names = POSITION_PRESETS.slice();
    function push(p) {
        p = String(p == null ? '' : p).trim();
        if (p && p !== '学生' && names.indexOf(p) < 0) names.push(p);
    }
    (rolesCache || []).forEach(function (r) { push(r.name); });
    (membersCache || []).forEach(function (m) {
        parsePositionsList(m.positions).forEach(push);
    });
    (selected || []).forEach(push);
    return names;
}

// 渲染职务多选标签
function renderPosPicker(boxId, selected) {
    var box = document.getElementById(boxId);
    if (!box) return;
    var sel = {};
    (selected || []).forEach(function (p) { sel[p] = true; });
    box.innerHTML = allPositionNames(selected).map(function (p) {
        var chk = sel[p] ? ' checked' : '';
        return '<label class="chip"><input type="checkbox" class="pos-cb" value="' + escAttr(p) + '"' + chk + '>' + esc(p) + '</label>';
    }).join('');
}

// 注册表单的职务选择器（保留当前勾选）
function renderRegPosPicker() {
    var checked = [];
    document.querySelectorAll('#regPosPicker .pos-cb:checked').forEach(function (cb) { checked.push(cb.value); });
    renderPosPicker('regPosPicker', checked);
}

// 加载 roles 表已定义的自定义职位（同步「管理职位」列表与各职务选择器）
async function loadRoles() {
    var el = document.getElementById('roleList');
    if (el) el.innerHTML = stateHTML('正在加载…', false, 'clock');
    try {
        var res = await api('/api/auth/roles');
        rolesCache = (res.data && res.data.list) || [];
        presetPerms = (res.data && res.data.presets) || {};
    } catch (e) {
        // 失败不能渲染成「暂无自定义职位」：管理员会以为从没配过、重复添加（issue #84 项 7）。
        // 保留上一次的 rolesCache，列表位置显示错误态；职位选择器也别用空数据重绘。
        if (el) el.innerHTML = stateHTML('自定义职位加载失败：' + e.message + '（刷新页面重试）', true);
        return;
    }
    renderRoleList();
    renderRegPosPicker();
}

// 权限码 → 中文
var PERM_LABELS = { 'content:write': '发布内容（活动、通知、表单）', 'user:manage': '成员与职位管理', 'class:exclude': '不计入班级管理' };
function permLabels(list) {
    if (!list || !list.length) return '无特殊权限';
    return list.map(function (k) { return PERM_LABELS[k] || k; }).join('、');
}
// roles.permissions 是 JSON 字符串，解析统一放这里（列表渲染与编辑回填共用）
function permList(permissions) {
    try { var p = JSON.parse(permissions); if (Array.isArray(p)) return p; } catch (e) {}
    return [];
}
function rolePermText(permissions) {
    return permLabels(permList(permissions));
}

// 渲染「管理职位」列表：默认职位置顶（不可修改 / 删除），其下为自定义职位
function renderRoleList() {
    var el = document.getElementById('roleList');
    if (!el) return;
    var preset = POSITION_PRESETS.map(function (name) {
        return '<div class="info-row member-row">'
            + '<div class="member-main">'
            + '<div class="member-line">'
            + '<span class="member-name">' + esc(name) + '</span>'
            + '<span class="member-pos">默认</span>'
            + '</div>'
            + '<div class="member-sub">' + esc(permLabels(presetPerms[name] || [])) + '</div>'
            + '</div>'
            + '</div>';
    }).join('');
    var custom = rolesCache.map(function (r) {
        // 增 / 删 / 改自定义职位要 user:manage（后端 routes/auth.js 就是这么卡的），所以只有
        // content:write 的人只给看列表，不给按钮 —— 否则就是那种「点了必然 403」的按钮（issue #79）。
        var actions = canManage
            ? '<div class="member-actions">'
                + '<button type="button" class="btn btn-outline" data-act="edit-role" data-id="' + escAttr(r.id) + '">编辑</button>'
                + '<button type="button" class="btn btn-danger" data-act="del-role" data-id="' + escAttr(r.id) + '">删除</button>'
                + '</div>'
            : '';
        // 权限说明挂在行下面而不是 .member-main 里：按钮多的行（编辑 / 删除）下，
        // 说明挤在名字下方会把那一行撑高、与按钮错位，落到按钮下面单独一行读起来更顺
        return '<div class="info-row member-row role-row">'
            + '<div class="member-main">'
            + '<div class="member-line">'
            + '<span class="member-name">' + esc(r.name) + '</span>'
            + '<span class="member-pos">自定义</span>'
            + '</div>'
            + '</div>'
            + actions
            + '<div class="member-sub role-meta">' + esc(rolePermText(r.permissions)) + '</div>'
            + '</div>';
    }).join('');
    el.innerHTML = '<div class="roles-group-label">默认职位（不可修改 / 删除）</div>'
        + preset
        + '<div class="roles-group-label">自定义职位</div>'
        + (rolesCache.length ? custom : stateHTML('暂无自定义职位'));
}

// 添加自定义职位（同名则更新其权限）
async function addRole() {
    var errBox = document.getElementById('roleError');
    errBox.classList.remove('show');
    var name = document.getElementById('roleName').value.trim();
    if (!name) { errBox.textContent = '职位名称不能为空'; errBox.classList.add('show'); return; }
    var permissions = [];
    if (document.getElementById('rolePermWrite').checked) permissions.push('content:write');
    if (document.getElementById('rolePermManage').checked) permissions.push('user:manage');
    if (document.getElementById('rolePermExclude').checked) permissions.push('class:exclude');
    var btn = document.getElementById('roleAddBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '添加中…';
    try {
        await api('/api/auth/roles', { method: 'POST', body: JSON.stringify({ name: name, permissions: permissions }) });
        document.getElementById('roleName').value = '';
        document.getElementById('rolePermWrite').checked = false;
        document.getElementById('rolePermManage').checked = false;
        document.getElementById('rolePermExclude').checked = false;
        errBox.textContent = '添加成功';
        errBox.classList.add('show');
        loadRoles();
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

async function delRole(id) {
    if (!confirm('确定删除该职位？')) return;
    try {
        await api('/api/auth/roles/' + id, { method: 'DELETE' });
        loadRoles();
    } catch (err) { alert(err.message); }
}

/**
 * 把已有职位的名称与权限回填到「添加职位」表单（同名提交 = 更新该职位权限）。
 * 不回填的话，管理员只能凭记忆重勾，漏勾一个就把这个职位原有的权限清掉了。
 */
function editRole(id) {
    var r = (rolesCache || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!r) { alert('未找到该职位'); return; }
    var perms = permList(r.permissions);
    document.getElementById('roleName').value = r.name;
    document.getElementById('rolePermWrite').checked = perms.indexOf('content:write') >= 0;
    document.getElementById('rolePermManage').checked = perms.indexOf('user:manage') >= 0;
    document.getElementById('rolePermExclude').checked = perms.indexOf('class:exclude') >= 0;
    var errBox = document.getElementById('roleError');
    errBox.textContent = '正在编辑「' + r.name + '」，提交即更新其权限';
    errBox.classList.add('show');
    var card = document.getElementById('addRoleCard');
    card.classList.add('open');
    var head = card.querySelector('.collapse-head');
    if (head) head.setAttribute('aria-expanded', 'true');
    card.scrollIntoView({ behavior: 'smooth', block: 'center' });
}

// 编辑弹窗的职务选择器
function renderEditPosPicker(selected) {
    renderPosPicker('editPosPicker', selected);
}

// ===== 成员邮箱：验证状态徽章 =====
// 与个人中心那个邮箱徽章同一套语义色：已验证＝成功色，未验证＝中性色（未验证不算出错，不上红）
var editingMemberEmail = '';        // 打开弹窗时该成员的邮箱（小写归一，用来判断值动没动）
var editingMemberEmailVerified = false;

function setEmailBadge(el, verified, text) {
    if (!el) return;
    el.className = 'badge ' + (verified ? 'badge-ok' : 'badge-muted');
    el.textContent = text;
    el.hidden = false;
}

/**
 * 「编辑成员」的邮箱框：值没动就照原样显示，一改就显示「未验证」。
 * 之所以要看「动没动」：后端只在地址真的变了时才清零验证状态（改姓名不该让人重新验证），
 * 徽章若一律说「未验证」，就会出现「界面说未验证、库里其实还是已验证」的错位。
 */
function syncEditEmailBadge() {
    var input = document.getElementById('editEmail');
    var badge = document.getElementById('editEmailBadge');
    if (!input || !badge) return;
    var value = input.value.trim().toLowerCase();
    if (!value) { badge.hidden = true; return; }
    var untouched = value === editingMemberEmail;
    setEmailBadge(badge, untouched && editingMemberEmailVerified,
        untouched && editingMemberEmailVerified ? '已验证' : '未验证');
}

function startEditMember(id) {
    var m = (membersCache || []).filter(function (x) { return String(x.id) === String(id); })[0];
    if (!m) { alert('未找到该成员'); return; }
    document.getElementById('editMemberTitle').textContent = '编辑成员';
    document.getElementById('editName').value = m.name || '';
    renderEditPosPicker(parsePositionsList(m.positions));
    document.getElementById('editContact').value = m.contact || '';
    document.getElementById('editEmail').value = m.email || '';
    editingMemberEmail = String(m.email || '').trim().toLowerCase();
    editingMemberEmailVerified = !!m.email_verified;
    syncEditEmailBadge();
    document.getElementById('editPassword').value = '';
    document.getElementById('editMemberError').classList.remove('show');
    editingMemberId = id;
    openModal('editMemberModal');
}

function cancelEditMember() {
    closeModal('editMemberModal');
    editingMemberId = null;
}

async function saveMember() {
    var errBox = document.getElementById('editMemberError');
    errBox.classList.remove('show');
    var name = document.getElementById('editName').value.trim();
    var contact = document.getElementById('editContact').value.trim();
    var email = document.getElementById('editEmail').value.trim();
    var password = document.getElementById('editPassword').value;
    if (!name) { errBox.textContent = '姓名不能为空'; errBox.classList.add('show'); return; }
    if (password && password.length < 6) { errBox.textContent = '新密码长度至少 6 位'; errBox.classList.add('show'); return; }
    var positions = [];
    document.querySelectorAll('#editPosPicker .pos-cb:checked').forEach(function (cb) { positions.push(cb.value); });
    var btn = document.getElementById('editMemberBtn');
    btn.disabled = true; var t = btn.textContent; btn.textContent = '保存中…';
    try {
        var payload = { name: name, positions: positions, contact: contact, email: email };
        if (password) payload.password = password;
        await api('/api/auth/users/' + editingMemberId, { method: 'PUT', body: JSON.stringify(payload) });
        cancelEditMember();
        loadMembers();
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false; btn.textContent = t;
    }
}

async function delMember(id) {
    if (!confirm('确定删除该成员账号？')) return;
    try {
        await api('/api/auth/users/' + id, { method: 'DELETE' });
        loadMembers();
    } catch (err) {
        alert(err.message);
    }
}

// ===== 添加成员 =====
function initMemberManagement() {
    var regForm = document.getElementById('regForm');
    regForm.addEventListener('submit', async function (e) {
        e.preventDefault();
        var errBox = document.getElementById('regError');
        errBox.classList.remove('show');
        var student_id = document.getElementById('regStudentId').value.trim();
        var name = document.getElementById('regName').value.trim();
        var password = document.getElementById('regPassword').value;
        var contact = document.getElementById('regContact').value.trim();
        var email = document.getElementById('regEmail').value.trim();
        // 多选职务标签
        var positions = [];
        document.querySelectorAll('#regPosPicker .pos-cb:checked').forEach(function (cb) { positions.push(cb.value); });
        if (!student_id || !name || !password) { errBox.textContent = '学号、姓名、密码为必填'; errBox.classList.add('show'); return; }
        if (password.length < 6) { errBox.textContent = '密码长度至少 6 位'; errBox.classList.add('show'); return; }
        var btn = document.getElementById('regBtn');
        btn.disabled = true; var t = btn.textContent; btn.textContent = '注册中…';
        try {
            var payload = { student_id: student_id, name: name, password: password, positions: positions, contact: contact, email: email };
            await api('/api/auth/register', { method: 'POST', body: JSON.stringify(payload) });
            errBox.classList.add('show');
            errBox.textContent = email ? '注册成功（邮箱待本人验证）' : '注册成功';
            regForm.reset();
            loadMembers();
        } catch (err) {
            errBox.textContent = err.message;
            errBox.classList.add('show');
        } finally {
            btn.disabled = false; btn.textContent = t;
        }
    });

    // 编辑弹窗那颗徽章跟着输入走：改了邮箱，立刻反映「保存之后会是什么状态」，
    // 而不是等保存完再让用户去成员列表里对。（添加成员不放徽章：新账号一律未验证）
    document.getElementById('editEmail').addEventListener('input', syncEditEmailBadge);
}

// ===== datetime-local 空值提示：用「未填写」替换原生的 yyyy/mm/dd 占位 =====
function refreshDateHints() {
    var wraps = document.querySelectorAll('.dt-field');
    for (var i = 0; i < wraps.length; i++) {
        var inp = wraps[i].querySelector('input');
        wraps[i].classList.toggle('is-empty', !(inp && inp.value));
    }
}
function initDateHints() {
    var inputs = document.querySelectorAll('input[type="datetime-local"]');
    for (var i = 0; i < inputs.length; i++) {
        var input = inputs[i];
        var wrap = document.createElement('div');
        wrap.className = 'dt-field';
        input.parentNode.insertBefore(wrap, input);
        wrap.appendChild(input);
        var hint = document.createElement('span');
        hint.className = 'dt-hint';
        hint.textContent = input.getAttribute('data-empty-hint') || '未填写';
        wrap.appendChild(hint);
        input.addEventListener('input', refreshDateHints);
        input.addEventListener('change', refreshDateHints);
    }
    refreshDateHints();
}

// ===== 操作日志（issue #108） =====
// 日志只记管理动作，detail 是后端白名单之后的 JSON。这里再按动作/字段做一层中文映射，
// 让管理页读起来是「谁把谁的密码重置了」，而不是一串 action 码。
var AUDIT_ACTION_LABELS = {
    password_reset: '重置密码',
    email_changed: '修改邮箱',
    member_updated: '修改成员资料',
    member_deleted: '删除成员',
    role_created: '新增职位',
    role_updated: '修改职位权限',
    role_deleted: '删除职位',
    settings_updated: '修改功能开关'
};
var AUDIT_FIELD_LABELS = { name: '姓名', positions: '职务', contact: '联系方式', email: '邮箱', password: '密码' };
var AUDIT_TARGET_LABELS = { member: '成员', role: '职位', settings: '系统设置' };
var auditState = { page: 1, pageSize: 20, total: 0 };

function auditDetailText(detail) {
    if (!detail) return '';
    if (typeof detail === 'string') return detail;
    var parts = [];
    if (detail.name) {
        parts.push('对象：' + detail.name + (detail.student_id ? '（' + detail.student_id + '）' : ''));
    }
    if (detail.permissions) parts.push('权限：' + permLabels(detail.permissions));
    if (detail.fields && detail.fields.length) {
        parts.push('改动字段：' + detail.fields.map(function (f) { return AUDIT_FIELD_LABELS[f] || f; }).join('、'));
    }
    return parts.join(' · ');
}

function renderAuditRow(row) {
    var action = AUDIT_ACTION_LABELS[row.action] || row.action;
    var target = AUDIT_TARGET_LABELS[row.target_type] || row.target_type || '';
    var targetText = target ? (target + ' #' + row.target_id) : (row.target_id || '');
    var detail = auditDetailText(row.detail);
    return '<div class="info-row member-row">'
        + '<div class="member-main">'
        + '<div class="member-line">'
        + '<span class="member-name">' + esc(row.actor_name || ('成员 #' + row.actor_id)) + '</span>'
        + '<span class="member-pos">' + esc(action) + '</span>'
        + '</div>'
        + '<div class="member-sub">' + esc(fmtDate(row.created_at)) + ' · ' + esc(targetText) + '</div>'
        + (detail ? '<div class="member-sub">' + esc(detail) + '</div>' : '')
        + (row.ip ? '<div class="member-sub">IP：' + esc(row.ip) + '</div>' : '')
        + '</div></div>';
}

function renderAuditPager(total) {
    var pages = Math.max(1, Math.ceil(total / auditState.pageSize));
    var info = document.getElementById('auditPageInfo');
    var prev = document.getElementById('auditPrev');
    var next = document.getElementById('auditNext');
    if (info) info.textContent = '第 ' + auditState.page + ' / ' + pages + ' 页 · 共 ' + total + ' 条';
    // 只有一页时也显示分页条，但按钮禁用 —— 至少让人知道「总共有几条」，而不是以为列表拉全了
    if (prev) prev.disabled = auditState.page <= 1;
    if (next) next.disabled = auditState.page >= pages;
}

async function loadAuditLogs(reset) {
    if (reset) auditState.page = 1;
    var host = document.getElementById('auditLogList');
    if (!host) return;

    var action = document.getElementById('auditAction').value;
    var actor = document.getElementById('auditActor').value.trim();
    var from = document.getElementById('auditFrom').value;
    var to = document.getElementById('auditTo').value;
    var qs = 'page=' + auditState.page + '&page_size=' + auditState.pageSize;
    if (action) qs += '&action=' + encodeURIComponent(action);
    if (actor) qs += '&actor=' + encodeURIComponent(actor);
    if (from) qs += '&from=' + encodeURIComponent(from);
    if (to) qs += '&to=' + encodeURIComponent(to);

    host.innerHTML = stateHTML('正在加载…', false, 'clock');
    try {
        var res = await api('/api/auth/audit-logs?' + qs);
        var data = res.data || {};
        var list = data.list || [];
        auditState.total = Number(data.total || 0);
        host.innerHTML = list.length ? list.map(renderAuditRow).join('') : stateHTML('没有符合条件的记录');
        renderAuditPager(auditState.total);
    } catch (e) {
        // 失败保留上一页内容更危险（会让人以为看到的是最新筛选结果），这里直接换成错误态
        host.innerHTML = stateHTML('操作日志加载失败：' + e.message, true);
    }
}

// ===== 功能开关（issue #106） =====
// 开关状态存在后端 app_settings；门户已经接上 /api/chaoxing/* 与 /api/mooc/* 转发层，
// 所以学习通、中国大学MOOC 开关与教务开关一样可操作（*_available 只作为旧环境的兜底灰态）。
// 读取失败只提示、不清空三个勾选框：清空会让人误以为开关被关掉了。
async function loadFeatureSettings() {
    var hint = document.getElementById('featureHint');
    try {
        var res = await api('/api/admin/settings');
        var data = res.data || {};
        document.getElementById('featureAcademic').checked = data.academic !== false;
        var chaoxing = document.getElementById('featureChaoxing');
        chaoxing.checked = data.chaoxing !== false;
        chaoxing.disabled = data.chaoxing_available === false;
        var mooc = document.getElementById('featureMooc');
        mooc.checked = data.mooc !== false;
        mooc.disabled = data.mooc_available === false;
        if (hint) hint.textContent = '';
    } catch (e) {
        if (hint) hint.textContent = '读取开关失败：' + e.message;
    }
}

async function saveFeatureSettings(el) {
    var hint = document.getElementById('featureHint');
    if (el) el.disabled = true;
    try {
        var res = await api('/api/admin/settings', {
            method: 'PUT',
            body: JSON.stringify({
                academic: document.getElementById('featureAcademic').checked,
                chaoxing: document.getElementById('featureChaoxing').checked,
                mooc: document.getElementById('featureMooc').checked
            })
        });
        var saved = (res.data && res.data.settings) || {};
        if (hint) {
            hint.textContent = '已保存：教务' + (saved.academic !== false ? '开启' : '停用')
                + '，学习通' + (saved.chaoxing !== false ? '开启' : '停用')
                + '，中国大学MOOC' + (saved.mooc !== false ? '开启' : '停用');
        }
    } catch (e) {
        if (hint) hint.textContent = '保存失败：' + e.message;
    } finally {
        if (el) el.disabled = false;
    }
}

// ===== 初始化：按权限显示对应区块 =====
// 卡片在 HTML 里默认 hidden（CSP 下不再用内联 display:none），有权限才摘掉这个属性
if (canWrite) {
    ['addNoticeCard', 'addActivityCard', 'addFormCard', 'manageFormsCard', 'delegateTodoCard'].forEach(function (id) {
        document.getElementById(id).hidden = false;
    });    document.getElementById('actStart').value = nowLocal();
    document.getElementById('actEnd').value = todayEnd();
    document.getElementById('ntcPublish').value = nowLocal();
    document.getElementById('ntcExpire').value = todayEnd();
    loadRemindChoices();
    // 附带待办：先把标签 chips 画出来（预置项常驻），并给自定义标签输入框挂回车
    renderTodoTags('notice');
    renderTodoTags('activity');
    bindTodoTagInput('ntcTodoTagInput', 'notice');
    bindTodoTagInput('actTodoTagInput', 'activity');
    initDelegateTodo();
    resetFormCreate();
    loadFormsAdmin();
}
// 「管理职位」列表对所有能进管理页的人可见（读接口对登录用户开放），只读 —— 所以这张卡无条件显示。
// 「添加职位」卡要 user:manage，只有 content:write 的人看不到；同理每行的「编辑 / 删除」按钮也不渲染
// （见 renderRoleList）。以前两张卡都是无条件摘 hidden，对学委就是一个提交必 403 的表单（issue #79）。
document.getElementById('manageRolesCard').hidden = false;
loadRoles();

if (canManage) {
    document.getElementById('addRoleCard').hidden = false;
    document.getElementById('auditLogCard').hidden = false;
    document.getElementById('featureCard').hidden = false;
    ['membersCard', 'addMemberCard'].forEach(function (id) {
        document.getElementById(id).hidden = false;
    });
    initMemberManagement();
    loadMembers();
    loadAuditLogs(true);
    loadFeatureSettings();
}

// 默认值已填好后再接管日期输入的空值提示
initDateHints();

// ===== 表单管理 =====
var formResultId = null;     // 当前查看结果的表单 id（导出用）
var formResultForm = null;   // 结果弹窗拉到的表单（字段定义 / 是否匿名），供明细按需加载复用，省一次 /api/forms/:id
var formPendingText = '';    // 未交名单文本（一键复制用）
var fieldSeq = 0;

async function loadFormsAdmin() {
    var el = document.getElementById('formAdminList');
    el.innerHTML = stateHTML('正在加载…', false, 'clock');
    try {
        var res = await api('/api/forms');
        var list = (res.data && res.data.list) || [];
        if (!list.length) { el.innerHTML = stateHTML('还没有表单'); return; }
        el.innerHTML = list.map(formAdminRowHTML).join('');
    } catch (err) {
        el.innerHTML = stateHTML(err.message, true);
    }
}

/**
 * 表单管理卡片：标题与按钮占第一行，meta 落到按钮下方一行。
 * 按钮现在有 4 个（多了停止收集），meta 再挤在左栏里会把按钮顶到换行。
 *
 * 不是自己发的表单不给按钮：这四个动作后端都要求是创建者（`creator_id === 当前用户`），
 * 摆在别人的表单上点一下就 403，所以按后端给的 can_manage 藏掉（issue #71）。
 * 列表本身仍然照常显示 —— 管理面板要能看清班里发过哪些表单、收了多少份。
 */
function formAdminRowHTML(f) {
    var closed = f.status !== 'open';
    var meta = ['提交 ' + (f.submission_count || 0) + ' 份'];
    if (f.deadline) meta.push('截止 ' + fmtDate(f.deadline));
    if (f.anonymous) meta.push('匿名');
    if (closed) meta.push('已关闭');
    var actions = f.can_manage
        ? '<div class="member-actions">'
            + '<button type="button" class="btn btn-outline btn-sm" data-act="toggle-form-status" data-id="' + escAttr(f.id) + '" data-status="' + (closed ? 'open' : 'closed') + '">'
            + (closed ? '恢复收集' : '停止收集') + '</button>'
            + '<button type="button" class="btn btn-outline btn-sm" data-act="open-form-time" data-id="' + escAttr(f.id) + '">修改时间</button>'
            + '<button type="button" class="btn btn-outline btn-sm" data-act="open-form-result" data-id="' + escAttr(f.id) + '">提交明细</button>'
            + '<button type="button" class="btn btn-danger btn-sm" data-act="del-form" data-id="' + escAttr(f.id) + '">删除</button>'
            + '</div>'
        : '';
    return '<div class="info-row member-row form-admin-row">'
        + '<div class="member-main">'
        + '<div class="member-line"><span class="member-name">' + esc(f.title) + '</span></div>'
        + '</div>'
        + actions
        + '<div class="member-line form-admin-meta"><span>' + esc(meta.join(' · ')) + '</span></div>'
        + '</div>';
}

// ===== 字段编辑器 =====
/**
 * 序号（字段1、字段2）只是前端渲染，方便对照；删掉中间某个后要重排，
 * 所以每次增删都调一次。提交时的 key 仍按当前顺序生成（见 collectFields），与这里显示的序号一致。
 */
function renumberFields() {
    var titles = document.querySelectorAll('#fcFields .fld-title');
    for (var i = 0; i < titles.length; i++) titles[i].textContent = '字段' + (i + 1);
}

function fieldRowHTML() {
    var id = 'fld' + (++fieldSeq);
    // 整行只有 member-main 一个 flex 子项，字段内容 / 选项才能像别的 .form-field 输入框一样
    // 占满整行。删除按钮原本另占一列（.member-actions，flex-shrink:0），于是下面两个 input
    // 永远比「表单标题」窄一截（少掉按钮 + gap 那约 80px），看着就是「没铺满」。
    // 行内 padding 也去掉左右那 4px，与 .form-field 的左边缘对齐
    return '<div class="info-row member-row member-row-flush" id="' + id + '">'
        + '<div class="member-main grow">'
        + '<div class="member-line member-line-spread">'
        + '<span class="member-name fld-title">字段</span>'
        + '<button type="button" class="btn btn-danger btn-sm" data-act="remove-field-row" data-id="' + escAttr(id) + '">删除</button>'
        + '</div>'
        + '<div class="fld-row">'
        + '<select class="form-input fld-type w-auto" data-act="field-type-change">'
        + '<option value="text">单行文本</option><option value="textarea">多行文本</option>'
        + '<option value="radio">单选</option><option value="checkbox">多选</option>'
        + '<option value="number">数字</option><option value="date">日期</option>'
        + '</select>'
        + '<label class="fld-required-row"><span>必填</span><span class="switch">'
        + '<input type="checkbox" class="fld-required"><span class="switch-track" aria-hidden="true"></span>'
        + '</span></label>'
        + '</div>'
        + '<div class="mb-8"><input class="form-input fld-label" type="text" placeholder="字段内容，如：姓名" autocomplete="off"></div>'
        + '<div class="fld-options-wrap" hidden><input class="form-input fld-options" type="text" placeholder="选项，用英文逗号分隔，如：午餐,晚餐" autocomplete="off"></div>'
        + '</div>'
        + '</div>';
}

function addFieldRow() {
    document.getElementById('fcFields').insertAdjacentHTML('beforeend', fieldRowHTML());
    renumberFields();
}

function removeFieldRow(id) {
    if (!confirm('确定删除该字段？已填的名称与选项会一起丢掉。')) return;
    var el = document.getElementById(id);
    if (el) el.remove();
    renumberFields();
}

function onFieldTypeChange(sel) {
    var t = sel.value;
    var wrap = sel.closest('.info-row').querySelector('.fld-options-wrap');
    if (wrap) wrap.hidden = !(t === 'radio' || t === 'checkbox');
}

/** 收集字段定义；key 由序号生成（字段一旦有人提交就锁死，key 不会漂移） */
function collectFields() {
    var rows = document.querySelectorAll('#fcFields .fld-label');
    var fields = [];
    for (var i = 0; i < rows.length; i++) {
        var row = rows[i].closest('.info-row');
        var label = rows[i].value.trim();
        if (!label) return { error: '第 ' + (i + 1) + ' 个字段没有填写名称' };
        var type = row.querySelector('.fld-type').value;
        var field = {
            key: 'q' + (i + 1),
            label: label,
            type: type,
            required: row.querySelector('.fld-required').checked
        };
        if (type === 'radio' || type === 'checkbox') {
            var opts = row.querySelector('.fld-options').value.split(',')
                .map(function (s) { return s.trim(); }).filter(Boolean);
            if (opts.length < 2) return { error: '「' + label + '」是选择类字段，至少填 2 个选项（用英文逗号分隔）' };
            field.options = opts;
        }
        fields.push(field);
    }
    if (!fields.length) return { error: '至少添加一个字段' };
    return { fields: fields };
}

function resetFormCreate() {
    var errBox = document.getElementById('fcError');
    errBox.classList.remove('show');
    errBox.textContent = '';
    document.getElementById('fcTitle').value = '';
    document.getElementById('fcDesc').value = '';
    document.getElementById('fcDeadline').value = '';
    document.getElementById('fcEditPolicy').value = 'before_deadline';
    document.getElementById('fcAnonymous').checked = false;
    document.getElementById('fcNotice').checked = false;
    document.getElementById('fcNoticeContent').value = '';
    document.getElementById('fcFields').innerHTML = '';
    addFieldRow();
    renderRemindChoices('fcRemind', []);
    refreshDateHints();
}

async function submitFormCreate() {
    var errBox = document.getElementById('fcError');
    errBox.classList.remove('show');
    function fail(msg) { errBox.textContent = msg; errBox.classList.add('show'); return; }

    var title = document.getElementById('fcTitle').value.trim();
    if (!title) return fail('请填写表单标题');
    var collected = collectFields();
    if (collected.error) return fail(collected.error);
    // 名单没加载出来时绝不能创建表单：collectRemind('fcRemind') 会是空数组（issue #78，同上）
    if (remindLoadFailed) return fail('提醒对象名单加载失败：为避免把定向内容误发成全班可见，发布已被禁止，请重试');

    var payload = {
        title: title,
        description: document.getElementById('fcDesc').value.trim(),
        deadline: document.getElementById('fcDeadline').value,
        edit_policy: document.getElementById('fcEditPolicy').value,
        anonymous: document.getElementById('fcAnonymous').checked,
        fields: collected.fields,
        remind_people: collectRemind('fcRemind'),
        notice: document.getElementById('fcNotice').checked,
        notice_content: document.getElementById('fcNoticeContent').value.trim()
    };

    var btn = document.getElementById('fcSubmitBtn');
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '创建中…';
    try {
        await api('/api/forms', { method: 'POST', body: JSON.stringify(payload) });
        resetFormCreate();
        loadFormsAdmin();
    } catch (err) {
        fail(err.message);
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function delForm(id) {
    if (!confirm('确定删除该表单？已提交的内容也会一起删除。')) return;
    try {
        await api('/api/forms/' + id, { method: 'DELETE' });
        loadFormsAdmin();
    } catch (err) {
        alert(err.message);
    }
}

/**
 * 停止 / 恢复收集：只改 status，不碰提交数据。
 * 停止后同学那边「我的表单」里就看不到它了（/api/forms/mine 只查 status='open'），
 * 提交也会被 submitGate 第一道拦住；已提交的答案原样保留。
 * 恢复用同一个接口、同一个按钮位 —— 不给恢复的话，误停就只能删掉重建。
 */
async function toggleFormStatus(id, next, btn) {
    if (next === 'closed'
        && !confirm('确定停止收集？停止后同学看不到这条表单，也不能再提交；已提交的答案会保留。')) return;
    var original = btn.textContent;
    btn.disabled = true;
    btn.textContent = next === 'closed' ? '停止中…' : '恢复中…';
    try {
        await api('/api/forms/' + id, { method: 'PUT', body: JSON.stringify({ status: next }) });
        loadFormsAdmin();
    } catch (err) {
        alert(err.message);
        btn.disabled = false;
        btn.textContent = original;
    }
}

// ===== 修改表单时间 / 修改策略 =====
// 只提交 deadline 与 edit_policy 两项：字段定义一旦有人提交就被后端锁死，
// 从管理列表直接改字段很容易和已有答案的 key 对不上，所以这里不提供改内容的入口。
var formTimeId = null;
async function openFormTime(id) {
    formTimeId = id;
    var errBox = document.getElementById('formTimeError');
    errBox.classList.remove('show');
    document.getElementById('ftDeadline').value = '';
    document.getElementById('ftEditPolicy').value = 'before_deadline';
    refreshDateHints();
    openModal('formTimeModal');
    try {
        var res = await api('/api/forms/' + id);
        // 关弹窗不会取消在途请求：回来时先确认还是同一条，否则会把 A 的截止时间
        // 填进为 B 打开的弹窗，保存时又按 B 提交（静默改掉 B 的时间）
        if (formTimeId !== id) return;
        var form = res.data.form;
        // 服务端存的是 'YYYY-MM-DD HH:mm:ss'，datetime-local 只认 'YYYY-MM-DDTHH:mm'
        document.getElementById('ftDeadline').value =
            form.deadline ? String(form.deadline).replace(' ', 'T').slice(0, 16) : '';
        document.getElementById('ftEditPolicy').value = form.edit_policy || 'before_deadline';
        refreshDateHints();
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    }
}

async function saveFormTime() {
    if (!formTimeId) return;
    var errBox = document.getElementById('formTimeError');
    errBox.classList.remove('show');
    var btn = document.getElementById('formTimeBtn');
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '保存中…';
    try {
        await api('/api/forms/' + formTimeId, {
            method: 'PUT',
            body: JSON.stringify({
                // 空串即「清除截止时间」（后端 toLocalDateTime('') 返回 null）
                deadline: document.getElementById('ftDeadline').value || '',
                edit_policy: document.getElementById('ftEditPolicy').value
            })
        });
        closeModal('formTimeModal');
        loadFormsAdmin();
    } catch (err) {
        errBox.textContent = err.message;
        errBox.classList.add('show');
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

async function openFormResult(id) {
    formResultId = id;
    formResultForm = null;
    formPendingText = '';
    document.getElementById('formResultTitle').textContent = '表单结果';
    document.getElementById('formResultMeta').textContent = '正在加载…';
    document.getElementById('formPendingList').innerHTML = '';
    document.getElementById('formSubsList').innerHTML = '';
    document.getElementById('formSubsBtn').hidden = false;
    openModal('formResultModal');
    try {
        var formRes = await api('/api/forms/' + id);
        // 同 openFormTime：响应回来时弹窗可能已经换成另一张表单，晚到的这一份必须丢弃
        if (formResultId !== id) return;
        var form = formRes.data.form;
        formResultForm = form;
        document.getElementById('formResultTitle').textContent = form.title;

        var meta = [];
        if (form.anonymous) meta.push('匿名表单：只看得到谁交了，看不到谁答了什么');
        meta.push(form.deadline ? '截止 ' + fmtDate(form.deadline) : '长期有效');
        document.getElementById('formResultMeta').textContent = meta.join(' · ');

        var prog = await api('/api/forms/' + id + '/progress');
        if (formResultId !== id) return;
        var p = prog.data || {};
        formPendingText = p.pendingText || '';
        document.getElementById('formPendingList').innerHTML = '<div class="info-row member-row">'
            + '<div class="member-main">'
            + '<div class="member-line"><span class="member-name">已交 ' + (p.submitted || 0) + ' / ' + (p.total || 0) + '</span></div>'
            + '<div class="member-line"><span>' + (formPendingText ? '还没交的：' + esc(formPendingText) : '全部已交') + '</span></div>'
            + '</div></div>';
    } catch (err) {
        document.getElementById('formResultMeta').textContent = err.message;
    }
}

/**
 * 提交明细按需加载。明细是「每人一条 × 全部答案」，是整个弹窗里最重的一个请求，
 * 所以只在点了按钮时才拉；字段定义与是否匿名直接复用 formResultForm，
 * 不再多请求一次 /api/forms/:id。
 */
async function loadFormSubs() {
    var btn = document.getElementById('formSubsBtn');
    var host = document.getElementById('formSubsList');
    // 表单详情那一步失败时 formResultForm 为空，别静默返回——按钮点了没反应最像卡死
    if (!formResultForm) { host.innerHTML = stateHTML('表单信息未加载，请关闭弹窗重开', true); return; }
    btn.disabled = true;
    var original = btn.textContent;
    btn.textContent = '正在加载…';
    try {
        // 明细是按 formResultId 拉的，字段定义却取 formResultForm：期间换过表单就会
        // 用 A 的字段去解释 B 的答案。所以先把这次请求对应的 id 记下来，回来再核一次
        var subsReqId = formResultId;
        var subsRes = await api('/api/forms/' + subsReqId + '/submissions');
        if (formResultId !== subsReqId || !formResultForm) return;
        var list = (subsRes.data && subsRes.data.list) || [];
        if (!list.length) {
            host.innerHTML = stateHTML('还没有人提交');
        } else {
            var form = formResultForm;
            var fields = form.fields || [];
            host.innerHTML = list.map(function (s) {
                var who = form.anonymous ? '匿名' : (esc(s.name || '未知') + ' · ' + esc(s.student_id || ''));
                var answers = fields.map(function (f) {
                    var v = s.answers[f.key];
                    var text = Array.isArray(v) ? v.join('、') : (v == null || v === '' ? '—' : String(v));
                    return esc(f.label) + '：' + esc(text);
                }).join('　');
                return '<div class="info-row member-row"><div class="member-main">'
                    + '<div class="member-line"><span class="member-name">' + who + '</span></div>'
                    + '<div class="member-line"><span>' + esc(fmtDate(s.updated_at || s.created_at)) + '</span></div>'
                    + '<div class="member-line"><span>' + answers + '</span></div>'
                    + '</div></div>';
            }).join('');
        }
        btn.hidden = true;
    } catch (err) {
        host.innerHTML = stateHTML(err.message, true);
    } finally {
        btn.disabled = false;
        btn.textContent = original;
    }
}

function copyPending() {
    if (!formPendingText) { alert('没有未交名单'); return; }
    var text = '还没交的：' + formPendingText;
    if (navigator.clipboard && navigator.clipboard.writeText) {
        navigator.clipboard.writeText(text).then(function () { alert('已复制未交名单'); }, function () { alert(text); });
    } else {
        alert(text);
    }
}

/** 导出要带 Bearer token，普通 <a> 拿不到，所以取回 Blob 再触发下载。
 * 走 api({raw:true})：Bearer 头、30s 超时、401 清会话都由它统一处理（issue #84 项 5），
 * 不再在调用方手抄一份 localStorage.getItem('ca_token')。 */
async function exportForm() {
    if (!formResultId) return;
    try {
        var res = await api('/api/forms/' + formResultId + '/export', { raw: true });
        var blob = await res.blob();
        var url = URL.createObjectURL(blob);
        var a = document.createElement('a');
        a.href = url;
        a.download = 'form-' + formResultId + '.csv';
        document.body.appendChild(a);
        a.click();
        document.body.removeChild(a);
        setTimeout(function () { URL.revokeObjectURL(url); }, 1000);
    } catch (err) {
        alert('导出失败：' + err.message);
    }
}

// ===== 事件绑定 =====
// CSP 的 script-src 只放行 'self'，页面里不能再写内联 onclick：
// 静态按钮用 data-act + data-arg 标记，动态列表行用 data-act + data-id 标记，
// 统一委托到 document（列表重绘也不用重新绑）。
delegate(document, 'click', '[data-act="toggle-collapse"]', function (el) { toggleCollapse(el.getAttribute('data-arg')); });
delegate(document, 'click', '[data-act="close-modal"]', function (el) { closeModal(el.getAttribute('data-arg')); });
delegate(document, 'input', '[data-act="filter-members"]', function () { filterMembers(); });
delegate(document, 'change', '[data-act="field-type-change"]', function (el) { onFieldTypeChange(el); });
delegate(document, 'click', '[data-act="submit-notice"]', function () { submitNotice(); });
delegate(document, 'click', '[data-act="submit-activity"]', function () { submitActivity(); });
// 附带待办：勾选框展开/收起字段，标签 chips 点选/取消（都用委托，卡片重绘也不用重绑）
delegate(document, 'change', '[data-act="toggle-notice-todo"]', function (el) { toggleTodoFields('notice', el.checked); });
delegate(document, 'change', '[data-act="toggle-activity-todo"]', function (el) { toggleTodoFields('activity', el.checked); });
delegate(document, 'click', '[data-act="toggle-notice-tag"]', function (el) { toggleTodoTag('notice', el.getAttribute('data-tag')); });
delegate(document, 'click', '[data-act="toggle-activity-tag"]', function (el) { toggleTodoTag('activity', el.getAttribute('data-tag')); });
delegate(document, 'click', '[data-act="submit-form-create"]', function () { submitFormCreate(); });
delegate(document, 'click', '[data-act="add-field-row"]', function () { addFieldRow(); });
delegate(document, 'click', '[data-act="remove-field-row"]', function (el) { removeFieldRow(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="edit-member"]', function (el) { startEditMember(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-member"]', function (el) { delMember(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="save-member"]', function () { saveMember(); });
delegate(document, 'click', '[data-act="cancel-edit-member"]', function () { cancelEditMember(); });
delegate(document, 'click', '[data-act="add-role"]', function () { addRole(); });
delegate(document, 'click', '[data-act="edit-role"]', function (el) { editRole(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="del-role"]', function (el) { delRole(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="open-form-time"]', function (el) { openFormTime(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="save-form-time"]', function () { saveFormTime(); });
delegate(document, 'click', '[data-act="open-form-result"]', function (el) { openFormResult(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="load-form-subs"]', function () { loadFormSubs(); });
delegate(document, 'click', '[data-act="copy-pending"]', function () { copyPending(); });
delegate(document, 'click', '[data-act="export-form"]', function () { exportForm(); });
delegate(document, 'click', '[data-act="del-form"]', function (el) { delForm(el.getAttribute('data-id')); });
delegate(document, 'click', '[data-act="toggle-form-status"]', function (el) {
    toggleFormStatus(el.getAttribute('data-id'), el.getAttribute('data-status'), el);
});

// 操作日志：文本筛选防抖 350ms，避免每敲一个字都打一次接口；
// 下拉与日期用 change 立即触发。翻页只改页码、不清空筛选条件。
var auditFilterTimer = null;
delegate(document, 'input', '[data-act="filter-audit"]', function () {
    clearTimeout(auditFilterTimer);
    auditFilterTimer = setTimeout(function () { loadAuditLogs(true); }, 350);
});
delegate(document, 'change', '[data-act="filter-audit"]', function () { loadAuditLogs(true); });
delegate(document, 'click', '[data-act="audit-page"]', function (el) {
    var pages = Math.max(1, Math.ceil(auditState.total / auditState.pageSize));
    var dir = el.getAttribute('data-arg');
    if (dir === 'prev' && auditState.page > 1) auditState.page -= 1;
    else if (dir === 'next' && auditState.page < pages) auditState.page += 1;
    else return;
    loadAuditLogs(false);
});

// 功能开关：保存后后端立即清缓存，本次请求就能看到新状态。
delegate(document, 'click', '[data-act="save-features"]', function (el) {
    saveFeatureSettings(el);
});

// 代加待办：选人 / 标签 / 提交都在这一张卡里（原先的「跳去待办页」已经不需要了）
delegate(document, 'click', '[data-act="toggle-delegate-tag"]', function (el) {
    toggleTodoTag('delegate', el.getAttribute('data-tag'));
});
delegate(document, 'click', '[data-act="add-delegate-tag"]', function () {
    addTodoCustomTag('delegate', document.getElementById('dlgTagInput'));
});
delegate(document, 'click', '[data-act="submit-delegate-todo"]', function (el) {
    submitDelegateTodo(el);
});
delegate(document, 'change', '#dlgMemberBox .remind-cb', updateDelegateHint);
// 「按职位快选」是程序化改 checked 的，不会触发 change，得单独补一拍计数
delegate(document, 'click', '#dlgMemberBox .pos-chip', function () { updateDelegateHint(); });
})();
