/**
 * 服务端时间统一按「本地时间」字符串（YYYY-MM-DD HH:mm:ss）存储，
 * 客户端（展示/导出）也按本地时间理解，不做 UTC 换算。
 */

export function toLocalDateTime(value) {
  if (!value) return null;
  const matched = String(value).trim().replace('T', ' ')
    .match(/^(\d{4}-\d{2}-\d{2}) (\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!matched) return null;
  const text = `${matched[1]} ${matched[2]}:${matched[3]}:${matched[4] || '00'}`;
  // 格式对不代表值合法：交给 parseLocalDateTime 做范围回读，2026-02-30 这类必须落空
  return parseLocalDateTime(text) == null ? null : text;
}

/** 本地时间字符串 -> 毫秒时间戳；无效返回 null */
export function parseLocalDateTime(value) {
  const matched = String(value || '').replace('T', ' ')
    .match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?$/);
  if (!matched) return null;
  const parts = [
    Number(matched[1]), Number(matched[2]), Number(matched[3]),
    Number(matched[4]), Number(matched[5]), Number(matched[6] || 0)
  ];
  const d = new Date(parts[0], parts[1] - 1, parts[2], parts[3], parts[4], parts[5]);
  // Date 会把越界值静默进位（2 月 30 日 → 3 月 2 日、25 点 → 次日 1 点），
  // 回读比对不一致即判为非法，否则定时发布的提醒会被悄悄挪到别的时间
  if (d.getFullYear() !== parts[0] || d.getMonth() !== parts[1] - 1 || d.getDate() !== parts[2]
    || d.getHours() !== parts[3] || d.getMinutes() !== parts[4] || d.getSeconds() !== parts[5]) {
    return null;
  }
  return d.getTime();
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
