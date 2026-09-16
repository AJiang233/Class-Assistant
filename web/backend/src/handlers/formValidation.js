/**
 * 表单的纯校验：字段定义、答案、提交闸门。
 *
 * 这个模块**不碰数据库** —— 只有 formHandler.js 里的 handle* 才做 IO。拆出来是 issue #22：
 * 原先这三件事和 CRUD、通知联动、CSV 导出挤在同一个 700 多行的文件里，改一处得先
 * 确认改的不是另外几处。凡是不需要 await 的表单判断都该落在这里。
 */
import { EDIT_POLICY } from '../models/formModel.js';
import { parseLocalDateTime } from '../utils/datetime.js';

const FIELD_TYPES = ['text', 'textarea', 'radio', 'checkbox', 'number', 'date'];
const MAX_FIELDS = 50;
const MAX_OPTIONS = 50;
const MAX_LABEL_LEN = 50;
const MAX_VALUE_LEN = 2000;
const MAX_ANSWERS_LEN = 32 * 1024;

/** 解析字段定义 JSON；坏数据返回空数组 */
export function parseFields(raw) {
  const arr = parseJson(raw, []);
  return Array.isArray(arr) ? arr : [];
}

export function parseJson(raw, fallback) {
  try {
    const v = JSON.parse(raw);
    return v == null ? fallback : v;
  } catch {
    return fallback;
  }
}

/** 是否已过截止时间（只看 deadline，供列表判断「还能不能填」） */
export function isPastDeadline(form, now = Date.now()) {
  if (!form.deadline) return false;
  const ms = parseLocalDateTime(form.deadline);
  return ms != null && ms < now;
}

/** 是否还能提交/覆盖。导出是为了让测试盯住「always 过截止也放行」这条口径 */
export function submitGate(form, hasSubmitted, now = Date.now()) {
  if (form.status !== 'open') {
    return { ok: false, message: '表单已关闭，如需补交请联系发布人', code: 'FORM_CLOSED' };
  }
  // 「随时可修改」不受截止时间约束：名单上的人过多久都能补交或改答案。
  // 必须与 handleListMyForms 的过滤同一口径，否则会「列表里列出来了却点不动」。
  if (form.edit_policy !== EDIT_POLICY.ALWAYS && isPastDeadline(form, now)) {
    return { ok: false, message: '表单已过截止时间，如需补交请联系发布人', code: 'FORM_CLOSED' };
  }
  if (hasSubmitted && form.edit_policy === EDIT_POLICY.NONE) {
    return { ok: false, message: '这条表单提交后不能再编辑', code: 'FORM_LOCKED' };
  }
  return { ok: true };
}

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
      return { ok: false, message: '字段标识只能以英文字母开头，只含英文字母、数字和下划线，最长 30 位', code: 'INVALID_FIELDS' };
    }
    if (seen.has(key)) {
      return { ok: false, message: '字段标识重复了，请换一个', code: 'INVALID_FIELDS' };
    }
    seen.add(key);
    if (!label) return { ok: false, message: '字段名称不能为空', code: 'INVALID_FIELDS' };
    if (label.length > MAX_LABEL_LEN) {
      return { ok: false, message: `字段名称最多 ${MAX_LABEL_LEN} 个字符`, code: 'INVALID_FIELDS' };
    }
    if (!FIELD_TYPES.includes(type)) {
      return { ok: false, message: '不支持这种字段类型', code: 'INVALID_FIELDS' };
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
      return { ok: false, message: `字段「${field.label}」的日期请按 2026-09-14 这样的格式填写`, code: 'INVALID_ANSWERS' };
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
    return { ok: false, message: `答案总长度超出上限（最多 ${MAX_VALUE_LEN} 个字符）`, code: 'INVALID_ANSWERS' };
  }
  return { ok: true, answers };
}
