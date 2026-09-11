import {
  handleCreateActivity,
  handleListActivities,
  handleGetActivity,
  handleUpdateActivity,
  handleDeleteActivity
} from '../handlers/activityHandler.js';
import { withAuth, withPermission } from '../middleware/auth.js';

/**
 * 活动路由
 * 读取需登录，发布/编辑/删除需 content:write 权限（班长/团支书/学习委员）
 */
export async function activityRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 发布活动（需 content:write）
  if (path === '/api/activities' && method === 'POST') {
    return withPermission('content:write')(handleCreateActivity)(request, env, ctx);
  }

  // 获取活动列表（需登录）
  if (path === '/api/activities' && method === 'GET') {
    return withAuth(handleListActivities)(request, env, ctx);
  }

  // 获取/更新/删除单条活动
  const match = path.match(/^\/api\/activities\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'GET') {
      return withAuth((req, env, user) =>
        handleGetActivity(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'PUT') {
      return withPermission('content:write')((req, env, user) =>
        handleUpdateActivity(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withPermission('content:write')((req, env, user) =>
        handleDeleteActivity(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
