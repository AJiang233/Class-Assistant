-- 已有 D1 执行一次即可。新库直接跑 schema.sql，不必跑本文件。
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-11-security.sql
--
-- 若已经有人把「学生」等预置名写进 roles 表，全班会被提权。这里清掉。

DELETE FROM roles WHERE name IN ('学生', '班长', '团支书', '学习委员');
