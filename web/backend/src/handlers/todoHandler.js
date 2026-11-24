import { TodoModel } from '../models/todoModel.js';
import { ConsentModel } from '../models/consentModel.js';
import { SettingModel } from '../models/settingModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { formatLocalDateTime, parseLocalDateTime, toLocalDateTime, addMinutes } from '../utils/datetime.js';
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
    // 历史页的「已隐藏」视图：只有 status=history 时有意义，进行中永远不返回隐藏项。
    const hidden = status === 'history' && url.searchParams.get('hidden') === '1';
    const limit = pageLimit(url, 50, 100);
    const offset = pageOffset(url);

    const model = new TodoModel(env.DB);
    const now = formatLocalDateTime();
    await model.expireOverdue(user.id, now);

    const page = await model.list({ ownerId: user.id, status, tag, hidden, limit, offset });
    const counts = await model.counts(user.id);
    const prefs = await model.getPrefs(user.id);
    const syncState = await model.getSyncState(user.id);
    const nowMs = parseLocalDateTime(now);

    return jsonResponse(success({
      list: page.list.map((row) => decorate(row, prefs, nowMs)),
      total: page.total,
      counts,
      prefs,
      tags: TODO_TAGS,
      // 前端据此决定进页是否自动同步；synced_today 按北京时间日期比，跨天即重新拉一轮。
      sync: syncState
        ? {
            last_synced_at: syncState.last_synced_at || null,
            last_attempt_at: syncState.last_attempt_at || null,
            last_result: syncState.last_result || null,
            last_message: syncState.last_message || null,
            synced_today: !!syncState.last_synced_at
              && String(syncState.last_synced_at).slice(0, 10) === now.slice(0, 10)
          }
        : null
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

// ===== 学习通作业 / 考试自动加入待办 =====

/**
 * 分批拉课程作业：一批 4 门并发。
 * 每门课内部要先取课程主页、再取作业列表，带 ?details=1 时还要逐份打开作业详情页，
 * 批次太大最容易把单个 Pages Function 拖过前端超时 —— 宁可多分几批。
 */
const SYNC_BATCH_DEFAULT = 4;
const SYNC_BATCH_MAX = 6;
/** 单轮最多同步的课程数：私有 Worker 一次调用只有 50 个子请求预算，留出余量。 */
const SYNC_MAX_COURSES = 40;
/** 手动按钮点击后的降温窗口（需求：变灰 60 秒）。服务端也校验，避免多标签页绕过。 */
const SYNC_COOLDOWN_MS = 60 * 1000;
/** 考试全量页通常很快，单独给短超时，别把第一批卡满 20 秒。 */
const SYNC_EXAM_TIMEOUT_MS = 15000;
/** 作业要逐份补详情页，单门调用给足时间；前端对应 90 秒。 */
const SYNC_WORKS_TIMEOUT_MS = 30000;

class ChaoxingCallError extends Error {
  constructor(message, code, status = 502) {
    super(message);
    this.name = 'ChaoxingCallError';
    this.code = code;
    this.status = status;
  }
}

/** 会话类错误说明 Cookie 已失效，继续逐门课重试只会白白打满上游。 */
function isSessionError(code) {
  return code === 'CHAOXING_EXPIRED' || code === 'CHAOXING_INVALID'
    || code === 'CHAOXING_NEED_CAPTCHA' || code === 'CHAOXING_UNREACHABLE';
}

function chaoxingHeaders(env, user) {
  const headers = new Headers();
  headers.set('X-Internal-Token', env.INTERNAL_TOKEN);
  headers.set('X-User-Id', String(user.id));
  headers.set('X-Student-Id', user.student_id || '');
  headers.set('X-User-Name', encodeURIComponent(user.name || ''));
  return headers;
}

/** 以门户身份调用私有学习通 Worker，返回 data；失败统一抛 ChaoxingCallError。 */
async function callChaoxing(env, user, path, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await env.CHAOXING_API.fetch(`https://private-api.local${path}`, {
      method: 'GET',
      headers: chaoxingHeaders(env, user),
      signal: controller.signal
    });
  } catch (e) {
    const aborted = e && (e.name === 'AbortError' || e.name === 'TimeoutError');
    throw new ChaoxingCallError(
      aborted ? '学习通响应超时，请稍后再试' : '学习通服务暂时不可用，请稍后再试',
      aborted ? 'CHAOXING_TIMEOUT' : 'CHAOXING_UNAVAILABLE',
      503
    );
  } finally {
    clearTimeout(timer);
  }

  const body = await res.json().catch(() => null);
  if (!res.ok || !body || body.success === false) {
    throw new ChaoxingCallError(
      (body && body.error) || '学习通服务返回异常',
      (body && body.code) || 'CHAOXING_BAD_RESPONSE',
      res.status || 502
    );
  }
  return body.data || {};
}

/** 「剩余 263 小时 6 分钟」→ 分钟；没有数字（已过期 / 空）返回 null。 */
function parseRemainingMinutes(text) {
  const s = String(text || '');
  const day = s.match(/(\d+)\s*天/);
  const hour = s.match(/(\d+)\s*小时/);
  const minute = s.match(/(\d+)\s*分钟/);
  if (!day && !hour && !minute) return null;
  return (day ? Number(day[1]) : 0) * 1440
    + (hour ? Number(hour[1]) : 0) * 60
    + (minute ? Number(minute[1]) : 0);
}

/** 「2026-11-15 18:30 至 2026-12-20 18:30」→ { start, end, endMs }。 */
function parseExamWindow(text) {
  const m = String(text || '').match(
    /(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?::\d{2})?\s*(?:至|~|—|－|-)\s*(\d{4}-\d{2}-\d{2}\s+\d{2}:\d{2})(?::\d{2})?/
  );
  if (!m) return null;
  const start = toLocalDateTime(m[1]);
  const end = toLocalDateTime(m[2]);
  const endMs = end ? parseLocalDateTime(end) : null;
  if (!end || endMs == null) return null;
  return { start, end, endMs };
}

/** 考试：「未交 / 未考 / 空」算未完成，其余（已交 / 已考 / 待批阅）算完成。 */
function isExamFinished(status) {
  return !!status && status !== '未交' && status !== '未考';
}

/**
 * 作业的完成态标记：含任一即视为已交（「待提交 / 未交 / 空」都还没交）。
 * 不能沿用考试的「非空即完成」——学习通作业状态里还有「待提交」。
 */
const WORK_DONE_MARKS = ['已完成', '已提交', '已交', '待批阅', '已批阅', '已批改'];

function isWorkFinished(status) {
  const s = String(status || '').trim();
  return WORK_DONE_MARKS.some((mark) => s.includes(mark));
}

function trimTitle(title) {
  const t = String(title || '').trim() || '学习通待办';
  return t.length > TITLE_MAX ? `${t.slice(0, TITLE_MAX - 1)}…` : t;
}

function examDescription(courseName, time, url) {
  return [
    '学习通考试',
    courseName,
    time ? `时间：${time}` : '',
    url ? `原页面：${url}` : ''
  ].filter(Boolean).join(' · ').slice(0, DESC_MAX);
}

function workDescription(courseName, status, url) {
  return [
    '学习通作业',
    courseName,
    status ? `状态：${status}` : '',
    url ? `原页面：${url}` : ''
  ].filter(Boolean).join(' · ').slice(0, DESC_MAX);
}

/**
 * 把一条学习通作业 / 考试落到待办：
 *   · 本地没有 → 只在「未完成且截止还没过」时新建；
 *   · 本地有、来源已完成 → open/expired 一律并进历史（用户手动改过也以学习通为准）；
 *   · 本地有、来源仍未完成 → 只刷新进行中的那条，已完成的不重新打开。
 * @returns {'created'|'updated'|'completed'|'skipped'}
 */
async function syncSourceItem(model, user, item) {
  const row = await model.findExternal(user.id, item.externalId);
  if (row) {
    if (item.finished) {
      if (row.status === 'open' || row.status === 'expired') {
        await model.completeExternal(row.id, item.now);
        return 'completed';
      }
      return 'skipped';
    }
    if (row.status === 'open' && item.dueMs > item.nowMs) {
      await model.refreshExternal(row.id, {
        title: item.title,
        description: item.description,
        start_at: item.startAt,
        due_at: item.dueAt
      });
      return 'updated';
    }
    return 'skipped';
  }

  if (item.finished) return 'skipped';
  // 已经截止但还没交：同样建出来，直接落成历史，避免「学习通有、待办里没有」的错觉。
  const expired = item.dueMs <= item.nowMs;
  try {
    await model.create({
      owner_id: user.id,
      title: item.title,
      description: item.description,
      start_at: item.startAt,
      due_at: item.dueAt,
      tags: item.tags,
      source: 'academic',
      external_id: item.externalId,
      created_by: user.id,
      status: expired ? 'expired' : 'open'
    });
    return 'created';
  } catch (e) {
    // 两个标签页同时同步时唯一索引会撞：对方已经建好，这一条跳过即可。
    if (/UNIQUE/i.test(String(e && e.message))) return 'skipped';
    throw e;
  }
}

/** 作业响应 → 统一的待办字段；解析不出截止时间（页面无截止 / 改版）返回 null。 */
function workToTodo(entry, courseName, now, nowMs) {
  const externalId = entry.workId ? `work:${entry.workId}` : '';
  if (!externalId) return null;

  // 新私有 API 会补 deadlineAt（详情页的绝对截止时间）；老缓存只有「剩余 x 小时」。
  let dueAt = entry.deadlineAt ? toLocalDateTime(entry.deadlineAt) : '';
  if (!dueAt) {
    const minutes = parseRemainingMinutes(entry.deadline);
    if (minutes == null) return null;
    dueAt = addMinutes(now, minutes);
  }
  const dueMs = parseLocalDateTime(dueAt);
  if (dueMs == null) return null;

  return {
    externalId,
    title: trimTitle(`${courseName ? `[${courseName}] ` : ''}${entry.title}`),
    description: workDescription(courseName, entry.status, entry.url),
    startAt: null,
    dueAt,
    dueMs,
    finished: isWorkFinished(entry.status),
    tags: JSON.stringify(['作业']),
    now,
    nowMs
  };
}

/** 考试响应 → 统一字段；时间解析失败或没有 examId 返回 null。 */
function examToTodo(entry, courseName, now, nowMs) {
  const win = parseExamWindow(entry.time);
  if (!win) return null;
  const externalId = entry.examId ? `exam:${entry.examId}` : '';
  if (!externalId) return null;
  return {
    externalId,
    title: trimTitle(`${courseName ? `[${courseName}] ` : ''}${entry.title}`),
    description: examDescription(courseName, entry.time, entry.url),
    startAt: win.start,
    dueAt: win.end,
    dueMs: win.endMs,
    finished: isExamFinished(entry.status),
    tags: JSON.stringify(['考试']),
    now,
    nowMs
  };
}

function countResult(stats, result) {
  if (result === 'created' || result === 'updated' || result === 'completed' || result === 'skipped') {
    stats[result] += 1;
  }
}

async function recordSyncFailure(model, user, e, notBoundMessage = '还没绑定学习通，绑定后会自动同步作业和考试') {
  const code = (e && e.code) || 'SYNC_FAILED';
  const message = (e && e.message) || '同步失败，请稍后再试';
  if (code === 'NOT_BOUND') {
    await model.finishSync(user.id, { result: 'not_bound', message });
    return jsonResponse(success({
      bound: false,
      done: true,
      message: notBoundMessage
    }));
  }
  await model.finishSync(user.id, { result: 'error', message });
  return jsonResponse(error(message, code), (e && e.status) || 502);
}

/**
 * POST /api/todos/sync-chaoxing
 * body: { cursor?:number, batch?:number, refresh?:boolean }
 *
 * 分页而不是一次拉完 39 门课：每个请求只抓 batch 门，前端拿到 next_cursor 继续，
 * 既能显示进度，也不会让单个 Pages Function 跑太久 / 超过私有 Worker 的子请求预算。
 */
export async function handleSyncChaoxingTodos(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const cursor = Math.max(0, Number.parseInt(body.cursor, 10) || 0);
    const batchSize = Math.min(
      SYNC_BATCH_MAX,
      Math.max(1, Number.parseInt(body.batch, 10) || SYNC_BATCH_DEFAULT)
    );
    const refresh = body.refresh !== false;

    if (!(await new SettingModel(env.DB).isEnabled('chaoxing'))) {
      return jsonResponse(
        {
          success: false,
          error: '该功能正在维护中，请稍后再试',
          code: 'FEATURE_DISABLED',
          data: { feature: 'chaoxing', retry_after: 30 }
        },
        503,
        { 'Retry-After': '30' }
      );
    }
    if (!env.CHAOXING_API || !env.INTERNAL_TOKEN) {
      return jsonResponse(error('学习通功能暂时不可用，请稍后重试', 'CHAOXING_UNAVAILABLE'), 503);
    }
    const consent = await new ConsentModel(env.DB).get(user.id);
    if (!consent || Number(consent.chaoxing) !== 1) {
      return jsonResponse(
        error(
          '尚未同意「使用身份登录学习通」，请到「个人中心 → 用户协议与授权」开启学习通授权',
          'CHAOXING_CONSENT_REQUIRED'
        ),
        403
      );
    }

    const model = new TodoModel(env.DB);
    const now = formatLocalDateTime();
    const nowMs = parseLocalDateTime(now);

    if (cursor === 0) {
      const state = await model.getSyncState(user.id);
      const lastMs = state && state.last_attempt_at ? parseLocalDateTime(state.last_attempt_at) : null;
      if (lastMs != null && nowMs - lastMs < SYNC_COOLDOWN_MS) {
        const retryAfter = Math.max(1, Math.ceil((SYNC_COOLDOWN_MS - (nowMs - lastMs)) / 1000));
        return jsonResponse(
          {
            success: false,
            error: `同步太频繁，请 ${retryAfter} 秒后再试`,
            code: 'SYNC_COOLDOWN',
            data: { retry_after: retryAfter }
          },
          429,
          { 'Retry-After': String(retryAfter) }
        );
      }
      await model.markSyncAttempt(user.id, now);
      // 先把已过截止时间的进行中待办挪进历史，同步结果与列表状态才是同一口径。
      await model.expireOverdue(user.id, now);
    }

    let courses = [];
    try {
      const data = await callChaoxing(env, user, '/api/chaoxing/courses');
      courses = Array.isArray(data.courses) ? data.courses : [];
    } catch (e) {
      return recordSyncFailure(model, user, e);
    }

    const capped = courses.slice(0, SYNC_MAX_COURSES);
    const total = capped.length;
    const batch = capped.slice(cursor, cursor + batchSize);
    const stats = { created: 0, updated: 0, completed: 0, skipped: 0, no_deadline: 0 };
    const errors = [];

    // 考试只需在第一批发一次全量请求：私有 Worker 会一次抓完学校考试系统并按课程写缓存。
    if (cursor === 0 && refresh) {
      try {
        const data = await callChaoxing(env, user, '/api/chaoxing/exams?refresh=1', SYNC_EXAM_TIMEOUT_MS);
        for (const entry of data.items || []) {
          const item = examToTodo(entry, entry.courseName || '', now, nowMs);
          if (!item) { stats.skipped += 1; continue; }
          countResult(stats, await syncSourceItem(model, user, item));
        }
      } catch (e) {
        if (isSessionError(e.code) || e.code === 'NOT_BOUND') {
          return recordSyncFailure(model, user, e);
        }
        errors.push(`考试：${e.message}`);
      }
    }

    // 作业必须逐门抓（私有 Worker 的 /works 只在带 courseId 时出网），这里并发 4 门。
    // details=1 让私有 API 逐份打开未交作业的详情页补绝对截止时间（列表页没有）。
    if (batch.length) {
      const settled = await Promise.allSettled(batch.map((course) => callChaoxing(
        env,
        user,
        `/api/chaoxing/works?courseId=${encodeURIComponent(course.courseId)}&refresh=1&details=1`,
        SYNC_WORKS_TIMEOUT_MS
      )));
      for (let i = 0; i < settled.length; i += 1) {
        const result = settled[i];
        const course = batch[i];
        if (result.status === 'rejected') {
          const e = result.reason;
          if (isSessionError(e && e.code) || (e && e.code) === 'NOT_BOUND') {
            return recordSyncFailure(model, user, e);
          }
          errors.push(`${course.name || course.courseId}：${(e && e.message) || '同步失败'}`);
          continue;
        }
        const data = result.value || {};
        const courseName = data.courseName || course.name || '';
        for (const entry of data.items || []) {
          const item = workToTodo(entry, courseName, now, nowMs);
          if (!item) {
            stats.skipped += 1;
            // 未交作业却没有截止时间：详情页也没解析到，单独提示，别让用户以为漏同步。
            if (!isWorkFinished(entry.status)) stats.no_deadline += 1;
            continue;
          }
          countResult(stats, await syncSourceItem(model, user, item));
        }
      }
    }

    const processed = Math.min(cursor + batch.length, total);
    const done = processed >= total;
    let message = '';
    if (done) {
      const parts = [];
      if (stats.created) parts.push(`新增 ${stats.created} 条`);
      if (stats.updated) parts.push(`更新 ${stats.updated} 条`);
      if (stats.completed) parts.push(`完成 ${stats.completed} 条`);
      if (stats.no_deadline) parts.push(`${stats.no_deadline} 条作业没有截止时间，未加入`);
      message = parts.join('，') || '已是最新';
      if (errors.length) message += `；${errors.length} 项暂时失败`;
      await model.finishSync(user.id, { result: 'ok', message, syncedAt: now });
    }

    return jsonResponse(success({
      bound: true,
      done,
      next_cursor: processed,
      total_courses: total,
      processed,
      created: stats.created,
      updated: stats.updated,
      completed: stats.completed,
      skipped: stats.skipped,
      no_deadline: stats.no_deadline,
      errors: errors.slice(0, 5),
      message,
      truncated: courses.length > SYNC_MAX_COURSES
    }));
  } catch (e) {
    console.error('同步学习通待办失败:', e);
    return jsonResponse(error('同步学习通待办失败，请稍后重试', 'SYNC_CHAOXING_FAILED'), 500);
  }
}

/** 中国大学MOOC 同步：一门课要拉一次学期 DTO，批次比学习通更小。 */
const MOOC_SYNC_BATCH_DEFAULT = 4;
const MOOC_SYNC_BATCH_MAX = 4;
const MOOC_SYNC_MAX_COURSES = 20;
const MOOC_SYNC_TIMEOUT_MS = 30000;

/** 中国大学MOOC 的私有 Worker 与学习通是同一个：优先专用 binding，没有就复用。 */
function moocBinding(env) {
  return env.MOOC_API || env.CHAOXING_API;
}

async function callMooc(env, user, path, timeoutMs = 20000) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  let res;
  try {
    res = await moocBinding(env).fetch(`https://private-api.local${path}`, {
      method: 'GET',
      headers: chaoxingHeaders(env, user),
      signal: controller.signal
    });
  } catch (e) {
    clearTimeout(timer);
    const aborted = e && (e.name === 'AbortError' || /abort/i.test(String(e.message)));
    throw new ChaoxingCallError(
      aborted ? '中国大学MOOC 响应超时' : '中国大学MOOC 暂时不可用',
      aborted ? 'MOOC_TIMEOUT' : 'MOOC_UNAVAILABLE'
    );
  }
  clearTimeout(timer);

  const text = await res.text();
  let body = null;
  try {
    body = text ? JSON.parse(text) : null;
  } catch {
    throw new ChaoxingCallError('中国大学MOOC 返回了无法解析的内容', 'MOOC_BAD_RESPONSE');
  }
  if (!res.ok || !body || body.success === false) {
    throw new ChaoxingCallError(
      (body && body.error) || `中国大学MOOC 请求失败（HTTP ${res.status}）`,
      (body && body.code) || 'MOOC_BAD_RESPONSE',
      res.status
    );
  }
  return body.data || {};
}

function isMoocSessionError(code) {
  return code === 'MOOC_EXPIRED' || code === 'MOOC_DECRYPT_FAILED'
    || code === 'MOOC_UNREACHABLE' || code === 'NOT_BOUND';
}

const MOOC_KIND_LABEL = { homework: '单元作业', quiz: '单元测验', exam: '考试' };

/** 私有 API 的 deadline 是 ISO（带 Z）字符串；待办口径统一用北京时间本地字符串。 */
function moocLocalTime(value) {
  if (!value) return null;
  const ms = Date.parse(value);
  if (Number.isNaN(ms)) return toLocalDateTime(value);
  return formatLocalDateTime(ms);
}

/**
 * 中国大学MOOC 的一条作业 / 测验 → 待办字段。
 *
 * 完成态只能从数据里推断：测验看已作答次数（usedTryCount > 0），作业看是否已有得分
 * （userScore 非空；未批阅时为空，宁可不标完成）。deadline 是私有 API 转好的 ISO 时间。
 */
function moocTestToTodo(entry, courseName, now, nowMs) {
  const externalId = entry.testId ? `mooc:${entry.testId}` : '';
  if (!externalId) return null;

  const dueAt = moocLocalTime(entry.deadline) || '';
  const dueMs = parseLocalDateTime(dueAt);
  if (!dueAt || dueMs == null) return null;

  const label = MOOC_KIND_LABEL[entry.kind] || '测验';
  const startAt = moocLocalTime(entry.releaseTime);
  return {
    externalId,
    title: trimTitle(`${courseName ? `[${courseName}] ` : ''}${label}：${entry.name || ''}`.trim()),
    description: [
      '中国大学MOOC',
      label,
      courseName,
      entry.chapterName ? `章节：${entry.chapterName}` : ''
    ].filter(Boolean).join(' · ').slice(0, DESC_MAX),
    startAt: startAt || null,
    dueAt,
    dueMs,
    finished: entry.kind === 'quiz'
      ? Number(entry.usedTryCount) > 0
      : entry.userScore != null,
    tags: JSON.stringify([entry.kind === 'homework' ? '作业' : '考试']),
    now,
    nowMs
  };
}

/**
 * POST /api/todos/sync-mooc
 * body: { cursor?:number, batch?:number, refresh?:boolean }
 *
 * 与学习通一致：分批同步，前端拿 next_cursor 继续。每门课先抓 /works（会顺带刷新学期
 * 缓存），再抓 /exams 复用同一份缓存，避免一门课重复请求两次上游。
 */
export async function handleSyncMoocTodos(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const cursor = Math.max(0, Number.parseInt(body.cursor, 10) || 0);
    const batchSize = Math.min(
      MOOC_SYNC_BATCH_MAX,
      Math.max(1, Number.parseInt(body.batch, 10) || MOOC_SYNC_BATCH_DEFAULT)
    );

    if (!(await new SettingModel(env.DB).isEnabled('mooc'))) {
      return jsonResponse(
        {
          success: false,
          error: '该功能正在维护中，请稍后再试',
          code: 'FEATURE_DISABLED',
          data: { feature: 'mooc', retry_after: 30 }
        },
        503,
        { 'Retry-After': '30' }
      );
    }
    if (!moocBinding(env) || !env.INTERNAL_TOKEN) {
      return jsonResponse(error('中国大学MOOC 功能暂时不可用，请稍后重试', 'MOOC_UNAVAILABLE'), 503);
    }
    const consent = await new ConsentModel(env.DB).get(user.id);
    if (!consent || Number(consent.mooc) !== 1) {
      return jsonResponse(
        error(
          '尚未同意「使用身份登录中国大学MOOC」，请到「个人中心 → 用户协议与授权」开启 MOOC 授权',
          'MOOC_CONSENT_REQUIRED'
        ),
        403
      );
    }

    const model = new TodoModel(env.DB);
    const now = formatLocalDateTime();
    const nowMs = parseLocalDateTime(now);

    if (cursor === 0) {
      const state = await model.getSyncState(user.id);
      const lastMs = state && state.last_attempt_at ? parseLocalDateTime(state.last_attempt_at) : null;
      if (lastMs != null && nowMs - lastMs < SYNC_COOLDOWN_MS) {
        const retryAfter = Math.max(1, Math.ceil((SYNC_COOLDOWN_MS - (nowMs - lastMs)) / 1000));
        return jsonResponse(
          {
            success: false,
            error: `同步太频繁，请 ${retryAfter} 秒后再试`,
            code: 'SYNC_COOLDOWN',
            data: { retry_after: retryAfter }
          },
          429,
          { 'Retry-After': String(retryAfter) }
        );
      }
      await model.markSyncAttempt(user.id, now);
      await model.expireOverdue(user.id, now);
    }

    let courses = [];
    try {
      const data = await callMooc(env, user, '/api/mooc/courses');
      courses = Array.isArray(data.courses) ? data.courses : [];
    } catch (e) {
      return recordSyncFailure(model, user, e, '还没绑定中国大学MOOC，绑定后会自动同步作业和测验');
    }

    const capped = courses.slice(0, MOOC_SYNC_MAX_COURSES);
    const total = capped.length;
    const batch = capped.slice(cursor, cursor + batchSize);
    const stats = { created: 0, updated: 0, completed: 0, skipped: 0, no_deadline: 0 };
    const errors = [];

    if (batch.length) {
      const settled = await Promise.allSettled(batch.map(async (course) => {
        const courseId = encodeURIComponent(course.courseId);
        const works = await callMooc(env, user, `/api/mooc/works?courseId=${courseId}&refresh=1`, MOOC_SYNC_TIMEOUT_MS);
        let exams = { items: [] };
        try {
          exams = await callMooc(env, user, `/api/mooc/exams?courseId=${courseId}`, MOOC_SYNC_TIMEOUT_MS);
        } catch (e) {
          // 学期缓存刚被 /works 写好，这里失败不应拖垮作业；记一条提示即可。
          exams = { items: [], error: e };
        }
        return { works, exams };
      }));

      for (let i = 0; i < settled.length; i += 1) {
        const result = settled[i];
        const course = batch[i];
        if (result.status === 'rejected') {
          const e = result.reason;
          if (isMoocSessionError(e && e.code)) return recordSyncFailure(model, user, e, '还没绑定中国大学MOOC，绑定后会自动同步作业和测验');
          errors.push(`${course.name || course.courseId}：${(e && e.message) || '同步失败'}`);
          continue;
        }
        const courseName = course.name || '';
        const { works, exams } = result.value;
        for (const entry of [...(works.items || []), ...(exams.items || [])]) {
          const item = moocTestToTodo(entry, entry.courseName || courseName, now, nowMs);
          if (!item) { stats.skipped += 1; stats.no_deadline += 1; continue; }
          countResult(stats, await syncSourceItem(model, user, item));
        }
        if (exams.error) {
          errors.push(`${courseName || course.courseId} 测验：${exams.error.message || '同步失败'}`);
        }
      }
    }

    const processed = Math.min(cursor + batch.length, total);
    const done = processed >= total;
    let message = '';
    if (done) {
      const parts = [];
      if (stats.created) parts.push(`新增 ${stats.created} 条`);
      if (stats.updated) parts.push(`更新 ${stats.updated} 条`);
      if (stats.completed) parts.push(`完成 ${stats.completed} 条`);
      if (stats.no_deadline) parts.push(`${stats.no_deadline} 条没有截止时间，未加入`);
      message = parts.join('，') || '已是最新';
      if (errors.length) message += `；${errors.length} 项暂时失败`;
      await model.finishSync(user.id, { result: 'ok', message, syncedAt: now });
    }

    return jsonResponse(success({
      bound: true,
      done,
      next_cursor: processed,
      total_courses: total,
      processed,
      created: stats.created,
      updated: stats.updated,
      completed: stats.completed,
      skipped: stats.skipped,
      no_deadline: stats.no_deadline,
      errors: errors.slice(0, 5),
      message,
      truncated: courses.length > MOOC_SYNC_MAX_COURSES
    }));
  } catch (e) {
    console.error('同步中国大学MOOC待办失败:', e);
    return jsonResponse(error('同步中国大学MOOC待办失败，请稍后重试', 'SYNC_MOOC_FAILED'), 500);
  }
}

/**
 * POST /api/todos/:id/hide body {hidden:true|false}
 * 只允许本人把「已完成 / 已超时」的学业待办收进隐藏视图；手动待办不提供隐藏。
 */
export async function handleHideTodo(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('待办不存在', 'INVALID_ID'), 400);

    const body = await request.json().catch(() => ({}));
    const hidden = body.hidden === true || body.hidden === 1;

    const model = new TodoModel(env.DB);
    const row = await model.findById(id);
    if (!row) return jsonResponse(error('待办不存在', 'TODO_NOT_FOUND'), 404);
    if (Number(row.owner_id) !== Number(user.id)) {
      return jsonResponse(error('只能操作自己的待办', 'FORBIDDEN'), 403);
    }
    if (row.source !== 'academic') {
      return jsonResponse(error('只有学习通同步的待办可以隐藏', 'TODO_NOT_HIDEABLE'), 400);
    }
    if (row.status !== 'done' && row.status !== 'expired') {
      return jsonResponse(error('只有已完成的待办可以隐藏', 'TODO_NOT_HISTORY'), 400);
    }

    await model.setHidden(id, hidden);
    return jsonResponse(success({ message: hidden ? '已隐藏' : '已取消隐藏', hidden }));
  } catch (e) {
    console.error('隐藏待办失败:', e);
    return jsonResponse(error('操作失败，请稍后重试', 'HIDE_TODO_FAILED'), 500);
  }
}
