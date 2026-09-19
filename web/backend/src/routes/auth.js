import {
  handleRegister,
  handleLogin,
  handleMe,
  handleUpdateProfile,
  handleChangePassword,
  handleSendEmailCode,
  handleVerifyEmail,
  handleUnbindEmail,
  handleGetEmailSubscriptions,
  handleSetEmailSubscriptions,
  handleForgotSend,
  handleForgotReset,
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

  // 邮箱验证（需要认证）：发绑定验证码 → 验码绑定 → 解绑
  if (path === '/api/auth/email/send-code' && method === 'POST') {
    return withAuth(handleSendEmailCode)(request, env, ctx);
  }
  if (path === '/api/auth/email/verify' && method === 'POST') {
    return withAuth(handleVerifyEmail)(request, env, ctx);
  }
  if (path === '/api/auth/email/unbind' && method === 'POST') {
    return withAuth(handleUnbindEmail)(request, env, ctx);
  }

  // 邮箱订阅（需要认证）：读 / 写订阅开关。订阅区只在邮箱已验证时显示，
  // 但读接口对未验证也照常返回，前端自行决定显隐。
  if (path === '/api/auth/email/subscriptions' && method === 'GET') {
    return withAuth(handleGetEmailSubscriptions)(request, env, ctx);
  }
  if (path === '/api/auth/email/subscriptions' && method === 'POST') {
    return withAuth(handleSetEmailSubscriptions)(request, env, ctx);
  }

  // 忘记密码（公开）：发重置码 → 验码重置并登录。
  // 只认「已绑定且已验证」的邮箱，失败一律回同一句文案（防账号枚举），所以不需要登录态。
  if (path === '/api/auth/forgot/send' && method === 'POST') {
    return handleForgotSend(request, env);
  }
  if (path === '/api/auth/forgot/reset' && method === 'POST') {
    return handleForgotReset(request, env);
  }

  // 获取班级成员列表（需 user:manage 权限）
  if (path === '/api/auth/users' && method === 'GET') {
    return withPermission('user:manage')(handleListUsers)(request, env, ctx);
  }

  // 获取成员精简列表（任何登录用户，用于提醒对象选择）
  if (path === '/api/auth/members-pick' && method === 'GET') {
    return withAuth(handleListMembersPick)(request, env, ctx);
  }

  // 自定义职位：列表（任何登录用户可读，保证「管理职位」卡片能正常显示）
  if (path === '/api/auth/roles' && method === 'GET') {
    return withAuth(handleListRoles)(request, env, ctx);
  }

  // 新增/更新自定义职位（需 user:manage 权限）
  if (path === '/api/auth/roles' && method === 'POST') {
    return withPermission('user:manage')(handleCreateRole)(request, env, ctx);
  }

  // 删除自定义职位（需 user:manage 权限）
  const roleMatch = path.match(/^\/api\/auth\/roles\/(\d+)$/);
  if (roleMatch && method === 'DELETE') {
    const params = { id: roleMatch[1] };
    return withPermission('user:manage')((req, env, user) =>
      handleDeleteRole(req, env, user, params)
    )(request, env, ctx);
  }

  // 更新/删除班级成员（需 user:manage 权限）
  const match = path.match(/^\/api\/auth\/users\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'PUT') {
      return withPermission('user:manage')((req, env, user) =>
        handleUpdateUser(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withPermission('user:manage')((req, env, user) =>
        handleDeleteUser(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
