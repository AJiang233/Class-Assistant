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
   * 按邮箱查找用户（绑定查重、找回密码都用它）
   * 邮箱统一小写存储（handlers/authHandler.js 的 normalizeEmail），所以这里按传入值精确匹配，
   * 不再做 LOWER() —— 用 LOWER() 会让 idx_users_email 那个表达式索引用不上。
   */
  async findByEmail(email) {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions, email, email_verified FROM users WHERE email = ?'
    ).bind(email).first();
    return result;
  }

  /**
   * 根据 ID 查找用户（不含密码等敏感字段）
   *
   * password_changed_at 一并取出：middleware 的 loadFreshUser 要用它比对 JWT 里的 iat，
   * 判断这个令牌是不是在改密之前签发的。它是时间戳不是凭据，且对外响应走 publicUser 白名单，
   * 不会因此漏出去。
   */
  async findById(id) {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions, contact, email, email_verified, password_changed_at FROM users WHERE id = ?'
    ).bind(id).first();
    return result;
  }

  /**
   * 获取全部班级成员（不含敏感字段）
   * 注意 handleListUsers 是整行展开（{ ...u }）下发的，这里选了什么字段就等于对外发了什么，
   * 所以 update_time 从下面拿掉了，免得绕过 publicUser 从成员列表漏出去。
   * email 是**故意**留着的：班长要能看到谁还没验证邮箱，才好去催。
   * password_changed_at 不放这里 —— 成员列表没有它的消费点。
   */
  async list() {
    const result = await this.db.prepare(
      'SELECT id, student_id, name, positions, contact, email, email_verified FROM users ORDER BY id ASC'
    ).all();
    return result.results;
  }

  /**
   * 获取成员精简列表（id/name/positions，供提醒对象选择器按职位一键选择使用）
   */
  async listPicks() {
    const result = await this.db.prepare(
      'SELECT id, name, positions FROM users ORDER BY name ASC'
    ).all();
    return result.results;
  }

  /**
   * 根据 ID 删除用户
   *
   * 连带清掉邮箱验证码与订阅开关：D1 里没建外键（现有表也都没用外键），只能靠代码收。
   * 漏了 email_codes 会留下无主验证码；真正麻烦的是 users.email 的唯一索引 ——
   * 残留的订阅行本身不影响它，但把「删除成员必须清干净」这条口径定在模型里，
   * 就不会有人在别处新增一张 user 附属表时忘了收尾。
   */
  async delete(id) {
    await this.db.prepare('DELETE FROM email_codes WHERE user_id = ?').bind(id).run();
    await this.db.prepare('DELETE FROM email_subscriptions WHERE user_id = ?').bind(id).run();
    const result = await this.db.prepare(
      'DELETE FROM users WHERE id = ?'
    ).bind(id).run();
    return result;
  }

  /**
   * 创建用户
   *
   * email 由管理员在「添加成员」里代填（选填）。**email_verified 一律写 0**：管理员填的地址
   * 没有走过验证码，不能替那位同学把邮箱「验证」了 —— 否则找回密码的凭据就由管理员说了算。
   * 这里显式写 0 而不吃列的默认值：这是一条需求，不是可以依赖的实现细节。
   */
  async create(userData) {
    const { student_id, name, password_hash, positions = '学生', contact = '', email = null } = userData;
    const result = await this.db.prepare(
      `INSERT INTO users (student_id, name, password_hash, positions, contact, email, email_verified, update_time)
       VALUES (?, ?, ?, ?, ?, ?, 0, CURRENT_TIMESTAMP)`
    ).bind(student_id, name, password_hash, positions, contact, email).run();
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
    if (data.email !== undefined) { fields.push('email = ?'); values.push(data.email); }
    if (data.email_verified !== undefined) { fields.push('email_verified = ?'); values.push(data.email_verified); }
    if (data.password_changed_at !== undefined) { fields.push('password_changed_at = ?'); values.push(data.password_changed_at); }

    if (fields.length === 0) return { success: true };

    fields.push('update_time = CURRENT_TIMESTAMP');
    values.push(id);

    const result = await this.db.prepare(
      `UPDATE users SET ${fields.join(', ')} WHERE id = ?`
    ).bind(...values).run();

    return result;
  }
}
