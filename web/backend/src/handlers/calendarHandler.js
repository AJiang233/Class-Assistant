import { ActivityModel } from '../models/activityModel.js';
import { NoticeModel } from '../models/noticeModel.js';
import { UserModel } from '../models/userModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { buildCalendar } from '../utils/ics.js';
import { parseLocalDateTime, addMinutes } from '../utils/datetime.js';

const CALENDAR_DOMAIN = 'class.qxwkstudio.top';
const MAX_EVENTS = 200;

/** 生成 32 位十六进制随机订阅密钥 */
function randomKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 订阅地址（含 webcal 形式，便于 iOS/macOS 一键订阅） */
function buildUrls(request, key) {
  const origin = new URL(request.url).origin;
  const url = `${origin}/api/calendar.ics?key=${key}`;
  return { key, url, webcal: url.replace(/^https?:/, 'webcal:') };
}

/** 把 URL 查询参数收敛到合法范围（订阅链接本身就是「配置」） */
function parseOptions(url) {
  const q = url.searchParams;
  const clampInt = (raw, min, max, fallback) => {
    const n = parseInt(raw, 10);
    if (Number.isNaN(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  };
  return {
    remind: clampInt(q.get('remind'), 0, 1440, 30),   // 提前提醒分钟数，0 = 不提醒
    past: clampInt(q.get('past'), 0, 365, 30),        // 包含过去多少天
    future: clampInt(q.get('future'), 1, 730, 365),   // 包含未来多少天
    notices: q.get('notices') === '1'                 // 是否把通知也放进日历
  };
}

function startKey(value) {
  const text = String(value || '');
  const full = text.length === 10 ? `${text} 00:00:00` : text;
  return parseLocalDateTime(full) || 0;
}

/**
 * 获取（首次访问则生成）本人的日历订阅密钥与订阅地址（需登录）
 */
export async function handleCalendarToken(request, env, user) {
  try {
    const userModel = new UserModel(env.DB);
    let key = await userModel.getAuthKey(user.id);
    if (!key) {
      key = randomKey();
      await userModel.setAuthKey(user.id, key);
    }
    return jsonResponse(success(buildUrls(request, key)));
  } catch (e) {
    console.error('获取日历订阅地址失败:', e);
    return jsonResponse(error('获取日历订阅地址失败', 'CALENDAR_TOKEN_FAILED'), 500);
  }
}

/**
 * 重置订阅密钥（需登录）：旧链接立即失效，用于链接外泄时止损
 */
export async function handleCalendarReset(request, env, user) {
  try {
    const userModel = new UserModel(env.DB);
    const key = randomKey();
    await userModel.setAuthKey(user.id, key);
    return jsonResponse(success(buildUrls(request, key)));
  } catch (e) {
    console.error('重置日历订阅密钥失败:', e);
    return jsonResponse(error('重置日历订阅密钥失败', 'CALENDAR_RESET_FAILED'), 500);
  }
}

/**
 * 日历订阅源（用 URL 里的 key 鉴权，供系统日历定时拉取）
 * 支持参数：remind=提前分钟数 past=包含过去天数 future=包含未来天数 notices=1 时附带通知
 */
export async function handleCalendarFeed(request, env) {
  const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8' };
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    if (!key) return new Response('missing key', { status: 400, headers: textHeaders });

    const userModel = new UserModel(env.DB);
    const user = await userModel.findByAuthKey(key);
    if (!user) return new Response('invalid key', { status: 404, headers: textHeaders });

    const options = parseOptions(url);
    // 边界按「天」对齐：past=0 表示从今天 0 点起（今天的内容仍然保留，全天事件也才不会被误判为过去）
    const DAY_MS = 24 * 60 * 60 * 1000;
    const now = new Date();
    const todayStart = new Date(now.getFullYear(), now.getMonth(), now.getDate()).getTime();
    const from = todayStart - options.past * DAY_MS;
    const to = todayStart + (options.future + 1) * DAY_MS - 1;

    const events = [];

    // 活动
    const activityModel = new ActivityModel(env.DB);
    const activities = await activityModel.list(MAX_EVENTS, 0);
    for (const item of activities) {
      const start = parseLocalDateTime(item.start_time);
      if (start == null || start < from || start > to) continue;
      events.push({
        uid: `activity-${item.id}@${CALENDAR_DOMAIN}`,
        title: item.title,
        description: item.content,
        location: item.location,
        start: item.start_time,
        // 没填结束时间就按 1 小时算，避免零长度事件
        end: item.end_time || addMinutes(item.start_time, 60)
      });
    }

    // 通知（可选，作为当天全天事件）
    if (options.notices) {
      const noticeModel = new NoticeModel(env.DB);
      const notices = await noticeModel.list(MAX_EVENTS, 0);
      for (const item of notices) {
        const day = String(item.publish_time || '').slice(0, 10);
        if (!/^\d{4}-\d{2}-\d{2}$/.test(day)) continue;
        const at = parseLocalDateTime(`${day} 00:00:00`);
        if (at == null || at < from || at > to) continue;
        events.push({
          uid: `notice-${item.id}@${CALENDAR_DOMAIN}`,
          title: `通知：${item.title}`,
          description: item.content,
          start: day,
          end: addMinutes(`${day} 00:00:00`, 24 * 60), // 全天事件 DTEND 为次日（RFC 5545）
          allDay: true
        });
      }
    }

    events.sort((a, b) => startKey(a.start) - startKey(b.start));

    const calendar = buildCalendar(events, `${user.name} - 班级助理`, options.remind);
    return new Response(calendar, {
      status: 200,
      headers: {
        'Content-Type': 'text/calendar; charset=utf-8',
        'Content-Disposition': 'inline; filename="class-assistant.ics"',
        'Cache-Control': 'no-cache'
      }
    });
  } catch (e) {
    console.error('生成日历订阅失败:', e);
    return new Response('calendar error', { status: 500, headers: textHeaders });
  }
}
