-- 已有 D1 执行一次即可。新库直接跑 schema.sql，不必跑本文件。
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-12-mfa-attempts.sql
--
-- 多因子中间态加尝试计数：验证码错满 5 次后 token 作废，需重新走学号密码登录。

ALTER TABLE academic_mfa_sessions ADD COLUMN attempts INTEGER DEFAULT 0;
