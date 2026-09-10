/**
 * 教务数据模型
 * 表结构：
 *   academic_bindings  (user_id, student_no, real_name, school_uid, cookies, status, bound_at, checked_at)
 *   academic_timetable (user_id, xnxq_id, payload, fetched_at)  主键 (user_id, xnxq_id)
 *   academic_credits   (user_id, payload, fetched_at)
 */
export class AcademicModel {
  constructor(db) {
    this.db = db;
  }

  // ===== 绑定关系 =====

  /** 取本人绑定信息（未绑定返回 null） */
  async getBinding(userId) {
    return this.db.prepare(
      `SELECT user_id, student_no, real_name, school_uid, cookies, status, bound_at, checked_at
       FROM academic_bindings WHERE user_id = ?`
    ).bind(userId).first();
  }

  /** 新建或覆盖绑定（重新绑定即刷新 Cookie 与身份） */
  async saveBinding(userId, data) {
    const { student_no = null, real_name = null, school_uid = null, cookies } = data;
    return this.db.prepare(
      `INSERT INTO academic_bindings (user_id, student_no, real_name, school_uid, cookies, status, bound_at, checked_at)
       VALUES (?, ?, ?, ?, ?, 'ok', CURRENT_TIMESTAMP, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         student_no = excluded.student_no,
         real_name  = excluded.real_name,
         school_uid = excluded.school_uid,
         cookies    = excluded.cookies,
         status     = 'ok',
         bound_at   = CURRENT_TIMESTAMP,
         checked_at = CURRENT_TIMESTAMP`
    ).bind(userId, student_no, real_name, school_uid, cookies).run();
  }

  /** 标记为已失效（教务登录态过期，需要重新绑定） */
  async markExpired(userId) {
    return this.db.prepare(
      `UPDATE academic_bindings SET status = 'expired' WHERE user_id = ?`
    ).bind(userId).run();
  }

  /** 校验成功：刷新 checked_at，并把状态掰回 ok */
  async touchBinding(userId) {
    return this.db.prepare(
      `UPDATE academic_bindings SET status = 'ok', checked_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    ).bind(userId).run();
  }

  /** 解绑并清空该用户的教务缓存 */
  async removeBinding(userId) {
    await this.db.prepare('DELETE FROM academic_bindings WHERE user_id = ?').bind(userId).run();
    await this.clearCache(userId);
  }

  // ===== 课表缓存 =====

  async getTimetable(userId, xnxqId) {
    return this.db.prepare(
      `SELECT payload, fetched_at FROM academic_timetable WHERE user_id = ? AND xnxq_id = ?`
    ).bind(userId, xnxqId).first();
  }

  /** 已缓存的学期列表（教务不可用时，界面仍能列出可选学期） */
  async listTimetableTerms(userId) {
    const result = await this.db.prepare(
      `SELECT xnxq_id, fetched_at FROM academic_timetable WHERE user_id = ? ORDER BY xnxq_id DESC`
    ).bind(userId).all();
    return result.results;
  }

  async saveTimetable(userId, xnxqId, payload) {
    return this.db.prepare(
      `INSERT INTO academic_timetable (user_id, xnxq_id, payload, fetched_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id, xnxq_id) DO UPDATE SET
         payload = excluded.payload,
         fetched_at = CURRENT_TIMESTAMP`
    ).bind(userId, xnxqId, payload).run();
  }

  // ===== 学业达成（学分）缓存 =====

  async getCredits(userId) {
    return this.db.prepare(
      `SELECT payload, fetched_at FROM academic_credits WHERE user_id = ?`
    ).bind(userId).first();
  }

  async saveCredits(userId, payload) {
    return this.db.prepare(
      `INSERT INTO academic_credits (user_id, payload, fetched_at)
       VALUES (?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         payload = excluded.payload,
         fetched_at = CURRENT_TIMESTAMP`
    ).bind(userId, payload).run();
  }

  // ===== 多因子认证中间态 =====

  /** 覆盖写入中间态（state 里只有 Cookie 罐与 reAuthParams，不含密码） */
  async saveMfaSession(userId, token, state) {
    return this.db.prepare(
      `INSERT INTO academic_mfa_sessions (token, user_id, state, created_at)
       VALUES (?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         state = excluded.state,
         created_at = CURRENT_TIMESTAMP`
    ).bind(token, userId, state).run();
  }

  /** 取中间态：只认本人的、且未过期的；过期即删并返回 null */
  async getMfaSession(userId, token, ttlMs) {
    const row = await this.db.prepare(
      `SELECT state, created_at FROM academic_mfa_sessions WHERE token = ? AND user_id = ?`
    ).bind(token, userId).first();
    if (!row) return null;

    const created = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
    if (!created || Date.now() - created > ttlMs) {
      await this.deleteMfaSession(token);
      return null;
    }
    return JSON.parse(row.state);
  }

  async deleteMfaSession(token) {
    return this.db.prepare('DELETE FROM academic_mfa_sessions WHERE token = ?').bind(token).run();
  }

  /** 顺手清掉过期中间态，避免表里堆垃圾 */
  async purgeExpiredMfaSessions(ttlMs) {
    return this.db.prepare(
      `DELETE FROM academic_mfa_sessions WHERE created_at < datetime('now', ?)`
    ).bind(`-${Math.floor(ttlMs / 1000)} seconds`).run();
  }

  // ===== 缓存清理 =====

  async clearCache(userId) {
    await this.db.prepare('DELETE FROM academic_timetable WHERE user_id = ?').bind(userId).run();
    await this.db.prepare('DELETE FROM academic_credits WHERE user_id = ?').bind(userId).run();
    await this.db.prepare('DELETE FROM academic_mfa_sessions WHERE user_id = ?').bind(userId).run();
  }
}
