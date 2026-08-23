import {
  handleCreateActivity,
  handleListActivities,
  handleGetActivity,
  handleUpdateActivity,
  handleDeleteActivity
} from '../handlers/activityHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 活动路由（全部需要认证）
 */
export async function activityRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 发布活动
  if (path === '/api/activities' && method === 'POST') {
    return withAuth(handleCreateActivity)(request, env, ctx);
  }

  // 获取活动列表
  if (path === '/api/activities' && method === 'GET') {
    return withAuth(handleListActivities)(request, env, ctx);
  }

  // 获取/更新/删除单条活动
  const match = path.match(/^\/api\/activities\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'GET') {
      return withAuth((req, env, ctx, user) =>
        handleGetActivity(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'PUT') {
      return withAuth((req, env, ctx, user) =>
        handleUpdateActivity(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withAuth((req, env, ctx, user) =>
        handleDeleteActivity(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
