/**
 * iCalendar (RFC 5545) 文本生成。
 *
 * 时间统一用「浮动时间」（既不带 Z 也不带 TZID），由日历客户端按本机时区解释——
 * 服务端存的本来就是本地时间字符串，正好对应。
 */

/** 转义 ICS 文本里的特殊字符 */
export function escapeText(value) {
  return String(value == null ? '' : value)
    .replace(/\\/g, '\\\\')
    .replace(/;/g, '\\;')
    .replace(/,/g, '\\,')
    .replace(/\r?\n/g, '\\n');
}

/** RFC 5545 要求单行不超过 75 字节，超出部分以「空格开头的续行」折行 */
function foldLine(line) {
  const encoder = new TextEncoder();
  if (encoder.encode(line).length <= 75) return line;

  let result = '';
  let current = '';
  let limit = 75;
  for (const ch of line) {
    if (encoder.encode(current + ch).length > limit) {
      result += (result ? '\r\n ' : '') + current;
      current = ch;
      limit = 74; // 续行开头多一个空格
    } else {
      current += ch;
    }
  }
  return result + (result ? '\r\n ' : '') + current;
}

/** "2026-09-10 21:09:00" -> "20260910T210900" */
export function toIcsStamp(localDateTime) {
  const m = String(localDateTime || '').replace('T', ' ')
    .match(/^(\d{4})-(\d{2})-(\d{2})[ ](\d{2}):(\d{2})(?::(\d{2}))?/);
  if (!m) return null;
  return `${m[1]}${m[2]}${m[3]}T${m[4]}${m[5]}${m[6] || '00'}`;
}

/** 当前 UTC 时间戳，如 20260910T131000Z */
export function utcStamp(date = new Date()) {
  return date.toISOString().replace(/[-:]/g, '').replace(/\.\d{3}/, '');
}

/**
 * 生成整份日历。
 * @param {Array<{uid:string,title:string,description?:string,location?:string,start:string,end?:string}>} events
 * @param {string} calendarName
 * @param {number} reminderMinutes 提前提醒分钟数，<= 0 表示不加提醒
 * @returns {string}
 */
export function buildCalendar(events, calendarName, reminderMinutes = 30) {
  const lines = [
    'BEGIN:VCALENDAR',
    'VERSION:2.0',
    'PRODID:-//Class Assistant//CN',
    'CALSCALE:GREGORIAN',
    'METHOD:PUBLISH',
    `X-WR-CALNAME:${escapeText(calendarName)}`
  ];

  for (const event of events) {
    const start = toIcsStamp(event.start);
    if (!start) continue;
    const end = toIcsStamp(event.end) || start;

    lines.push('BEGIN:VEVENT');
    lines.push(`UID:${event.uid}`);
    lines.push(`DTSTAMP:${utcStamp()}`);
    lines.push(`DTSTART:${start}`);
    lines.push(`DTEND:${end}`);
    lines.push(`SUMMARY:${escapeText(event.title || '班级活动')}`);
    if (event.description) lines.push(`DESCRIPTION:${escapeText(event.description)}`);
    if (event.location) lines.push(`LOCATION:${escapeText(event.location)}`);
    if (reminderMinutes > 0) {
      lines.push('BEGIN:VALARM');
      lines.push('ACTION:DISPLAY');
      lines.push(`DESCRIPTION:${escapeText(event.title || '班级活动')}`);
      lines.push(`TRIGGER:-PT${Math.max(1, Math.round(reminderMinutes))}M`);
      lines.push('END:VALARM');
    }
    lines.push('END:VEVENT');
  }

  lines.push('END:VCALENDAR');
  return lines.map(foldLine).join('\r\n') + '\r\n';
}
