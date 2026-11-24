import { formatLocalDateTime } from '../utils/datetime.js';

/**
 * 待办数据模型（issue #99）
 *
 * 表结构见 db/schema.sql / db/migrations-v2/0007_todos.sql：
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

  /**
   * 首页/页签要的计数：进行中、可见历史数、其中可见超时数、已隐藏数。
   * 隐藏只作用于历史（学习通完成的作业可以收起来），所以进行中永远不扣。
   */
  async counts(ownerId) {
    const result = await this.db.prepare(
      `SELECT status, count(*) AS n,
              sum(CASE WHEN hidden = 1 THEN 1 ELSE 0 END) AS hidden
       FROM todos WHERE owner_id = ? GROUP BY status`
    ).bind(ownerId).all();
    const byStatus = { open: 0, done: 0, expired: 0 };
    const hiddenByStatus = { open: 0, done: 0, expired: 0 };
    for (const row of result.results || []) {
      if (!(row.status in byStatus)) continue;
      byStatus[row.status] = row.n;
      hiddenByStatus[row.status] = row.hidden || 0;
    }
    return {
      open: byStatus.open,
      history: byStatus.done + byStatus.expired - hiddenByStatus.done - hiddenByStatus.expired,
      overdue: byStatus.expired - hiddenByStatus.expired,
      hidden: hiddenByStatus.done + hiddenByStatus.expired
    };
  }

  /**
   * 取一页待办。
   * @param {{ownerId:number, status?:'open'|'history', tag?:string|null, hidden?:boolean,
   *          limit?:number, offset?:number}} options
   */
  async list({ ownerId, status = 'open', tag = null, hidden = false, limit = 50, offset = 0 }) {
    const where = ['t.owner_id = ?'];
    const args = [ownerId];
    if (status === 'history') {
      where.push("t.status IN ('done','expired')");
      // 隐藏只是历史页的一个视图：默认看不到，hidden=1 时只看被收起来的那些。
      where.push(hidden ? 't.hidden = 1' : 't.hidden = 0');
    } else {
      where.push("t.status = 'open'");
    }
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
              t.tags, t.source, t.source_id, t.external_id, t.hidden, t.created_by,
              t.completed_at, t.created_at, u.name AS created_by_name
       FROM todos t LEFT JOIN users u ON u.id = t.created_by
       WHERE ${whereSql} ${order} LIMIT ? OFFSET ?`
    ).bind(...args, limit, offset).all();
    return { list: result.results, total: totalRow ? totalRow.n : 0 };
  }

  async findById(id) {
    return this.db.prepare(
      `SELECT t.id, t.owner_id, t.title, t.description, t.start_at, t.due_at, t.status,
              t.tags, t.source, t.source_id, t.external_id, t.hidden, t.created_by,
              t.completed_at, t.created_at, u.name AS created_by_name
       FROM todos t LEFT JOIN users u ON u.id = t.created_by
       WHERE t.id = ?`
    ).bind(id).first();
  }

  async create(data) {
    const {
      owner_id, title, description = null, start_at = null, due_at,
      tags = null, source = 'manual', source_id = null, external_id = null, created_by = null
    } = data;
    // 学习通同步可能补建「已经截止但一直没交」的作业：直接落成 expired，进历史而不是进行中。
    const status = data.status === 'expired' ? 'expired' : 'open';
    const row = await this.db.prepare(
      `INSERT INTO todos (owner_id, title, description, start_at, due_at, tags, source, source_id, external_id, created_by, status)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(owner_id, title, description, start_at, due_at, tags, source, source_id, external_id, created_by, status).first();
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

  // ===== 学习通外部来源（作业 / 考试自动加入）=====

  /** 按 external_id 找本人已有的那条学业待办（`work:<id>` / `exam:<id>`）。 */
  async findExternal(ownerId, externalId) {
    return this.db.prepare(
      `SELECT id, status, hidden, title, description, start_at, due_at
       FROM todos WHERE owner_id = ? AND external_id = ?`
    ).bind(ownerId, externalId).first();
  }

  /** 外部来源仍在进行中时刷新文案与时间；用户手动改过的也能被覆盖，保证与学习通一致。 */
  async refreshExternal(id, { title, description, start_at, due_at }) {
    return this.db.prepare(
      `UPDATE todos SET title = ?, description = ?, start_at = ?, due_at = ?,
              updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status = 'open'`
    ).bind(title, description, start_at, due_at, id).run();
  }

  /** 学习通显示作业已交 / 考试已考：把本地进行中或已超时的待办并进历史。 */
  async completeExternal(id, now = formatLocalDateTime()) {
    return this.db.prepare(
      `UPDATE todos SET status = 'done', completed_at = ?, updated_at = CURRENT_TIMESTAMP
       WHERE id = ? AND status IN ('open','expired')`
    ).bind(now, id).run();
  }

  /** 隐藏 / 取消隐藏（只对历史学业待办开放，校验在 handler）。 */
  async setHidden(id, hidden) {
    return this.db.prepare(
      'UPDATE todos SET hidden = ?, updated_at = CURRENT_TIMESTAMP WHERE id = ?'
    ).bind(hidden ? 1 : 0, id).run();
  }

  // ===== 学习通同步状态 =====

  async getSyncState(ownerId) {
    return this.db.prepare(
      `SELECT last_synced_at, last_attempt_at, last_result, last_message
       FROM todo_sync_state WHERE owner_id = ?`
    ).bind(ownerId).first();
  }

  /** 每轮同步开头写一次尝试时间：手动按钮的 60 秒降温按这个字段续算。 */
  async markSyncAttempt(ownerId, now = formatLocalDateTime()) {
    return this.db.prepare(
      `INSERT INTO todo_sync_state (owner_id, last_attempt_at)
       VALUES (?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         last_attempt_at = excluded.last_attempt_at,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(ownerId, now).run();
  }

  /** 整轮结束后落结果；syncedAt 为空表示失败，保留上一次成功时间。 */
  async finishSync(ownerId, { result, message = null, syncedAt = null }) {
    return this.db.prepare(
      `INSERT INTO todo_sync_state (owner_id, last_synced_at, last_result, last_message)
       VALUES (?, ?, ?, ?)
       ON CONFLICT(owner_id) DO UPDATE SET
         last_synced_at = COALESCE(excluded.last_synced_at, todo_sync_state.last_synced_at),
         last_result = excluded.last_result,
         last_message = excluded.last_message,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(ownerId, syncedAt, result, message).run();
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

  // ===== 到期 Web Push 提醒（P1-4）=====

  /**
   * 到点提醒设置：开关 + 提前量（分钟）。
   * 没写过记录时默认关闭、提前 60 分钟——服务端只在用户显式打开后才登记投递。
   */
  async getReminderPrefs(userId) {
    const row = await this.db.prepare(
      'SELECT enabled, lead_minutes FROM todo_reminder_prefs WHERE user_id = ?'
    ).bind(userId).first();
    return row
      ? { enabled: Number(row.enabled) === 1, lead_minutes: Number(row.lead_minutes) }
      : { enabled: false, lead_minutes: 60 };
  }

  async setReminderPrefs(userId, { enabled, leadMinutes }) {
    return this.db.prepare(
      `INSERT INTO todo_reminder_prefs (user_id, enabled, lead_minutes)
       VALUES (?, ?, ?)
       ON CONFLICT(user_id) DO UPDATE SET
         enabled = excluded.enabled,
         lead_minutes = excluded.lead_minutes,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(userId, enabled ? 1 : 0, leadMinutes).run();
  }
}
