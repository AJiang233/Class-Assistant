import { ActivityModel } from '../models/activityModel.js';
import { NoticeModel } from '../models/noticeModel.js';
import { SettingModel } from '../models/settingModel.js';
import { UserModel } from '../models/userModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { buildCalendar } from '../utils/ics.js';
import { parseLocalDateTime, addMinutes, formatLocalDateTime } from '../utils/datetime.js';
import { clampInt } from '../utils/query.js';
import { canView, loadViewer } from '../utils/audience.js';

const CALENDAR_DOMAIN = 'class.qxwkstudio.top';
const DAY_MS = 24 * 60 * 60 * 1000;
const WEEK_MS = 7 * DAY_MS;
/** 合并后的事件总上限：整份订阅源会被手机日历反复全量解析，条目太多会拖慢客户端 */
const MAX_EVENTS = 200;
/**
 * 各来源先各自限流，再合并排序截断。
 * 课表是「一门课按周展开成十几条」的来源，如果先放进同一个名额池，一门一周五次的课
 * 就能把活动与待办挤出去 —— 所以每类各自设上限，谁也别想独占 200 条。
 */
const MAX_ACTIVITY_EVENTS = 120;
const MAX_NOTICE_EVENTS = 120;
const MAX_COURSE_EVENTS = 120;
const MAX_TODO_EVENTS = 100;

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
  return {
    remind: clampInt(q.get('remind'), 0, 1440, 30),   // 提前提醒分钟数，0 = 不提醒
    past: clampInt(q.get('past'), 0, 365, 30),        // 包含过去多少天
    future: clampInt(q.get('future'), 1, 730, 365),   // 包含未来多少天
    notices: q.get('notices') === '1',                // 是否把通知也放进日历（默认关）
    // 课程与待办是「本人自己的事」，默认放进来；订阅链接里写 courses=0 / todos=0 可关掉
    courses: q.get('courses') !== '0',
    todos: q.get('todos') !== '0'
  };
}

function startKey(value) {
  const text = String(value || '');
  const full = text.length === 10 ? `${text} 00:00:00` : text;
  return parseLocalDateTime(full) || 0;
}

/** 北京时间字符串里的星期几：1=周一 … 7=周日（与教务课表的 weekday 口径一致） */
function weekdayOf(date) {
  const day = new Date(`${date}T00:00:00Z`).getUTCDay();
  return day === 0 ? 7 : day;
}

/** 不可见条目不占日历名额；两种内容共用同一分页与受众判定。 */
async function calendarRows(model, viewer, from, to, limit = MAX_EVENTS) {
  const out = [];
  for (let offset = 0; out.length < limit; offset += limit) {
    const rows = await model.listForCalendar(from, to, limit, offset);
    for (const row of rows) {
      if (canView(row.remind_people, viewer)) out.push(row);
      if (out.length === limit) break;
    }
    if (rows.length < limit) break;
  }
  return out;
}

/**
 * 读取本人课表（走 Service Binding，不带 refresh —— 只读私有 Worker 的缓存，不出网访问教务）。
 *
 * 任何一步不可用都返回 null：没配绑定、没配内部令牌、上游报错/未绑定/会话过期。
 * 日历订阅是系统日历后台定时拉的，一旦返回 500，iOS 会把整条订阅标记成取不到并把
 * 已有事件清掉 —— 所以这里宁可少一段课程，也不能让整份 feed 失败。
 */
async function loadTimetable(request, env, user) {
  const binding = env.ACADEMIC_API;
  if (!binding || typeof binding.fetch !== 'function') return null;
  const token = env.INTERNAL_TOKEN;
  if (!token) return null;

  // 管理员「紧急停用教务」后，订阅源也不能继续把缓存里的课表发出去 ——
  // 否则开关只挡住了页面，系统日历照旧每天提醒上课，等于没停。
  const settings = new SettingModel(env.DB);
  if (!(await settings.isEnabled('academic'))) return null;

  // 请求头与 routes/academic.js 转发时保持一致：私有 Worker 靠这三个头认人
  const headers = new Headers();
  headers.set('X-Internal-Token', String(token));
  headers.set('X-User-Id', String(user.id));
  headers.set('X-Student-Id', user.student_id || '');

  try {
    const url = `${new URL(request.url).origin}/api/academic/timetable`;
    const res = await binding.fetch(url, { method: 'GET', headers });
    // 未绑定（NOT_BOUND）、学期为空、维护中都属于「正常但没数据」，静默跳过即可
    if (!res || !res.ok) return null;
    const body = await res.json();
    if (!body || body.success !== true || !body.data) return null;
    return body.data;
  } catch (e) {
    console.error('读取课表失败，日历本次跳过课程:', e && e.message);
    return null;
  }
}

/**
 * 把课表展开成 from~to 窗口内的每次课。
 *
 * 口径（与 assets/js/academic.js 的课表渲染一致）：
 *   · firstDate 是第 1 周周一的日期，week = floor(距 firstDate 的天数 / 7) + 1；
 *   · weekday 1=周一 … 7=周日；weeks 是「这门课在第几周上」的数组（单双周/轮换课）；
 *   · start/end 是 HH:MM 的本地时刻。
 * UID 用「课程下标 + 日期」，同一次课在多份订阅、多次拉取之间保持一致，
 * 客户端才不会把同一节课当成新事件反复添加/提醒。
 */
function expandCourses(timetable, from, to, limit) {
  const out = [];
  if (!timetable || typeof timetable !== 'object') return out;

  const firstDate = String(timetable.firstDate || '').slice(0, 10);
  const firstAt = parseLocalDateTime(`${firstDate} 00:00:00`);
  if (firstAt == null) return out;

  const courses = Array.isArray(timetable.courses) ? timetable.courses : [];
  if (!courses.length) return out;
  const weekCount = Number(timetable.weekCount) || 0;

  let dayAt = parseLocalDateTime(`${formatLocalDateTime(from).slice(0, 10)} 00:00:00`);
  if (dayAt == null) return out;

  for (; dayAt <= to && out.length < limit; dayAt += DAY_MS) {
    const date = formatLocalDateTime(dayAt).slice(0, 10);
    const week = Math.floor((dayAt - firstAt) / WEEK_MS) + 1;
    if (week < 1) continue;                       // 学期还没开始
    if (weekCount > 0 && week > weekCount) continue; // 学期已经结束
    const weekday = weekdayOf(date);

    for (let i = 0; i < courses.length && out.length < limit; i++) {
      const course = courses[i] || {};
      if (Number(course.weekday) !== weekday) continue;
      const weeks = Array.isArray(course.weeks) ? course.weeks.map(Number) : [];
      if (weeks.indexOf(week) < 0) continue;      // 本周不上这门课（单双周 / 前半学期课）

      const startClock = /^\d{2}:\d{2}$/.test(String(course.start || '')) ? String(course.start) : '';
      if (!startClock) continue;                  // 节次时间缺失的脏数据跳过，不猜
      const start = `${date} ${startClock}:00`;
      const startAt = parseLocalDateTime(start);
      if (startAt == null || startAt < from || startAt > to) continue;

      const endClock = /^\d{2}:\d{2}$/.test(String(course.end || '')) ? String(course.end) : '';
      let end = endClock ? `${date} ${endClock}:00` : '';
      const endAt = end ? parseLocalDateTime(end) : null;
      // 起止相等或倒挂（教务排课脏数据）时按 60 分钟兜底，避免零长度 / 负长度事件
      if (endAt == null || endAt <= startAt) end = addMinutes(start, 60);

      out.push({
        uid: `course-${i}-${date.replace(/-/g, '')}@${CALENDAR_DOMAIN}`,
        title: course.name || '课程',
        description: [
          course.teacher ? `教师：${course.teacher}` : '',
          course.room ? `教室：${course.room}` : '',
          `第 ${week} 周`
        ].filter(Boolean).join('\n'),
        location: course.room || '',
        start,
        end
      });
    }
  }
  return out;
}

const TODO_SOURCE_LABELS = { notice: '通知', activity: '活动', academic: '学业同步' };

/** tags 存的是 JSON 数组字符串；坏数据按空数组处理，不让一条脏行拖垮整份订阅 */
function todoTags(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr.map((x) => String(x)).filter(Boolean) : [];
  } catch {
    return [];
  }
}

/** 本人进行中的待办：截止时间落在窗口内的那些，按截止时间取前 100 条（与待办页同口径：隐藏的不算） */
async function loadTodos(env, userId, fromText, toText, limit) {
  try {
    const { results } = await env.DB.prepare(
      `SELECT id, title, description, due_at, tags, source
       FROM todos
       WHERE owner_id = ? AND status = 'open' AND hidden = 0 AND due_at >= ? AND due_at <= ?
       ORDER BY due_at ASC, id ASC LIMIT ?`
    ).bind(userId, fromText, toText, limit).all();
    return results || [];
  } catch (e) {
    console.error('读取待办失败，日历本次跳过待办:', e && e.message);
    return [];
  }
}

function todoEvent(row) {
  const tags = todoTags(row.tags);
  const description = [];
  if (row.description) description.push(String(row.description));
  if (tags.length) description.push(`标签：${tags.join('、')}`);
  if (TODO_SOURCE_LABELS[row.source]) description.push(`来源：${TODO_SOURCE_LABELS[row.source]}`);
  return {
    uid: `todo-${row.id}@${CALENDAR_DOMAIN}`,
    title: `待办：${row.title}`,
    description: description.join('\n'),
    start: row.due_at,
    end: addMinutes(row.due_at, 30)  // 截止时刻起 30 分钟的「处理窗口」，避免零长度事件
  };
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
 * 支持参数：remind=提前分钟数 past=包含过去天数 future=包含未来天数
 *          notices=1 附带通知（默认关） courses=0 不含课程 todos=0 不含待办（默认都含）
 */
export async function handleCalendarFeed(request, env) {
  const textHeaders = { 'Content-Type': 'text/plain; charset=utf-8' };
  try {
    const url = new URL(request.url);
    const key = url.searchParams.get('key') || '';
    if (!key) return new Response('missing key', { status: 400, headers: textHeaders });

    const userModel = new UserModel(env.DB);
    const user = await userModel.findByAuthKey(key);
    // key 无效是鉴权失败，不是「路由不存在」：用 403 以免和 404 混淆
    if (!user) return new Response('invalid key', { status: 403, headers: textHeaders });

    // 订阅源与网页列表必须同一套可见性：key 只证明「你是谁」，不代表能看到全班内容
    const viewer = await loadViewer(env, user);

    const options = parseOptions(url);
    // 边界按「天」对齐：past=0 表示从今天 0 点起（今天的内容仍然保留，全天事件也才不会被误判为过去）
    const todayStart = parseLocalDateTime(`${formatLocalDateTime().slice(0, 10)} 00:00:00`);
    const from = todayStart - options.past * DAY_MS;
    const to = todayStart + (options.future + 1) * DAY_MS - 1;
    const fromText = formatLocalDateTime(from);
    const toText = formatLocalDateTime(to);

    const events = [];

    // 活动
    const activityModel = new ActivityModel(env.DB);
    const activities = await calendarRows(activityModel, viewer, fromText, toText, MAX_ACTIVITY_EVENTS);
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
      const notices = await calendarRows(noticeModel, viewer, fromText, toText, MAX_NOTICE_EVENTS);
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

    // 课程（默认含）：私有 Worker 不可用时静默跳过，活动与待办照常输出
    if (options.courses) {
      const timetable = await loadTimetable(request, env, user);
      events.push(...expandCourses(timetable, from, to, MAX_COURSE_EVENTS));
    }

    // 待办（默认含）：本人 open 且截止时间在窗口内的记录
    if (options.todos) {
      const rows = await loadTodos(env, user.id, fromText, toText, MAX_TODO_EVENTS);
      for (const row of rows) {
        const at = parseLocalDateTime(row.due_at);
        if (at == null || at < from || at > to) continue;
        events.push(todoEvent(row));
      }
    }

    events.sort((a, b) => startKey(a.start) - startKey(b.start));
    // 各来源已分别限流，合并后仍可能超过总上限：按时间截断，保证订阅源体积可控
    const calendar = buildCalendar(
      events.slice(0, MAX_EVENTS),
      `${user.name} - 班级助理`,
      options.remind
    );
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
