-- 待办（issue #99）：个人待办、通知/活动附带的待办模板、每人红黄阈值。
--
-- 时间列沿用全站口径的北京时间字符串（YYYY-MM-DD HH:mm:ss）。超时不做定时任务，
-- 查询时按 due_at 与当前北京时间懒判定（见 models/todoModel.js 的 expireOverdue）。
-- 这份 DDL 与 schema.sql 尾部的同名段落必须逐字一致：architecture.test.js 会用
-- sqlite_master 深比较「新库快照」与「基线 + 迁移顺序执行」的结构。
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

-- 所有列表都按「我的 + 状态 + 截止时间」取，这条索引直接覆盖。
CREATE INDEX IF NOT EXISTS idx_todos_owner_status_due ON todos(owner_id, status, due_at);

-- 同一个通知/活动对同一个人只生成一条待办；手动待办 source_id 为空，不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_owner_source ON todos(owner_id, source, source_id) WHERE source_id IS NOT NULL;

-- 通知/活动随发布附带的待办模板（一键加入时复制成个人待办快照）。
-- 单独一张表而不是给 notices/activities 加列：那两张表的同步触发器会把整行写进
-- content_changes，加列就得同步改三组触发器；而这个功能只有网页端用，也不该进安卓同步载荷。
CREATE TABLE IF NOT EXISTS content_todos (
  kind       TEXT NOT NULL CHECK(kind IN ('notice','activity')),
  item_id    INTEGER NOT NULL,
  title      TEXT NOT NULL,
  due_at     TEXT NOT NULL,
  tags       TEXT,
  created_at TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY(kind, item_id)
);

-- 通知/活动被删时顺手清掉模板：管理员删内容、表单联动删通知都会走到这里。
CREATE TRIGGER IF NOT EXISTS notices_delete_todo AFTER DELETE ON notices BEGIN
  DELETE FROM content_todos WHERE kind = 'notice' AND item_id = OLD.id;
END;
CREATE TRIGGER IF NOT EXISTS activities_delete_todo AFTER DELETE ON activities BEGIN
  DELETE FROM content_todos WHERE kind = 'activity' AND item_id = OLD.id;
END;

-- 每人的红/黄阈值（决策 2.A）：默认 24 小时内红、36 小时内黄，越早越紧急。
-- 没有记录时按这两档默认值处理，不需要初始化行。
CREATE TABLE IF NOT EXISTS todo_prefs (
  user_id      INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  urgent_hours INTEGER NOT NULL DEFAULT 24,
  warn_hours   INTEGER NOT NULL DEFAULT 36,
  updated_at   TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
