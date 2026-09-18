-- 课程成绩缓存表（issue #38）
--
-- 成绩走的是「服务端代为爬教务」这条路，与课表、学分完全同构：教务登录态大概一天
-- 就会被重置一次，抓不到是常态而不是异常，所以必须有一份服务端缓存兜着 ——
-- 抓不到时把手上这份给出去（见 academicHandler 的 cacheDecision），页面至少还能看。
--
-- 按学期一份，与 academic_timetable 同一套形状。xnxq_id 为空串表示「全部学期」：
-- 那是成绩页上的一个真实选项（ALL_TERM_ID），不是「没指定学期」——成绩页默认就落在它上面，
-- 因为当前学期开学初通常一门成绩都没有。
--
-- 语句可重复执行。

CREATE TABLE IF NOT EXISTS academic_grades (
  user_id       INTEGER NOT NULL,
  xnxq_id       TEXT NOT NULL,             -- 如 2025-2026-2；'' = 全部学期
  payload       TEXT NOT NULL,             -- 归一化成绩 JSON（rows + summary）
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, xnxq_id)
);
