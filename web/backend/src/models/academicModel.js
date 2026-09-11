import { openCookies } from '../utils/cookieVault.js';

/** 验证码尝试次数上限：超过即作废 token，需重新走学号密码登录 */
export const MFA_MAX_ATTEMPTS = 5;

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

  /** 仅更新 Cookie 密文（明文旧记录读出后回写时用） */
  async saveCookies(userId, cookies) {
    return this.db.prepare(
      `UPDATE academic_bindings SET cookies = ?, checked_at = CURRENT_TIMESTAMP WHERE user_id = ?`
    ).bind(cookies, userId).run();
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
      `INSERT INTO academic_mfa_sessions (token, user_id, state, attempts, created_at)
       VALUES (?, ?, ?, 0, CURRENT_TIMESTAMP)
       ON CONFLICT(token) DO UPDATE SET
         user_id = excluded.user_id,
         state = excluded.state,
         attempts = 0,
         created_at = CURRENT_TIMESTAMP`
    ).bind(token, userId, state).run();
  }

  /**
   * 取中间态：只认本人的、未过期、未超尝试上限的；过期/超限即删并返回 null。
   * state 解不开（密钥缺失/密文损坏）按「会话无效」处理，删掉并返回 null，
   * 不把内部异常直接抛成 500。
   */
  async getMfaSession(userId, token, ttlMs, env) {
    const row = await this.db.prepare(
      `SELECT state, attempts, created_at FROM academic_mfa_sessions WHERE token = ? AND user_id = ?`
    ).bind(token, userId).first();
    if (!row) return null;

    const expired = (() => {
      const created = Date.parse(String(row.created_at).replace(' ', 'T') + 'Z');
      return !created || Date.now() - created > ttlMs;
    })();
    if (expired || (row.attempts || 0) >= MFA_MAX_ATTEMPTS) {
      await this.deleteMfaSession(token);
      return null;
    }
    try {
      const raw = await openCookies(env, row.state);
      return JSON.parse(raw);
    } catch {
      // 密文损坏或密钥轮换后解不开：中间态已无意义，清掉让用户重新登录
      await this.deleteMfaSession(token);
      return null;
    }
  }

  /** 验证码每错一次记一笔，超上限后 getMfaSession 直接作废 */
  async bumpMfaAttempts(token) {
    return this.db.prepare(
      `UPDATE academic_mfa_sessions SET attempts = attempts + 1 WHERE token = ?`
    ).bind(token).run();
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
