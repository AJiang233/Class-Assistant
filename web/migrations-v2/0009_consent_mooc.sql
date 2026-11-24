-- 中国大学MOOC（icourse163）授权（第三个第三方数据源）。
--
-- 与学习通同一套口径：授权只拦「会拿着用户身份真的出网访问 icourse163」的请求，
-- 撤权之后已缓存的课程 / 任务点 / 作业照旧能读。
--
-- 时间戳规则沿用 0003：只在 0 → 1 时刷新，撤回不清历史。
--
-- 沿用 0007 / 0008 的做法：列用 ALTER 追加，web/schema.sql 尾部必须逐字重复这两条，
-- 否则 architecture.test.js 的结构深比较会失败。
ALTER TABLE user_consents ADD COLUMN mooc INTEGER NOT NULL DEFAULT 0;
ALTER TABLE user_consents ADD COLUMN mooc_agreed_at DATETIME;
