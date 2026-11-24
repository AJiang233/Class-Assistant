-- 用户协议同意记录：登录前必须先同意《用户协议》，两项可选授权（学习通 / 教务系统）分别留痕。
--
-- 每人在本表最多一行（user_id 作主键），所以不需要额外的唯一索引。version 记的是
-- 同意时的协议版本：协议改版后这个值落后于后端的 AGREEMENT_VERSION，登录时据此
-- 重新弹窗并要求重新勾选。旧版本号不会被就地改写，保留「当时同意的是哪一版」。
--
-- 三个时间戳的语义：terms / chaoxing / academic 各自一个「最近一次开启授权的时间」。
-- 撤回授权只把对应 flag 置 0，不清时间戳 —— 时间戳回答的是「什么时候授权过」，
-- 清掉等于伪造历史；重新开启时才刷新成当前时间。
--
-- 删除成员时靠外键 ON DELETE CASCADE 连带清掉。users_delete_subscriptions 那条
-- 触发器里列的清理表清单没有这张表，也不需要加：级联比触发器更难漏。
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
