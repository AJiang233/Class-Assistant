import { handleCalendarToken, handleCalendarFeed } from '../handlers/calendarHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 日历订阅路由
 * - GET /api/calendar/token  需登录：取（或首次生成）本人订阅密钥与订阅地址
 * - GET /api/calendar.ics    用 URL 里的 key 鉴权：系统日历直接拉取的 .ics 源
 *   （日历客户端无法携带 Authorization 头，所以走密钥）
 */
export async function calendarRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  if (path === '/api/calendar/token' && method === 'GET') {
    return withAuth(handleCalendarToken)(request, env, ctx);
  }

  if (path === '/api/calendar.ics' && (method === 'GET' || method === 'HEAD')) {
    return handleCalendarFeed(request, env, ctx);
  }

  return null;
}
