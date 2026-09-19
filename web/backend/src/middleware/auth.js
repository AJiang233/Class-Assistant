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

/**
 * 这个令牌是不是在最近一次改密**之前**签发的？
 *
 * JWT 是无状态的、没有会话表可以撤销，「改密后轮换会话」只能靠这一比实现：改密时把
 * users.password_changed_at 写成当时的 Unix 秒（见 handlers/authHandler.js 的 markPasswordChanged），
 * 之后所有 iat 早于它的令牌一律拒绝 —— 也就是「密码改过，别处的登录态全部作废」。
 *
 * 代价是每个请求多一次整数比较，而 loadFreshUser 本来就要查一次 users，等于零成本。
 * password_changed_at 为 NULL（从未改过密码）时不限制；没有 iat 的令牌按过期处理。
 * 注意用 `<` 而不是 `<=`：改密当刻重新签发的令牌 iat 与 password_changed_at 同秒，
 * 必须让它继续有效，否则用户改完密码自己就被踢出去了。
 */
function tokenIssuedBeforePasswordChange(payload, fresh) {
  const changed = fresh.password_changed_at;
  if (changed === null || changed === undefined) return false;
  const iat = Number(payload && payload.iat);
  if (!Number.isFinite(iat)) return true;
  return iat < Number(changed);
}

async function loadFreshUser(request, env) {
  if (!env.JWT_SECRET) {
    console.error('未配置 JWT_SECRET，无法校验登录态');
    return { error: jsonError(500, '服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED') };
  }
  const authResult = await authenticate(request, env.JWT_SECRET);
  if (!authResult.valid) {
    return { error: jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED') };
  }

  const userModel = new UserModel(env.DB);
  const fresh = await userModel.findById(authResult.user.id);
  if (!fresh) {
    return { error: jsonError(401, '未登录或登录已过期', 'UNAUTHORIZED') };
  }
  if (tokenIssuedBeforePasswordChange(authResult.user, fresh)) {
    // 与普通 401 用同一个状态码：前端对 401 的处理就是清本地会话回登录页，正是想要的结果；
    // 单独的 code 只是让日志与排查能区分「令牌过期」和「密码改过被踢」
    return { error: jsonError(401, '密码已修改，请重新登录', 'PASSWORD_CHANGED') };
  }
  return { user: fresh };
}

/**
 * 需要认证的路由包装器
 * handler 签名统一为 (request, env, user, ctx)，user 为数据库里的最新资料。
 * ctx 透传是为了让 handler 能用 ctx.waitUntil（推送这类不该拖慢响应的收尾工作）。
 */
export function withAuth(handler) {
  return async (request, env, ctx) => {
    const loaded = await loadFreshUser(request, env);
    if (loaded.error) return loaded.error;
    return handler(request, env, loaded.user, ctx);
  };
}

/**
 * 需要指定权限的路由包装器
 * 先验证登录，再按最新用户职位检查权限，无权限返回 403
 * handler 签名统一为 (request, env, user, ctx)，传入的是最新用户信息（含 positions）
 */
export function withPermission(perm) {
  return (handler) => async (request, env, ctx) => {
    const loaded = await loadFreshUser(request, env);
    if (loaded.error) return loaded.error;

    // 加载自定义职位权限（roles 表），让自定义职位也能参与鉴权
    const roleModel = new RoleModel(env.DB);
    const customMap = buildRoleMap(await roleModel.list());

    if (!hasPermission(loaded.user.positions, perm, customMap)) {
      return jsonError(403, '没有操作权限，请联系班长或团支书', 'FORBIDDEN');
    }

    return handler(request, env, loaded.user, ctx);
  };
}
