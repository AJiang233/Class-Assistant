import {
  handleCreateNotice,
  handleListNotices,
  handleListArchivedNotices,
  handleGetNotice,
  handleUpdateNotice,
  handleDeleteNotice
} from '../handlers/noticeHandler.js';
import { withAuth, withPermission } from '../middleware/auth.js';

/**
 * 通知路由
 * 读取需登录，发布/编辑/删除需 content:write 权限（班长/团支书/学习委员）
 */
export async function noticeRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 发布通知（需 content:write）
  if (path === '/api/notices' && method === 'POST') {
    return withPermission('content:write')(handleCreateNotice)(request, env, ctx);
  }

  // 获取通知列表（需登录）
  if (path === '/api/notices' && method === 'GET') {
    return withAuth(handleListNotices)(request, env, ctx);
  }

  // 归档通知列表（含已过期，需 content:write）
  if (path === '/api/notices/archive' && method === 'GET') {
    return withPermission('content:write')(handleListArchivedNotices)(request, env, ctx);
  }

  // 获取/更新/删除单条通知
  const match = path.match(/^\/api\/notices\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'GET') {
      return withAuth((req, env, user) =>
        handleGetNotice(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'PUT') {
      return withPermission('content:write')((req, env, user) =>
        handleUpdateNotice(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withPermission('content:write')((req, env, user) =>
        handleDeleteNotice(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
