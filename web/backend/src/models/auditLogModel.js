/**
 * 管理员操作审计日志（issue #108）。
 *
 * 设计要点（也是这张表为什么长这样）：
 *   · 只记「管理员对被管理者」的敏感操作，不记普通业务读写 —— 日志的价值在于追溯权力使用，
 *     全量请求日志既贵又没必要（wrangler 那边本来就有）。
 *   · 不设外键、actor_name / target_id 都是快照：删成员之后记录必须还在，且还能看懂是谁。
 *   · detail 只放字段名、权限列表这类结构性信息；密码、邮箱、验证码的明文一律不落盘。
 *     这里是最后一道把关：调用方传什么我们控制不了，但可以在序列化前把敏感键剔掉。
 *   · 写日志失败只 console.error，绝不把主流程带崩 —— 管理员不该因为「日志表满了」而
 *     没法删掉一个垃圾账号。反过来也不吞掉真实错误：错误进日志，运维能看到。
 */

/** 保留天数：与 README「管理操作日志」一节、隐私政策口径一致 */
export const AUDIT_RETENTION_DAYS = 180;

/** detail 的序列化上限：正常一条只有几十字节，超长说明调用方塞错了东西，截断避免写入放大 */
const DETAIL_MAX_CHARS = 4000;

/** 会被写进 detail 的字段名白名单：除此之外的键一律丢弃（防止误传密码/邮箱明文） */
const DETAIL_ALLOWED_KEYS = new Set([
  'fields',
  'name',
  'student_id',
  'permissions',
  'action',
  'target',
  'changed'
]);

/** 敏感键：即便在 detail 里出现也直接剔除。与上面的白名单是双保险（白名单已经挡掉） */
const SENSITIVE_KEYS = new Set(['password', 'email', 'code', 'token', 'new_password']);

export class AuditLogModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 写一条日志。
   *
   * 返回值只用于测试断言「确实写进去了」；业务代码不需要看它 —— 失败已经被吞成 false。
   * 时间用数据库的 CURRENT_TIMESTAMP（UTC），与全库其它时间列同一口径。
   */
  async record({ actor, action, targetType = null, targetId = null, detail = null, request = null }) {
    try {
      if (!actor || !action) return false;
      const ip = request && request.headers ? (request.headers.get('CF-Connecting-IP') || null) : null;
      const userAgent = request && request.headers ? (request.headers.get('User-Agent') || null) : null;

      await this.db.prepare(
        `INSERT INTO audit_logs (actor_id, actor_name, action, target_type, target_id, detail, ip, user_agent)
         VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
      ).bind(
        Number(actor.id),
        String(actor.name || ''),
        String(action),
        targetType == null ? null : String(targetType),
        targetId == null ? null : String(targetId),
        serializeDetail(detail),
        ip,
        userAgent
      ).run();

      await this.purge();
      return true;
    } catch (e) {
      // 审计失败不能影响主流程：这里只留痕给运维，由调用方继续完成原本的操作
      console.error('写审计日志失败（不影响主流程）:', e && e.message);
      return false;
    }
  }

  /**
   * 分页查询。筛选条件全部可选：
   *   · action：精确匹配动作码；
   *   · actor：既接受操作者 id（纯数字），也接受姓名片段（LIKE）——管理页一个输入框两种用法；
   *   · from / to：按天筛选，to 由调用方补成当天 23:59:59 再进来。
   * 按 id 倒序而不是 created_at：同一秒内的多条记录也要有稳定顺序，id 自增天然满足。
   */
  async list({ limit = 50, offset = 0, action = '', actor = '', from = '', to = '' } = {}) {
    const where = [];
    const params = [];

    if (action) {
      where.push('action = ?');
      params.push(action);
    }
    if (actor) {
      const asId = Number(actor);
      if (Number.isInteger(asId) && asId > 0) {
        where.push('actor_id = ?');
        params.push(asId);
      } else {
        where.push('actor_name LIKE ?');
        params.push(`%${actor}%`);
      }
    }
    if (from) {
      where.push('created_at >= ?');
      params.push(`${from} 00:00:00`);
    }
    if (to) {
      where.push('created_at <= ?');
      params.push(`${to} 23:59:59`);
    }

    const whereSql = where.length ? ` WHERE ${where.join(' AND ')}` : '';
    const totalRow = await this.db.prepare(
      `SELECT count(*) AS n FROM audit_logs${whereSql}`
    ).bind(...params).first();
    const rows = await this.db.prepare(
      `SELECT id, actor_id, actor_name, action, target_type, target_id, detail, ip, user_agent, created_at
       FROM audit_logs${whereSql}
       ORDER BY id DESC
       LIMIT ? OFFSET ?`
    ).bind(...params, limit, offset).all();

    return {
      list: (rows.results || []).map((row) => ({ ...row, detail: parseDetail(row.detail) })),
      total: Number((totalRow && totalRow.n) || 0)
    };
  }

  /** 删除超过保留期的记录。每次写日志顺手调用一次，站点没有 Cron Trigger 也能自清理。 */
  async purge() {
    await this.db.prepare(
      `DELETE FROM audit_logs WHERE created_at < datetime('now', '-${AUDIT_RETENTION_DAYS} days')`
    ).run();
  }
}

/** 只有白名单键、且不是敏感键的字段才保留；JSON 化后超长则截断（截断后仍是合法 JSON 字符串） */
function serializeDetail(detail) {
  if (detail == null) return null;
  if (typeof detail !== 'object') return null;

  const clean = {};
  for (const [key, value] of Object.entries(detail)) {
    if (!DETAIL_ALLOWED_KEYS.has(key)) continue;
    if (SENSITIVE_KEYS.has(String(key).toLowerCase())) continue;
    clean[key] = value;
  }
  if (Object.keys(clean).length === 0) return null;

  let text;
  try {
    text = JSON.stringify(clean);
  } catch {
    return null;
  }
  return text.length > DETAIL_MAX_CHARS ? JSON.stringify({ truncated: true }) : text;
}

function parseDetail(raw) {
  if (!raw) return null;
  try {
    return JSON.parse(raw);
  } catch {
    // 历史脏数据不该让整页 500：原样回字符串，前端会按纯文本展示
    return raw;
  }
}
