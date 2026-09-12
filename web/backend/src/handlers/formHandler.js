/**
 * 表单：班委下发、同学填写、导出、未交名单。
 *
 * 学号与姓名一律由服务端从登录态注入（见 handleSubmitForm），
 * 请求体里若带同名字段会被忽略 —— 前端 readonly 挡不住伪造请求。
 */
import { FormModel, EDIT_POLICY } from '../models/formModel.js';
import { UserModel } from '../models/userModel.js';
import { NoticeModel } from '../models/noticeModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { toLocalDateTime, parseLocalDateTime } from '../utils/datetime.js';
import { pageLimit, pageOffset } from '../utils/query.js';

const FIELD_TYPES = ['text', 'textarea', 'radio', 'checkbox', 'number', 'date'];
const EDIT_POLICIES = Object.values(EDIT_POLICY);
const MAX_FIELDS = 50;
const MAX_OPTIONS = 50;
const MAX_LABEL_LEN = 50;
const MAX_VALUE_LEN = 2000;
const MAX_ANSWERS_LEN = 32 * 1024;
const MAX_TITLE_LEN = 100;
const MAX_DESC_LEN = 1000;

// ===== 通用工具 =====

function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 解析字段定义 JSON；坏数据返回空数组 */
export function parseFields(raw) {
  const arr = parseJson(raw, []);
  return Array.isArray(arr) ? arr : [];
}

/** 服务端补「当前本地时间」字符串，与 SQL 里的 datetime('now','+8 hours') 同一口径 */
function nowLocalDateTime() {
  const d = new Date(Date.now() + 8 * 3600 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getUTCFullYear()}-${p(d.getUTCMonth() + 1)}-${p(d.getUTCDate())} ` +
    `${p(d.getUTCHours())}:${p(d.getUTCMinutes())}:${p(d.getUTCSeconds())}`;
}

/** 应交名单：remind_people 为空 = 全班；与首页 remindMe() 同一口径（按姓名，也接受存 id） */
function parseRemindNames(raw) {
  if (!raw) return [];
  const parsed = parseJson(String(raw), null);
  if (Array.isArray(parsed)) return parsed.map((x) => String(x).trim()).filter(Boolean);
  return String(raw).split(',').map((x) => x.trim()).filter(Boolean);
}

function inMyRemindList(raw, user) {
  const names = parseRemindNames(raw);
  if (!names.length) return true;
  return names.includes(String(user.name)) || names.includes(String(user.id));
}

function rosterFor(users, raw) {
  const names = parseRemindNames(raw);
  if (!names.length) return users;
  return users.filter((u) => names.includes(String(u.name)) || names.includes(String(u.id)));
}

/** 是否已过截止时间（只看 deadline，供列表判断「还能不能填」） */
function isPastDeadline(form, now = Date.now()) {
  if (!form.deadline) return false;
  const ms = parseLocalDateTime(form.deadline);
  return ms != null && ms < now;
}

/** 是否还能提交/覆盖 */
function submitGate(form, hasSubmitted, now = Date.now()) {
  if (form.status !== 'open') {
    return { ok: false, message: '表单已关闭', code: 'FORM_CLOSED' };
  }
  if (isPastDeadline(form, now)) {
    return { ok: false, message: '表单已过截止时间', code: 'FORM_CLOSED' };
  }
  if (hasSubmitted && form.edit_policy === EDIT_POLICY.NONE) {
    return { ok: false, message: '该表单提交后不可修改', code: 'FORM_LOCKED' };
  }
  return { ok: true };
}

function publicForm(form) {
  return {
    id: form.id,
    title: form.title,
    description: form.description,
    fields: parseFields(form.fields),
    edit_policy: form.edit_policy,
    anonymous: !!form.anonymous,
    status: form.status,
    deadline: form.deadline,
    creator_name: form.creator_name,
    created_at: form.created_at
  };
}

/** 取表单并校验调用者是创建者；不满足时返回可直接回给前端的 failure */
async function loadOwnedForm(env, user, rawId) {
  const id = parseInt(rawId);
  if (!id) return { failure: { message: '无效的表单ID', code: 'INVALID_ID', status: 400 } };

  const model = new FormModel(env.DB);
  const form = await model.findById(id);
  if (!form) return { failure: { message: '表单不存在', code: 'FORM_NOT_FOUND', status: 404 } };
  if (form.creator_id !== user.id) {
    return { failure: { message: '只能管理自己创建的表单', code: 'FORBIDDEN', status: 403 } };
  }
  return { form, model };
}

// ===== 字段与答案校验（只在服务端生效） =====

/** 校验并规范化字段定义 */
export function normalizeFields(raw) {
  if (!Array.isArray(raw) || raw.length === 0) {
    return { ok: false, message: '表单至少需要一个字段', code: 'INVALID_FIELDS' };
  }
  if (raw.length > MAX_FIELDS) {
    return { ok: false, message: `字段数不能超过 ${MAX_FIELDS} 个`, code: 'INVALID_FIELDS' };
  }

  const out = [];
  const seen = new Set();
  for (const item of raw) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) {
      return { ok: false, message: '字段定义格式不正确', code: 'INVALID_FIELDS' };
    }
    const key = String(item.key == null ? '' : item.key).trim();
    const label = String(item.label == null ? '' : item.label).trim();
    const type = String(item.type == null ? 'text' : item.type);

    if (!/^[A-Za-z][A-Za-z0-9_]{0,29}$/.test(key)) {
      return { ok: false, message: '字段标识需以字母开头，只含字母数字下划线，最长 30 位', code: 'INVALID_FIELDS' };
    }
    if (seen.has(key)) {
      return { ok: false, message: `字段标识重复：${key}`, code: 'INVALID_FIELDS' };
    }
    seen.add(key);
    if (!label) return { ok: false, message: '字段名称不能为空', code: 'INVALID_FIELDS' };
    if (label.length > MAX_LABEL_LEN) {
      return { ok: false, message: `字段名称最多 ${MAX_LABEL_LEN} 个字符`, code: 'INVALID_FIELDS' };
    }
    if (!FIELD_TYPES.includes(type)) {
      return { ok: false, message: `不支持的字段类型：${type}`, code: 'INVALID_FIELDS' };
    }

    const field = { key, label, type, required: !!item.required };
    if (type === 'radio' || type === 'checkbox') {
      const options = Array.isArray(item.options)
        ? item.options.map((o) => String(o).trim()).filter(Boolean)
        : [];
      if (options.length < 2) {
        return { ok: false, message: `字段「${label}」的选项至少要有 2 个`, code: 'INVALID_FIELDS' };
      }
      if (options.length > MAX_OPTIONS) {
        return { ok: false, message: `字段「${label}」的选项不能超过 ${MAX_OPTIONS} 个`, code: 'INVALID_FIELDS' };
      }
      field.options = options;
    }
    if (item.placeholder) field.placeholder = String(item.placeholder).slice(0, 100);
    out.push(field);
  }
  return { ok: true, fields: out };
}

/** 单个字段取值规范化 */
function normalizeValue(field, value) {
  if (field.type === 'checkbox') {
    const arr = Array.isArray(value) ? value : (value == null || value === '' ? [] : [value]);
    const list = [];
    for (const item of arr) {
      const s = String(item);
      if (!field.options.includes(s)) {
        return { ok: false, message: `字段「${field.label}」的选项不合法`, code: 'INVALID_ANSWERS' };
      }
      if (!list.includes(s)) list.push(s);
    }
    return { ok: true, value: list };
  }

  const s = value == null ? '' : String(value).trim();

  if (field.type === 'radio') {
    if (s && !field.options.includes(s)) {
      return { ok: false, message: `字段「${field.label}」的选项不合法`, code: 'INVALID_ANSWERS' };
    }
    return { ok: true, value: s };
  }
  if (field.type === 'number') {
    if (s && !/^-?\d+(\.\d+)?$/.test(s)) {
      return { ok: false, message: `字段「${field.label}」必须是数字`, code: 'INVALID_ANSWERS' };
    }
    return { ok: true, value: s };
  }
  if (field.type === 'date') {
    if (s && !/^\d{4}-\d{2}-\d{2}$/.test(s)) {
      return { ok: false, message: `字段「${field.label}」日期格式应为 YYYY-MM-DD`, code: 'INVALID_ANSWERS' };
    }
    return { ok: true, value: s };
  }
  if (s.length > MAX_VALUE_LEN) {
    return { ok: false, message: `字段「${field.label}」最多 ${MAX_VALUE_LEN} 个字符`, code: 'INVALID_ANSWERS' };
  }
  return { ok: true, value: s };
}

/** 校验整套答案：只保留定义内的字段，忽略多余键 */
export function validateAnswers(fields, raw) {
  if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
    return { ok: false, message: '答案格式不正确', code: 'INVALID_ANSWERS' };
  }

  const answers = {};
  for (const field of fields) {
    const r = normalizeValue(field, raw[field.key]);
    if (!r.ok) return r;
    const empty = Array.isArray(r.value) ? r.value.length === 0 : r.value === '';
    if (field.required && empty) {
      return { ok: false, message: `请填写「${field.label}」`, code: 'INVALID_ANSWERS' };
    }
    answers[field.key] = r.value;
  }

  if (JSON.stringify(answers).length > MAX_ANSWERS_LEN) {
    return { ok: false, message: '答案总长度超出上限', code: 'INVALID_ANSWERS' };
  }
  return { ok: true, answers };
}

// ===== 导出 =====

function answerText(value) {
  if (Array.isArray(value)) return value.join('、');
  if (value == null) return '';
  if (typeof value === 'object') return JSON.stringify(value);
  return String(value);
}

/** CSV 单元格：中和公式注入 + 标准转义 */
export function csvCell(value) {
  let s = value == null ? '' : String(value);
  // Excel 会把 = + - @ 开头的单元格当公式执行，导出的是全班学号姓名，必须先中和
  if (/^[=+\-@]/.test(s)) s = "'" + s;
  if (/[",\r\n]/.test(s)) s = '"' + s.replace(/"/g, '""') + '"';
  return s;
}

export function buildCsv(header, rows) {
  const lines = [header.map(csvCell).join(',')];
  for (const row of rows) lines.push(row.map(csvCell).join(','));
  return lines.join('\r\n');
}

// ===== 表单管理（content:write） =====

/**
 * 创建表单；body.notice 为真时同时下发一条通知，link 指向填写页。
 * D1 没有事务：通知写失败就把刚建的表单删掉，不留半成品。
 */
export async function handleCreateForm(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));

    const title = String(body.title == null ? '' : body.title).trim();
    if (!title) return jsonResponse(error('请填写表单标题', 'MISSING_FIELDS'), 400);
    if (title.length > MAX_TITLE_LEN) {
      return jsonResponse(error(`表单标题最多 ${MAX_TITLE_LEN} 个字符`, 'INVALID_TITLE'), 400);
    }

    const nf = normalizeFields(body.fields);
    if (!nf.ok) return jsonResponse(error(nf.message, nf.code), 400);

    const editPolicy = EDIT_POLICIES.includes(body.edit_policy)
      ? body.edit_policy : EDIT_POLICY.BEFORE_DEADLINE;

    let deadline = null;
    if (body.deadline) {
      deadline = toLocalDateTime(body.deadline);
      if (!deadline) return jsonResponse(error('截止时间格式不正确', 'INVALID_DEADLINE'), 400);
    }

    const remind = normalizeRemind(body.remind_people);
    if (remind === false) return jsonResponse(error('提交对象格式不正确', 'INVALID_REMIND'), 400);

    const model = new FormModel(env.DB);
    const formId = await model.create({
      title,
      description: body.description == null ? null : String(body.description).trim().slice(0, MAX_DESC_LEN),
      fields: JSON.stringify(nf.fields),
      edit_policy: editPolicy,
      anonymous: body.anonymous ? 1 : 0,
      deadline,
      creator_id: user.id,
      creator_name: user.name,
      remind_people: remind
    });
    if (!formId) return jsonResponse(error('创建表单失败', 'CREATE_FORM_FAILED'), 500);

    if (body.notice) {
      try {
        const noticeModel = new NoticeModel(env.DB);
        const noticeId = await noticeModel.create({
          title: String(body.notice_title || title).trim().slice(0, MAX_TITLE_LEN) || title,
          content: String(body.notice_content == null ? '' : body.notice_content).trim().slice(0, MAX_DESC_LEN)
            || `请填写表单《${title}》`,
          publish_time: toLocalDateTime(body.notice_publish_time) || nowLocalDateTime(),
          publisher: user.name,
          remind_people: remind,
          expire_time: toLocalDateTime(body.notice_expire_time),
          link: `/forms.html?id=${formId}`
        });
        if (noticeId) await model.update(formId, { notice_id: noticeId });
      } catch (e) {
        console.error('表单下发通知失败，回滚表单:', e);
        await model.remove(formId);
        return jsonResponse(error('下发通知失败，表单未创建', 'NOTICE_LINK_FAILED'), 500);
      }
    }

    return jsonResponse(success({ message: '表单已创建', id: formId }), 201);
  } catch (e) {
    console.error('创建表单失败:', e);
    return jsonResponse(error('创建表单失败，请稍后重试', 'CREATE_FORM_FAILED'), 500);
  }
}

/** 表单列表（班委管理面板） */
export async function handleListForms(request, env, user) {
  try {
    const url = new URL(request.url);
    const model = new FormModel(env.DB);
    const list = await model.listAll(pageLimit(url), pageOffset(url));
    return jsonResponse(success({ list, total: list.length }));
  } catch (e) {
    console.error('获取表单列表失败:', e);
    return jsonResponse(error('获取表单列表失败', 'LIST_FORMS_FAILED'), 500);
  }
}

/** 我的表单：待填 + 已填可修改（首页待办 / 填写页） */
export async function handleListMyForms(request, env, user) {
  try {
    const model = new FormModel(env.DB);
    const rows = await model.listMine(user.id);
    const now = Date.now();

    const pending = [];
    const editable = [];
    for (const row of rows) {
      if (!inMyRemindList(row.remind_people, user)) continue;
      // 已过截止的表单不再算待办：填不了，列出来只会误导（仍可通过链接打开看到已截止）
      if (isPastDeadline(row, now)) continue;
      const submitted = !!row.my_submitted_at;
      const item = {
        id: row.id,
        title: row.title,
        deadline: row.deadline,
        creator_name: row.creator_name,
        anonymous: !!row.anonymous,
        submitted_at: row.my_submitted_at || null
      };
      if (!submitted) pending.push(item);
      else if (row.edit_policy !== EDIT_POLICY.NONE) editable.push(item);
    }

    return jsonResponse(success({ pending, editable }));
  } catch (e) {
    console.error('获取我的表单失败:', e);
    return jsonResponse(error('获取我的表单失败', 'LIST_MY_FORMS_FAILED'), 500);
  }
}

/** 表单详情 + 我的提交 */
export async function handleGetForm(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('无效的表单ID', 'INVALID_ID'), 400);

    const model = new FormModel(env.DB);
    const form = await model.findById(id);
    if (!form) return jsonResponse(error('表单不存在', 'FORM_NOT_FOUND'), 404);

    const mine = await model.findMySubmission(id, user.id);
    const gate = submitGate(form, !!mine);

    return jsonResponse(success({
      form: publicForm(form),
      mySubmission: mine
        ? { answers: parseJson(mine.answers, {}), created_at: mine.created_at, updated_at: mine.updated_at }
        : null,
      canSubmit: gate.ok,
      submitBlockedReason: gate.ok ? '' : gate.message,
      isCreator: form.creator_id === user.id
    }));
  } catch (e) {
    console.error('获取表单失败:', e);
    return jsonResponse(error('获取表单失败', 'GET_FORM_FAILED'), 500);
  }
}

/** 更新表单（只能改自己的；已有人提交后锁字段，避免旧答案的 key 悬空） */
export async function handleUpdateForm(request, env, user, params) {
  try {
    const owned = await loadOwnedForm(env, user, params.id);
    if (owned.failure) {
      return jsonResponse(error(owned.failure.message, owned.failure.code), owned.failure.status);
    }
    const { form, model } = owned;
    const body = await request.json().catch(() => ({}));
    const data = {};

    if (body.title !== undefined) {
      const title = String(body.title).trim();
      if (!title) return jsonResponse(error('请填写表单标题', 'MISSING_FIELDS'), 400);
      if (title.length > MAX_TITLE_LEN) {
        return jsonResponse(error(`表单标题最多 ${MAX_TITLE_LEN} 个字符`, 'INVALID_TITLE'), 400);
      }
      data.title = title;
    }
    if (body.description !== undefined) {
      data.description = String(body.description || '').trim().slice(0, MAX_DESC_LEN);
    }
    if (body.edit_policy !== undefined) {
      if (!EDIT_POLICIES.includes(body.edit_policy)) {
        return jsonResponse(error('修改策略不合法', 'INVALID_EDIT_POLICY'), 400);
      }
      data.edit_policy = body.edit_policy;
    }
    if (body.anonymous !== undefined) data.anonymous = body.anonymous ? 1 : 0;
    if (body.status !== undefined) {
      if (!['open', 'closed'].includes(body.status)) {
        return jsonResponse(error('表单状态不合法', 'INVALID_STATUS'), 400);
      }
      data.status = body.status;
    }
    if (body.deadline !== undefined) {
      const d = toLocalDateTime(body.deadline);
      if (body.deadline && !d) {
        return jsonResponse(error('截止时间格式不正确', 'INVALID_DEADLINE'), 400);
      }
      data.deadline = d;
    }
    if (body.remind_people !== undefined) {
      const r = normalizeRemind(body.remind_people);
      if (r === false) return jsonResponse(error('提交对象格式不正确', 'INVALID_REMIND'), 400);
      data.remind_people = r;
    }
    if (body.fields !== undefined) {
      const submitted = await model.listSubmittedUserIds(form.id);
      if (submitted.length > 0) {
        return jsonResponse(
          error('已有同学提交，不能再修改字段（标题、说明、截止时间可改）', 'FORM_FIELDS_LOCKED'),
          409
        );
      }
      const nf = normalizeFields(body.fields);
      if (!nf.ok) return jsonResponse(error(nf.message, nf.code), 400);
      data.fields = JSON.stringify(nf.fields);
    }

    await model.update(form.id, data);
    return jsonResponse(success({ message: '表单已更新' }));
  } catch (e) {
    console.error('更新表单失败:', e);
    return jsonResponse(error('更新表单失败', 'UPDATE_FORM_FAILED'), 500);
  }
}

/** 删除表单（连同提交） */
export async function handleDeleteForm(request, env, user, params) {
  try {
    const owned = await loadOwnedForm(env, user, params.id);
    if (owned.failure) {
      return jsonResponse(error(owned.failure.message, owned.failure.code), owned.failure.status);
    }
    await owned.model.remove(owned.form.id);
    return jsonResponse(success({ message: '表单已删除' }));
  } catch (e) {
    console.error('删除表单失败:', e);
    return jsonResponse(error('删除表单失败', 'DELETE_FORM_FAILED'), 500);
  }
}

/** 提交明细（含学号姓名；匿名表单不返回这两列） */
export async function handleListSubmissions(request, env, user, params) {
  try {
    const owned = await loadOwnedForm(env, user, params.id);
    if (owned.failure) {
      return jsonResponse(error(owned.failure.message, owned.failure.code), owned.failure.status);
    }
    const { form, model } = owned;
    const rows = await model.listSubmissions(form.id, !!form.anonymous);

    const list = rows.map((r) => {
      const item = {
        id: r.id,
        answers: parseJson(r.answers, {}),
        created_at: r.created_at,
        updated_at: r.updated_at
      };
      if (!form.anonymous) {
        item.student_id = r.student_id || '';
        item.name = r.name || '';
      }
      return item;
    });

    return jsonResponse(success({ list, anonymous: !!form.anonymous, total: list.length }));
  } catch (e) {
    console.error('获取提交明细失败:', e);
    return jsonResponse(error('获取提交明细失败', 'LIST_SUBMISSIONS_FAILED'), 500);
  }
}

/** 已交 / 未交名单（催交用） */
export async function handleFormProgress(request, env, user, params) {
  try {
    const owned = await loadOwnedForm(env, user, params.id);
    if (owned.failure) {
      return jsonResponse(error(owned.failure.message, owned.failure.code), owned.failure.status);
    }
    const { form, model } = owned;

    const userModel = new UserModel(env.DB);
    const roster = rosterFor(await userModel.list(), form.remind_people);
    const submittedIds = new Set(await model.listSubmittedUserIds(form.id));

    const pending = roster.filter((u) => !submittedIds.has(u.id));
    return jsonResponse(success({
      total: roster.length,
      submitted: roster.length - pending.length,
      pending: pending.map((u) => ({ id: u.id, student_id: u.student_id, name: u.name })),
      pendingText: pending.map((u) => u.name).join('、')
    }));
  } catch (e) {
    console.error('获取提交进度失败:', e);
    return jsonResponse(error('获取提交进度失败', 'FORM_PROGRESS_FAILED'), 500);
  }
}

/** 导出 CSV（带 UTF-8 BOM，Excel 直接打开不乱码） */
export async function handleExportForm(request, env, user, params) {
  try {
    const owned = await loadOwnedForm(env, user, params.id);
    if (owned.failure) {
      return jsonResponse(error(owned.failure.message, owned.failure.code), owned.failure.status);
    }
    const { form, model } = owned;
    const anonymous = !!form.anonymous;
    const fields = parseFields(form.fields);
    const rows = await model.listSubmissions(form.id, anonymous);

    const header = anonymous ? ['提交时间'] : ['学号', '姓名', '提交时间'];
    for (const f of fields) header.push(f.label);

    const body = rows.map((r) => {
      const answers = parseJson(r.answers, {});
      const line = anonymous ? [r.created_at] : [r.student_id || '', r.name || '', r.created_at];
      for (const f of fields) line.push(answerText(answers[f.key]));
      return line;
    });

    return new Response('\uFEFF' + buildCsv(header, body), {
      status: 200,
      headers: {
        'Content-Type': 'text/csv; charset=utf-8',
        'Content-Disposition': `attachment; filename="form-${form.id}.csv"`
      }
    });
  } catch (e) {
    console.error('导出表单失败:', e);
    return jsonResponse(error('导出表单失败', 'EXPORT_FORM_FAILED'), 500);
  }
}

/** 提交 / 覆盖提交（学号姓名取登录态） */
export async function handleSubmitForm(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) return jsonResponse(error('无效的表单ID', 'INVALID_ID'), 400);

    const model = new FormModel(env.DB);
    const form = await model.findById(id);
    if (!form) return jsonResponse(error('表单不存在', 'FORM_NOT_FOUND'), 404);

    const mine = await model.findMySubmission(id, user.id);
    const gate = submitGate(form, !!mine);
    if (!gate.ok) return jsonResponse(error(gate.message, gate.code), 409);

    const body = await request.json().catch(() => ({}));
    const va = validateAnswers(parseFields(form.fields), body.answers);
    if (!va.ok) return jsonResponse(error(va.message, va.code), 400);

    // 学号姓名一律取服务端登录态，请求体里的同名字段一概忽略
    await model.submit(id, user.id, user.student_id, user.name, JSON.stringify(va.answers));

    return jsonResponse(success({ message: mine ? '已更新提交' : '提交成功' }));
  } catch (e) {
    console.error('提交表单失败:', e);
    return jsonResponse(error('提交表单失败', 'SUBMIT_FORM_FAILED'), 500);
  }
}

/** 提交对象：数组 / JSON 数组字符串 / 逗号分隔；空 = 全班 */
function normalizeRemind(raw) {
  if (raw === undefined || raw === null || raw === '') return null;

  let list;
  if (Array.isArray(raw)) {
    list = raw;
  } else if (typeof raw === 'string') {
    const s = raw.trim();
    if (!s) return null;
    if (s.charAt(0) === '[') {
      const parsed = parseJson(s, null);
      if (!Array.isArray(parsed)) return false;
      list = parsed;
    } else {
      list = s.split(',');
    }
  } else {
    return false;
  }

  const names = list.map((x) => String(x).trim()).filter(Boolean);
  return names.length ? JSON.stringify(names) : null;
}
