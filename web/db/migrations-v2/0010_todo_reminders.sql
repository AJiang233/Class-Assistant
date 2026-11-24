-- 待办到期 Web Push 提醒（P1-4）。
--
-- 浏览器（尤其 iOS 主屏 PWA）关闭后没有任何本地定时通知能力，所以「提前 N 分钟提醒」
-- 必须由服务端 Cron 每分钟检查：到窗口就给本人的每个推送订阅登记一条投递，再按 outbox
-- 的租约语义发送（120 秒租约、指数退避、永久错误终止）。
--
-- 投递记录不复用 outbox_deliveries：那张表的 event_seq 外键绑定内容变更事件，而待办
-- 提醒与事件无关；单独建表才能按「待办 + 用户 + 截止时间 + 端点」去重，改期也会自然
-- 产生新记录（旧记录发送前复核 due_at 不一致即跳过）。
--
-- 与 0007 同理：这份 DDL 与 schema.sql 尾部的同名段落必须逐字一致，
-- architecture.test.js 会用 sqlite_master 深比较「新库快照」与「基线 + 迁移顺序执行」。
CREATE TABLE IF NOT EXISTS todo_reminder_prefs (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  enabled      INTEGER NOT NULL DEFAULT 0,
  lead_minutes INTEGER NOT NULL DEFAULT 60,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS todo_reminder_deliveries (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  todo_id     INTEGER NOT NULL REFERENCES todos(id) ON DELETE CASCADE,
  due_at      TEXT NOT NULL,
  endpoint    TEXT NOT NULL,
  payload     TEXT NOT NULL,
  state       TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','dead','skipped')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  next_at     INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error  TEXT,
  created_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at  TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(todo_id, user_id, due_at, endpoint)
);

-- Cron 每轮只找「待发送且到点」或「租约过期的发送中」，这条索引直接覆盖。
CREATE INDEX IF NOT EXISTS idx_todo_reminder_ready ON todo_reminder_deliveries(state, next_at, lease_until);
