/**
 * Cloudflare Pages Functions 入口（catch-all：仅接管 /api/* 请求）
 * 复用 backend/src/index.js 的 Worker fetch handler，前后端同域部署。
 * 生产环境的 DB 绑定、JWT_SECRET、COOKIE_SECRET 在 Pages 项目 Dashboard → Settings 中配置。
 */
import api from '../../backend/src/index.js';

export async function onRequest(context) {
  // context = { request, env, ... }，与 Worker fetch(request, env, ctx) 签名对齐
  return api.fetch(context.request, context.env, context);
}
