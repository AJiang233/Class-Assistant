/**
 * 邮箱验证码模型（绑定验证 + 找回密码共用一张表，靠 purpose 区分）。
 *
 * 三条不变量，动这个文件时别拆：
 *  1. **一码制**：发新码前删掉该用户同用途的旧码 —— 否则用户会拿到多个还能用的码，
 *     「用后即焚」也就不成立了（旧的没被焚）。
 *  2. **试错上限靠原子占坑**，不是「先读 attempts 判上限、验码失败再回来累加」：
 *     后者在读与写之间隔着一次验码，并发下上限会被轻松绕过（与教务 MFA 同一套写法）。
 *     占坑用 `UPDATE ... WHERE attempts < 5` 交给 D1 串行写入去筛选命中行。
 *  3. **时间是 UTC**（CURRENT_TIMESTAMP / datetime('now', ...)）。站内其它表存的是本地时间
 *     字符串，这里刻意不同：有效期与重发间隔全在 SQL 里算，不经后端时区转换。
 *     混用会让验证码立刻过期、或永不判过期（差 8 小时）。
 */
import {
  CODE_TTL_MINUTES,
  MAX_CODE_ATTEMPTS,
  RESEND_INTERVAL_SECONDS,
  genEmailCode
} from '../utils/email.js';

export class EmailCodeModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 发一个新码（一码制）。
   *
   * @returns {{ok:true, code:string} | {ok:false, reason:'TOO_SOON'}}
   *   TOO_SOON = RESEND_INTERVAL_SECONDS 内刚发过，前端提示「请稍后再试」
   */
  async issue(userId, email, purpose) {
    const recent = await this.db.prepare(
      `SELECT 1 FROM email_codes
       WHERE user_id = ? AND purpose = ? AND used_at IS NULL
         AND expires_at > datetime('now')
         AND created_at > datetime('now', '-${RESEND_INTERVAL_SECONDS} seconds')`
    ).bind(userId, purpose).first();
    if (recent) return { ok: false, reason: 'TOO_SOON' };

    // 先删旧码再插新码：顺序不能反，否则刚插进去的那条会被自己删掉
    await this.db.prepare(
      'DELETE FROM email_codes WHERE user_id = ? AND purpose = ?'
    ).bind(userId, purpose).run();

    const code = genEmailCode();
    await this.db.prepare(
      `INSERT INTO email_codes (user_id, email, code, purpose, expires_at)
       VALUES (?, ?, ?, ?, datetime('now', '+${CODE_TTL_MINUTES} minutes'))`
    ).bind(userId, email, code, purpose).run();

    return { ok: true, code };
  }

  /**
   * 校验并消耗一个码。
   *
   * @returns {{ok:true} | {ok:false, reason:'MISSING'|'TOO_MANY'|'MISMATCH'}}
   *   MISSING  码不存在 / 已过期 / 已用过 / 与当前邮箱对不上（换过邮箱）
   *   TOO_MANY 试错满 MAX_CODE_ATTEMPTS 次，或并发占坑没抢到名额
   *   MISMATCH 码错了 —— 名额已占，码保留，用户可以直接重试
   */
  async verify(userId, { purpose, email, code }) {
    const row = await this.db.prepare(
      `SELECT id, email, code, attempts FROM email_codes
       WHERE user_id = ? AND purpose = ? AND used_at IS NULL AND expires_at > datetime('now')
       ORDER BY id DESC LIMIT 1`
    ).bind(userId, purpose).first();

    // 查不到、或这条码不是发给当前这个邮箱的（用户换过邮箱）：一律当「没有码」，
    // 不给「码过期了」这种能区分出状态的说法
    if (!row || row.email !== email) return { ok: false, reason: 'MISSING' };
    if (Number(row.attempts) >= MAX_CODE_ATTEMPTS) return { ok: false, reason: 'TOO_MANY' };

    // 原子占坑：命中 0 行说明名额刚好被并发抢完 / 已被消耗
    const claimed = await this.db.prepare(
      `UPDATE email_codes SET attempts = attempts + 1
       WHERE id = ? AND used_at IS NULL AND attempts < ${MAX_CODE_ATTEMPTS}`
    ).bind(row.id).run();
    if (!claimed.meta || claimed.meta.changes !== 1) return { ok: false, reason: 'TOO_MANY' };

    if (String(row.code) !== String(code)) return { ok: false, reason: 'MISMATCH' };

    // 用后即焚：再带一次 WHERE used_at IS NULL，并发重放只成功一次
    const used = await this.db.prepare(
      "UPDATE email_codes SET used_at = CURRENT_TIMESTAMP WHERE id = ? AND used_at IS NULL"
    ).bind(row.id).run();
    if (!used.meta || used.meta.changes !== 1) return { ok: false, reason: 'MISSING' };

    return { ok: true };
  }

  /** 清掉某用户某用途的码（改邮箱 / 换绑时调用，让旧码立刻失效） */
  async clear(userId, purpose) {
    await this.db.prepare(
      'DELETE FROM email_codes WHERE user_id = ? AND purpose = ?'
    ).bind(userId, purpose).run();
  }
}
