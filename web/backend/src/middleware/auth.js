import { verify } from '../utils/jwt.js';

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
