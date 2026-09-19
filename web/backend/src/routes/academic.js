import { withAuth } from '../middleware/auth.js';
import { error, jsonResponse } from '../utils/response.js';

const PREFIX = '/api/academic/';

/**
 * 教务系统路由 —— 只做转发。
 *
 * 访问教务系统的实现（接口清单、CAS 代登录复刻、字段归一化、缓存决策、教务那几张表）
 * 已经整体挪到独立的私有 Worker `class-assistant-private-api`，本仓库不再包含这部分代码。
 * 这里只负责：认过登录态 → 把身份与原始请求交给那个 Worker → 把它的响应原样回给前端。
 *
 * 三条设计约束，都是为了「拆出去」这一步对上层零影响：
 *
 *   1. **路径与响应体逐字不变**。私有 Worker 监听的正是 /api/academic/*，用的也是同一套
 *      success / error 信封与错误码（ACADEMIC_EXPIRED / ACADEMIC_UNREACHABLE / NOT_BOUND …），
 *      所以前端 assets/js/academic.js、安卓的离线预热清单、以及所有已缓存的数据都不用动。
 *   2. **不经过公网**。走 Service Binding（绑定名 ACADEMIC_API），请求直接调到那个 Worker，
 *      它自己没有 workers.dev 子域、也没有任何 route，公网上不存在入口。绑定之外还带一个
 *      共享的 INTERNAL_TOKEN —— 万一哪天误配了一条公开路由，没有令牌照样进不来。
 *   3. **鉴权仍然在这里**。withAuth 解 JWT 并从库中载入最新用户，再把 id 与学号通过请求头
 *      传过去；私有 Worker 不再重复校验登录态。
 *
 * 路由清单（方法与查询参数的含义见私有仓）：
 * - GET    /api/academic/status     绑定状态 + 已缓存学期
 * - POST   /api/academic/bind       绑定（body: { cookies }）
 * - POST   /api/academic/login      用学号+密码代登录（body: { student_id, password }）
 * - POST   /api/academic/mfa/send   下发二次验证码（body: { token }）
 * - POST   /api/academic/mfa/verify 提交验证码完成绑定（body: { token, code }）
 * - DELETE /api/academic/bind       解绑并清缓存
 * - GET    /api/academic/timetable  课表（?xnxq= 学期，?refresh=1 强制重抓）
 * - GET    /api/academic/credits    学业达成 / 学分（?refresh=1 强制重抓）
 * - GET    /api/academic/grades     课程成绩（?xnxq= 学期，省略/留空 = 全部学期；?refresh=1 强制重抓）
 */
export async function academicRoutes(request, env, ctx) {
  if (!new URL(request.url).pathname.startsWith(PREFIX)) return null;
  return withAuth(forwardToAcademicService)(request, env, ctx);
}

/**
 * 把请求转发给私有 Worker。
 *
 * 不该匹配的路径（比如 /api/academic/does-not-exist）也一并转过去：那边没认领时返回的
 * 404 与本站的 404 是同一个响应体，所以「接口不存在」这个行为与拆分前一致。
 */
async function forwardToAcademicService(request, env, user) {
  const binding = env.ACADEMIC_API;
  if (!binding) {
    // 兜底：某个环境没配这条绑定（production 与 preview 现在都配了，防的是将来新加的环境）。
    // 这里给一个明确的 503，而不是让「读 undefined 的方法」变成 500 —— 前端能把这一档和
    // 「服务端崩了」分开。
    console.error('未绑定 ACADEMIC_API：教务功能在该环境下不可用');
    return jsonResponse(error('教务功能暂时不可用，请稍后重试', 'ACADEMIC_UNAVAILABLE'), 503);
  }

  const token = env.INTERNAL_TOKEN;
  if (!token) {
    console.error('未配置 INTERNAL_TOKEN，无法调用教务服务');
    return jsonResponse(error('服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED'), 500);
  }

  const headers = new Headers();
  headers.set('X-Internal-Token', token);
  headers.set('X-User-Id', String(user.id));
  headers.set('X-Student-Id', user.student_id || '');
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  const init = { method: request.method, headers };
  // 先读成文本再转交：绑定两侧的流不能直接对接，而教务这几个接口的 body 都很小。
  // 判一次 request.body 是为了别给本来没有 body 的请求（DELETE 解绑）凭空造一个空串。
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = await request.text();
  }

  let res;
  try {
    // 用原始 URL 即可：私有 Worker 只读 pathname 与 search，主机名不参与路由
    res = await binding.fetch(request.url, init);
  } catch (e) {
    console.error('调用教务服务失败:', e && e.message);
    return jsonResponse(error('教务功能暂时不可用，请稍后重试', 'ACADEMIC_UNAVAILABLE'), 503);
  }

  // 原样透传状态码与响应体（含那套错误码），只补 Content-Type；CORS 由外层统一加
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}
