/**
 * 服务端时间统一按「本地时间」字符串（YYYY-MM-DD HH:mm:ss）存储，
 * 客户端（展示/导出）也按本地时间理解，不做 UTC 换算。
 */

export function toLocalDateTime(value) {
  if (!value) return null;
  const matched = String(value).trim().replace('T', ' ')
    .match(/^(\d{4}-\d{2}-\d{2} \d{2}:\d{2})(:\d{2})?/);
  if (!matched) return null;
  return matched[1] + (matched[2] || ':00');
}

/** 本地时间字符串 -> 毫秒时间戳；无效返回 null */
export function parseLocalDateTime(value) {
  const matched = String(value || '').replace('T', ' ')
    .match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!matched) return null;
  return new Date(
    Number(matched[1]),
    Number(matched[2]) - 1,
    Number(matched[3]),
    Number(matched[4]),
    Number(matched[5]),
    Number(matched[6] || 0)
  ).getTime();
}

/** 本地时间加 N 分钟，仍返回 YYYY-MM-DD HH:mm:ss */
export function addMinutes(value, minutes) {
  const ms = parseLocalDateTime(value);
  if (ms == null) return '';
  const d = new Date(ms + minutes * 60 * 1000);
  const p = (n) => String(n).padStart(2, '0');
  return `${d.getFullYear()}-${p(d.getMonth() + 1)}-${p(d.getDate())} ` +
    `${p(d.getHours())}:${p(d.getMinutes())}:${p(d.getSeconds())}`;
}
