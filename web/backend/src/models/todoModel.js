import { formatLocalDateTime } from '../utils/datetime.js';

/**
 * 待办数据模型（issue #99）
 *
 * 表结构见 schema.sql / migrations-v2/0007_todos.sql：
 *   todos         个人待办（owner_id 是「谁的待办」，created_by 是「谁加的」）
 *   content_todos 通知/活动随发布附带的待办模板
 *   todo_prefs    每人的红/黄阈值
 *
 * 时间列是北京时间字符串（YYYY-MM-DD HH:mm:ss）。超时不靠定时任务，读取前先
 * expireOverdue() 把已过截止时间的 open 待办改成 expired —— 这是全站唯一的超时判定点，
 * 别在其它查询里另写一份。
 */
export class TodoModel {
  constructor(db) {
    this.db = db;
  }

  /** 把本人已过截止时间的待办标记为超时（幂等，读取前调用）。 */
  async expireOverdue(ownerId, now = formatLocalDateTime()) {
    return this.db.prepare(
      `UPDATE todos SET status = 'expired', updated_at = CURRENT_TIMESTAMP
       WHERE owner_id = ? AND status = 'open' AND due_at < ?`
    ).bind(ownerId, now).run();
  }

  /** 首页/页签要的三个计数：进行中、历史总数、其中超时数。 */
  async counts(ownerId) {
    const result = await this.db.prepare(
      'SELECT status, count(*) AS n FROM todos WHERE owner_id = ? GROUP BY status'
    ).bind(ownerId).all();
    const byStatus = { open: 0, done: 0, expired: 0 };
    for (const row of result.results || []) byStatus[row.status] = row.n;
    return {
      open: byStatus.open,
      history: byStatus.done + byStatus.expired,
      overdue: byStatus.expired
    };
  }

  /**
   * 取一页待办。
   * @param {{ownerId:number, status?:'open'|'history', tag?:string|null, limit?:number, offset?:number}} options
   */
  async list({ ownerId, status = 'open', tag = null, limit = 50, offset = 0 }) {
    const where = ['t.owner_id = ?'];
    const args = [ownerId];
    if (status === 'history') where.push("t.status IN ('done','expired')");
    else where.push("t.status = 'open'");
    if (tag) {
      // tags 存 JSON 数组；坏数据按空数组处理，不让一条脏行把整个列表查挂
      where.push(`EXISTS (
        SELECT 1 FROM json_each(CASE WHEN json_valid(t.tags) THEN t.tags ELSE '[]' END)
        WHERE json_each.value = ?
      )`);
      args.push(tag);
    }
    const whereSql = where.join(' AND ');
    const totalRow = await this.db.prepare(
      `SELECT count(*) AS n FROM todos t WHERE ${whereSql}`
    ).bind(...args).first();
    const order = status === 'history'
      ? 'ORDER BY COALESCE(t.completed_at, t.due_at) DESC, t.id DESC'
      : 'ORDER BY t.due_at ASC, t.id ASC';
    const result = await this.db.prepare(
      `SELECT t.id, t.owner_id, t.title, t.description, t.start_at, t.due_at, t.status,
              t.tags, t.source, t.source_id, t.created_by, t.completed_at, t.created_at,
              u.name AS created_by_name
       FROM todos t LEFT JOIN users u ON u.id = t.created_by
       WHERE ${whereSql} ${order} LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset).all();
    return { list: result.results, total: totalRow ? totalRow.n : 0 };
  }

  async findById(id) {
    return this.db.prepare(
      `SELECT t.id, t.owner_id, t.title, t.description, t.start_at, t.due_at, t.status,
              t.tags, t.source, t.source_id, t.created_by, t.completed_at, t.created_at,
              u.name AS created_by_name
       FROM todos t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = ?`
    ).bind(id).first();
  }

  async create(data) {
    const {
      owner_id, title, description = null, start_at = null, due_at,
      tags = null, source = 'manual', source_id = null, created_by = null
    } = data;
    const row = await this.db.prepare(
      `INSERT INTO todos (owner_id, title, description, start_at, due_at, tags, source, source_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(owner_id, title, description, start_at, due_at, tags, source, source_id, created_by).first();
    return row ? row.id : null;
  }

  /** 班委代加：一人一条，批量写入。返回实际写入条数。 */
  async createMany(ownerIds, data) {
    const statements = ownerIds.map((ownerId) => this.db.prepare(
      `INSERT INTO todos (owner_id, title, description, start_at, due_at, tags, source, source_id, created_by)
       VALUES (?, ?, ?, ?, ?, ?, 'manual', NULL, ?)`
    ).bind(ownerId, data.title, data.description || null, data.start_at || null,
      data.due_at, data.tags || null, data.created_by));
    if (!statements.length) return 0;
    const results = await this.db.batch(statements);
    return results.length;
  }

  /** 只更新传入的字段（归属校验在 handler 里做）。 */
  async update(id, data) {
    const fields = [];
    const values = [];
    for (const key of ['title', 'description', 'start_at', 'due_at', 'tags']) {
      if (data[key] !== undefined) {
        fields.push(`${key} = ?`);
        values.push(data[key]);
      }
    }
    if (!fields.length) return { meta: { changes: 0 } };
    fields.push('updated_at = CURRENT_TIMESTAMP');
    values.push(id);
    return this.db.prepare(`UPDATE todos SET ${fields.join(', ')} WHERE id = ?`).bind(...values).run();
  }

  /** 完成 / 重新打开：status 与 completed_at 必须一起变，别分两次写。 */
  async setStatus(id, status, now = formatLocalDateTime()) {
    if (status === 'done') {
      return this.db.prepare(
        "UPDATE todos SET status = 'done', completed_at = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
      ).bind(now, id).run();
    }
    return this.db.prepare(
      "UPDATE todos SET status = 'open', completed_at = NULL, updated_at = CURRENT_TIMESTAMP WHERE id = ?"
    ).bind(id).run();
  }

  async remove(id) {
    return this.db.prepare('DELETE FROM todos WHERE id = ?').bind(id).run();
  }

  /** 本人是否已从某个通知/活动加入过待办。 */
  async hasFromSource(ownerId, source, sourceId) {
    const row = await this.db.prepare(
      'SELECT id FROM todos WHERE owner_id = ? AND source = ? AND source_id = ?'
    ).bind(ownerId, source, sourceId).first();
    return !!row;
  }

  /**
   * 从通知/活动模板生成一条个人待办快照。
   * 返回新 id；已存在（唯一索引兜底）时返回 null。
   */
  async addFromSource({ ownerId, source, sourceId, title, dueAt, tags = null }) {
    try {
      const row = await this.db.prepare(
        `INSERT INTO todos (owner_id, title, description, due_at, tags, source, source_id, created_by)
         VALUES (?, ?, NULL, ?, ?, ?, ?, NULL)
         RETURNING id`
      ).bind(ownerId, title, dueAt, tags, source, sourceId).first();
      return row ? row.id : null;
    } catch (e) {
      if (/UNIQUE/i.test(String(e && e.message))) return null;
      throw e;
    }
  }

  // ===== 通知/活动附带的待办模板 =====

  async getContentTodo(kind, itemId) {
    return this.db.prepare(
      'SELECT kind, item_id, title, due_at, tags FROM content_todos WHERE kind = ? AND item_id = ?'
    ).bind(kind, itemId).first();
  }

  /** 发布时写入模板；编辑通知/活动时不动它（本期不提供单独编辑入口）。 */
  async setContentTodo(kind, itemId, { title, dueAt, tags = null }) {
    return this.db.prepare(
      `INSERT INTO content_todos (kind, item_id, title, due_at, tags)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(kind, item_id) DO UPDATE SET
         title = excluded.title, due_at = excluded.due_at, tags = excluded.tags`
    ).bind(kind, itemId, title, dueAt, tags).run();
  }

  // ===== 每人阈值（决策 2.A）=====

  async getPrefs(userId) {
    const row = await this.db.prepare(
      'SELECT urgent_hours, warn_hours FROM todo_prefs WHERE user_id = ?'
    ).bind(userId).first();
    return row
      ? { urgent_hours: row.urgent_hours, warn_hours: row.warn_hours }
      : { urgent_hours: 24, warn_hours: 36 };
  }

  async setPrefs(userId, { urgentHours, warnHours }) {
    return this.db.prepare(
      `INSERT INTO todo_prefs (user_id, urgent_hours, warn_hours)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         urgent_hours = excluded.urgent_hours,
         warn_hours = excluded.warn_hours,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(userId, urgentHours, warnHours).run();
  }
}
