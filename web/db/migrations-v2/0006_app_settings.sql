-- 全局功能开关（对应 migrations-v2/0006_app_settings.sql，DDL 必须逐字一致）。
-- 教务 / 学习通访问的紧急停用开关：关掉后门户在转发前直接 503 FEATURE_DISABLED，
-- 连私有 Worker 都不调用。没有记录时按开启处理（缺省即线上原有行为），
-- 避免升级后忘了写初始行导致功能被误关。
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,              -- academic_enabled / chaoxing_enabled
  value       TEXT NOT NULL,                 -- '1' 开启 / '0' 停用
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);