/**
 * 查询参数收敛，避免 ?limit=999999 把 D1 打满。
 */

export function clampInt(raw, min, max, fallback) {
  // parseInt 会截断（'10abc' → 10）也会误读科学计数法（'1e9' → 1），先严格校验收敛
  const text = String(raw == null ? '' : raw).trim();
  if (!/^-?\d+$/.test(text)) return fallback;
  const n = Number(text);
  if (!Number.isFinite(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function pageLimit(url, fallback = 50, max = 100) {
  return clampInt(url.searchParams.get('limit'), 1, max, fallback);
}

export function pageOffset(url, max = 10000) {
  return clampInt(url.searchParams.get('offset'), 0, max, 0);
}
