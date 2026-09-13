/**
 * 一条待提醒的活动（只保留提醒与卡片需要的字段）。
 */
export class SchoolEvent {
  id: number = 0;
  title: string = '';
  startMillis: number = 0;
  location: string = '';

  constructor(id: number, title: string, startMillis: number, location: string) {
    this.id = id;
    this.title = title;
    this.startMillis = startMillis;
    this.location = location;
  }
}

/** 落盘到首选项里的活动结构（字段名与安卓端缓存保持一致） */
export interface EventData {
  id: number;
  title: string;
  start: number;
  location: string;
}

/**
 * 服务端时间是不带时区的「本地时间」字符串（如 2026-09-10 21:09:00），
 * 直接按设备时区拆字段构造，不做 UTC 换算。
 */
export function parseServerTime(text: string): number {
  if (text.length === 0) {
    return 0;
  }
  const value: string = text.trim().replace('T', ' ');
  const parts: string[] = value.split(' ');
  if (parts.length < 2) {
    return 0;
  }
  const dateParts: string[] = parts[0].split('-');
  const timeParts: string[] = parts[1].split(':');
  if (dateParts.length < 3 || timeParts.length < 2) {
    return 0;
  }
  const year: number = Number(dateParts[0]);
  const month: number = Number(dateParts[1]);
  const day: number = Number(dateParts[2]);
  const hour: number = Number(timeParts[0]);
  const minute: number = Number(timeParts[1]);
  const second: number = timeParts.length >= 3 ? Number(timeParts[2]) : 0;
  if (Number.isNaN(year) || Number.isNaN(month) || Number.isNaN(day) ||
    Number.isNaN(hour) || Number.isNaN(minute)) {
    return 0;
  }
  return new Date(year, month - 1, day, hour, minute, second).getTime();
}

function pad2(value: number): string {
  return value < 10 ? '0' + value.toString() : value.toString();
}

/** 09:30 */
export function formatClock(millis: number): string {
  const d: Date = new Date(millis);
  return pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

/** 09-12 09:30 */
export function formatDayClock(millis: number): string {
  const d: Date = new Date(millis);
  return pad2(d.getMonth() + 1) + '-' + pad2(d.getDate()) + ' ' +
    pad2(d.getHours()) + ':' + pad2(d.getMinutes());
}

export function isSameDay(a: number, b: number): boolean {
  const da: Date = new Date(a);
  const db: Date = new Date(b);
  return da.getFullYear() === db.getFullYear() &&
    da.getMonth() === db.getMonth() &&
    da.getDate() === db.getDate();
}
