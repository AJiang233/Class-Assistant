import {
  handleAcademicBind,
  handleAcademicUnbind,
  handleAcademicStatus,
  handleAcademicTimetable,
  handleAcademicCredits,
  handleAcademicPasswordLogin,
  handleAcademicMfaSend,
  handleAcademicMfaVerify
} from '../handlers/academicHandler.js';
import { withAuth } from '../middleware/auth.js';

/**
 * 教务系统路由（均需登录）
 * - GET    /api/academic/status     绑定状态 + 已缓存学期
 * - POST   /api/academic/bind       绑定（body: { cookies }）
 * - POST   /api/academic/login      用学号+密码代登录（body: { student_id, password }）；
 *                                   账号开了多因子认证时返回 { mfaRequired, token, contact, method }
 * - POST   /api/academic/mfa/send   下发二次验证码（body: { token }）
 * - POST   /api/academic/mfa/verify 提交验证码完成绑定（body: { token, code, trust }）
 * - DELETE /api/academic/bind       解绑并清缓存
 * - GET    /api/academic/timetable  课表（?xnxq= 学期，?refresh=1 强制重抓）
 * - GET    /api/academic/credits    学业达成 / 学分（?refresh=1 强制重抓）
 */
export async function academicRoutes(request, env, ctx) {
  const path = new URL(request.url).pathname;
  const method = request.method;

  if (path === '/api/academic/status' && method === 'GET') {
    return withAuth(handleAcademicStatus)(request, env, ctx);
  }

  if (path === '/api/academic/bind' && method === 'POST') {
    return withAuth(handleAcademicBind)(request, env, ctx);
  }

  if (path === '/api/academic/login' && method === 'POST') {
    return withAuth(handleAcademicPasswordLogin)(request, env, ctx);
  }

  if (path === '/api/academic/mfa/send' && method === 'POST') {
    return withAuth(handleAcademicMfaSend)(request, env, ctx);
  }

  if (path === '/api/academic/mfa/verify' && method === 'POST') {
    return withAuth(handleAcademicMfaVerify)(request, env, ctx);
  }

  if (path === '/api/academic/bind' && method === 'DELETE') {
    return withAuth(handleAcademicUnbind)(request, env, ctx);
  }

  if (path === '/api/academic/timetable' && method === 'GET') {
    return withAuth(handleAcademicTimetable)(request, env, ctx);
  }

  if (path === '/api/academic/credits' && method === 'GET') {
    return withAuth(handleAcademicCredits)(request, env, ctx);
  }

  return null;
}
