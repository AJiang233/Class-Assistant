/**
 * 用户数据模型
 * 表结构：users (id, student_id, name, password_hash, auth_key, positions, contact, update_time)
 */
export class UserModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 根据学号查找用户（登录/注册查重用，含密码字段）
   */
  async findByStudentId(studentId) {
    const result = await this.db.prepare(
      'SELECT * FROM users WHERE student_id = ?'
    ).bind(studentId).first();
    return result;
  }

  /**
   * 按日历订阅密钥查找用户
   * 系统日历拉取订阅源时无法携带 Authorization 头，只能用 URL 里的密钥鉴权
   */
  async findByAuthKey(authKey) {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions FROM users WHERE auth_key = ?'
    ).bind(authKey).first();
    return result;
  }

  /**
   * 读取用户的日历订阅密钥
   */
  async getAuthKey(id) {
    const result = await this.db.prepare(
      'SELECT auth_key FROM users WHERE id = ?'
    ).bind(id).first();
    return result ? result.auth_key : null;
  }

  /**
   * 保存日历订阅密钥
   */
  async setAuthKey(id, authKey) {
    const result = await this.db.prepare(
      'UPDATE users SET auth_key = ? WHERE id = ?'
    ).bind(authKey, id).run();
    return result;
  }

  /**
   * 根据 ID 查找用户（不含敏感字段）
   */
  async findById(id) {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions, contact, token_version, update_time FROM users WHERE id = ?'
    ).bind(id).first();
    return result;
  }

  /**
   * 获取全部班级成员（不含敏感字段）
   */
  async list() {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions, contact, update_time FROM users ORDER BY id ASC'
    ).all();
    return result.results;
  }

  /**
   * 获取成员精简列表（仅 id/name，供提醒对象选择器等使用）
   */
  async listPicks() {
    const result = await this.db.prepare(
      'SELECT id, name FROM users ORDER BY name ASC'
    ).all();
    return result.results;
  }

  /**
   * 根据 ID 删除用户
   */
  async delete(id) {
    const result = await this.db.prepare(
      'DELETE FROM users WHERE id = ?'
    ).bind(id).run();
    return result;
  }

  /**
   * 创建用户
   */
  async create(userData) {
    const { student_id, name, password_hash, positions = '学生', contact = '' } = userData;
    const result = await this.db.prepare(
      `INSERT INTO users (student_id, name, password_hash, positions, contact, update_time)
       VALUES (?, ?, ?, ?, ?, CURRENT_TIMESTAMP)`
    ).bind(student_id, name, password_hash, positions, contact).run();
    return result;
  }

  /**
   * 更新用户信息（只更新传入的字段）
   */
  async update(id, data) {
    const fields = [];
    const values = [];

    if (data.name !== undefined) { fields.push('name = ?'); values.push(data.name); }
    if (data.positions !== undefined) { fields.push('positions = ?'); values.push(data.positions); }
    if (data.contact !== undefined) { fields.push('contact = ?'); values.push(data.contact); }
    if (data.password_hash !== undefined) { fields.push('password_hash = ?'); values.push(data.password_hash); }
    if (data.token_version !== undefined) { fields.push('token_version = ?'); values.push(data.token_version); }

    if (fields.length === 0) return { success: true };

    fields.push('update_time = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await this.db.prepare(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return result;
  }
}
