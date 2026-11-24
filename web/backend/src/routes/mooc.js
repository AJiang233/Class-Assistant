import { withAuth } from '../middleware/auth.js';
import { ConsentModel } from '../models/consentModel.js';
import { SettingModel } from '../models/settingModel.js';
import { error, jsonResponse } from '../utils/response.js';

const PREFIX = '/api/mooc/';

/**
 * 中国大学MOOC（icourse163）路由 —— 只做转发。
 *
 * 与学习通完全同一套拆法：访问 icourse163 的实现（Cookie 会话、/web/j/*.rpc 调用、
 * 课程 / 章节任务点 / 作业测验的解析与缓存表）整体在私有 Worker
 * `class-assistant-private-api` 里，本仓库只负责「认登录态 → 查准入 → 转交身份 → 原样回响应」。
 *
 * 复用学习通那条 Service Binding（两者都指向同一个私有 Worker）：少一条绑定就少一处
 * 部署时漏配的可能；将来真要分开，配一个 MOOC_API 即可（下面优先读它）。
 *
 * 路由清单（语义见私有仓 src/routes/mooc.js）：
 * - GET    /api/mooc/status          绑定状态 + 已缓存课程数
 * - POST   /api/mooc/bind            用上报的 Cookie 绑定（body: { cookies, account? }）
 * - POST   /api/mooc/bind/preview    先预览身份、不落库（只读）
 * - POST   /api/mooc/login           恒 501：icourse163 是 SPA 登录，服务端代登录不可行
 * - DELETE /api/mooc/bind            解绑并清缓存
 * - GET    /api/mooc/courses         课程列表（?refresh=1 强制重抓）
 * - GET    /api/mooc/progress        章节任务点进度（?courseId= 单门；?nodes=1 逐节点）
 * - GET    /api/mooc/works           单元作业（?courseId= 单门；?refresh=1 强制重抓）
 * - GET    /api/mooc/exams           单元测验 + 考试（参数同上）
 */
export async function moocRoutes(request, env, ctx) {
  if (!new URL(request.url).pathname.startsWith(PREFIX)) return null;
  return withAuth(forwardToMoocService)(request, env, ctx);
}

async function forwardToMoocService(request, env, user) {
  const binding = env.MOOC_API || env.CHAOXING_API;
  if (!binding) {
    console.error('未绑定 MOOC_API / CHAOXING_API：中国大学MOOC 功能在该环境下不可用');
    return jsonResponse(error('中国大学MOOC 功能暂时不可用，请稍后重试', 'MOOC_UNAVAILABLE'), 503);
  }

  const token = env.INTERNAL_TOKEN;
  if (!token) {
    console.error('未配置 INTERNAL_TOKEN，无法调用中国大学MOOC服务');
    return jsonResponse(error('服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED'), 500);
  }

  const url = new URL(request.url);

  // 全局紧急停用开关：与教务/学习通同一套语义（管理员止血，不发版）
  if (!(await new SettingModel(env.DB).isEnabled('mooc'))) {
    return jsonResponse(
      {
        success: false,
        error: '该功能正在维护中，请稍后再试',
        code: 'FEATURE_DISABLED',
        data: { feature: 'mooc', retry_after: 30 }
      },
      503,
      { 'Retry-After': '30' }
    );
  }

  // 授权检查：只拦「会拿着用户身份真的出网访问 icourse163」的请求。
  // 撤权后已缓存的课程/任务点/作业照旧能读，解绑与状态查询也放行。
  if (touchesMooc(request.method, url)) {
    const consent = await new ConsentModel(env.DB).get(user.id);
    if (!consent || Number(consent.mooc) !== 1) {
      return jsonResponse(
        error(
          '尚未同意「使用身份登录中国大学MOOC」，请到「个人中心 → 用户协议与授权」开启 MOOC 授权',
          'MOOC_CONSENT_REQUIRED'
        ),
        403
      );
    }
  }

  const headers = new Headers();
  headers.set('X-Internal-Token', token);
  headers.set('X-User-Id', String(user.id));
  headers.set('X-Student-Id', user.student_id || '');
  headers.set('X-User-Name', encodeURIComponent(user.name || ''));
  const contentType = request.headers.get('Content-Type');
  if (contentType) headers.set('Content-Type', contentType);

  const init = { method: request.method, headers };
  if (request.method !== 'GET' && request.method !== 'HEAD' && request.body) {
    init.body = await request.text();
  }

  let res;
  try {
    res = await binding.fetch(request.url, init);
  } catch (e) {
    console.error('调用中国大学MOOC服务失败:', e && e.message);
    return jsonResponse(error('中国大学MOOC 功能暂时不可用，请稍后重试', 'MOOC_UNAVAILABLE'), 503);
  }

  return new Response(res.body, {
    status: res.status,
    headers: { 'Content-Type': 'application/json' }
  });
}

/**
 * 这个请求会不会真的拿着用户身份去 icourse163（决定要不要检查 MOOC 授权）。
 *
 * 与学习通同一份清单：POST bind / bind/preview / login，以及带 refresh=1 的 GET。
 * 注意 /api/mooc/login 恒 501、不碰 icourse163，但绑定意图明确，一并拦下更一致。
 */
function touchesMooc(method, url) {
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
