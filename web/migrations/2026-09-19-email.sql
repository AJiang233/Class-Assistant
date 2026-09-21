-- 邮箱验证与邮件订阅（与 qxwkaccount 同款能力）
-- wrangler d1 execute class-assistant-db --remote --file=./migrations/2026-09-19-email.sql
-- 或 npm run db:migrate:email
--
-- 三块：
--   1) users 补 email / email_verified / password_changed_at
--   2) email_codes 验证码（绑定验证与找回密码共用一张表，靠 purpose 区分）
--   3) email_subscriptions 三类邮件订阅开关（功能以后再接，先把列落好）
--
-- ALTER 是一次性的：重复执行会报 duplicate column name，属预期（同其它迁移脚本）；
-- CREATE TABLE / INDEX 都带 IF NOT EXISTS，可重复执行。

-- ===== 1. users：邮箱、验证状态、改密时刻 =====
-- email 为空即「未绑定」，一律写 NULL，不要写空串：唯一索引容忍多个 NULL，
-- 但两个 '' 会互相撞（与「没有职务一律存 '学生'」是同一类归一问题）。
ALTER TABLE users ADD COLUMN email TEXT;

-- 0 未验证 / 1 已验证。邮箱一旦真的变了（含清空）必须重置为 0，需重新验证。
ALTER TABLE users ADD COLUMN email_verified INTEGER DEFAULT 0;

-- 改密 / 被管理员重置密码 / 忘记密码重置的时刻，Unix 秒（UTC）。
-- 刻意不用 DATETIME：它唯一的用途是与 JWT 载荷里的 iat 比大小（middleware/auth.js），
-- 存整数直接比，不必在 JS 里解析时间字符串、也不用担心时区。
-- NULL = 从未改过密码，比对时视为「不限制」。
ALTER TABLE users ADD COLUMN password_changed_at INTEGER;

-- 一个邮箱只能归一个账号，否则找回密码时分不清是谁。
-- WHERE email IS NOT NULL 让它成为部分索引：未绑定（NULL）不参与唯一性。
-- COLLATE NOCASE 是双保险：写入侧已经统一转小写（handlers/authHandler.js 的 normalizeEmail），
-- 但 SQLite 默认的 TEXT 比较是区分大小写的，一旦有人绕过归一化直接改库，
-- A@qq.com 与 a@qq.com 就会变成两个账号，找回密码时分不清是谁 —— 这类洞不靠自觉。
CREATE UNIQUE INDEX IF NOT EXISTS idx_users_email ON users(email COLLATE NOCASE) WHERE email IS NOT NULL;

-- ===== 2. 验证码（绑定验证 + 找回密码） =====
-- 时间统一走 UTC（CURRENT_TIMESTAMP / datetime('now', ...)），与站内其它表存的
-- 本地时间字符串刻意不同：有效期与「60 秒限发」全部在 SQL 里算，不经过后端的时区转换，
-- 少一层能出错的地方（私有仓那张教务 MFA 表也是这个口径）。
-- 同一张表内部自洽即可；混用会让验证码立刻过期、或永不判过期（差 8 小时）。
CREATE TABLE IF NOT EXISTS email_codes (
  id         INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id    INTEGER NOT NULL,             -- 门户 users.id
  email      TEXT NOT NULL,                -- 目标邮箱（换邮箱后旧码自然失效）
  code       TEXT NOT NULL,                -- 6 位数字
  purpose    TEXT NOT NULL,                -- 'verify' 绑定验证 | 'reset' 找回密码
  attempts   INTEGER DEFAULT 0,            -- 试错计数，满 5 次作废（对齐教务 MFA 的口径）
  expires_at TEXT NOT NULL,                -- UTC，如 datetime('now', '+10 minutes')
  used_at    TEXT,                         -- NULL = 未使用（用后即焚）
  created_at TEXT DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_email_codes_user  ON email_codes(user_id, purpose);
CREATE INDEX IF NOT EXISTS idx_email_codes_email ON email_codes(email, purpose);

-- ===== 3. 邮件订阅开关（功能以后再接，先把列落好） =====
-- 默认全 0：绑邮箱的初衷是验证与找回密码，订阅是额外的「主动同意」，
-- 功能上线那一刻不该有人被默认订阅。
-- 这三类只覆盖「班务推送」；验证码 / 找回密码这类事务邮件不读这张表 ——
-- 用户把开关全关掉，也必须收得到验证码与重置码。
-- 删成员时要连带删这行（D1 没建外键，见 UserModel.delete）。
CREATE TABLE IF NOT EXISTS email_subscriptions (
  user_id         INTEGER PRIMARY KEY,     -- = users.id，一对一
  sub_activities  INTEGER DEFAULT 0,       -- 活动订阅
  sub_notices     INTEGER DEFAULT 0,       -- 通知订阅
  sub_forms       INTEGER DEFAULT 0,       -- 表单订阅
  updated_at      TEXT DEFAULT CURRENT_TIMESTAMP
);
