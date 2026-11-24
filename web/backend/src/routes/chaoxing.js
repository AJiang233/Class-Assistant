import { withAuth } from '../middleware/auth.js';
import { ConsentModel } from '../models/consentModel.js';
import { SettingModel } from '../models/settingModel.js';
import { error, jsonResponse } from '../utils/response.js';

const PREFIX = '/api/chaoxing/';

/**
 * 学习通（超星）路由 —— 只做转发。
 *
 * 与教务同一套拆法：访问学习通的实现（登录、Cookie 会话、HTML 解析、课程 / 作业 / 考试
 * 的缓存表）整体在私有 Worker `class-assistant-private-api` 里，本仓库只负责
 * 「认登录态 → 查准入 → 把身份与原始请求交过去 → 原样回响应」。
 *
 * 四条设计约束：
 *
 *   1. **路径与响应体逐字不变**。私有 Worker 监听的正是 /api/chaoxing/*，错误码
 *      （CHAOXING_INVALID / CHAOXING_NEED_CAPTCHA / CHAOXING_UNREACHABLE / NOT_BOUND …）
 *      也由那边定义，所以前端拿到的信封与直连时完全一样。
 *   2. **不经过公网**。走 Service Binding（绑定名 CHAOXING_API，与 ACADEMIC_API 指向同一个
 *      Worker），再带一个共享的 INTERNAL_TOKEN；私有 Worker 本身没有公网入口。
 *   3. **鉴权仍然在这里**。withAuth 解 JWT 并从库中载入最新用户，再把 id 与学号通过请求头
 *      传过去；私有 Worker 不重复校验登录态。
 *   4. **学习通授权在这里把关**。用户没勾「使用本软件使用你的身份登录学习通」时，一切会拿着
 *      用户身份去碰学习通的请求都拦在门户，前端藏入口只是体验，绕过前端直接打接口同样进不来。
 *
 * 路由清单（语义见私有仓）：
 * - GET    /api/chaoxing/status          绑定状态 + 已缓存课程数
 * - POST   /api/chaoxing/bind            用上报的 Cookie 绑定（body: { cookies, account? }）
 * - POST   /api/chaoxing/bind/preview    先预览身份、不落库（body: { cookies, account? }）
 * - POST   /api/chaoxing/login           账号 + 密码代登录并绑定（body: { account, password }）
 * - DELETE /api/chaoxing/bind            解绑并清缓存
 * - GET    /api/chaoxing/courses         课程列表（?refresh=1 强制重抓）
 * - GET    /api/chaoxing/works           作业（?courseId= 单门；?refresh=1 强制重抓）
 * - GET    /api/chaoxing/exams           考试（参数同上）
 * - GET    /api/chaoxing/progress        章节任务点进度（?courseId= 单门；?nodes=1 逐节点）
 */
export async function chaoxingRoutes(request, env, ctx) {
  if (!new URL(request.url).pathname.startsWith(PREFIX)) return null;
  return withAuth(forwardToChaoxingService)(request, env, ctx);
}

/**
 * 把请求转发给私有 Worker。
 *
 * 不该匹配的路径（比如 /api/chaoxing/does-not-exist）也一并转过去：那边没认领时返回的
 * 404 与本站的 404 是同一个响应体，所以「接口不存在」的行为与拆分前一致。
 */
async function forwardToChaoxingService(request, env, user) {
  const binding = env.CHAOXING_API;
  if (!binding) {
    // 兜底：某个环境没配这条绑定（production 与 preview 都配了，防的是将来新加的环境）。
    // 给明确的 503，而不是让「读 undefined 的方法」变成 500。
    console.error('未绑定 CHAOXING_API：学习通功能在该环境下不可用');
    return jsonResponse(error('学习通功能暂时不可用，请稍后重试', 'CHAOXING_UNAVAILABLE'), 503);
  }

  const token = env.INTERNAL_TOKEN;
  if (!token) {
    console.error('未配置 INTERNAL_TOKEN，无法调用学习通服务');
    return jsonResponse(error('服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED'), 500);
  }

  const url = new URL(request.url);

  // ---- 全局紧急停用开关（issue #106）----
  // 放在配置检查之后、consent 之前：环境没配好时先报配置；停用时连 consent 都不用查，
  // 更不去调用私有 Worker。「管理员主动止血」得给出明确的维护文案与 FEATURE_DISABLED 码，
  // 而不是一坨 503 CHAOXING_UNAVAILABLE。开关缓存 30 秒，与教务那一层完全一致。
  if (!(await new SettingModel(env.DB).isEnabled('chaoxing'))) {
    return jsonResponse(
      {
        success: false,
        error: '该功能正在维护中，请稍后再试',
        code: 'FEATURE_DISABLED',
        // retry_after 取开关缓存 TTL：最迟到那时本 isolate 会重新读库，管理员若已恢复就能进来
        data: { feature: 'chaoxing', retry_after: 30 }
      },
      503,
      { 'Retry-After': '30' }
    );
  }

  // ---- 学习通授权检查（放在配置检查之后：环境没配好时先报配置，不要误报成「没授权」）----
  // 只拦「会拿着用户身份真的出网访问学习通」的请求。撤权之后已缓存的课程 / 作业 / 考试
  // 照旧能读（不带 refresh 的 GET 走私有 Worker 的缓存，不出网），解绑与状态查询也放行 ——
  // 否则撤了权反而连解绑都做不了。
  if (touchesChaoxing(request.method, url)) {
    const consent = await new ConsentModel(env.DB).get(user.id);
    if (!consent || Number(consent.chaoxing) !== 1) {
      return jsonResponse(
        error(
          '尚未同意「使用身份登录学习通」，请到「个人中心 → 用户协议与授权」开启学习通授权',
          'CHAOXING_CONSENT_REQUIRED'
        ),
        403
      );
    }
  }

  const headers = new Headers();
  headers.set('X-Internal-Token', token);
  headers.set('X-User-Id', String(user.id));
  headers.set('X-Student-Id', user.student_id || '');
  // 学习通没有学号查询接口，本人校验只能比姓名；HTTP 头是 ByteString，中文姓名
  // 必须先 URL 编码，私有 Worker 侧 decodeURIComponent 再还原（见其 identityOf）。
  headers.set('X-User-Name', encodeURIComponent(user.name || ''));
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  const init = { method: request.method, headers };
  // 先读成文本再转交：绑定两侧的流不能直接对接，而学习通这几个接口的 body 都很小。
  // 判一次 request.body 是为了别给本来没有 body 的请求（DELETE 解绑）凭空造一个空串。
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = await request.text();
  }

  let res;
  try {
    // 用原始 URL 即可：私有 Worker 只读 pathname 与 search，主机名不参与路由
    res = await binding.fetch(request.url, init);
  } catch (e) {
    console.error('调用学习通服务失败:', e && e.message);
    return jsonResponse(error('学习通功能暂时不可用，请稍后重试', 'CHAOXING_UNAVAILABLE'), 503);
  }

  // 原样透传状态码与响应体（含那套错误码），只补 Content-Type；CORS 由外层统一加
  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 这个请求会不会真的拿着用户身份去学习通（决定要不要检查学习通授权）。
 *
 * 拦截清单只放「必须把用户身份送到学习通」的那些：
 *   · POST bind / bind/preview / login —— 绑定、预览身份、代登录；
 *   · GET courses / works / exams 且 refresh 为真 —— 强制重抓才会出网。
 *
 * 其余全部放行，尤其是：
 *   · DELETE bind（解绑）—— 撤权之后还得让人能解绑；
 *   · GET status —— 只读绑定状态与已缓存课程数；
 *   · 不带 refresh 的 GET —— 读私有 Worker 的缓存，撤权后缓存仍可看，
 *     只是不再访问学习通（这正是「撤回授权」该有的效果）。
 * 用路径与方法精确匹配，避免把 status 之类误伤；refresh 同时认 1 与 true。
 */
function touchesChaoxing(method, url) {
  const path = url.pathname;

  if (method === 'POST') {
    return path === PREFIX + 'bind'
      || path === PREFIX + 'bind/preview'
      || path === PREFIX + 'login';
  }

  if (method === 'GET') {
    const cacheable = path === PREFIX + 'courses'
      || path === PREFIX + 'works'
      || path === PREFIX + 'exams'
      || path === PREFIX + 'progress';
    if (!cacheable) return false;
    const refresh = url.searchParams.get('refresh');
    return refresh === '1' || refresh === 'true';
  }

  return false;
}
