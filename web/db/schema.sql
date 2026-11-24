-- 新库快照：与 migrations-v2 顺序执行一致。
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

-- Web Push 订阅（iOS / 安卓 PWA 通用）
--
-- endpoint 全局唯一：同一个浏览器/设备重复订阅是同一条，所以换账号登录时必须改绑 user_id，
-- 否则旧账号会继续收到推送（见 PushSubscriptionModel.upsert 的 ON CONFLICT 分支）。
CREATE TABLE IF NOT EXISTS push_subscriptions (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  user_id     INTEGER NOT NULL,
  endpoint    TEXT NOT NULL UNIQUE,
  p256dh      TEXT NOT NULL,
  auth        TEXT NOT NULL,
  ua          TEXT,
  created_at  DATETIME DEFAULT CURRENT_TIMESTAMP,
  last_ok_at  DATETIME
);

CREATE INDEX IF NOT EXISTS idx_push_subs_user ON push_subscriptions(user_id);

-- 统一生命周期、稳定受众、持久投递与同步序号。
CREATE TABLE IF NOT EXISTS architecture_versions (version INTEGER PRIMARY KEY);
CREATE TABLE IF NOT EXISTS audience_migration_issues (
  kind TEXT NOT NULL, item_id INTEGER NOT NULL, legacy_value TEXT NOT NULL,
  PRIMARY KEY (kind, item_id)
);
CREATE TABLE IF NOT EXISTS orphan_submission_archive AS
  SELECT * FROM form_submissions WHERE form_id NOT IN (SELECT id FROM forms);
DELETE FROM form_submissions WHERE form_id NOT IN (SELECT id FROM forms);
CREATE TABLE IF NOT EXISTS form_submissions_v2 (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  form_id INTEGER NOT NULL REFERENCES forms(id) ON DELETE CASCADE,
  user_id INTEGER NOT NULL, student_id TEXT, name TEXT, answers TEXT NOT NULL,
  created_at DATETIME DEFAULT CURRENT_TIMESTAMP, updated_at DATETIME DEFAULT CURRENT_TIMESTAMP,
  UNIQUE(form_id, user_id)
);
INSERT OR IGNORE INTO form_submissions_v2 SELECT * FROM form_submissions;
DROP TABLE form_submissions;
ALTER TABLE form_submissions_v2 RENAME TO form_submissions;
CREATE INDEX idx_form_submissions_form ON form_submissions(form_id);
CREATE TABLE IF NOT EXISTS form_notice_links (
  operation_key TEXT PRIMARY KEY,
  form_id INTEGER NOT NULL UNIQUE REFERENCES forms(id) ON DELETE CASCADE
);
CREATE TRIGGER IF NOT EXISTS forms_delete_notice AFTER DELETE ON forms BEGIN
  DELETE FROM notices WHERE id = OLD.notice_id;
END;
CREATE TRIGGER IF NOT EXISTS notices_clear_link AFTER DELETE ON notices BEGIN
  UPDATE forms SET notice_id = NULL WHERE notice_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS users_delete_subscriptions AFTER DELETE ON users BEGIN
  DELETE FROM push_subscriptions WHERE user_id = OLD.id;
  DELETE FROM email_subscriptions WHERE user_id = OLD.id;
  DELETE FROM email_codes WHERE user_id = OLD.id;
END;

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'notices', id, remind_people FROM notices
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE notices SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'activities', id, remind_people FROM activities
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE activities SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

INSERT OR IGNORE INTO audience_migration_issues
SELECT 'forms', id, remind_people FROM forms
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1)
AND remind_people IS NOT NULL AND trim(remind_people) NOT IN ('', '[]')
AND EXISTS(SELECT 1 FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j) WHERE uid=0);
UPDATE forms SET remind_people = CASE
 WHEN remind_people IS NULL OR trim(remind_people) IN ('', '[]') THEN NULL
 ELSE (SELECT json_group_array(uid) FROM (SELECT CASE WHEN EXISTS(SELECT 1 FROM users WHERE CAST(id AS TEXT)=CAST(j.value AS TEXT)) THEN CAST(j.value AS INTEGER) WHEN (SELECT count(*) FROM users WHERE name=CAST(j.value AS TEXT))=1 THEN (SELECT id FROM users WHERE name=CAST(j.value AS TEXT)) ELSE 0 END AS uid FROM json_each(CASE WHEN json_valid(remind_people) AND json_type(remind_people) = 'array' THEN remind_people ELSE json_array(remind_people) END) j)) END
WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);

CREATE TABLE IF NOT EXISTS content_changes (
  seq INTEGER PRIMARY KEY AUTOINCREMENT,
  kind TEXT NOT NULL CHECK(kind IN ('notices','activities','forms')),
  item_id INTEGER NOT NULL,
  operation TEXT NOT NULL CHECK(operation IN ('create','update','delete')),
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX IF NOT EXISTS idx_changes_item ON content_changes(kind, item_id, seq);
CREATE TABLE IF NOT EXISTS outbox_events (
  seq INTEGER PRIMARY KEY REFERENCES content_changes(seq),
  expanded INTEGER NOT NULL DEFAULT 0
);
CREATE TABLE IF NOT EXISTS outbox_deliveries (
  id INTEGER PRIMARY KEY AUTOINCREMENT,
  event_seq INTEGER NOT NULL REFERENCES outbox_events(seq),
  user_id INTEGER NOT NULL,
  channel TEXT NOT NULL CHECK(channel IN ('email','push')),
  target TEXT NOT NULL,
  payload TEXT NOT NULL CHECK(json_valid(payload)),
  state TEXT NOT NULL DEFAULT 'pending' CHECK(state IN ('pending','sending','sent','dead','skipped')),
  attempts INTEGER NOT NULL DEFAULT 0,
  next_at INTEGER NOT NULL DEFAULT 0,
  lease_until INTEGER NOT NULL DEFAULT 0,
  lease_token TEXT,
  last_error TEXT,
  UNIQUE(event_seq, channel, target)
);
CREATE INDEX IF NOT EXISTS idx_deliveries_ready ON outbox_deliveries(state, next_at, lease_until);

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'notices', id, 'update', json_object('id', id, 'title', title, 'content', content, 'publish_time', publish_time, 'publisher', publisher, 'remind_people', remind_people, 'source', source, 'expire_time', expire_time, 'link', link, 'created_by', created_by, 'created_at', created_at) FROM notices WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS notices_change_create AFTER INSERT ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'publish_time', NEW.publish_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'source', NEW.source, 'expire_time', NEW.expire_time, 'link', NEW.link, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS notices_change_update AFTER UPDATE ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'publish_time', NEW.publish_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'source', NEW.source, 'expire_time', NEW.expire_time, 'link', NEW.link, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS notices_change_delete AFTER DELETE ON notices BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('notices', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'content', OLD.content, 'publish_time', OLD.publish_time, 'publisher', OLD.publisher, 'remind_people', OLD.remind_people, 'source', OLD.source, 'expire_time', OLD.expire_time, 'link', OLD.link, 'created_by', OLD.created_by, 'created_at', OLD.created_at));
END;

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'activities', id, 'update', json_object('id', id, 'title', title, 'content', content, 'location', location, 'start_time', start_time, 'end_time', end_time, 'publisher', publisher, 'remind_people', remind_people, 'created_by', created_by, 'created_at', created_at) FROM activities WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS activities_change_create AFTER INSERT ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'location', NEW.location, 'start_time', NEW.start_time, 'end_time', NEW.end_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS activities_change_update AFTER UPDATE ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'content', NEW.content, 'location', NEW.location, 'start_time', NEW.start_time, 'end_time', NEW.end_time, 'publisher', NEW.publisher, 'remind_people', NEW.remind_people, 'created_by', NEW.created_by, 'created_at', NEW.created_at));
END;
CREATE TRIGGER IF NOT EXISTS activities_change_delete AFTER DELETE ON activities BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('activities', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'content', OLD.content, 'location', OLD.location, 'start_time', OLD.start_time, 'end_time', OLD.end_time, 'publisher', OLD.publisher, 'remind_people', OLD.remind_people, 'created_by', OLD.created_by, 'created_at', OLD.created_at));
END;

INSERT INTO content_changes(kind,item_id,operation,payload) SELECT 'forms', id, 'update', json_object('id', id, 'title', title, 'description', description, 'fields', fields, 'edit_policy', edit_policy, 'anonymous', anonymous, 'status', status, 'deadline', deadline, 'creator_id', creator_id, 'creator_name', creator_name, 'remind_people', remind_people, 'notice_id', notice_id, 'created_at', created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=forms.id))) FROM forms WHERE NOT EXISTS(SELECT 1 FROM architecture_versions WHERE version=1);
CREATE TRIGGER IF NOT EXISTS forms_change_create AFTER INSERT ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', NEW.id, 'create', json_object('id', NEW.id, 'title', NEW.title, 'description', NEW.description, 'fields', NEW.fields, 'edit_policy', NEW.edit_policy, 'anonymous', NEW.anonymous, 'status', NEW.status, 'deadline', NEW.deadline, 'creator_id', NEW.creator_id, 'creator_name', NEW.creator_name, 'remind_people', NEW.remind_people, 'notice_id', NEW.notice_id, 'created_at', NEW.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=NEW.id))));
  INSERT INTO outbox_events(seq) VALUES (last_insert_rowid());
END;
CREATE TRIGGER IF NOT EXISTS forms_change_update AFTER UPDATE ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', NEW.id, 'update', json_object('id', NEW.id, 'title', NEW.title, 'description', NEW.description, 'fields', NEW.fields, 'edit_policy', NEW.edit_policy, 'anonymous', NEW.anonymous, 'status', NEW.status, 'deadline', NEW.deadline, 'creator_id', NEW.creator_id, 'creator_name', NEW.creator_name, 'remind_people', NEW.remind_people, 'notice_id', NEW.notice_id, 'created_at', NEW.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=NEW.id))));
END;
CREATE TRIGGER IF NOT EXISTS forms_change_delete AFTER DELETE ON forms BEGIN
  INSERT INTO content_changes(kind,item_id,operation,payload) VALUES ('forms', OLD.id, 'delete', json_object('id', OLD.id, 'title', OLD.title, 'description', OLD.description, 'fields', OLD.fields, 'edit_policy', OLD.edit_policy, 'anonymous', OLD.anonymous, 'status', OLD.status, 'deadline', OLD.deadline, 'creator_id', OLD.creator_id, 'creator_name', OLD.creator_name, 'remind_people', OLD.remind_people, 'notice_id', OLD.notice_id, 'created_at', OLD.created_at, 'submitted_users', json((SELECT json_group_array(user_id) FROM form_submissions WHERE form_id=OLD.id))));
END;
INSERT OR IGNORE INTO architecture_versions(version) VALUES (1);

-- 提交状态变化也推进表单同步序号，数据与序号在同一事务中可见。
CREATE TRIGGER IF NOT EXISTS submission_change_insert AFTER INSERT ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=NEW.form_id;
END;
CREATE TRIGGER IF NOT EXISTS submission_change_update AFTER UPDATE ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=NEW.form_id;
END;
CREATE TRIGGER IF NOT EXISTS submission_change_delete AFTER DELETE ON form_submissions BEGIN
  UPDATE forms SET status=status WHERE id=OLD.form_id;
END;

-- 用户协议同意记录（对应 migrations-v2/0003_consent.sql，DDL 必须逐字一致：
-- architecture.test.js 用 sqlite_master 的新库快照与「基线 + 迁移顺序执行」对比结构）。
-- 一人一行，user_id 作主键；version 记同意时的协议版本，落后于后端常量就要重新弹窗；
-- 撤回授权只清 flag、保留时间戳。删成员时靠外键级联连带清掉。
CREATE TABLE IF NOT EXISTS user_consents (
  user_id INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  version TEXT NOT NULL,
  terms INTEGER NOT NULL DEFAULT 0,
  chaoxing INTEGER NOT NULL DEFAULT 0,
  academic INTEGER NOT NULL DEFAULT 0,
  terms_agreed_at DATETIME,
  chaoxing_agreed_at DATETIME,
  academic_agreed_at DATETIME,
  created_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 登录失败计数（对应 migrations-v2/0004_login_attempts.sql，DDL 必须逐字一致：
-- 同样是 architecture.test.js 拿 sqlite_master 深比较的对象）。
-- 两张表只服务限流、不参与任何业务读，丢了最多是当晚的退避记录归零。
-- 主键即查询键（学号 / IP 哈希）；last_failed_at 的索引只服务清理语句的范围删除，
-- 时间列是 Unix 秒整数，理由见 models/loginAttemptModel.js 顶部：字符串时间跨时区比较太容易写错。
CREATE TABLE IF NOT EXISTS login_attempts (
  student_id TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  last_failed_at INTEGER NOT NULL
);
CREATE TABLE IF NOT EXISTS login_ip_failures (
  ip_hash TEXT PRIMARY KEY,
  failures INTEGER NOT NULL DEFAULT 0,
  window_start INTEGER NOT NULL,
  last_failed_at INTEGER NOT NULL
);
-- 每次记失败都会顺带清理过期行；清理按 last_failed_at 范围删除，给它一条索引，
-- 否则失败次数一多，这条 DELETE 会变成每次全表扫描（写入放大把自己变成 DoS 面）。
CREATE INDEX IF NOT EXISTS idx_login_attempts_last_failed_at ON login_attempts(last_failed_at);
CREATE INDEX IF NOT EXISTS idx_login_ip_failures_last_failed_at ON login_ip_failures(last_failed_at);

-- 管理操作审计日志（对应 migrations-v2/0005_audit_logs.sql，DDL 必须逐字一致：
-- architecture.test.js 用 sqlite_master 深比较新库快照与「基线 + 迁移顺序执行」）。
-- 刻意不设外键：删成员后日志必须还在；actor/target 都只是快照，detail 不含密码/邮箱明文。
CREATE TABLE IF NOT EXISTS audit_logs (
  id            INTEGER PRIMARY KEY AUTOINCREMENT,
  actor_id      INTEGER NOT NULL,            -- 操作者 users.id 快照（不设外键）
  actor_name    TEXT NOT NULL,               -- 操作时的姓名快照
  action        TEXT NOT NULL,               -- 动作码，见 README「管理操作日志」表
  target_type   TEXT,                        -- member / role / settings
  target_id     TEXT,                        -- 被操作对象（成员 id / 职位名 / 设置键），不设外键
  detail        TEXT,                        -- JSON：字段名、权限等结构性信息，无敏感值
  ip            TEXT,                        -- CF-Connecting-IP
  user_agent    TEXT,
  created_at    DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 列表按时间倒序翻页；清理按时间范围删除。两条索引分别服务这两个查询。
CREATE INDEX IF NOT EXISTS idx_audit_logs_created_at ON audit_logs(created_at);
CREATE INDEX IF NOT EXISTS idx_audit_logs_actor ON audit_logs(actor_id, created_at);

-- 全局功能开关（对应 migrations-v2/0006_app_settings.sql，DDL 必须逐字一致）。
-- 教务 / 学习通访问的紧急停用开关：关掉后门户在转发前直接 503 FEATURE_DISABLED，
-- 连私有 Worker 都不调用。没有记录时按开启处理（缺省即线上原有行为），
-- 避免升级后忘了写初始行导致功能被误关。
CREATE TABLE IF NOT EXISTS app_settings (
  key         TEXT PRIMARY KEY,              -- academic_enabled / chaoxing_enabled
  value       TEXT NOT NULL,                 -- '1' 开启 / '0' 停用
  updated_at  DATETIME NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 待办（对应 migrations-v2/0007_todos.sql，DDL 必须逐字一致）。
-- 个人待办 + 通知/活动附带的待办模板 + 每人红黄阈值；超时在查询时懒判定。
CREATE TABLE IF NOT EXISTS todos (
  id           INTEGER PRIMARY KEY AUTOINCREMENT,
  owner_id     INTEGER NOT NULL REFERENCES users(id) ON DELETE CASCADE,
  title        TEXT NOT NULL,
  description  TEXT,
  start_at     TEXT,
  due_at       TEXT NOT NULL,
  status       TEXT NOT NULL DEFAULT 'open' CHECK(status IN ('open','done','expired')),
  tags         TEXT,
  source       TEXT NOT NULL DEFAULT 'manual' CHECK(source IN ('manual','notice','activity','academic')),
  source_id    INTEGER,
  created_by   INTEGER,
  completed_at TEXT,
  created_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

CREATE INDEX IF NOT EXISTS idx_todos_owner_status_due ON todos(owner_id, status, due_at);
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_owner_source ON todos(owner_id, source, source_id) WHERE source_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS content_todos (
  kind       TEXT NOT NULL CHECK(kind IN ('notice','activity')),
  item_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  tags       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(kind, item_id)
);

CREATE TRIGGER IF NOT EXISTS notices_delete_todo AFTER DELETE ON notices BEGIN
  DELETE FROM content_todos WHERE kind = 'notice' AND item_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS activities_delete_todo AFTER DELETE ON activities BEGIN
  DELETE FROM content_todos WHERE kind = 'activity' AND item_id = OLD.id;
END;

CREATE TABLE IF NOT EXISTS todo_prefs (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  urgent_hours INTEGER NOT NULL DEFAULT 24,
  warn_hours   INTEGER NOT NULL DEFAULT 36,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- 学习通待办联动（对应 migrations-v2/0008_todo_chaoxing.sql，DDL 必须逐字一致）。
-- 新列必须用 ALTER 追加：0007 的 CREATE TABLE 已在迁移链里执行过，直接改建表语句会让
-- sqlite_master 与「基线 + 迁移」不一致。SQLite 追加列后会把 `\n, external_id TEXT` 拼进
-- 原始 SQL，这里保持与迁移文件逐字相同的写法。
ALTER TABLE todos ADD COLUMN external_id TEXT;
ALTER TABLE todos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_owner_external ON todos(owner_id, external_id) WHERE external_id IS NOT NULL;

CREATE TABLE IF NOT EXISTS todo_sync_state (
  owner_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_synced_at TEXT,
  last_attempt_at TEXT,
  last_result    TEXT,
  last_message   TEXT,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
