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
  email          TEXT,                       -- 邮箱；未绑定为 NULL，不要写空串（见下面的唯一索引）
  email_verified INTEGER DEFAULT 0,          -- 0 未验证 / 1 已验证；邮箱真的变了就重置为 0
  password_changed_at INTEGER,               -- 改密时刻（Unix 秒，UTC）；NULL = 从未改过。用于让旧 JWT 立即失效
  update_time    DATETIME DEFAULT CURRENT_TIMESTAMP
);

-- 一个邮箱只能归一个账号（否则找回密码时分不清是谁）；WHERE email IS NOT NULL 让「未绑定」不参与唯一性
-- COLLATE NOCASE 是双保险：写入侧已统一转小写，但 SQLite 的 TEXT 比较默认区分大小写
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

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

-- ===== 邮箱验证与邮件订阅 =====
-- 时间统一走 UTC（CURRENT_TIMESTAMP / datetime('now', ...)），与上面那些表的本地时间字符串
-- 刻意不同：有效期与重发间隔全在 SQL 里算，不经后端时区转换（混用会差 8 小时）。

-- 验证码：绑定验证与找回密码共用一张表，靠 purpose 区分；一码制 + 用后即焚
CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,             -- 门户 users.id
  email      TEXT NOT NULL,                -- 目标邮箱（换邮箱后旧码自然失效）
  code       TEXT NOT NULL,                -- 6 位数字
  purpose    TEXT NOT NULL,                -- 'verify' 绑定验证 | 'reset' 找回密码
  attempts   INTEGER DEFAULT 0,            -- 试错计数，满 5 次作废（原子占坑，对齐教务 MFA 口径）
  expires_at TEXT NOT NULL,                -- UTC，如 datetime('now', '+10 minutes')
  used_at    TEXT,                         -- NULL = 未使用（用后即焚）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_email_codes_user  ON email_codes(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose);

-- 邮件订阅开关（活动 / 通知 / 表单）。默认全 0：订阅是额外的「主动同意」。
-- 只覆盖班务推送；验证码 / 找回密码这类事务邮件不读这张表 —— 开关全关也得收得到。
-- 推送收件人 = 提醒对象 ∩ 邮箱已验证 ∩ 这里开着（批量筛人见 utils/emailPush.js）。
CREATE TABLE IF NOT EXISTS email_subscriptions (
  user_id         INTEGER PRIMARY KEY,     -- = users.id，一对一
  sub_activities  INTEGER DEFAULT 0,       -- 活动订阅
  sub_notices     INTEGER DEFAULT 0,       -- 通知订阅
  sub_forms       INTEGER DEFAULT 0,       -- 表单订阅
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
