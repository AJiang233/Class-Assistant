-- 删除本库里教务那几张旧表（随「教务访问代码拆到私有 Worker」后的收尾）
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-19-drop-academic-tables.sql
-- 或 npm run db:migrate:drop-academic
--
-- 这几张表随教务实现一起搬到了私有 Worker 的库 class-assistant-private-api
-- （建表语句见那个仓库的 schema.sql），本库这边的旧表已经没有任何代码读写：
-- 门户只剩下 routes/academic.js 那层转发，数据全在私有库。
--
-- 搬迁时就没迁数据 —— 教务登录态大概一天就会被重置一次，绑定记录留着没用，
-- 用户重新绑一次即可，所以这里直接连表一起删，不留空壳。
--
-- 执行前建议先备份一次，删掉之后想回滚就不是「切回拆分前的代码」那么简单了
-- （要重建表、用户还要重新绑定）：
--   npx wrangler d1 export class-assistant-db --remote --output=academic-backup.sql
--
-- 语句可重复执行。

DROP TABLE IF EXISTS academic_bindings;
DROP TABLE IF EXISTS academic_timetable;
DROP TABLE IF EXISTS academic_credits;
DROP TABLE IF EXISTS academic_grades;
DROP TABLE IF EXISTS academic_mfa_sessions;
