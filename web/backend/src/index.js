import { authRoutes } from './routes/auth.js';
import { noticeRoutes } from './routes/notices.js';
import { activityRoutes } from './routes/activities.js';
import { calendarRoutes } from './routes/calendar.js';
import { academicRoutes } from './routes/academic.js';
import { formRoutes } from './routes/forms.js';
import { handleCors, corsResponse } from './middleware/cors.js';
import { logger } from './middleware/logger.js';

export default {
  async fetch(request, env, ctx) {
    const url = new URL(request.url);
    const method = request.method;

    // 日志
    logger(request, env);

    // 处理 CORS 预检请求
    if (method === 'OPTIONS') {
      return corsResponse(request);
    }

    // 路由分发
    let response = null;

    // 认证路由
    response = await authRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 通知路由
    response = await noticeRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 活动路由
    response = await activityRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 日历订阅路由
    response = await calendarRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 教务系统路由
    response = await academicRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 表单路由
    response = await formRoutes(request, env, ctx);
    if (response) return addCors(response, request);

    // 404
    return addCors(
      new Response(JSON.stringify({
        success: false,
        error: '接口不存在',
        code: 'NOT_FOUND'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      }),
      request
    );
  }
};

/**
 * 为响应添加 CORS 头
 */
function addCors(response, request) {
  const corsHeaders = handleCors(request);
  const newHeaders = new Headers(response.headers);
  for (const [key, value] of Object.entries(corsHeaders)) {
    newHeaders.set(key, value);
  }
  return new Response(response.body, {
    status: response.status,
    statusText: response.statusText,
    headers: newHeaders
  });
}
