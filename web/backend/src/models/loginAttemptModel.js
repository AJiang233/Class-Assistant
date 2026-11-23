/**
 * 登录失败计数与退避（issue #104：登录接口缺少失败限流与退避，学号可被在线撞库）。
 *
 * 两件事，都围绕「让猜密码变慢」，而不是「把账号锁死」：
 *
 * 1. 按学号计数：连续失败到阈值后，下一次尝试得等 30s，再错 120s，再错 600s，
 *    第 8 次起 1 小时封顶。**故意不做长期硬锁定** —— 学号在班级里是公开信息
 *    （成员列表、提醒对象、CSV 导出都有），硬锁定等于给任何人一个「输入同学学号
 *    就能把他关在门外」的按钮。退避的截止时间是从「最后一次失败」往前推的，
 *    所以攻击者想一直拖住某个人，就得每次退避到期都重新打一次，而他每打一次只是
 *    把对方续进同一档，等待时间不会继续膨胀。
 *
 * 2. 按来源 IP 计数：同一 IP 在窗口内的失败次数超上限就直接 429。这条防的是
 *    「一个弱口令喷洒全班」——按学号的退避对「每个账号只试一次」完全无效，
 *    而班级场景里这种喷洒最省事、也最容易得手。只计失败，不计成功：全班挤在
 *    同一个校园 NAT 后面是常态，按请求数限流会在早高峰误伤正常登录。
 *
 * 为什么计数落在 D1 而不是 Workers 内存 / KV：Worker 实例随时回收，内存计数等于没有；
 * KV 是最终一致的，并发请求读到的往往是旧值，限流会被直接绕过。D1 的写入是串行的，
 * 下面每条计数都是一句原子自增 SQL，没有读-改-写窗口。
 *
 * 时间一律用 Unix 秒（整数）。跨时区、以及 CURRENT_TIMESTAMP 的字符串格式在比较时
 * 都容易出错，整数最不容易写错。
 */

/** 连续失败到第几次开始退避（前 4 次输了就是普通 401，正常用户输错一两次毫无感知） */
export const FAILURE_THRESHOLD = 5;
/** 退避档位（秒）：第 5、6、7 次失败后分别等 30s / 2min / 10min，第 8 次起 1 小时封顶 */
const BACKOFF_LADDER = [30, 120, 600, 3600];
/** 静默期：超过这么久没再失败，旧账一笔勾销（几个月前手滑过三次不该拖累今天） */
export const RESET_AFTER_SECONDS = 24 * 60 * 60;
/** IP 失败计数窗口（秒）与上限 */
export const IP_WINDOW_SECONDS = 600;
export const IP_FAILURE_LIMIT = 50;
/** IP 行留多久：窗口过期后这行就没用了，留 1 小时只是让清理不必和窗口精确对齐 */
const IP_RETENTION_SECONDS = 60 * 60;

/** 当前 Unix 秒（导出出来给测试与调用方对齐口径，避免各处各写一遍） */
export function nowSeconds() {
  return Math.floor(Date.now() / 1000);
}

/**
 * 第 N 次连续失败之后要等多少秒才能再试；阈值以下返回 0。
 * 纯函数，退避档位只有这一处定义，检查与描述（Retry-After）共用同一份计算。
 */
export function backoffSeconds(failures) {
  const n = Math.floor(Number(failures)) || 0;
  if (n < FAILURE_THRESHOLD) return 0;
  const step = Math.min(n - FAILURE_THRESHOLD, BACKOFF_LADDER.length - 1);
  return BACKOFF_LADDER[step];
}

/**
 * 客户端 IP 的哈希（SHA-256，hex）。
 *
 * 库里不留明文 IP：限流只需要「是不是同一个来源」，不需要知道是谁。哈希挡不住
 * 有 CPU 的人枚举 IPv4 空间，但它能保证一次数据泄露不至于连带整张访问者 IP 名单。
 * 前缀是固定的域分隔串，不当作密钥（不作为安全性来源）。
 */
export async function hashClientIp(ip) {
  const data = new TextEncoder().encode('class-assistant:login-ip:' + ip);
  const digest = await crypto.subtle.digest('SHA-256', data);
  return Array.from(new Uint8Array(digest), (b) => b.toString(16).padStart(2, '0')).join('');
}

/**
 * 从「锚点时刻 + 要等的秒数」算出还剩多少秒，0 表示现在就可以试。
 * 向上取整：Retry-After 是整数秒，宁可多等不到 1 秒，也不要下发 0 让人立刻重试。
 */
function remainingSeconds(anchorSeconds, waitSeconds, now) {
  if (waitSeconds <= 0) return 0;
  const left = Number(anchorSeconds) + waitSeconds - now;
  return left > 0 ? Math.ceil(left) : 0;
}

export class LoginAttemptModel {
  constructor(db) {
    this.db = db;
  }

  /**
   * 该学号现在还要被挡多少秒（0 = 放行）。
   * 键是「请求里原样传来的学号字符串」，不管这个学号在库里存不存在：
   * 不存在的学号也照样计数、照样退避，否则 429 与 401 的差异就成了学号探测器。
   */
  async accountRetryAfter(studentId, now = nowSeconds()) {
    const row = await this.db
      .prepare('SELECT failures, last_failed_at FROM login_attempts WHERE student_id = ?')
      .bind(studentId)
      .first();
    if (!row) return 0;
    // 静默期过了就不再挡：旧账留着但不再生效（下次失败会被重置成 1）
    if (now - Number(row.last_failed_at) > RESET_AFTER_SECONDS) return 0;
    return remainingSeconds(row.last_failed_at, backoffSeconds(row.failures), now);
  }

  /**
   * 记一次学号维度的失败（原子自增）。
   * 静默期判断写在 DO UPDATE 的 CASE 里，与自增是同一条语句：不存在
   * 「先读到旧值、再被别人改掉」的窗口。
   */
  async recordAccountFailure(studentId, now = nowSeconds()) {
    // 用普通 ? 占位符（与仓库里其他模型一致，D1 对 ?NNN 的支持没有先例可循），
    // 同一个值出现几次就绑几次；绑定顺序必须与出现顺序一一对应。
    await this.db
      .prepare(`
        INSERT INTO login_attempts (student_id, failures, last_failed_at)
        VALUES (?, 1, ?)
        ON CONFLICT(student_id) DO UPDATE SET
          failures = CASE WHEN ? - last_failed_at > ? THEN 1 ELSE failures + 1 END,
          last_failed_at = ?
      `)
      .bind(studentId, now, now, RESET_AFTER_SECONDS, now)
      .run();
    // 顺手删掉过了静默期的行：表里只留最近 24 小时内真的失败过的学号，
    // 不用再依赖一个定时任务（D1 没有触发器式的定时清理）。
    await this.db
      .prepare('DELETE FROM login_attempts WHERE last_failed_at < ?')
      .bind(now - RESET_AFTER_SECONDS)
      .run();
  }

  /** 登录成功：把该学号的失败账清掉（issue 的验收项之一） */
  async clearAccount(studentId) {
    await this.db
      .prepare('DELETE FROM login_attempts WHERE student_id = ?')
      .bind(studentId)
      .run();
  }

  /**
   * 该来源 IP 在窗口内是否已经打满（0 = 放行）。
   * 固定窗口，最坏情况下跨窗口边界能连发两倍上限 —— 接受这个粗糙：
   * 真正的硬闸是按学号的退避，这条只是给「喷洒全班」加个速度上限。
   */
  async ipRetryAfter(ipHash, now = nowSeconds()) {
    const row = await this.db
      .prepare('SELECT failures, window_start FROM login_ip_failures WHERE ip_hash = ?')
      .bind(ipHash)
      .first();
    if (!row) return 0;
    if (Number(row.failures) < IP_FAILURE_LIMIT) return 0;
    return remainingSeconds(row.window_start, IP_WINDOW_SECONDS, now);
  }

  /** 记一次 IP 维度的失败（跨窗口自动开新窗口） */
  async recordIpFailure(ipHash, now = nowSeconds()) {
    await this.db
      .prepare(`
        INSERT INTO login_ip_failures (ip_hash, failures, window_start, last_failed_at)
        VALUES (?, 1, ?, ?)
        ON CONFLICT(ip_hash) DO UPDATE SET
          failures = CASE WHEN ? - window_start >= ? THEN 1 ELSE failures + 1 END,
          window_start = CASE WHEN ? - window_start >= ? THEN ? ELSE window_start END,
          last_failed_at = ?
      `)
      // 绑定顺序：ip_hash、窗口起点、锚点、判断窗口的 now、窗口长度、
      // 重置窗口的 now、窗口长度、新窗口起点、锚点。
      .bind(ipHash, now, now, now, IP_WINDOW_SECONDS, now, IP_WINDOW_SECONDS, now, now)
      .run();
    await this.db
      .prepare('DELETE FROM login_ip_failures WHERE last_failed_at < ?')
      .bind(now - IP_RETENTION_SECONDS)
      .run();
  }
}
