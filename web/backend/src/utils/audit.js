/**
 * 审计日志写入的统一入口。
 *
 * 调用点只该关心「谁、对谁、做了什么」；落库细节（IP/UA 提取、detail 白名单、
 * 180 天懒清理、写失败不阻断主流程）全部收在 AuditLogModel 里。
 * 这里单独包一层而不是在每个 handler 里 new 模型，是为了：
 *   1) 调用点只多一行，不会把 handler 写成一堆样板；
 *   2) 以后换存储（比如加一张 outbox 或发到外部日志）只改这里；
 *   3) 统一「先做主操作、成功后再记」的调用位置，避免出现「记了但没删」的假记录。
 */
import { AuditLogModel } from '../models/auditLogModel.js';

export function recordAudit(env, request, actor, action, targetType, targetId, detail) {
  return new AuditLogModel(env.DB).record({
    actor,
    action,
    targetType,
    targetId,
    detail,
    request
  });
}
