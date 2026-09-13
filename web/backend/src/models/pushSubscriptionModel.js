/**
 * Web Push 订阅数据模型
 * 表结构：push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at, last_ok_at)
 */
export class PushSubscriptionModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 落库或改绑。
   *
   * endpoint 唯一：同一设备换账号登录时，这里会把 user_id 改成新账号 —— 否则旧账号
   * 会一直收到发给新账号的推送（同一台手机的推送是发给「浏览器」而不是「人」的）。
   */
  async upsert({ userId, endpoint, p256dh, auth, ua = null }) {
    const result = await this.db.prepare(
      `INSERT INTO push_subscriptions (user_id, endpoint, p256dh, auth, ua)
       VALUES (?, ?, ?, ?, ?)
       ON CONFLICT(endpoint) DO UPDATE SET
         user_id = excluded.user_id,
         p256dh  = excluded.p256dh,
         auth    = excluded.auth,
         ua      = excluded.ua`
    ).bind(userId, endpoint, p256dh, auth, ua).run();
    return result;
  }

  /**
   * 退订：只删自己的那一条，避免拿别人的 endpoint 把别人的订阅删掉
   */
  async removeOwn(userId, endpoint) {
    const result = await this.db.prepare(
      'DELETE FROM push_subscriptions WHERE user_id = ? AND endpoint = ?'
    ).bind(userId, endpoint).run();
    return result;
  }

  /** 该用户当前有几条订阅（用于前端显示「已开启」状态） */
  async countByUser(userId) {
    const row = await this.db.prepare(
      'SELECT COUNT(*) AS n FROM push_subscriptions WHERE user_id = ?'
    ).bind(userId).first();
    return row ? row.n : 0;
  }

  /** 取这批用户的全部订阅（发送时用；一条用户可能有多台设备） */
  async listByUsers(userIds) {
    const ids = (userIds || []).filter((id) => Number.isInteger(id) || /^\d+$/.test(String(id)));
    if (!ids.length) return [];
    const placeholders = ids.map(() => '?').join(',');
    const result = await this.db.prepare(
      `SELECT id, user_id, endpoint, p256dh, auth
         FROM push_subscriptions
        WHERE user_id IN (${placeholders})`
    ).bind(...ids.map(Number)).all();
    return result.results;
  }

  /** 端点已死（404/410）：立即删行，后续不再尝试 */
  async removeByEndpoints(endpoints) {
    const list = (endpoints || []).filter(Boolean);
    if (!list.length) return 0;
    const placeholders = list.map(() => '?').join(',');
    await this.db.prepare(
      `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`
    ).bind(...list).run();
    return list.length;
  }

  /** 记录一次成功投递 */
  async markOk(endpoints) {
    const list = (endpoints || []).filter(Boolean);
    if (!list.length) return;
    const placeholders = list.map(() => '?').join(',');
    await this.db.prepare(
      `UPDATE push_subscriptions SET last_ok_at = CURRENT_TIMESTAMP
        WHERE endpoint IN (${placeholders})`
    ).bind(...list).run();
  }
}
