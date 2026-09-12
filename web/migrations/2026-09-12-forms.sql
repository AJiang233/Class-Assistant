-- 已有 D1 执行一次即可。新库直接跑 schema.sql，不必跑本文件。
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-12-forms.sql
--
-- 1) 表单功能两张表（forms / form_submissions）
-- 2) 通知加 link 列：表单下发通知时指向填写页
--
-- 注意：末尾的 ALTER TABLE 不幂等，重复执行会报 duplicate column name，忽略即可。

CREATE TABLE IF NOT EXISTS forms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT,
  fields         TEXT NOT NULL,
  edit_policy    TEXT DEFAULT 'before_deadline',
  anonymous      INTEGER DEFAULT 0,
  status         TEXT DEFAULT 'open',
  deadline       DATETIME,
  creator_id     INTEGER NOT NULL,
  creator_name   TEXT NOT NULL,
  remind_people  TEXT,
  notice_id      INTEGER,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS form_submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  student_id  TEXT,
  name        TEXT,
  answers     TEXT NOT NULL,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (form_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_id);

ALTER TABLE notices ADD COLUMN link TEXT;
