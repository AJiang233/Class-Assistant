-- Class Assistant 后端数据库结构
-- 与线上 Cloudflare D1 数据库保持一致（2026-08-22 核对；
-- 文末 academic_* 三张表为教务功能新增，已有库需单独执行建表语句）

CREATE TABLE IF NOT EXISTS users (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  student_id     TEXT UNIQUE NOT NULL,
  name           TEXT NOT NULL,
  password_hash  TEXT NOT NULL,
  auth_key       TEXT,
  positions      TEXT DEFAULT '学生',
  contact        TEXT,
  update_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

CREATE TABLE IF NOT EXISTS notices (
  id             INTEGER PRIMARY KEY AUTOINCREMENT,
  title          TEXT NOT NULL,
  content        TEXT NOT NULL,
  publish_time   DATETIME NOT NULL,
  publisher      TEXT NOT NULL,
  remind_people  TEXT,
  source         TEXT DEFAULT 'manual',
  expire_time    DATETIME,
  link           TEXT,                      -- 可选跳转（仅站内相对路径），如表单填写页
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
  publisher      TEXT NOT NULL,
  remind_people  TEXT,
  created_at     DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 教务系统绑定：每用户一条，存会话 Cookie（HttpOnly 也可由安卓原生读出）
CREATE TABLE IF NOT EXISTS academic_bindings (
  user_id       INTEGER PRIMARY KEY,
  student_no    TEXT,                      -- 教务学号
  real_name     TEXT,                      -- 教务姓名
  school_uid    TEXT,                      -- 教务用户 id（即各接口的 xsid / xsxxid）
  cookies       TEXT NOT NULL,             -- 教务会话 Cookie（AES-GCM 密文，旧明文记录读时兼容）
  status        TEXT DEFAULT 'ok',         -- ok / expired
  bound_at      DATETIME DEFAULT CURRENT_TIMESTAMP,
  checked_at    DATETIME                   -- 最近一次成功校验/抓取时间
);

-- 课表缓存：按「用户 + 学年学期」存归一化后的课表
CREATE TABLE IF NOT EXISTS academic_timetable (
  user_id       INTEGER NOT NULL,
  xnxq_id       TEXT NOT NULL,             -- 如 2026-2027-1
  payload       TEXT NOT NULL,             -- 归一化课表 JSON
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, xnxq_id)
);

-- 学业达成（学分）缓存：每用户一条
CREATE TABLE IF NOT EXISTS academic_credits (
  user_id       INTEGER PRIMARY KEY,
  payload       TEXT NOT NULL,             -- 归一化学分 JSON
  fetched_at    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 多因子认证中间态：代登录被要求二次验证时，暂存 CAS 会话，等用户回填验证码
CREATE TABLE IF NOT EXISTS academic_mfa_sessions (
  token         TEXT PRIMARY KEY,          -- 一次性令牌，前端持有并回传
  user_id       INTEGER NOT NULL,
  state         TEXT NOT NULL,             -- CAS Cookie 罐 + reAuthParams（AES-GCM 密文，不含密码）
  attempts      INTEGER DEFAULT 0,         -- 验证码试错计数，满 5 次 token 作废
  created_at    DATETIME DEFAULT CURRENT_TIMESTAMP
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
