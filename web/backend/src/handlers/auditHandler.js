import { AuditLogModel } from '../models/auditLogModel.js';
import { error, jsonResponse, success } from '../utils/response.js';

/** 动作码清单：前端用它渲染筛选下拉框，新增动作时只改这一处（与 README 表格同步） */
export const AUDIT_ACTIONS = [
  'password_reset',
  'email_changed',
  'member_updated',
  'member_deleted',
  'role_created',
  'role_updated',
  'role_deleted',
  'settings_updated'
];

const PAGE_SIZE_DEFAULT = 50;
const PAGE_SIZE_MAX = 200;

/**
 * 管理操作日志查询（需 user:manage 权限）。
 *
 * 查询参数：
 *   action  动作码（精确）
 *   actor   操作者 id 或姓名片段
 *   from/to 日期 YYYY-MM-DD（含当天）
 *   page    页码，从 1 开始
 *   limit   每页条数，默认 50，上限 200
 *
 * 只读接口：日志一旦写入就不提供修改/删除入口 —— 审计记录能改就等于没有审计。
 * 保留期清理由 AuditLogModel.purge() 在写日志时顺手完成。
 */
export async function handleListAuditLogs(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = clampInt(url.searchParams.get('limit'), PAGE_SIZE_DEFAULT, 1, PAGE_SIZE_MAX);
    const page = clampInt(url.searchParams.get('page'), 1, 1, 100000);
    const actionParam = (url.searchParams.get('action') || '').trim();
    const action = AUDIT_ACTIONS.includes(actionParam) ? actionParam : '';
    const actor = (url.searchParams.get('actor') || '').trim().slice(0, 40);
    const from = normalizeDay(url.searchParams.get('from'));
    const to = normalizeDay(url.searchParams.get('to'));

    const model = new AuditLogModel(env.DB);
    const { list, total } = await model.list({
      limit,
      offset: (page - 1) * limit,
      action,
      actor,
      from,
      to
    });

    return jsonResponse(success({
      list,
      total,
      page,
      page_size: limit,
      actions: AUDIT_ACTIONS
    }));
  } catch (e) {
    console.error('查询审计日志失败:', e);
    return jsonResponse(error('查询操作日志失败，请稍后重试', 'LIST_AUDIT_LOGS_FAILED'), 500);
  }
}

/** 只接受 YYYY-MM-DD：其它形状当没传，避免把用户输入直接拼进 SQL 参数做字符串比较 */
function normalizeDay(value) {
  const text = String(value || '').trim();
  return /^\d{4}-\d{2}-\d{2}$/.test(text) ? text : '';
}

function clampInt(value, fallback, min, max) {
  const n = parseInt(value, 10);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(Math.max(n, min), max);
}
