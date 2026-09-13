/**
 * Web Push 订阅数据模型
 * 表结构：push_subscriptions (id, user_id, endpoint, p256dh, auth, ua, created_at, last_ok_at)
 */

/**
 * 单条 SQL 最多能绑多少个参数。
 *
 * D1 的硬上限是 100，与套餐无关 —— 超了直接报错，不是慢一点。一次班级通知的收件人
 * 很容易几百台设备（一人多机），所以凡是用 `IN (...)` 拼参数的地方都必须分批。
 * 取 50 是留一倍余量：以后要往同一条语句里再加参数不至于立刻越界。
 * ponytail: 50 这个数是刻意选的，不是随手写的；别再改回「一把梭」。
 */
const MAX_BIND_PARAMS = 50;

/** 把数组切成每段最多 size 个；空数组返回 []，调用方各自短路 */
function chunk(list, size = MAX_BIND_PARAMS) {
  const out = [];
  for (let i = 0; i < list.length; i += size) out.push(list.slice(i, i + size));
  return out;
}

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
    const rows = [];
    // 分批：班级人数 * 人均设备数很容易超过 50/100 个绑定参数
    for (const part of chunk(ids.map(Number))) {
      const placeholders = part.map(() => '?').join(',');
      const result = await this.db.prepare(
        `SELECT id, user_id, endpoint, p256dh, auth
           FROM push_subscriptions
          WHERE user_id IN (${placeholders})`
      ).bind(...part).all();
      rows.push(...result.results);
    }
    return rows;
  }

  /** 端点已死（404/410）：立即删行，后续不再尝试 */
  async removeByEndpoints(endpoints) {
    const list = (endpoints || []).filter(Boolean);
    if (!list.length) return 0;
    for (const part of chunk(list)) {
      const placeholders = part.map(() => '?').join(',');
      await this.db.prepare(
        `DELETE FROM push_subscriptions WHERE endpoint IN (${placeholders})`
      ).bind(...part).run();
    }
    return list.length;
  }

  /** 记录一次成功投递 */
  async markOk(endpoints) {
    const list = (endpoints || []).filter(Boolean);
    if (!list.length) return;
    for (const part of chunk(list)) {
      const placeholders = part.map(() => '?').join(',');
      await this.db.prepare(
        `UPDATE push_subscriptions SET last_ok_at = CURRENT_TIMESTAMP
          WHERE endpoint IN (${placeholders})`
      ).bind(...part).run();
    }
  }
}
