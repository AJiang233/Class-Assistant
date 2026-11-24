-- 登录失败计数与退避（issue #104：登录接口缺少失败限流与退避，学号可被在线撞库）。
--
-- 两张表都只服务限流、不参与任何业务读，随时可以整表清空：最坏结果只是当晚的
-- 退避记录归零、攻击者多几次机会。
--
-- login_attempts 按「请求里原样传来的学号字符串」计数，不管这个学号是否存在 ——
-- 只对存在的账号计数，429 与 401 的差异本身就成了学号探测器。last_failed_at 是
-- 活跃锚点：退避截止时间 = last_failed_at + 档位秒数，静默 24 小时后旧账自动失效。
-- 只有失败才写，成功登录会把整行删掉（验收项「成功登录后清零」）。
--
-- login_ip_failures 存的是 IP 的 SHA-256，不是明文：限流只需要判断「是不是同一个
-- 来源」。只记失败、不记成功 —— 全班挤在同一个校园 NAT 后面是常态，按请求数限流
-- 会在早高峰误伤正常登录。窗口是固定的 10 分钟，跨窗口边界能连发两倍上限，
-- 这点粗糙是有意接受的：真正的硬闸是按学号的退避，这条只给「一个弱口令喷洒全班」
-- 加个速度上限。
--
-- 时间列一律 Unix 秒（整数）：跨时区、以及 CURRENT_TIMESTAMP 生成的字符串格式
-- 在比较时都容易出错，整数最不容易写错。
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
