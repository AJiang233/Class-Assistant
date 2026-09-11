import { AcademicModel } from '../models/academicModel.js';
import { SchoolClient, SchoolSessionExpired } from '../utils/schoolApi.js';
import {
  CasError,
  loginWithPassword,
  sendMfaCode,
  verifyMfaCode,
  isMfaCodeSupported,
  mfaMethodLabel
} from '../utils/casLogin.js';
import { success, error, jsonResponse, tooManyRequests } from '../utils/response.js';
import { sameStudentId } from '../utils/identity.js';
import { sealCookies, openCookies, isSealed } from '../utils/cookieVault.js';
import { consumeRateLimit, resetRateLimit } from '../utils/rateLimit.js';

/** 课表节次方案 id（教务默认方案） */
const DEFAULT_KBJCMS_ID = 1;

/** 缓存新鲜期：超过则下次访问自动重新抓取（毫秒） */
const CACHE_TTL = 6 * 60 * 60 * 1000;

/** 多因子认证中间态有效期（毫秒） */
const MFA_TTL = 10 * 60 * 1000;

/** 一次性令牌（中间态在前后端之间传递的凭据） */
function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

const ACADEMIC_LOGIN_LIMIT = 5;
const ACADEMIC_LOGIN_WINDOW_MS = 15 * 60 * 1000;
const MFA_SEND_LIMIT = 3;
const MFA_SEND_WINDOW_MS = 10 * 60 * 1000;

/** 读出教务 Cookie；旧明文记录顺手封存回去 */
async function readBindingCookies(env, model, binding) {
  const plain = await openCookies(env, binding.cookies);
  if (plain && !isSealed(binding.cookies)) {
    await model.saveCookies(binding.user_id, await sealCookies(env, plain));
  }
  return plain;
}

async function schoolClientFromBinding(env, model, binding) {
  try {
    const cookies = await readBindingCookies(env, model, binding);
    if (!cookies) {
      return { failure: { message: '教务登录态已失效，请重新绑定', code: 'ACADEMIC_EXPIRED', status: 400 } };
    }
    return { client: new SchoolClient(cookies) };
  } catch {
    await model.markExpired(binding.user_id);
    return { failure: { message: '教务会话无法解密，请重新绑定', code: 'ACADEMIC_EXPIRED', status: 400 } };
  }
}

// ===== 通用工具 =====

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 保留一位小数，避免浮点累加出现 19.500000000000004 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** D1 的 CURRENT_TIMESTAMP 是 UTC 的 "YYYY-MM-DD HH:MM:SS"，这里统一转成时间戳 */
function parseSqlTime(value) {
  if (!value) return 0;
  const s = String(value);
  const iso = s.includes('T') ? s : s.replace(' ', 'T') + 'Z';
  const t = Date.parse(iso);
  return Number.isNaN(t) ? 0 : t;
}

function toIso(value) {
  const t = parseSqlTime(value);
  if (t) return new Date(t).toISOString();
  return value ? String(value) : '';
}

function isFresh(fetchedAt) {
  const t = parseSqlTime(fetchedAt);
  return t > 0 && Date.now() - t < CACHE_TTL;
}

/** 学期下拉项：实时列表优先，历次缓存里出现过的学期做兜底 */
function buildTerms(terms, cachedTerms, currentId) {
  const map = new Map();
  for (const t of terms || []) map.set(t.id, t.xnxqmc || t.id);
  for (const t of cachedTerms || []) if (!map.has(t.xnxq_id)) map.set(t.xnxq_id, t.xnxq_id);
  return Array.from(map, ([id, name]) => ({ id, name, current: id === currentId }));
}

function cachedTermOptions(cachedTerms, currentId) {
  return (cachedTerms || []).map((t) => ({
    id: t.xnxq_id,
    name: t.xnxq_id,
    current: t.xnxq_id === currentId
  }));
}

/** kkzcMx 形如 ",1,2,3,14," —— 教务给出的准确周次列表 */
function parseWeekList(raw) {
  const list = String(raw || '')
    .split(',')
    .map((s) => parseInt(s, 10))
    .filter((n) => Number.isFinite(n) && n > 0);
  return Array.from(new Set(list)).sort((a, b) => a - b);
}

/** kkzc 形如 "1-14" / "3-8,10-12" —— kkzcMx 缺失时的兜底解析 */
function parseWeekRange(text) {
  const out = [];
  for (const seg of String(text || '').split(/[,，;；]/)) {
    const range = seg.match(/(\d+)\s*-\s*(\d+)/);
    if (range) {
      const from = parseInt(range[1], 10);
      const to = parseInt(range[2], 10);
      for (let i = from; i <= to; i++) out.push(i);
      continue;
    }
    const single = parseInt(seg, 10);
    if (Number.isFinite(single) && single > 0) out.push(single);
  }
  return Array.from(new Set(out)).sort((a, b) => a - b);
}

// ===== 归一化 =====

/** 节次配置 → 课表网格的行（第一节 08:00-08:45 …） */
function normalizePeriods(list) {
  return (list || [])
    .filter((p) => String(p.xsflag ?? '1') === '1')
    .sort((a, b) => num(a.xh) - num(b.xh))
    .map((p) => ({
      index: num(p.xh),
      name: p.djmc || '',
      start: p.kssj || '',
      end: p.jssj || '',
      block: p.sjdbsmc || '',
      code: p.jchbmc || ''
    }));
}

/** 已排课程的字段裁剪（原始字段有几十个，只留界面用得上的） */
function normalizeCourse(c) {
  const weeks = parseWeekList(c.kkzcMx);
  return {
    id: String(c.kbid || c.jxapid || c.jxrwId || ''),
    name: c.kcmc || '',
    code: c.kcbh || '',
    teacher: c.skjs || '',
    room: c.jsmc || '',
    campus: c.xqmc || '',
    weekday: num(c.xq),
    start: c.kssj || '',
    end: c.jssj || '',
    weeks: weeks.length ? weeks : parseWeekRange(c.kkzc),
    weekText: c.kkzc || '',
    credit: num(c.xf),
    category: c.kclb || '',
    nature: c.kcsx || '',
    className: c.skbj || '',
    students: num(c.skrs)
  };
}

/** 未排课课程 */
function normalizeUnscheduled(c) {
  return {
    id: String(c.jxrwid || ''),
    name: c.kcmc || '',
    code: c.kcbm || '',
    credit: num(c.xf),
    hours: num(c.zxs),
    teacher: c.skjs || '',
    className: c.skbj || '',
    category: c.kclb || '',
    campus: c.xqmc || ''
  };
}

/** 递归展开学分树的叶子节点（只有叶子带学分数字） */
function collectCreditRows(nodes, level, out) {
  for (const node of nodes || []) {
    const children = node.xywcqkDetailsDtoList || [];
    const leaf = children.length === 0;
    const required = num(node.required);
    const remaining = num(node.remaining);
    out.push({
      level,
      name: node.kctxmc || '',
      required,
      obtained: num(node.obtained),
      current: num(node.current),
      remaining,
      // 教务对「0 学分要求」的叶子也会标 achieved，这里同时对空要求兜底
      achieved: leaf && (node.status === 'achieved' || (required === 0 && remaining === 0)),
      leaf
    });
    if (children.length) collectCreditRows(children, level + 1, out);
  }
}

/** 学业达成情况 → 看板数据（扁平行 + 汇总） */
function normalizeCredits(data) {
  const allRows = [];
  collectCreditRows(data && data.xywcqkDetailsDtoList, 1, allRows);

  // 教务在树末尾额外返回一条名为「总计」的叶子（本身不带子节点），
  // 若按叶子累加会正好翻倍，因此单独摘出来当汇总，且不混进明细
  const totalRow = allRows.find((r) => r.level === 1 && r.leaf && r.name === '总计');
  const rows = totalRow ? allRows.filter((r) => r !== totalRow) : allRows;

  const leafRows = rows.filter((r) => r.leaf);
  let required = 0;
  let obtained = 0;
  let current = 0;
  let remaining = 0;
  let achievedCount = 0;
  for (const r of leafRows) {
    required += r.required;
    obtained += r.obtained;
    current += r.current;
    remaining += r.remaining;
    if (r.achieved) achievedCount += 1;
  }

  const summary = {
    // 有「总计」行时以教务口径为准，否则退回叶子累加
    required: totalRow ? totalRow.required : round1(required),
    obtained: totalRow ? totalRow.obtained : round1(obtained),
    current: totalRow ? totalRow.current : round1(current),
    remaining: totalRow ? totalRow.remaining : round1(remaining),
    achievedCount,
    totalCount: leafRows.length
  };

  return {
    profile: {
      grade: (data && data.xsnj) || '',
      college: (data && data.xsyx) || '',
      major: (data && data.xszy) || '',
      className: (data && data.xsbj) || '',
      plan: (data && data.dqfa) || '',
      matchRate: (data && data.dqfappd) || ''
    },
    rows,
    summary
  };
}

// ===== 绑定 =====

/**
 * 校验会话并把绑定写进 D1（绑定 Cookie / 代登录两条路径共用）
 * @returns {Promise<{data?: object, failure?: {message: string, code: string, status: number}}>}
 */
async function bindWithCookies(env, user, cookies) {
  const client = new SchoolClient(cookies);
  let info;
  try {
    info = await client.sessionUserInfo();
  } catch (e) {
    if (e instanceof SchoolSessionExpired) {
      return { failure: { message: '教务登录态无效，请重新登录教务系统', code: 'ACADEMIC_INVALID', status: 400 } };
    }
    return { failure: { message: `无法连接教务系统：${e.message}`, code: 'ACADEMIC_UNREACHABLE', status: 502 } };
  }
  if (!info || !info.id) {
    return { failure: { message: '教务返回的用户信息异常，请重新登录教务系统', code: 'ACADEMIC_INVALID', status: 400 } };
  }
  if (!sameStudentId(user.student_id, info.userAccount)) {
    return { failure: { message: '教务账号与当前学号不一致，只能绑定本人', code: 'ACADEMIC_IDENTITY_MISMATCH', status: 403 } };
  }

  const model = new AcademicModel(env.DB);
  await model.saveBinding(user.id, {
    student_no: info.userAccount || '',
    real_name: info.userNameZh || '',
    school_uid: info.id,
    cookies: await sealCookies(env, cookies)
  });

  return {
    data: {
      bound: true,
      studentNo: info.userAccount || '',
      realName: info.userNameZh || ''
    }
  };
}

/** 绑定教务系统：用上报的 Cookie 调一次 sessionUserInfo 做校验，通过才落库 */
export async function handleAcademicBind(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const cookies = String(body.cookies || '').trim();
  if (!cookies) {
    return jsonResponse(error('缺少教务系统会话 Cookie', 'MISSING_COOKIES'), 400);
  }

  const result = await bindWithCookies(env, user, cookies);
  if (result.failure) {
    return jsonResponse(error(result.failure.message, result.failure.code), result.failure.status);
  }
  return jsonResponse(success(result.data));
}

/**
 * 用学号 + 密码走统一身份认证代登录，成功后直接绑定
 * 密码只在本次请求的内存里用一次，不落库、不打日志
 * 若账号开了多因子认证，则暂存 CAS 会话并返回 mfaRequired，等用户回填验证码
 */
export async function handleAcademicPasswordLogin(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const studentId = String(user.student_id || '').trim();
  const password = String(body.password || '');
  if (!studentId || !password) {
    return jsonResponse(error('请填写学号与密码', 'MISSING_CREDENTIALS'), 400);
  }
  const claimed = String(body.student_id || '').trim();
  if (claimed && !sameStudentId(claimed, studentId)) {
    return jsonResponse(error('只能绑定自己的教务账号', 'ACADEMIC_IDENTITY_MISMATCH'), 403);
  }

  const userHit = await consumeRateLimit(env.DB, `academic:user:${user.id}`, ACADEMIC_LOGIN_LIMIT, ACADEMIC_LOGIN_WINDOW_MS);
  if (!userHit.allowed) return tooManyRequests(userHit.retryAfterMs);
  const idHit = await consumeRateLimit(env.DB, `academic:id:${studentId}`, 8, ACADEMIC_LOGIN_WINDOW_MS);
  if (!idHit.allowed) return tooManyRequests(idHit.retryAfterMs);

  let session;
  try {
    session = await loginWithPassword(studentId, password);
  } catch (e) {
    if (e instanceof CasError) {
      // 需要验证码时用 409，前端据此提示改走手动绑定（401 会触发退出登录，不能用）
      const status = e.code === 'CAS_NEED_CAPTCHA' ? 409 : 400;
      return jsonResponse(error(e.message, e.code), status);
    }
    return jsonResponse(error(`统一身份认证登录失败：${e.message}`, 'CAS_ERROR'), 502);
  }

  // 认证已通过，但要求多因子二次验证：暂存会话，让前端进入第二步
  if (session.mfaRequired) {
    const type = session.state.reAuthType;
    if (!isMfaCodeSupported(type)) {
      return jsonResponse(
        error('该账号的二次验证方式不是短信/邮箱验证码，暂不支持代登录，请改用手动粘贴 Cookie 绑定', 'MFA_UNSUPPORTED'),
        400
      );
    }
    const model = new AcademicModel(env.DB);
    await model.purgeExpiredMfaSessions(MFA_TTL);
    const token = randomToken();
    await model.saveMfaSession(user.id, token, JSON.stringify(session.state));
    return jsonResponse(success({
      mfaRequired: true,
      token,
      contact: session.contact || '',
      method: mfaMethodLabel(type)
    }));
  }

  const result = await bindWithCookies(env, user, session.cookies);
  if (result.failure) {
    // 代登录路径独有的诊断：带上拿到的 Cookie 名与跳转链（只有名字，没有值）
    const hint = `已拿到 Cookie：${session.cookieNames.join(',') || '无'}；跳转：${session.hops.join(' → ')}`;
    return jsonResponse(error(`${result.failure.message}（${hint}）`, result.failure.code), result.failure.status);
  }
  await resetRateLimit(env.DB, `academic:user:${user.id}`);
  return jsonResponse(success({ ...result.data, via: 'password' }));
}

/** 中间态共用：取出本人在有效期内的 CAS 会话 */
async function loadMfaState(env, user, token) {
  if (!token) return { failure: { message: '缺少认证会话', code: 'MISSING_TOKEN', status: 400 } };
  const model = new AcademicModel(env.DB);
  const state = await model.getMfaSession(user.id, token, MFA_TTL);
  if (!state) {
    return { failure: { message: '认证会话已过期，请重新输入学号密码', code: 'MFA_EXPIRED', status: 400 } };
  }
  return { model, state };
}

/** 第二步：给绑定的手机/邮箱下发二次验证码 */
export async function handleAcademicMfaSend(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const loaded = await loadMfaState(env, user, String(body.token || ''));
  if (loaded.failure) {
    return jsonResponse(error(loaded.failure.message, loaded.failure.code), loaded.failure.status);
  }

  const mfaHit = await consumeRateLimit(env.DB, `academic:mfa:${user.id}`, MFA_SEND_LIMIT, MFA_SEND_WINDOW_MS);
  if (!mfaHit.allowed) return tooManyRequests(mfaHit.retryAfterMs);

  try {
    const sent = await sendMfaCode(loaded.state);
    return jsonResponse(success({ sent: true, mobile: sent.mobile, label: sent.label }));
  } catch (e) {
    if (e instanceof CasError) return jsonResponse(error(e.message, e.code), 400);
    return jsonResponse(error(`验证码发送失败：${e.message}`, 'MFA_SEND_FAILED'), 502);
  }
}

/** 第三步：提交验证码完成二次验证，随后换取教务会话并绑定 */
export async function handleAcademicMfaVerify(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!code) return jsonResponse(error('请填写验证码', 'MISSING_CODE'), 400);

  const loaded = await loadMfaState(env, user, String(body.token || ''));
  if (loaded.failure) {
    return jsonResponse(error(loaded.failure.message, loaded.failure.code), loaded.failure.status);
  }

  let session;
  try {
    session = await verifyMfaCode(loaded.state, code);
  } catch (e) {
    // 验证码错误时保留中间态，让用户直接重试
    if (e instanceof CasError) return jsonResponse(error(e.message, e.code), 400);
    return jsonResponse(error(`多因子认证失败：${e.message}`, 'MFA_ERROR'), 502);
  }

  const result = await bindWithCookies(env, user, session.cookies);
  await loaded.model.deleteMfaSession(String(body.token || ''));
  if (result.failure) {
    const hint = `已拿到 Cookie：${session.cookieNames.join(',') || '无'}；跳转：${session.hops.join(' → ')}`;
    return jsonResponse(error(`${result.failure.message}（${hint}）`, result.failure.code), result.failure.status);
  }
  await resetRateLimit(env.DB, `academic:user:${user.id}`);
  return jsonResponse(success({ ...result.data, via: 'password+mfa' }));
}

/** 解绑并清空教务缓存 */
export async function handleAcademicUnbind(request, env, user) {
  const model = new AcademicModel(env.DB);
  await model.removeBinding(user.id);
  return jsonResponse(success({ bound: false }));
}

/** 绑定状态（含已缓存学期，供页面先渲染下拉框） */
export async function handleAcademicStatus(request, env, user) {
  const model = new AcademicModel(env.DB);
  const binding = await model.getBinding(user.id);
  const cachedTerms = await model.listTimetableTerms(user.id);

  if (!binding) {
    return jsonResponse(success({
      bound: false,
      terms: cachedTermOptions(cachedTerms, '')
    }));
  }

  return jsonResponse(success({
    bound: true,
    status: binding.status,
    studentNo: binding.student_no || '',
    realName: binding.real_name || '',
    boundAt: toIso(binding.bound_at),
    checkedAt: toIso(binding.checked_at),
    terms: cachedTermOptions(cachedTerms, '')
  }));
}

// ===== 课表 =====

/**
 * 课表（默认走缓存，refresh=1 强制重抓；缓存过期也会自动重抓）
 * 参数：xnxq=2026-2027-1 指定学期；refresh=1 强制刷新
 */
export async function handleAcademicTimetable(request, env, user) {
  const model = new AcademicModel(env.DB);
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh') === '1';

  const binding = await model.getBinding(user.id);
  if (!binding) return jsonResponse(error('尚未绑定教务系统', 'NOT_BOUND'), 400);

  const cachedTerms = await model.listTimetableTerms(user.id);
  const opened = await schoolClientFromBinding(env, model, binding);
  if (opened.failure) {
    return jsonResponse(error(opened.failure.message, opened.failure.code), opened.failure.status);
  }
  const client = opened.client;

  // 1. 取学期列表（顺带校验登录态是否还有效），教务不可达时退回本地缓存
  let terms = null;
  let liveError = null;
  try {
    terms = await client.termList();
  } catch (e) {
    liveError = e;
  }
  if (liveError instanceof SchoolSessionExpired) {
    await model.markExpired(user.id);
    return jsonResponse(error(liveError.message, 'ACADEMIC_EXPIRED'), 400);
  }

  let xnxqId = url.searchParams.get('xnxq') || '';
  if (!xnxqId) {
    const current = (terms || []).find((t) => String(t.dqxqflag) === '1') || (terms || [])[0];
    xnxqId = current ? current.id : (cachedTerms[0] ? cachedTerms[0].xnxq_id : '');
  }
  if (!xnxqId) return jsonResponse(error('未能确定学年学期', 'NO_TERM'), 400);

  // 2. 缓存命中：未强制刷新且未过期，或教务当前不可达（此时优先把旧数据给出去）
  const cached = await model.getTimetable(user.id, xnxqId);
  if (cached && (liveError || (!refresh && isFresh(cached.fetched_at)))) {
    return jsonResponse(success({
      ...JSON.parse(cached.payload),
      terms: buildTerms(terms, cachedTerms, xnxqId),
      fetchedAt: toIso(cached.fetched_at),
      fromCache: true,
      stale: !!liveError
    }));
  }
  if (liveError) {
    return jsonResponse(error(`教务系统暂时不可用：${liveError.message}`, 'ACADEMIC_UNREACHABLE'), 502);
  }

  // 3. 实时抓取并落库
  try {
    const [periods, courses, unscheduled, weekCal] = await Promise.all([
      client.periodConfig(DEFAULT_KBJCMS_ID, xnxqId),
      client.arrangedCourses(xnxqId, DEFAULT_KBJCMS_ID),
      client.unscheduledCourses(xnxqId, DEFAULT_KBJCMS_ID),
      client.weekCalendar(xnxqId)
    ]);

    const payload = {
      xnxqId,
      periods: normalizePeriods(periods),
      firstDate: (weekCal && weekCal.ksrq) || '',
      weekCount: num(weekCal && weekCal.jzzc),
      courses: (courses || []).map(normalizeCourse),
      unscheduled: (unscheduled || []).map(normalizeUnscheduled)
    };
    await model.saveTimetable(user.id, xnxqId, JSON.stringify(payload));
    await model.touchBinding(user.id);

    return jsonResponse(success({
      ...payload,
      terms: buildTerms(terms, cachedTerms, xnxqId),
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      stale: false
    }));
  } catch (e) {
    if (e instanceof SchoolSessionExpired) {
      await model.markExpired(user.id);
      return jsonResponse(error(e.message, 'ACADEMIC_EXPIRED'), 400);
    }
    return jsonResponse(error(`抓取课表失败：${e.message}`, 'ACADEMIC_FETCH_FAILED'), 502);
  }
}

// ===== 学业达成（学分） =====

/**
 * 学业达成情况（默认走缓存，refresh=1 强制重抓）
 * 学分数据依赖「当前执行计划 id」，需先查学生基本信息拿 zxjhid
 */
export async function handleAcademicCredits(request, env, user) {
  const model = new AcademicModel(env.DB);
  const refresh = new URL(request.url).searchParams.get('refresh') === '1';

  const binding = await model.getBinding(user.id);
  if (!binding) return jsonResponse(error('尚未绑定教务系统', 'NOT_BOUND'), 400);

  const cached = await model.getCredits(user.id);
  if (cached && !refresh && isFresh(cached.fetched_at)) {
    return jsonResponse(success({
      ...JSON.parse(cached.payload),
      fetchedAt: toIso(cached.fetched_at),
      fromCache: true,
      stale: false
    }));
  }

  const opened = await schoolClientFromBinding(env, model, binding);
  if (opened.failure) {
    return jsonResponse(error(opened.failure.message, opened.failure.code), opened.failure.status);
  }
  const client = opened.client;
  try {
    const plan = await client.studentPlan(binding.school_uid || '');
    const pyfaid = plan && (plan.zxjhid || plan.pyfaid);
    if (!pyfaid) {
      return jsonResponse(error('未取到当前执行计划，无法计算学业达成情况', 'NO_PLAN'), 400);
    }

    const details = await client.creditDetails(binding.school_uid, pyfaid, null);
    const payload = normalizeCredits(details);
    await model.saveCredits(user.id, JSON.stringify(payload));
    await model.touchBinding(user.id);

    return jsonResponse(success({
      ...payload,
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      stale: false
    }));
  } catch (e) {
    if (e instanceof SchoolSessionExpired) {
      await model.markExpired(user.id);
      return jsonResponse(error(e.message, 'ACADEMIC_EXPIRED'), 400);
    }
    // 抓取失败但有旧缓存：先把旧数据给出去，页面标记为过期
    if (cached) {
      return jsonResponse(success({
        ...JSON.parse(cached.payload),
        fetchedAt: toIso(cached.fetched_at),
        fromCache: true,
        stale: true,
        warning: e.message
      }));
    }
    return jsonResponse(error(`抓取学业达成情况失败：${e.message}`, 'ACADEMIC_FETCH_FAILED'), 502);
  }
}
