import { authRoutes } from './routes/auth.js';
import { noticeRoutes } from './routes/notices.js';
import { activityRoutes } from './routes/activities.js';
import { calendarRoutes } from './routes/calendar.js';
import { academicRoutes } from './routes/academic.js';
import { formRoutes } from './routes/forms.js';
import { pushRoutes } from './routes/push.js';
import { handleCors, corsResponse } from './middleware/cors.js';
import { logger } from './middleware/logger.js';
import { error, jsonResponse } from './utils/response.js';

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

    // 路由分发。整段包在错误边界里：任一 handler 抛出的异常都在这里收口，
    // 转成与其它失败一致的 JSON（前端才处理得了），原始异常只进日志。
    // 没有这层时异常会变成裸 500，前端拿不到 code，只能显示「未知错误」。
    try {
      return addCors(await dispatch(request, env, ctx), request);
    } catch (e) {
      console.error(`未捕获的请求异常 ${method} ${url.pathname}:`, e);
      return addCors(jsonResponse(error('服务器出错了，请稍后重试', 'INTERNAL_ERROR'), 500), request);
    }
  }
};

/**
 * 依次问各个路由：谁认领了这个请求就返回它的响应，都不认领则 404。
 * 抽成函数，是为了让 fetch 里的错误边界包住整个分发过程。
 */
async function dispatch(request, env, ctx) {
  // 认证路由
  let response = await authRoutes(request, env, ctx);
  if (response) return response;

  // 通知路由
  response = await noticeRoutes(request, env, ctx);
  if (response) return response;

  // 活动路由
  response = await activityRoutes(request, env, ctx);
  if (response) return response;

  // 日历订阅路由
  response = await calendarRoutes(request, env, ctx);
  if (response) return response;

  // 教务系统路由
  response = await academicRoutes(request, env, ctx);
  if (response) return response;

  // 表单路由
  response = await formRoutes(request, env, ctx);
  if (response) return response;

  // Web Push 路由
  response = await pushRoutes(request, env, ctx);
  if (response) return response;

  // 404
  return new Response(JSON.stringify({
    success: false,
    error: '接口不存在',
    code: 'NOT_FOUND'
  }), {
    status: 404,
    headers: { 'Content-Type': 'application/json' }
  });
}

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
