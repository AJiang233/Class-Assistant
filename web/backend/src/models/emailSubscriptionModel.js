/**
 * 邮箱订阅模型（email_subscriptions，与 users 一对一）。
 *
 * 订阅位：sub_activities 活动 / sub_notices 通知 / sub_forms 表单，默认全 0。
 * 按订阅推送（活动 / 通知 / 表单）的接入点是 utils/emailPush.js，它**批量**筛人：
 * 先用 subscribedIds 一次问出「这批人里开了这类订阅的 id」，再与 users 里的
 * email_verified 合并 —— 逐个 get 就是每人一条 D1 查询，而 D1 查询计入 Worker 的
 * subrequest 配额（免费版一次调用 50 个），几十人的班发一次就撞上限。
 *
 * 与 email_codes 不同，这里不设「无行 == 全 0」之外的复杂语义：
 * 无行（刚注册、从未碰过订阅）由 get 直接返回全 false；解绑时保留行、置 0
 * （resetToZero），用户重新绑定后从全 0 重新勾选，不继承旧订阅。
 */

/**
 * 订阅类型 → 列名。新增订阅类目（如「成绩订阅」）时在这里加一行 ——
 * 建表语句、读写接口与推送筛选都读这一份，别在别处再抄一遍。
 */
export const SUBSCRIPTION_COLUMNS = {
  activities: 'sub_activities',
  notices: 'sub_notices',
  forms: 'sub_forms'
};

export class EmailSubscriptionModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 读取订阅开关。无行（从未设置过）返回全 false —— 订阅默认是关的。
   */
  async get(userId) {
    const row = await this.db.prepare(
      'SELECT sub_activities, sub_notices, sub_forms FROM email_subscriptions WHERE user_id = ?'
    ).bind(userId).first();
    return {
      activities: !!row && Number(row.sub_activities) === 1,
      notices: !!row && Number(row.sub_notices) === 1,
      forms: !!row && Number(row.sub_forms) === 1
    };
  }

  /**
   * 写订阅开关（UPSERT：第一次存是 INSERT，之后再存是 UPDATE）。
   * 布尔参数由调用方转 0/1，这里不做隐式转换。
   */
  async set(userId, { activities, notices, forms }) {
    await this.db.prepare(
      `INSERT INTO email_subscriptions (user_id, sub_activities, sub_notices, sub_forms, updated_at)
       VALUES (?, ?, ?, ?, CURRENT_TIMESTAMP)
       ON CONFLICT(user_id) DO UPDATE SET
         sub_activities = excluded.sub_activities,
         sub_notices = excluded.sub_notices,
         sub_forms = excluded.sub_forms,
         updated_at = CURRENT_TIMESTAMP`
    ).bind(userId, activities ? 1 : 0, notices ? 1 : 0, forms ? 1 : 0).run();
  }

  /**
   * 这批用户里「开了某一类订阅」的 id（推送挑选收件人用）。
   *
   * 一次问完而不是逐个 get：D1 的每条查询都算一个 subrequest，免费版一次调用只有 50 个，
   * 几十人的班逐个问就会撞上限 —— 而撞上限的后果是「一部分人静默收不到」。
   *
   * 分批口径与 PushSubscriptionModel 一致（D1 单条语句最多 100 个绑定参数，取 50 留余量）。
   *
   * @param {number[]} userIds
   * @param {'activities'|'notices'|'forms'} kind
   * @returns {Promise<number[]>} 开了这类订阅的 user_id
   */
  async subscribedIds(userIds, kind) {
    const col = SUBSCRIPTION_COLUMNS[kind];
    if (!col) throw new Error(`未知的订阅类型: ${kind}`);

    const ids = (userIds || []).map(Number).filter((n) => Number.isInteger(n));
    if (!ids.length) return [];

    const out = [];
    for (let i = 0; i < ids.length; i += 50) {
      const part = ids.slice(i, i + 50);
      const placeholders = part.map(() => '?').join(',');
      const result = await this.db.prepare(
        `SELECT user_id FROM email_subscriptions
          WHERE user_id IN (${placeholders}) AND ${col} = 1`
      ).bind(...part).all();
      for (const row of result.results) out.push(Number(row.user_id));
    }
    return out;
  }

  /**
   * 解绑邮箱时清零订阅（保留行，不删）。
   * 邮箱没了，订阅就没有承载体 —— 保留行而不是删，是让「曾经设过订阅」这件事
   * 不至于被误判成「从未设置」；反正 get 对全 0 的语义与无行一致，都是全关。
   */
  async resetToZero(userId) {
    await this.db.prepare(
      `UPDATE email_subscriptions
       SET sub_activities = 0, sub_notices = 0, sub_forms = 0, updated_at = CURRENT_TIMESTAMP
       WHERE user_id = ?`
    ).bind(userId).run();
  }
}
