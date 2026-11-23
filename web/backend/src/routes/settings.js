import { withPermission } from '../middleware/auth.js';
import { handleGetSettings, handleUpdateSettings } from '../handlers/settingHandler.js';

/**
 * 全局功能开关路由（issue #106）。
 *
 * 单独开一个文件而不是塞进 auth.js：开关管理的是「功能可用性」，不是账号，
 * 以后加别的系统级开关也落在这里。读写都要求 user:manage —— 能停教务的人，
 * 权限等级和能删成员的人应该是一样的（班长 / 团支书）。
 */
export async function settingRoutes(request, env, ctx) {
  const path = new URL(request.url).pathname;
  if (path !== '/api/admin/settings') return null;

  if (request.method === 'GET') {
    return withPermission('user:manage')(handleGetSettings)(request, env, ctx);
  }
  if (request.method === 'PUT' || request.method === 'POST') {
    return withPermission('user:manage')(handleUpdateSettings)(request, env, ctx);
  }
  return null;
}
