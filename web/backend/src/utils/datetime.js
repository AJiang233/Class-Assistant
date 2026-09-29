/**
 * 班务时间按北京时间字符串（YYYY-MM-DD HH:mm:ss）存储。
 * 与时间戳互转时固定使用 UTC+8，不能依赖 Worker 或开发机的宿主时区。
 */
const LOCAL_OFFSET_MS = 8 * 60 * 60 * 1000;

/** 时间戳转为库内北京时间字符串。 */
export function formatLocalDateTime(ms = Date.now()) {
  return new Date(ms + LOCAL_OFFSET_MS).toISOString().slice(0, 19).replace('T', ' ');
}

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
  const d = new Date(`${matched[1]}-${matched[2]}-${matched[3]}T${matched[4]}:${matched[5]}:${matched[6] || '00'}Z`);
  // Date 会把越界值静默进位（2 月 30 日 → 3 月 2 日、25 点 → 次日 1 点），
  // 回读比对不一致即判为非法，否则定时发布的提醒会被悄悄挪到别的时间
  if (d.getUTCFullYear() !== parts[0] || d.getUTCMonth() !== parts[1] - 1 || d.getUTCDate() !== parts[2]
    || d.getUTCHours() !== parts[3] || d.getUTCMinutes() !== parts[4] || d.getUTCSeconds() !== parts[5]) {
    return null;
  }
  return d.getTime() - LOCAL_OFFSET_MS;
}

/** 本地时间加 N 分钟，仍返回 YYYY-MM-DD HH:mm:ss */
export function addMinutes(value, minutes) {
  const ms = parseLocalDateTime(value);
  if (ms == null) return '';
  return formatLocalDateTime(ms + minutes * 60 * 1000);
}

/** 通知与活动共用：开始时间必填，结束可空且不能早于开始。 */
export function normalizeTimeRange(startValue, endValue) {
  const start = toLocalDateTime(startValue);
  const emptyEnd = endValue == null || endValue === '';
  const end = emptyEnd ? null : toLocalDateTime(endValue);
  if (!start || (!emptyEnd && !end) || (end && end < start)) return null;
  return { start, end };
}
