-- Class Assistant 后端数据库结构
-- 与线上 Cloudflare D1 数据库保持一致（2026-08-22 核对）
-- 教务那几张表（academic_*）已随实现搬到私有仓 class-assistant-private-api 的库，
-- 建表语句见该仓库的 schema.sql，本库不再包含。

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  auth_key       TEXT,
  positions      TEXT DEFAULT '学生',        -- 职位：单个字符串或 JSON 数组字符串；没有职务一律存 '学生'（唯一写法）
  contact        TEXT,
  update_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  publish_time   DATETIME NOT NULL,
  publisher      TEXT NOT NULL,               -- 署名，创建时由服务端从登录态写入
  remind_people  TEXT,
  source         TEXT DEFAULT 'manual',
  expire_time    DATETIME,
  link           TEXT,                      -- 可选跳转（仅站内相对路径），如表单填写页
  created_by     INTEGER,                   -- 创建者 user id；迁移前的历史行为 NULL
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS roles (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  name         TEXT UNIQUE NOT NULL,
  permissions  TEXT NOT NULL,
  created_at   DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS activities (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT,
  location       TEXT,
  start_time     DATETIME NOT NULL,
  end_time       DATETIME,
  publisher      TEXT NOT NULL,               -- 署名，创建时由服务端从登录态写入
  remind_people  TEXT,
  created_by     INTEGER,                   -- 创建者 user id；迁移前的历史行为 NULL
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表单：班委下发，同学填写
CREATE TABLE IF NOT EXISTS forms (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  description    TEXT,
  fields         TEXT NOT NULL,                    -- 字段定义 JSON 数组
  edit_policy    TEXT DEFAULT 'before_deadline',   -- none / before_deadline / always
  anonymous      INTEGER DEFAULT 0,                -- 1 = 匿名（展示与导出隐去学号姓名）
  status         TEXT DEFAULT 'open',              -- open / closed
  deadline       DATETIME,                         -- 截止时间（本地时间字符串）
  creator_id     INTEGER NOT NULL,
  creator_name   TEXT NOT NULL,
  remind_people  TEXT,                             -- 应交名单 JSON 数组，空 = 全班
  notice_id      INTEGER,                          -- 联动生成的通知 id
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 表单提交：每人每表一条（允许修改时原地覆盖）
CREATE TABLE IF NOT EXISTS form_submissions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id     INTEGER NOT NULL,
  user_id     INTEGER NOT NULL,
  student_id  TEXT,     -- 服务端从登录态注入，不接受前端传参
  name        TEXT,     -- 同上
  answers     TEXT NOT NULL,                       -- {字段key: 值}
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  updated_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE (form_id, user_id)
);

CREATE INDEX IF NOT EXISTS idx_form_submissions_form ON form_submissions(form_id);
