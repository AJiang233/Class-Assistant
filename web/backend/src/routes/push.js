import {
  handlePushConfig,
  handlePushSubscribe,
  handlePushUnsubscribe,
  handlePushTest
} from '../handlers/pushHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * Web Push 路由
 * 全部要登录：配置要告诉前端「本机是否已订阅」，订阅也是绑在账号上的。
 */
export async function pushRoutes(request, env, ctx) {
  const path = new URL(request.url).pathname;
  const method = request.method;

  if (path === '/api/push/config' && method === 'GET') {
    return withAuth(handlePushConfig)(request, env, ctx);
  }

  if (path === '/api/push/subscribe' && method === 'POST') {
    return withAuth(handlePushSubscribe)(request, env, ctx);
  }

  if (path === '/api/push/unsubscribe' && method === 'POST') {
    return withAuth(handlePushUnsubscribe)(request, env, ctx);
  }

  if (path === '/api/push/test' && method === 'POST') {
    return withAuth(handlePushTest)(request, env, ctx);
  }

  return null;
}
