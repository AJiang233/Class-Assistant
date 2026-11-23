-- 管理操作审计日志（对应 migrations-v2/0005_audit_logs.sql，DDL 必须逐字一致：
-- architecture.test.js 用 sqlite_master 深比较新库快照与「基线 + 迁移顺序执行」）。
-- 刻意不设外键：删成员后日志必须还在；actor/target 都只是快照，detail 不含密码/邮箱明文。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      INTEGER NOT NULL,            -- 操作者 users.id 快照（不设外键）
  actor_name    TEXT NOT NULL,               -- 操作时的姓名快照
  action        TEXT NOT NULL,               -- 动作码，见 README「管理操作日志」表
  target_type   TEXT,                        -- member / role / settings
  target_id     TEXT,                        -- 被操作对象（成员 id / 职位名 / 设置键），不设外键
  detail        TEXT,                        -- JSON：字段名、权限等结构性信息，无敏感值
  ip            TEXT,                        -- CF-Connecting-IP
  user_agent    TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 列表按时间倒序翻页；清理按时间范围删除。两条索引分别服务这两个查询。
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at);
