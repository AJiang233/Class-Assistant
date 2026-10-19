import { AGREEMENT_VERSION } from '../utils/consent.js';

/**
 * 用户协议同意记录（user_consents）。
 *
 * 一人一行，user_id 就是主键，所以 upsert 是「先读再分支」：首次同意写三项时间戳，
 * 之后只改 flag、时间戳与 updated_at。
 */
export class ConsentModel {
  constructor(db) {
    this.db = db;
  }

  async get(userId) {
    const row = await this.db
      .prepare('SELECT * FROM user_consents WHERE user_id = ?')
      .bind(userId)
      .first();
    return row || null;
  }

  /**
   * 写入同意情况并返回最新一行。
   *
   * 时间戳规则（撤回不清历史，重新开启才刷新）：
   *   · 首次写入：本次为 true 的项记 CURRENT_TIMESTAMP，false 项留 NULL；
   *   · 已有行：terms 恒为 true，保留原 terms_agreed_at；
   *     chaoxing / academic 只在「原本 0 → 本次 1」时刷新时间，其余保留原值；
   *     撤回（1 → 0）不动时间戳，只把 flag 置 0；
   *   · version 一律覆盖成当前 AGREEMENT_VERSION，表示「已按当前版本重新同意」。
   *
   * SET 子句右侧写列名（chaoxing = 0）而不是 bind 参数：这里要的是更新前的值。
   * SQLite 的新行由「原行 + 各 SET 表达式」算出，表达式读到的都是原值，
   * 所以同一条 UPDATE 里先写 chaoxing = ? 不会影响后面判断 chaoxing = 0。
   */
  async upsert(userId, { terms, chaoxing, academic }) {
    const t = terms === true || terms === 1 ? 1 : 0;
    const c = chaoxing === true || chaoxing === 1 ? 1 : 0;
    const a = academic === true || academic === 1 ? 1 : 0;
    const existing = await this.get(userId);

    if (!existing) {
      await this.db
        .prepare(
          `INSERT INTO user_consents
             (user_id, version, terms, chaoxing, academic,
              terms_agreed_at, chaoxing_agreed_at, academic_agreed_at)
           VALUES (?, ?, ?, ?, ?,
              CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
              CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END,
              CASE WHEN ? THEN CURRENT_TIMESTAMP ELSE NULL END)`
        )
        .bind(userId, AGREEMENT_VERSION, t, c, a, t, c, a)
        .run();
    } else {
      await this.db
        .prepare(
          `UPDATE user_consents SET
             version = ?,
             terms = ?,
             chaoxing = ?,
             academic = ?,
             terms_agreed_at = COALESCE(terms_agreed_at, CASE WHEN ? THEN CURRENT_TIMESTAMP END),
             chaoxing_agreed_at = CASE WHEN chaoxing = 0 AND ? = 1 THEN CURRENT_TIMESTAMP ELSE chaoxing_agreed_at END,
             academic_agreed_at = CASE WHEN academic = 0 AND ? = 1 THEN CURRENT_TIMESTAMP ELSE academic_agreed_at END,
             updated_at = CURRENT_TIMESTAMP
           WHERE user_id = ?`
        )
        .bind(AGREEMENT_VERSION, t, c, a, t, c, a, userId)
        .run();
    }

    return this.get(userId);
  }
}
