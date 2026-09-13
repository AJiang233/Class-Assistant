-- Web Push 订阅（iOS / 安卓 PWA 通用）
--
-- endpoint 全局唯一：同一个浏览器/设备重复订阅是同一条，所以换账号登录时必须改绑 user_id，
-- 否则旧账号会继续收到推送（见 PushSubscriptionModel.upsert 的 ON CONFLICT 分支）。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_ok_at  DATETIME
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);
