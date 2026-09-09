import { verify } from '../utils/jwt.js';
import { UserModel } from '../models/userModel.js';
import { hasPermission } from '../utils/permissions.js';

/**
 * 从请求头中提取并验证 JWT
 * @param {Request} request
 * @param {string} secret
 * @returns {Promise<{valid: boolean, user: Object|null}>}
 */
export async function authenticate(request, secret) {
  const authHeader = request.headers.get('Authorization');
  if (!authHeader) {
    return { valid: false, user: null };
  }

  const parts = authHeader.split(' ');
  if (parts.length !== 2 || parts[0] !== 'Bearer') {
    return { valid: false, user: null };
  }

  const token = parts[1];
  const payload = await verify(token, secret);

  if (!payload) {
    return { valid: false, user: null };
  }

  return { valid: true, user: payload };
}

/**
 * 需要认证的路由包装器
 * 包装后的 handler 签名：handler(request, env, ctx, user)
 */
export function withAuth(handler) {
  return async (request, env, ctx) => {
    const authResult = await authenticate(request, env.JWT_SECRET);
    if (!authResult.valid) {
      return new Response(JSON.stringify({
        success: false,
        error: '未登录或登录已过期',
        code: 'UNAUTHORIZED'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }
    return handler(request, env, authResult.user);
  };
}

/**
 * 需要指定权限的路由包装器
 * 先验证登录，再按最新用户职位检查权限，无权限返回 403
 * 包装后的 handler 签名：handler(request, env, ctx, user) —— 传入的是最新用户信息（含 positions）
 */
export function withPermission(perm) {
  return (handler) => async (request, env, ctx) => {
    const authResult = await authenticate(request, env.JWT_SECRET);
    if (!authResult.valid) {
      return new Response(JSON.stringify({
        success: false,
        error: '未登录或登录已过期',
        code: 'UNAUTHORIZED'
      }), {
        status: 401,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    // 用最新用户数据判断权限，保证职位变更即时生效
    const userModel = new UserModel(env.DB);
    const fresh = await userModel.findById(authResult.user.id);
    if (!fresh) {
      return new Response(JSON.stringify({
        success: false,
        error: '用户不存在',
        code: 'USER_NOT_FOUND'
      }), {
        status: 404,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    if (!hasPermission(fresh.positions, perm)) {
      return new Response(JSON.stringify({
        success: false,
        error: '没有操作权限',
        code: 'FORBIDDEN'
      }), {
        status: 403,
        headers: { 'Content-Type': 'application/json' }
      });
    }

    return handler(request, env, fresh);
  };
}
