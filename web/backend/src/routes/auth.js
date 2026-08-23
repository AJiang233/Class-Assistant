import {
  handleRegister,
  handleLogin,
  handleMe
} from '../handlers/authHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 认证路由
 */
export async function authRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 注册
  if (path === '/api/auth/register' && method === 'POST') {
    return handleRegister(request, env);
  }

  // 登录
  if (path === '/api/auth/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  // 获取当前用户信息（需要认证）
  if (path === '/api/auth/me' && method === 'GET') {
    return withAuth(handleMe)(request, env, ctx);
  }

  return null;
}
