-- 安全加固迁移（已有 D1 必须执行；新库直接跑 schema.sql 即可）
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-11-security.sql
-- ALTER 不能重跑：若报 duplicate column name，说明 token_version 已经加过，跳过该句即可。

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  hits      INTEGER NOT NULL DEFAULT 0,
  reset_at  INTEGER NOT NULL
);

-- 若已经有人把「学生」写进 roles 表，全班会被提权；这里清掉预置名
DELETE FROM roles WHERE name IN ('学生', '班长', '团支书', '学习委员');
