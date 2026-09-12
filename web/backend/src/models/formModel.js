/**
 * 表单数据模型
 * 表结构：
 *   forms            (id, title, description, fields, edit_policy, anonymous, status, deadline,
 *                     creator_id, creator_name, remind_people, notice_id, created_at)
 *   form_submissions (id, form_id, user_id, student_id, name, answers, created_at, updated_at)
 */

/** 修改策略：不可改 / 截止前可改 / 随时可改 */
export const EDIT_POLICY = Object.freeze({
  NONE: 'none',
  BEFORE_DEADLINE: 'before_deadline',
  ALWAYS: 'always'
});

const FORM_COLUMNS = `id, title, description, fields, edit_policy, anonymous, status, deadline,
       creator_id, creator_name, remind_people, notice_id, created_at`;

export class FormModel {
  constructor(db) {
    this.db = db;
  }

  /** 建表单，返回新 id（联动下发通知时要回写 notice_id） */
  async create(data) {
    const {
      title, description = null, fields, edit_policy = EDIT_POLICY.BEFORE_DEADLINE,
      anonymous = 0, deadline = null, creator_id, creator_name, remind_people = null
    } = data;
    const row = await this.db.prepare(
      `INSERT INTO forms (title, description, fields, edit_policy, anonymous, deadline,
         creator_id, creator_name, remind_people)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
       RETURNING id`
    ).bind(title, description, fields, edit_policy, anonymous, deadline,
      creator_id, creator_name, remind_people).first();
    return row ? row.id : null;
  }

  async findById(id) {
    const result = await this.db.prepare(
      `SELECT ${FORM_COLUMNS} FROM forms WHERE id = ?`
    ).bind(id).first();
    return result;
  }

  /** 表单列表（班委管理面板），带提交数 */
  async listAll(limit = 50, offset = 0) {
    const result = await this.db.prepare(
      `SELECT ${FORM_COLUMNS},
         (SELECT COUNT(*) FROM form_submissions s WHERE s.form_id = forms.id) AS submission_count
       FROM forms ORDER BY created_at DESC LIMIT ? OFFSET ?`
    ).bind(limit, offset).all();
    return result.results;
  }

  /**
   * 我的表单（首页待办 / 填写页）：未关闭的表单 + 本人提交状态。
   * 是否算「待填」由 handler 结合 edit_policy 与截止时间判断。
   */
  async listMine(userId, limit = 100) {
    const result = await this.db.prepare(
      `SELECT f.id, f.title, f.description, f.edit_policy, f.anonymous, f.deadline,
              f.creator_name, f.remind_people, f.created_at,
              s.created_at AS my_submitted_at, s.updated_at AS my_updated_at
       FROM forms f
       LEFT JOIN form_submissions s ON s.form_id = f.id AND s.user_id = ?
       WHERE f.status = 'open'
       ORDER BY f.created_at DESC LIMIT ?`
    ).bind(userId, limit).all();
    return result.results;
  }

  /** 更新表单（只更新传入的字段） */
  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.title !== undefined) { fields.push('title = ?'); values.push(data.title); }
    if (data.description !== undefined) { fields.push('description = ?'); values.push(data.description); }
    if (data.fields !== undefined) { fields.push('fields = ?'); values.push(data.fields); }
    if (data.edit_policy !== undefined) { fields.push('edit_policy = ?'); values.push(data.edit_policy); }
    if (data.anonymous !== undefined) { fields.push('anonymous = ?'); values.push(data.anonymous); }
    if (data.status !== undefined) { fields.push('status = ?'); values.push(data.status); }
    if (data.deadline !== undefined) { fields.push('deadline = ?'); values.push(data.deadline); }
    if (data.remind_people !== undefined) { fields.push('remind_people = ?'); values.push(data.remind_people); }
    if (data.notice_id !== undefined) { fields.push('notice_id = ?'); values.push(data.notice_id); }

    if (fields.length === 0) return { success: true };

    values.push(id);
    return this.db.prepare(
      `UPDATE forms SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();
  }

  /** 删除表单（连带删除其提交） */
  async remove(id) {
    await this.db.prepare('DELETE FROM form_submissions WHERE form_id = ?').bind(id).run();
    return this.db.prepare('DELETE FROM forms WHERE id = ?').bind(id).run();
  }

  async findMySubmission(formId, userId) {
    const result = await this.db.prepare(
      `SELECT id, answers, created_at, updated_at
       FROM form_submissions WHERE form_id = ? AND user_id = ?`
    ).bind(formId, userId).first();
    return result;
  }

  /**
   * 提交 / 覆盖提交（每人每表一条）。
   * created_at 只在首次写入时产生，覆盖时保持不变，仅刷新 updated_at。
   */
  async submit(formId, userId, studentId, name, answers) {
    return this.db.prepare(
      `INSERT INTO form_submissions (form_id, user_id, student_id, name, answers, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(form_id, user_id) DO UPDATE SET
         student_id = excluded.student_id,
         name = excluded.name,
         answers = excluded.answers,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(formId, userId, studentId, name, answers).run();
  }

  /**
   * 提交明细。
   * 匿名表单不返回 student_id / name —— 脱敏只在这一处决定，
   * 避免导出与列表两条路径各写一遍导致漏改。
   */
  async listSubmissions(formId, anonymous) {
    const cols = anonymous
      ? 'id, answers, created_at, updated_at'
      : 'id, student_id, name, answers, created_at, updated_at';
    const result = await this.db.prepare(
      `SELECT ${cols} FROM form_submissions WHERE form_id = ? ORDER BY created_at ASC`
    ).bind(formId).all();
    return result.results;
  }

  /** 已提交的 user_id 集合（用于算未交名单；匿名表单同样需要，这是弱匿名的固有边界） */
  async listSubmittedUserIds(formId) {
    const result = await this.db.prepare(
      'SELECT user_id FROM form_submissions WHERE form_id = ?'
    ).bind(formId).all();
    return result.results.map((r) => r.user_id);
  }
}
