-- 学习通待办联动（issue #99 后续）：外部来源去重、手动隐藏、同步状态。
--
-- 学习通作业/考试不是「用户主动加入」，而是每天自动拉进待办：
--   · external_id 存 `work:<workId>` / `exam:<examId>`，同一份作业只生成一条待办；
--   · hidden 让用户把已完成的学业待办从历史列表里收起来（不删数据，随时可取消隐藏）；
--   · todo_sync_state 记录每人的上次成功/尝试时间，前端据此决定是否自动同步、手动按钮降温。
--
-- 沿用 0007 的做法：列用 ALTER 追加（SQLite 会把新列拼进 sqlite_master 的原始 SQL），
-- schema.sql 尾部必须逐字重复这几条 ALTER，否则 architecture.test.js 的结构深比较会失败。
ALTER TABLE todos ADD COLUMN external_id TEXT;
ALTER TABLE todos ADD COLUMN hidden INTEGER NOT NULL DEFAULT 0;

-- 同一个人、同一个学习通来源只允许一条；手动/通知/活动待办的 external_id 为空，不受约束。
CREATE UNIQUE INDEX IF NOT EXISTS idx_todos_owner_external ON todos(owner_id, external_id) WHERE external_id IS NOT NULL;

-- 每人一条同步状态：last_synced_at 只在整轮成功后写，last_attempt_at 每次开跑都写（手动按钮 60s 降温用）。
CREATE TABLE IF NOT EXISTS todo_sync_state (
  owner_id       INTEGER PRIMARY KEY REFERENCES users(id) ON DELETE CASCADE,
  last_synced_at TEXT,
  last_attempt_at TEXT,
  last_result    TEXT,
  last_message   TEXT,
  updated_at     TEXT NOT NULL DEFAULT CURRENT_TIMESTAMP
);
