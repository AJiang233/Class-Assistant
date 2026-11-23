import { TodoModel } from '../models/todoModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { formatLocalDateTime, parseLocalDateTime, toLocalDateTime } from '../utils/datetime.js';
import { pageLimit, pageOffset } from '../utils/query.js';

/**
 * 待办处理器（issue #99）
 *
 * 权限口径：
 *   - 所有待办接口都要登录；读到的永远是「自己的」待办，班委/管理员也不例外（决策 3.A 的边界）。
 *   - 代加（一次性给多个学生加）需要 content:write，代加人只能撤回自己加的、还没完成的待办。
 *   - 编辑、完成、删除自己的待办只认 owner_id。
 *
 * 响应里的 todo 形状：数据库行 + tags（数组）+ created_by_name + urgency
 * （overdue=已超时 / urgent=红 / warn=黄 / normal=正常，阈值取本人 todo_prefs）。
 */

/** 预置标签（决策 4.A）；前端允许在此基础上手动输入新标签，后端只做长度/数量校验。 */
export const TODO_TAGS = ['作业', '考试', '班会', '活动', '材料', '缴费'];

const TITLE_MAX = 100;
const DESC_MAX = 1000;
const TAG_MAX = 12;
const TAGS_MAX = 4;
const DELEGATE_MAX = 200;

/** 标签数组 → 存库的 JSON 字符串；不合法返回 { error }。 */
function normalizeTags(raw) {
  if (raw === undefined || raw === null) return { tags: null };
  if (!Array.isArray(raw)) return { error: '标签格式不正确' };
  const out = [];
  for (const item of raw) {
    if (typeof item !== 'string') return { error: '标签格式不正确' };
    const tag = item.trim();
    if (!tag || tag.length > TAG_MAX) return { error: `每个标签不能超过 ${TAG_MAX} 个字` };
    if (!out.includes(tag)) out.push(tag);
  }
  if (out.length > TAGS_MAX) return { error: `标签最多 ${TAGS_MAX} 个` };
  return { tags: out.length ? JSON.stringify(out) : null };
}

/** 库里的 tags JSON → 数组；坏数据按空数组处理。 */
export function parseTagList(raw) {
  if (!raw) return [];
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.filter((x) => typeof x === 'string') : [];
  } catch {
    return [];
  }
}

/**
 * 校验一条待办的输入。返回 { value:{title,description,start_at,due_at,tags} } 或 { error, code }。
 * titleFallback 用于通知/活动发布：待办标题可以留空，默认跟内容标题一致。
 */
export function buildTodoInput(body, { titleFallback = null } = {}) {
  const rawTitle = body.title === undefined || body.title === null || body.title === ''
    ? titleFallback
    : body.title;
  const title = String(rawTitle == null ? '' : rawTitle).trim();
  if (!title) return { error: '请填写待办标题', code: 'INVALID_TODO_TITLE' };
  if (title.length > TITLE_MAX) return { error: `待办标题最多 ${TITLE_MAX} 字`, code: 'INVALID_TODO_TITLE' };

  const description = body.description == null || body.description === ''
    ? null
    : String(body.description).trim();
  if (description && description.length > DESC_MAX) {
    return { error: `待办说明最多 ${DESC_MAX} 字`, code: 'INVALID_TODO_DESC' };
  }

  const start_at = body.start_at ? toLocalDateTime(body.start_at) : null;
  if (body.start_at && !start_at) return { error: '开始时间格式不正确', code: 'INVALID_TODO_TIME' };

  const due_at = toLocalDateTime(body.due_at);
  if (!due_at) return { error: '请填写正确的截止时间', code: 'INVALID_TODO_TIME' };
  if (start_at && due_at <= start_at) {
    return { error: '截止时间必须晚于开始时间', code: 'INVALID_TODO_TIME' };
  }

  const tags = normalizeTags(body.tags);
  if (tags.error) return { error: tags.error, code: 'INVALID_TODO_TAGS' };

  return { value: { title, description, start_at, due_at, tags: tags.tags } };
}

/** 给一条待办补上 tags 数组与紧急度（阈值来自本人 prefs）。 */
function decorate(row, prefs, nowMs) {
  const dueMs = parseLocalDateTime(row.due_at);
  let urgency = 'normal';
  if (row.status === 'expired') {
    urgency = 'overdue';
  } else if (row.status === 'open' && dueMs != null) {
    const minutesLeft = (dueMs - nowMs) / 60000;
    if (minutesLeft <= 0) urgency = 'overdue';
    else if (minutesLeft <= prefs.urgent_hours * 60) urgency = 'urgent';
    else if (minutesLeft <= prefs.warn_hours * 60) urgency = 'warn';
  }
  return { ...row, tags: parseTagList(row.tags), urgency };
}

/** 首页摘要卡 / 待办列表共用：GET /api/todos?status=open|history&tag=&limit=&offset= */
export async function handleListTodos(request, env, user) {
  try {
    const url = new URL(request.url);
    const status = url.searchParams.get('status') === 'history' ? 'history' : 'open';
    const tag = (url.searchParams.get('tag') || '').trim().slice(0, TAG_MAX) || null;
    const limit = pageLimit(url, 50, 100);
    const offset = pageOffset(url);

    const model = new TodoModel(env.DB);
    const now = formatLocalDateTime();
    await model.expireOverdue(user.id, now);

    const page = await model.list({ ownerId: user.id, status, tag, limit, offset });
    const counts = await model.counts(user.id);
    const prefs = await model.getPrefs(user.id);
    const nowMs = parseLocalDateTime(now);

    return jsonResponse(success({
      list: page.list.map((row) => decorate(row, prefs, nowMs)),
      total: page.total,
      counts,
      prefs,
      tags: TODO_TAGS
    }));
  } catch (e) {
    console.error('获取待办列表失败:', e);
    return jsonResponse(error('获取待办列表失败', 'LIST_TODOS_FAILED'), 500);
  }
}

/** POST /api/todos：给自己新建一条待办。 */
export async function handleCreateTodo(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const built = buildTodoInput(body);
    if (built.error) return jsonResponse(error(built.error, built.code), 400);

    const now = formatLocalDateTime();
    if (built.value.due_at <= now) {
      return jsonResponse(error('截止时间必须晚于现在', 'TODO_DUE_PAST'), 400);
    }

    const model = new TodoModel(env.DB);
    const id = await model.create({
      ...built.value,
      owner_id: user.id,
      created_by: user.id,
      source: 'manual'
    });
    const row = await model.findById(id);
    const prefs = await model.getPrefs(user.id);
    return jsonResponse(success({ todo: decorate(row, prefs, parseLocalDateTime(now)) }), 201);
  } catch (e) {
    console.error('新建待办失败:', e);
    return jsonResponse(error('新建待办失败，请稍后重试', 'CREATE_TODO_FAILED'), 500);
  }
}

/** PUT /api/todos/:id：只有本人、且只有进行中的待办可以改。 */
export async function handleUpdateTodo(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('待办不存在', 'INVALID_ID'), 400);

    const model = new TodoModel(env.DB);
    const row = await model.findById(id);
    if (!row) return jsonResponse(error('待办不存在', 'TODO_NOT_FOUND'), 404);
    if (Number(row.owner_id) !== Number(user.id)) {
      return jsonResponse(error('只能编辑自己的待办', 'FORBIDDEN'), 403);
    }
    if (row.status !== 'open') {
      return jsonResponse(error('只有进行中的待办可以编辑', 'TODO_LOCKED'), 400);
    }

    const body = await request.json().catch(() => ({}));
    // 未传的字段保持原值；显式传空串（description/start_at）表示清空
    const built = buildTodoInput({
      title: body.title !== undefined ? body.title : row.title,
      description: body.description !== undefined ? body.description : row.description,
      start_at: body.start_at !== undefined ? body.start_at : row.start_at,
      due_at: body.due_at !== undefined ? body.due_at : row.due_at,
      tags: body.tags !== undefined ? body.tags : parseTagList(row.tags)
    });
    if (built.error) return jsonResponse(error(built.error, built.code), 400);

    const now = formatLocalDateTime();
    if (built.value.due_at <= now) {
      return jsonResponse(error('截止时间必须晚于现在', 'TODO_DUE_PAST'), 400);
    }

    await model.update(id, built.value);
    const fresh = await model.findById(id);
    const prefs = await model.getPrefs(user.id);
    return jsonResponse(success({ todo: decorate(fresh, prefs, parseLocalDateTime(now)) }));
  } catch (e) {
    console.error('保存待办失败:', e);
    return jsonResponse(error('保存待办失败，请稍后重试', 'UPDATE_TODO_FAILED'), 500);
  }
}

/** POST /api/todos/:id/status：完成 / 重新打开（只有本人）。 */
export async function handleUpdateTodoStatus(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('待办不存在', 'INVALID_ID'), 400);

    const body = await request.json().catch(() => ({}));
    const target = body.status;
    if (target !== 'done' && target !== 'open') {
      return jsonResponse(error('状态只能是 done 或 open', 'INVALID_STATUS'), 400);
    }

    const model = new TodoModel(env.DB);
    const row = await model.findById(id);
    if (!row) return jsonResponse(error('待办不存在', 'TODO_NOT_FOUND'), 404);
    if (Number(row.owner_id) !== Number(user.id)) {
      return jsonResponse(error('只能操作自己的待办', 'FORBIDDEN'), 403);
    }
    if (row.status === 'expired') {
      return jsonResponse(error('已超时的待办不能再修改状态', 'TODO_EXPIRED'), 400);
    }

    if (row.status !== target) await model.setStatus(id, target);
    const fresh = await model.findById(id);
    const prefs = await model.getPrefs(user.id);
    return jsonResponse(success({ todo: decorate(fresh, prefs, Date.now()) }));
  } catch (e) {
    console.error('更新待办状态失败:', e);
    return jsonResponse(error('更新待办状态失败，请稍后重试', 'UPDATE_TODO_STATUS_FAILED'), 500);
  }
}

/** DELETE /api/todos/:id：本人删自己的；代加人可撤回自己加的、未完成的。 */
export async function handleDeleteTodo(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('待办不存在', 'INVALID_ID'), 400);

    const model = new TodoModel(env.DB);
    const row = await model.findById(id);
    if (!row) return jsonResponse(error('待办不存在', 'TODO_NOT_FOUND'), 404);

    const isOwner = Number(row.owner_id) === Number(user.id);
    const canWithdraw = !isOwner
      && Number(row.created_by) === Number(user.id)
      && row.status === 'open';
    if (!isOwner && !canWithdraw) {
      return jsonResponse(error('只能删除自己的待办', 'FORBIDDEN'), 403);
    }

    await model.remove(id);
    return jsonResponse(success({ message: canWithdraw ? '已撤回待办' : '待办已删除' }));
  } catch (e) {
    console.error('删除待办失败:', e);
    return jsonResponse(error('删除待办失败，请稍后重试', 'DELETE_TODO_FAILED'), 500);
  }
}

/** POST /api/todos/delegate：班委一次给多个学生代加同一条待办（决策 3.A）。 */
export async function handleDelegateTodos(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const rawIds = Array.isArray(body.user_ids) ? body.user_ids : [];
    if (!rawIds.length) return jsonResponse(error('请选择要代加待办的同学', 'MISSING_MEMBERS'), 400);
    if (rawIds.length > DELEGATE_MAX) {
      return jsonResponse(error(`一次最多给 ${DELEGATE_MAX} 人代加`, 'TOO_MANY_MEMBERS'), 400);
    }
    const ids = [];
    for (const raw of rawIds) {
      const n = Number(raw);
      if (!Number.isInteger(n) || n <= 0) {
        return jsonResponse(error('成员列表不正确，请刷新后重试', 'INVALID_MEMBERS'), 400);
      }
      if (!ids.includes(n)) ids.push(n);
    }

    const built = buildTodoInput(body);
    if (built.error) return jsonResponse(error(built.error, built.code), 400);
    const now = formatLocalDateTime();
    if (built.value.due_at <= now) {
      return jsonResponse(error('截止时间必须晚于现在', 'TODO_DUE_PAST'), 400);
    }

    // 逐个核对成员是否存在：删号/手改 id 都挡在写库之前，避免给不存在的人留孤儿待办
    const usersResult = await env.DB.prepare('SELECT id FROM users').all();
    const existing = new Set((usersResult.results || []).map((row) => Number(row.id)));
    if (ids.some((id) => !existing.has(id))) {
      return jsonResponse(error('有成员不存在，请刷新名单后重试', 'INVALID_MEMBERS'), 400);
    }

    const model = new TodoModel(env.DB);
    const created = await model.createMany(ids, { ...built.value, created_by: user.id });
    return jsonResponse(success({ created, message: `已给 ${created} 位同学加上待办` }), 201);
  } catch (e) {
    console.error('代加待办失败:', e);
    return jsonResponse(error('代加待办失败，请稍后重试', 'DELEGATE_TODOS_FAILED'), 500);
  }
}

/** POST /api/todos/from-source：把通知/活动附带的待办加入自己的待办（同一来源只加一次）。 */
export async function handleAddTodoFromSource(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const kind = body.kind;
    if (kind !== 'notice' && kind !== 'activity') {
      return jsonResponse(error('来源类型不正确', 'INVALID_SOURCE'), 400);
    }
    const itemId = parseInt(body.id);
    if (!itemId) return jsonResponse(error('内容不存在', 'INVALID_ID'), 400);

    const model = new TodoModel(env.DB);
    const template = await model.getContentTodo(kind, itemId);
    if (!template) {
      return jsonResponse(error('这条内容没有附带待办', 'SOURCE_TODO_NOT_FOUND'), 404);
    }

    const now = formatLocalDateTime();
    const nowMs = parseLocalDateTime(now);
    const dueMs = parseLocalDateTime(template.due_at);
    if (dueMs == null || dueMs <= nowMs) {
      return jsonResponse(error('这个待办已经过了截止时间', 'SOURCE_TODO_EXPIRED'), 400);
    }

    if (await model.hasFromSource(user.id, kind, itemId)) {
      return jsonResponse(success({ duplicate: true, message: '这条待办已经在你的列表里了' }));
    }

    const id = await model.addFromSource({
      ownerId: user.id,
      source: kind,
      sourceId: itemId,
      title: template.title,
      dueAt: template.due_at,
      tags: template.tags
    });
    if (!id) return jsonResponse(success({ duplicate: true, message: '这条待办已经在你的列表里了' }));

    const row = await model.findById(id);
    const prefs = await model.getPrefs(user.id);
    return jsonResponse(success({ todo: decorate(row, prefs, nowMs) }), 201);
  } catch (e) {
    console.error('加入待办失败:', e);
    return jsonResponse(error('加入待办失败，请稍后重试', 'ADD_TODO_FROM_SOURCE_FAILED'), 500);
  }
}

/** GET /api/todos/prefs：本人红黄阈值 + 预置标签。 */
export async function handleGetTodoPrefs(request, env, user) {
  try {
    const prefs = await new TodoModel(env.DB).getPrefs(user.id);
    return jsonResponse(success({ prefs, tags: TODO_TAGS }));
  } catch (e) {
    console.error('获取待办设置失败:', e);
    return jsonResponse(error('获取待办设置失败', 'GET_TODO_PREFS_FAILED'), 500);
  }
}

/** PUT /api/todos/prefs：每人自定义红/黄阈值（决策 2.A）。 */
export async function handleUpdateTodoPrefs(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    // 只收真正的数字：Number('2') 也是 2，字符串入参要当非法值挡掉，
    // 否则前端一个手误就能把阈值写成难以排查的隐式转换结果。
    const urgent = body.urgent_hours;
    const warn = body.warn_hours;
    if (typeof urgent !== 'number' || !Number.isInteger(urgent) || urgent < 1 || urgent > 168) {
      return jsonResponse(error('红色提醒时间需为 1–168 小时', 'INVALID_PREFS'), 400);
    }
    if (typeof warn !== 'number' || !Number.isInteger(warn) || warn < 2 || warn > 720) {
      return jsonResponse(error('黄色提醒时间需为 2–720 小时', 'INVALID_PREFS'), 400);
    }
    if (warn <= urgent) {
      return jsonResponse(error('黄色提醒时间必须晚于红色提醒时间', 'INVALID_PREFS'), 400);
    }

    const model = new TodoModel(env.DB);
    await model.setPrefs(user.id, { urgentHours: urgent, warnHours: warn });
    return jsonResponse(success({ message: '已保存', prefs: { urgent_hours: urgent, warn_hours: warn } }));
  } catch (e) {
    console.error('保存待办设置失败:', e);
    return jsonResponse(error('保存待办设置失败', 'UPDATE_TODO_PREFS_FAILED'), 500);
  }
}

/**
 * 通知/活动发布时解析附带待办（body.todo）。没传返回 { value:null }。
 * 返回 { value:{title,dueAt,tags} }（注意这里字段是 dueAt，写 content_todos 用）
 * 或 { error, code }。
 */
export function parseContentTodo(raw, fallbackTitle, now = formatLocalDateTime()) {
  if (raw === undefined || raw === null) return { value: null };
  if (typeof raw !== 'object' || Array.isArray(raw)) {
    return { error: '附带待办格式不正确', code: 'INVALID_TODO' };
  }
  const built = buildTodoInput(raw, { titleFallback: fallbackTitle });
  if (built.error) return built;
  if (built.value.due_at <= now) {
    return { error: '附带待办的截止时间必须晚于现在', code: 'TODO_DUE_PAST' };
  }
  return {
    value: {
      title: built.value.title,
      dueAt: built.value.due_at,
      tags: built.value.tags
    }
  };
}
