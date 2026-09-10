import { ActivityModel } from '../models/activityModel.js';
import { UserModel } from '../models/userModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { buildCalendar } from '../utils/ics.js';
import { parseLocalDateTime, addMinutes } from '../utils/datetime.js';

const CALENDAR_DOMAIN = 'class.qxwkstudio.top';
const REMIND_MINUTES = 30;

/** 生成 32 位十六进制随机订阅密钥 */
function randomKey() {
  const bytes = new Uint8Array(16);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
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

    const origin = new URL(request.url).origin;
    const url = `${origin}/api/calendar.ics?key=${key}`;
    return jsonResponse(success({
      key,
      url,
      // iOS / macOS 用 webcal:// 可以直接唤起「订阅日历」
      webcal: url.replace(/^https?:/, 'webcal:')
    }));
  } catch (e) {
    console.error('获取日历订阅地址失败:', e);
    return jsonResponse(error('获取日历订阅地址失败', 'CALENDAR_TOKEN_FAILED'), 500);
  }
}

/**
 * 日历订阅源（用 URL 里的 key 鉴权，供系统日历定时拉取）
 */
export async function handleCalendarFeed(request, env) {
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    if (!key) {
      return new Response('missing key', { status: 400, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const userModel = new UserModel(env.DB);
    const user = await userModel.findByAuthKey(key);
    if (!user) {
      return new Response('invalid key', { status: 404, headers: { 'Content-Type': 'text/plain; charset=utf-8' } });
    }

    const activityModel = new ActivityModel(env.DB);
    const list = await activityModel.list(200, 0);

    // 日历里保留「近 30 天 ~ 未来一年」的活动，避免把很久以前的全塞进去
    const now = Date.now();
    const from = now - 30 * 24 * 60 * 60 * 1000;
    const to = now + 365 * 24 * 60 * 60 * 1000;

    const events = list
      .filter((item) => {
        const start = parseLocalDateTime(item.start_time);
        return start != null && start >= from && start <= to;
      })
      .map((item) => ({
        uid: `activity-${item.id}@${CALENDAR_DOMAIN}`,
        title: item.title,
        description: item.content,
        location: item.location,
        start: item.start_time,
        // 没填结束时间就按 1 小时算，避免零长度事件
        end: item.end_time || addMinutes(item.start_time, 60)
      }))
      .sort((a, b) => (parseLocalDateTime(a.start) || 0) - (parseLocalDateTime(b.start) || 0));

    const calendar = buildCalendar(events, `${user.name} - 班级助理`, REMIND_MINUTES);
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
    return new Response('calendar error', {
      status: 500,
      headers: { 'Content-Type': 'text/plain; charset=utf-8' }
    });
  }
}
