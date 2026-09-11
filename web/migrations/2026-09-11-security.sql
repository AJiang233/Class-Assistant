-- 安全加固迁移（已有 D1 必须执行；新库直接跑 schema.sql 即可）
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-11-security.sql

ALTER TABLE users ADD COLUMN token_version INTEGER NOT NULL DEFAULT 0;

CREATE TABLE IF NOT EXISTS rate_limits (
  key       TEXT PRIMARY KEY,
  count     INTEGER NOT NULL DEFAULT 0,
  reset_at  INTEGER NOT NULL
);
