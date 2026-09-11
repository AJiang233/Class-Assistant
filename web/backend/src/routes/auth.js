import {
  handleRegister,
  handleLogin,
  handleMe,
  handleUpdateProfile,
  handleChangePassword,
  handleListUsers,
  handleDeleteUser,
  handleUpdateUser,
  handleListMembersPick,
  handleListRoles,
  handleCreateRole,
  handleDeleteRole
} from '../handlers/authHandler.js';
import { withAuth, withPermission } from '../middleware/auth.js';

/**
 * 认证路由
 */
export async function authRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 注册（需 user:manage 权限，仅班长/团支书可注册账号）
  if (path === '/api/auth/register' && method === 'POST') {
    return withPermission('user:manage')(handleRegister)(request, env, ctx);
  }

  // 登录（公开）
  if (path === '/api/auth/login' && method === 'POST') {
    return handleLogin(request, env);
  }

  // 获取当前用户信息（需要认证）
  if (path === '/api/auth/me' && method === 'GET') {
    return withAuth(handleMe)(request, env, ctx);
  }

  // 更新当前用户自己的资料（联系方式，需要认证）
  if (path === '/api/auth/profile' && method === 'PUT') {
    return withAuth(handleUpdateProfile)(request, env, ctx);
  }

  // 修改当前用户密码（需要认证）
  if (path === '/api/auth/change-password' && method === 'POST') {
    return withAuth(handleChangePassword)(request, env, ctx);
  }

  // 获取班级成员列表（需 user:manage 权限）
  if (path === '/api/auth/users' && method === 'GET') {
    return withPermission('user:manage')(handleListUsers)(request, env, ctx);
  }

  // 获取成员精简列表（任何登录用户，用于提醒对象选择）
  if (path === '/api/auth/members-pick' && method === 'GET') {
    return withAuth(handleListMembersPick)(request, env, ctx);
  }

  // 自定义职位：列表（需 user:manage 权限）
  if (path === '/api/auth/roles' && method === 'GET') {
    return withPermission('user:manage')(handleListRoles)(request, env, ctx);
  }

  // 新增/更新自定义职位（需 user:manage 权限）
  if (path === '/api/auth/roles' && method === 'POST') {
    return withPermission('user:manage')(handleCreateRole)(request, env, ctx);
  }

  // 删除自定义职位（需 user:manage 权限）
  const roleMatch = path.match(/^\/api\/auth\/roles\/(\d+)$/);
  if (roleMatch && method === 'DELETE') {
    const params = { id: roleMatch[1] };
    return withPermission('user:manage')((req, env, c, user) =>
      handleDeleteRole(req, env, user, params)
    )(request, env, ctx);
  }

  // 更新/删除班级成员（需 user:manage 权限）
  const match = path.match(/^\/api\/auth\/users\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'PUT') {
      return withPermission('user:manage')((req, env, c, user) =>
        handleUpdateUser(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withPermission('user:manage')((req, env, c, user) =>
        handleDeleteUser(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
