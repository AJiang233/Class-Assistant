/**
 * 查询参数收敛，避免 ?limit=999999 把 D1 打满。
 */

export function clampInt(raw, min, max, fallback) {
  const n = parseInt(raw, 10);
  if (Number.isNaN(n)) return fallback;
  return Math.min(max, Math.max(min, n));
}

export function pageLimit(url, fallback = 50, max = 100) {
  return clampInt(url.searchParams.get('limit'), 1, max, fallback);
}

export function pageOffset(url, max = 10000) {
  return clampInt(url.searchParams.get('offset'), 0, max, 0);
}
