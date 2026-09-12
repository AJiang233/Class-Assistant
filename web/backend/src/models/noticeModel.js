/**
 * 通知数据模型
 * 表结构：notices (id, title, content, publish_time, publisher, remind_people, source, created_at)
 */
export class NoticeModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 创建通知，返回新 id（表单联动下发时要回写 forms.notice_id）
   */
  async create(data) {
    const { title, content, publish_time, publisher, remind_people = null, source = 'manual', expire_time = null, link = null } = data;
    const row = await this.db.prepare(
      `INSERT INTO notices (title, content, publish_time, publisher, remind_people, source, expire_time, link)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(title, content, publish_time, publisher, remind_people, source, expire_time, link).first();
    return row ? row.id : null;
  }

  /**
   * 获取「当前生效」的通知列表（按发布时间倒序）
   * 生效窗口：[publish_time, expire_time]（按天，两端都含）；publish_time 为空则视为立即生效，expire_time 为空则视为永不失效
   * 与活动同一套口径：窗口覆盖某天，该天就显示（不传 date 时以「今天」为目标日）
   * @param {number} limit
   * @param {number} offset
   * @param {string} [date] 可选，目标日期 YYYY-MM-DD；返回生效窗口覆盖该日的通知
   */
  async list(limit = 50, offset = 0, date = null) {
    const day = date ? '?' : "substr(datetime('now', '+8 hours'), 1, 10)";
    const sql = `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, link, created_at
         FROM notices
         WHERE (publish_time IS NULL OR publish_time = '' OR substr(publish_time, 1, 10) <= ${day})
           AND (expire_time IS NULL OR expire_time = '' OR substr(expire_time, 1, 10) >= ${day})
         ORDER BY publish_time DESC
         LIMIT ? OFFSET ?`;
    const args = date ? [date, date, limit, offset] : [limit, offset];
    const result = await this.db.prepare(sql).bind(...args).all();
    return result.results;
  }

  /**
   * 获取全部通知（含已过期，供管理员归档查看，按发布时间倒序）
   */
  async listAll(limit = 50, offset = 0) {
    const result = await this.db.prepare(
      `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, link, created_at
       FROM notices
       ORDER BY publish_time DESC
       LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    return result.results;
  }

  /**
   * 根据 ID 获取通知
   */
  async findById(id) {
    const result = await this.db.prepare(
      `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, link, created_at
       FROM notices WHERE id = ?`
    ).bind(id).first();
    return result;
  }

  /**
   * 更新通知（只更新传入的字段）
   */
  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
    if (data.content !== undefined) { fields.push('content = ?'); values.push(data.content); }
    if (data.publish_time !== undefined) { fields.push('publish_time = ?'); values.push(data.publish_time); }
    if (data.publisher !== undefined) { fields.push('publisher = ?'); values.push(data.publisher); }
    if (data.remind_people !== undefined) { fields.push('remind_people = ?'); values.push(data.remind_people); }
    if (data.expire_time !== undefined) { fields.push('expire_time = ?'); values.push(data.expire_time); }
    if (data.link !== undefined) { fields.push('link = ?'); values.push(data.link); }

    if (fields.length === 0) return { success: true };

    values.push(id);
    const result = await this.db.prepare(
      `UPDATE notices SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    return result;
  }

  /**
   * 删除通知
   */
  async delete(id) {
    const result = await this.db.prepare(
      'DELETE FROM notices WHERE id = ?'
    ).bind(id).run();
    return result;
  }
}
