import { verify } from '../utils/jwt.js';
import { UserModel } from '../models/userModel.js';
import { RoleModel } from '../models/roleModel.js';
import { hasPermission, buildRoleMap } from '../utils/permissions.js';

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

function jsonError(status, message, code) {
  return new Response(JSON.stringify({
    success: false,
    error: message,
    code
  }), {
    status,
    headers: { 'Content-Type': 'application/json' }
  });
}

function tokenVersionOf(user) {
  const n = Number(user && user.token_version);
  return Number.isFinite(n) ? n : 0;
}

/**
 * 需要认证的路由包装器
 * handler 签名统一为 (request, env, user)，user 为数据库里的最新资料。
 */
export function withAuth(handler) {
  return async (request, env, ctx) => {
    const authResult = await authenticate(request, env.JWT_SECRET);
    if (!authResult.valid) {
      return jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED');
    }

    const userModel = new UserModel(env.DB);
    const fresh = await userModel.findById(authResult.user.id);
    if (!fresh) {
      return jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED');
    }

    const tokenVer = Number(authResult.user.ver ?? 0);
    if (tokenVer !== tokenVersionOf(fresh)) {
      return jsonError(401, '登录已失效，请重新登录', 'TOKEN_REVOKED');
    }

    return handler(request, env, fresh);
  };
}

/**
 * 需要指定权限的路由包装器
 * 先验证登录，再按最新用户职位检查权限，无权限返回 403
 * handler 签名统一为 (request, env, user)，传入的是最新用户信息（含 positions）
 */
export function withPermission(perm) {
  return (handler) => async (request, env, ctx) => {
    const authResult = await authenticate(request, env.JWT_SECRET);
    if (!authResult.valid) {
      return jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED');
    }

    // 用最新用户数据判断权限，保证职位变更即时生效
    const userModel = new UserModel(env.DB);
    const fresh = await userModel.findById(authResult.user.id);
    if (!fresh) {
      return jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED');
    }

    const tokenVer = Number(authResult.user.ver ?? 0);
    if (tokenVer !== tokenVersionOf(fresh)) {
      return jsonError(401, '登录已失效，请重新登录', 'TOKEN_REVOKED');
    }

    // 加载自定义职位权限（roles 表），让自定义职位也能参与鉴权
    const roleModel = new RoleModel(env.DB);
    const customMap = buildRoleMap(await roleModel.list());

    if (!hasPermission(fresh.positions, perm, customMap)) {
      return jsonError(403, '没有操作权限', 'FORBIDDEN');
    }

    return handler(request, env, fresh);
  };
}
