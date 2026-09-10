/**
 * 通知数据模型
 * 表结构：notices (id, title, content, publish_time, publisher, remind_people, source, created_at)
 */
export class NoticeModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 创建通知
   */
  async create(data) {
    const { title, content, publish_time, publisher, remind_people = null, source = 'manual', expire_time = null } = data;
    const result = await this.db.prepare(
      `INSERT INTO notices (title, content, publish_time, publisher, remind_people, source, expire_time)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(title, content, publish_time, publisher, remind_people, source, expire_time).run();
    return result;
  }

  /**
   * 获取通知列表（按发布时间倒序，过滤已过期的通知）
   * @param {number} limit
   * @param {number} offset
   * @param {string} [date] 可选，按发布日期过滤（格式 YYYY-MM-DD）
   */
  async list(limit = 50, offset = 0, date = null) {
    const hasDate = date ? date.length > 0 : false;
    const sql = hasDate
      ? `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, created_at
         FROM notices
         WHERE (expire_time IS NULL OR expire_time > datetime('now', '+8 hours'))
           AND substr(publish_time, 1, 10) = ?
         ORDER BY publish_time DESC
         LIMIT ? OFFSET ?`
      : `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, created_at
         FROM notices
         WHERE expire_time IS NULL OR expire_time > datetime('now', '+8 hours')
         ORDER BY publish_time DESC
         LIMIT ? OFFSET ?`;
    const result = await this.db.prepare(sql).bind(...(hasDate ? [date, limit, offset] : [limit, offset])).all();
    return result.results;
  }

  /**
   * 获取全部通知（含已过期，供管理员归档查看，按发布时间倒序）
   */
  async listAll(limit = 50, offset = 0) {
    const result = await this.db.prepare(
      `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, created_at
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
      `SELECT id, title, content, publish_time, publisher, remind_people, source, expire_time, created_at
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
