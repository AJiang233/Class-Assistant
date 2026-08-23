import {
  handleCreateNotice,
  handleListNotices,
  handleGetNotice,
  handleUpdateNotice,
  handleDeleteNotice
} from '../handlers/noticeHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 通知路由（全部需要认证）
 */
export async function noticeRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 发布通知
  if (path === '/api/notices' && method === 'POST') {
    return withAuth(handleCreateNotice)(request, env, ctx);
  }

  // 获取通知列表
  if (path === '/api/notices' && method === 'GET') {
    return withAuth(handleListNotices)(request, env, ctx);
  }

  // 获取/更新/删除单条通知
  const match = path.match(/^\/api\/notices\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'GET') {
      return withAuth((req, env, ctx, user) =>
        handleGetNotice(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'PUT') {
      return withAuth((req, env, ctx, user) =>
        handleUpdateNotice(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withAuth((req, env, ctx, user) =>
        handleDeleteNotice(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
