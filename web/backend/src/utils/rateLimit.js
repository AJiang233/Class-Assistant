/**
 * 固定窗口限流。状态存在 D1，适合 Pages Functions 这种无记忆实例。
 * 表缺失时放行并打日志，避免「代码先于迁移上线」把全班锁在门外。
 */

export function nextRateState(row, now, limit, windowMs) {
  if (!row || !row.reset_at || row.reset_at <= now) {
    return {
      allowed: true,
      count: 1,
      reset_at: now + windowMs,
      remaining: Math.max(0, limit - 1),
      retryAfterMs: 0
    };
  }
  if (row.count >= limit) {
    return {
      allowed: false,
      count: row.count,
      reset_at: row.reset_at,
      remaining: 0,
      retryAfterMs: Math.max(0, row.reset_at - now)
    };
  }
  return {
    allowed: true,
    count: row.count + 1,
    reset_at: row.reset_at,
    remaining: Math.max(0, limit - row.count - 1),
    retryAfterMs: 0
  };
}

export function clientIp(request) {
  const cf = request.headers.get('CF-Connecting-IP');
  if (cf) return cf.trim();
  const forwarded = request.headers.get('X-Forwarded-For');
  if (forwarded) return forwarded.split(',')[0].trim();
  return 'unknown';
}

export async function consumeRateLimit(db, key, limit, windowMs) {
  const now = Date.now();
  try {
    const row = await db.prepare(
      'SELECT count, reset_at FROM rate_limits WHERE key = ?'
    ).bind(key).first();
    const next = nextRateState(row, now, limit, windowMs);
    if (next.allowed) {
      await db.prepare(
        `INSERT INTO rate_limits (key, count, reset_at)
         VALUES (?, ?, ?)
         ON CONFLICT(key) DO UPDATE SET
           count = excluded.count,
           reset_at = excluded.reset_at`
      ).bind(key, next.count, next.reset_at).run();
    }
    return next;
  } catch (e) {
    console.error('限流表不可用，本次放行:', e);
    return {
      allowed: true,
      count: 0,
      reset_at: now + windowMs,
      remaining: limit,
      retryAfterMs: 0,
      degraded: true
    };
  }
}

export async function resetRateLimit(db, key) {
  try {
    await db.prepare('DELETE FROM rate_limits WHERE key = ?').bind(key).run();
  } catch (e) {
    console.error('清理限流计数失败:', e);
  }
}
