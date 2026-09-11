/**
 * 活动数据模型
 * 表结构：activities (id, title, content, location, start_time, end_time, publisher, remind_people, created_at)
 */
export class ActivityModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 创建活动
   */
  async create(data) {
    const { title, content = '', location = '', start_time, end_time = '', publisher, remind_people = null } = data;
    const result = await this.db.prepare(
      `INSERT INTO activities (title, content, location, start_time, end_time, publisher, remind_people)
       VALUES (?, ?, ?, ?, ?, ?, ?)`
    ).bind(title, content, location, start_time, end_time, publisher, remind_people).run();
    return result;
  }

  /**
   * 获取「当前生效」的活动列表（按开始时间倒序）
   * 时间窗口：[start_time, end_time]（按天，两端都含）；end_time 为空则视为只有开始当天
   * 与通知同一套口径：窗口覆盖某天，该天就显示（不传 date 时以「今天」为目标日）
   * @param {number} limit
   * @param {number} offset
   * @param {string} [date] 可选，目标日期 YYYY-MM-DD；返回时间窗口覆盖该日的活动
   */
  async list(limit = 50, offset = 0, date = null) {
    const day = date ? '?' : "substr(datetime('now', '+8 hours'), 1, 10)";
    const sql = `SELECT id, title, content, location, start_time, end_time, publisher, remind_people, created_at
         FROM activities
         WHERE substr(start_time, 1, 10) <= ${day}
           AND max(substr(start_time, 1, 10), substr(coalesce(nullif(end_time, ''), start_time), 1, 10)) >= ${day}
         ORDER BY start_time DESC
         LIMIT ? OFFSET ?`;
    const args = date ? [date, date, limit, offset] : [limit, offset];
    const result = await this.db.prepare(sql).bind(...args).all();
    return result.results;
  }

  /**
   * 获取全部活动（含已结束/未来的，供「全部活动」归档视图，按开始时间倒序）
   */
  async listAll(limit = 50, offset = 0) {
    const result = await this.db.prepare(
      `SELECT id, title, content, location, start_time, end_time, publisher, remind_people, created_at
       FROM activities
       ORDER BY start_time DESC
       LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    return result.results;
  }

  /**
   * 根据 ID 获取活动
   */
  async findById(id) {
    const result = await this.db.prepare(
      `SELECT id, title, content, location, start_time, end_time, publisher, remind_people, created_at
       FROM activities WHERE id = ?`
    ).bind(id).first();
    return result;
  }

  /**
   * 更新活动（只更新传入的字段）
   */
  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
    if (data.content !== undefined) { fields.push('content = ?'); values.push(data.content); }
    if (data.location !== undefined) { fields.push('location = ?'); values.push(data.location); }
    if (data.start_time !== undefined) { fields.push('start_time = ?'); values.push(data.start_time); }
    if (data.end_time !== undefined) { fields.push('end_time = ?'); values.push(data.end_time); }
    if (data.publisher !== undefined) { fields.push('publisher = ?'); values.push(data.publisher); }
    if (data.remind_people !== undefined) { fields.push('remind_people = ?'); values.push(data.remind_people); }

    if (fields.length === 0) return { success: true };

    values.push(id);
    const result = await this.db.prepare(
      `UPDATE activities SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
    return result;
  }

  /**
   * 删除活动
   */
  async delete(id) {
    const result = await this.db.prepare(
      'DELETE FROM activities WHERE id = ?'
    ).bind(id).run();
    return result;
  }
}
