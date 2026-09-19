/**
 * 邮箱订阅模型（email_subscriptions，与 users 一对一）。
 *
 * 订阅位：sub_activities 活动 / sub_notices 通知 / sub_forms 表单，默认全 0。
 * 本期前端只有读写与联动，真正按订阅发信（活动 / 通知 / 表单推送）还没接，
 * 接入点统一走 utils/email.js 的 sendSubscribedEmail —— 那一道会再校验一次
 * 「邮箱已验证 + 对应订阅开着」，前端拦不住的后端再兜一遍。
 *
 * 与 email_codes 不同，这里不设「无行 == 全 0」之外的复杂语义：
 * 无行（刚注册、从未碰过订阅）由 get 直接返回全 false；解绑时保留行、置 0
 * （resetToZero），用户重新绑定后从全 0 重新勾选，不继承旧订阅。
 */
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

  /** 删除成员时连带清理（没有外键，靠代码收；userModel.delete 已处理，这里保持对称） */
  async removeByUser(userId) {
    await this.db.prepare('DELETE FROM email_subscriptions WHERE user_id = ?').bind(userId).run();
  }
}
