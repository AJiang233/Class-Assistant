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
import { success, error, jsonResponse } from '../utils/response.js';
import { sameStudentId } from '../utils/identity.js';
import { sealCookies, openCookies, isSealed } from '../utils/cookieVault.js';

/** 课表节次方案 id（教务默认方案） */
const DEFAULT_KBJCMS_ID = 1;

/**
 * 缓存新鲜期：超过则下次访问自动重新抓取（毫秒）。
 *
 * 三天。教务那边大概一天就会把会话重置一次，所以「抓取失败」是常态而不是异常；
 * 配上「失败就回缓存」（见下面的 handleAcademicTimetable），用户平时打开看到的
 * 基本都是本地这份，不必每次翻课表都去教务那儿碰一次运气。想要最新的按「刷新」。
 */
const CACHE_TTL = 3 * 24 * 60 * 60 * 1000;

/** 多因子认证中间态有效期（毫秒） */
const MFA_TTL = 10 * 60 * 1000;

/**
 * kkzc 兜底解析里，单个「起-止」区段最多展开多少周。
 *
 * 一学期最多几十周，而 kkzc 是教务下发的自由文本：字段写坏成 "1-50000000" 时，
 * 逐周 push 会构造出几千万个元素的数组 —— Worker 直接 CPU 超时或 OOM，
 * 而且这条路径每个学期、每门课都会走一次。数值取 60 只是给脏数据留足余量。
 */
const MAX_WEEK_SPAN = 60;

/** 一次性令牌（中间态在前后端之间传递的凭据） */
function randomToken() {
  const bytes = new Uint8Array(24);
  crypto.getRandomValues(bytes);
  return Array.from(bytes).map((b) => b.toString(16).padStart(2, '0')).join('');
}

/** 读出教务 Cookie；旧明文记录顺手封存回去 */
async function readBindingCookies(env, model, binding) {
  const plain = await openCookies(env, binding.cookies);
  if (plain && !isSealed(binding.cookies)) {
    await model.saveCookies(binding.user_id, await sealCookies(env, plain));
  }
  return plain;
}

/**
 * 「手上这份教务会话用不了」—— 密文损坏，或者密钥轮换后再也解不开。
 *
 * 单独一类，是为了和 SchoolSessionExpired 分开：那边是教务把登录态踢了，这边是本地
 * 密文读不出来，要查的是密钥而不是教务。但对用户是同一件事 —— 得重新绑定，
 * 所以 cacheReasonOf 把它也归到 'expired'（界面据此给出重新登录的入口）。
 */
export class AcademicSessionError extends Error {
  constructor(code, message = '教务登录态已过期，请重新登录教务系统') {
    super(message);
    this.name = 'AcademicSessionError';
    this.code = code;
    this.status = 400;
  }
}

/** 这次失败是不是「会话用不了」（用户得重新绑定教务） */
function isSessionUnusable(e) {
  return e instanceof SchoolSessionExpired || e instanceof AcademicSessionError;
}

/**
 * 建教务客户端。失败只返回 failure，不在这里 markExpired：
 * 调用方很可能靠着缓存照样把数据给出去，那种请求不该动绑定状态。
 * 要标失效，等确认真给不出数据了（缓存也没有）再标。
 */
async function schoolClientFromBinding(env, model, binding) {
  let cookies;
  try {
    cookies = await readBindingCookies(env, model, binding);
  } catch (e) {
    // 密文损坏 / 密钥轮换后解不开：与登录态过期区分开，便于排查是密钥问题而非教务问题
    console.error('教务会话解密失败:', e);
    return { failure: new AcademicSessionError('ACADEMIC_DECRYPT_FAILED') };
  }
  if (!cookies) {
    return { failure: new AcademicSessionError('ACADEMIC_EXPIRED') };
  }
  return { client: new SchoolClient(cookies) };
}

// ===== 通用工具 =====

/**
 * 读缓存 payload。缓存是可能被写坏的：写入被打断、手工改库、字段结构演进。
 * 坏掉的缓存必须清掉再重抓 —— 否则每次请求都卡在同一个 JSON.parse 上变成 500，
 * 而代码不会自愈，用户重试多少次都一样。
 *
 * 返回 null 表示「这条缓存不可用」，调用方按「没有缓存」继续走实时抓取。
 * 清除失败也返回 null：这一轮照样能靠重抓给出结果，只是坏数据会留到下次再清。
 *
 * @param {{payload: string}} row 缓存行
 * @param {() => Promise<any>} clear 清除这条缓存的回调
 */
export async function readCachePayload(row, clear) {
  try {
    const value = JSON.parse(row.payload);
    if (value && typeof value === 'object' && !Array.isArray(value)) return value;
    throw new Error(`缓存结构不是对象（${typeof value}）`);
  } catch (e) {
    console.error('教务缓存无法解析，清除后重新抓取:', e.message);
    try {
      await clear();
    } catch (clearError) {
      console.error('清除损坏的教务缓存失败:', clearError);
    }
    return null;
  }
}

function num(value) {
  const n = Number(value);
  return Number.isFinite(n) ? n : 0;
}

/** 保留一位小数，避免浮点累加出现 19.500000000000004 */
function round1(value) {
  return Math.round(value * 10) / 10;
}

/** 保留两位小数（绩点用） */
function round2(value) {
  return Math.round(value * 100) / 100;
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

export function isFresh(fetchedAt) {
  const t = parseSqlTime(fetchedAt);
  return t > 0 && Date.now() - t < CACHE_TTL;
}

/**
 * 「这一轮为什么给的是缓存」——页面据此决定提示哪一句：
 *   expired      登录态被教务那边重置了（或本地密文解不开），要用户重新登录才拿得到新数据
 *   unreachable  教务暂时连不上，过会儿再刷就行
 * 两者对用户的意思差得远，别混成一句「系统暂时不可用」：前者得给重新登录的入口，
 * 后者只需要说一句「这是缓存，稍后自动会更新」。
 */
export function cacheReasonOf(e) {
  return isSessionUnusable(e) ? 'expired' : 'unreachable';
}

/**
 * 这一轮到底把缓存给不给出去、给的话是因为什么。
 *
 * 顺序是有讲究的：**教务那一趟失败时，缓存无条件优先**（不管新不新鲜、是不是手动刷新）。
 * 教务登录态大概一天就会被重置一次，抓不到是常态；这时候把手上这份给出去，
 * 用户至少还能看课表，而不是被一句「请重新绑定」挡住。
 * 反过来，教务好着的时候只在「没手动刷新 + 缓存还在新鲜期内」才用缓存 ——
 * 手动刷新就是用户明确说「我要最新的」，这时候不能再拿旧的糊弄。
 *
 * @returns {null | {reason: string|null}} null = 不能用缓存（调用方去重抓或报错）
 */
export function cacheDecision({ hasCache, liveError, refresh, fetchedAt }) {
  if (!hasCache) return null;
  if (liveError) return { reason: cacheReasonOf(liveError) };
  if (!refresh && isFresh(fetchedAt)) return { reason: null };
  return null;
}

/**
 * 按当前日期算「现在该看哪一学期」，返回 id（形如 2026-2027-1）。
 *
 * 为什么不认教务给的「当前学期」标记：那个标记在学期切换上并不跟着走 —— 2026-2027-2 还没开学，
 * 它就已经被标成当前学期，于是每次进页面默认展开的是一份还没开始的课表。
 * 学期 id 自己就带学年与学期序号，按日期推准得多：9 月–次年 1 月是第 1 学期，
 * 2–8 月是第 2 学期（7、8 月暑假算上学年末尾）。
 *
 * 日期按北京时间算：Workers 跑在 UTC，9 月 1 日凌晨那几个小时会差出一天去。
 */
export function termIdByDate(now = new Date()) {
  const bj = new Date(now.getTime() + 8 * 60 * 60 * 1000);
  const y = bj.getUTCFullYear();
  const m = bj.getUTCMonth() + 1;
  const first = m >= 9 || m === 1;
  const startYear = m >= 9 ? y : y - 1;
  return startYear + '-' + (startYear + 1) + '-' + (first ? 1 : 2);
}

/** 教务的「当前学期」标记：接口给过的形态有 '1' / 1 / true，宽松认一下 */
function isFlaggedCurrent(t) {
  const v = t && t.dqxqflag;
  return v === true || String(v) === '1' || String(v) === 'true';
}

/**
 * 这一轮看哪一学期。
 *
 * 调用方显式指定了学期（`?xnxq=`，用户在下拉里选过、或前端带回上次看的）就先认它，
 * 但只认在教务列表里的那一个：旧学期被教务清理掉之后，拿一个它不认的 id 去抓，
 * 抓回来是一份空课表，用户看到的是「这学期没课」而不是「这学期已经不在了」。
 * 教务那次没成时列表是空的，这时候不能丢人家选的学期 —— 缓存里也许还有。
 *
 * 没指定（或指定的学期无效）时才推默认：按日期推出来的学期在教务列表里就用它，这是绝大多数
 * 情况；不在（教务还没建这份、或 id 规则变了）用教务自己标的；再不行才用列表第一项。
 * 列表同样为空时退到缓存里出现过的学期 —— 缓存也按学期倒序，直接取第一项会落在
 * 「最近的未来学期」上，正是这次要修的那个坑。
 */
export function resolveCurrentTermId(terms, cachedTerms, requested, now = new Date()) {
  const live = terms || [];
  const cachedIds = (cachedTerms || []).map((t) => t.xnxq_id);
  if (requested && (!live.length || live.some((t) => String(t.id) === requested))) return requested;
  const wanted = termIdByDate(now);
  if (live.some((t) => String(t.id) === wanted)) return wanted;
  const flagged = live.find(isFlaggedCurrent);
  if (flagged) return flagged.id;
  if (cachedIds.indexOf(wanted) >= 0) return wanted;
  if (live[0]) return live[0].id;
  return cachedIds[0] || '';
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
export function parseWeekRange(text) {
  const out = [];
  for (const seg of String(text || '').split(/[,，;；]/)) {
    const range = seg.match(/(\d+)\s*-\s*(\d+)/);
    if (range) {
      const from = parseInt(range[1], 10);
      // 跨度封顶：脏数据（"1-50000000"）不能让这里展开成几千万个元素
      const to = Math.min(parseInt(range[2], 10), from + MAX_WEEK_SPAN);
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

// ===== 成绩 =====

/** 「全部学期」在接口与缓存里的表示：空串（教务页面上的那一项 id 也是空串） */
export const ALL_TERM_ID = '';

/** 单次向教务要多少条成绩（一个学期通常二三十门，一页就够；不够会继续翻页） */
const GRADE_PAGE_SIZE = 100;

/** 翻页上限：教务的 rowCount 若给出脏值，不能让这里变成一个无界循环 */
const GRADE_MAX_PAGES = 20;

/** 课程串形如 "[BIOL3102]植物学Ⅱ"，把课程号摘出来；没有方括号就退化为整个串 */
export function courseCodeOf(text) {
  const m = String(text || '').match(/^\s*\[([^\]]+)\]/);
  return m ? m[1].trim() : String(text || '').trim();
}

/** 课程串里的课程名（去掉 "[课程号]" 前缀），取不到就原样返回 */
export function courseNameOf(text) {
  const s = String(text || '');
  const m = s.match(/^\s*\[[^\]]+\]\s*([\s\S]*)$/);
  return m ? m[1].trim() : s.trim();
}

/**
 * 这一条成绩算不算进均分 / 绩点。
 *
 * 三条排除规则都是有真实数据支撑的，不是提前防御：
 *   · 成绩统计说明里写着「不参与所有成绩统计计算」—— 教务自己在说这门别算
 *     （实测：人工智能通识、军事技能训练这类）
 *   · 成绩标识是缓考 / 缺考 —— 成绩位的 0 是占位符，不是真考了 0 分
 *     （实测：体育Ⅱ 缓考，成绩 0、绩点 0；照算能把均分拉下来好几分）
 *   · 成绩本身不是数字 —— 合格 / A / 优秀 这类没有可比的分值
 *     （实测：军事技能训练成绩 "A"、人工智能通识成绩 "合格"）
 */
export function isCountedForStats(row) {
  if (/不参与/.test(row.statisticNote || '')) return false;
  if (/缓考|缺考/.test(row.scoreMark || '')) return false;
  return row.scoreNum !== null;
}

/** 成绩单条 → 界面要用的字段（教务原始字段有十几个，只留用得上的） */
export function normalizeGradeItem(g) {
  const score = (g && g.zcj != null) ? String(g.zcj).trim() : '';
  const point = (g && g.jd != null) ? String(g.jd).trim() : '';
  const scoreNum = score === '' ? NaN : Number(score);
  const pointNum = point === '' ? NaN : Number(point);
  const kcxx = (g && g.kcxx) || '';
  return {
    code: courseCodeOf(kcxx),
    name: courseNameOf(kcxx) || kcxx,
    credit: num(g && g.xf),
    score,
    scoreNum: Number.isFinite(scoreNum) ? scoreNum : null,
    point,
    pointNum: Number.isFinite(pointNum) ? pointNum : null,
    scoreType: (g && g.cjxzmc) || '',
    scoreMark: (g && g.cjbzmc) || '',
    termId: (g && g.cxxnxq) || '',
    termName: (g && g.zsxnxqmc) || '',
    category: (g && g.kclbmc) || '',
    nature: (g && g.kcsxmc) || '',
    generalCategory: (g && g.tsklbmc) || '',
    statisticNote: (g && g.cjtjsm) || '',
    remark: (g && g.bz) || ''
  };
}

/**
 * 成绩列表 + 汇总。
 *
 * 汇总口径（两条都只统计 isCountedForStats 为真的记录）：
 *   · 均分 —— 算术平均，四舍五入到一位小数
 *   · 绩点 —— **学分加权**平均（Σ 学分×绩点 ÷ Σ 学分），两位小数。不等权是因为
 *     一门 5 学分的课和一门 0.5 学分的课对 GPA 的影响本来就不该一样
 *
 * 同一门课出现多条（补重）时，统计只留**分数最高的那条** —— 教务页面上「显示补重成绩」
 * 默认是开的，列表里原成绩与补重成绩会一起出现；照单全收会让这门课的学分被算两遍，
 * 均分也被两条平均一次。列表本身照旧全部展示（那是用户要看的原始记录）。
 */
export function normalizeGrades(items) {
  const rows = (items || []).map(normalizeGradeItem);

  const best = new Map();
  for (const r of rows) {
    if (!isCountedForStats(r)) continue;
    const key = r.code || r.name;
    const prev = best.get(key);
    if (!prev || r.scoreNum > prev.scoreNum) best.set(key, r);
  }

  let scoreSum = 0;
  let scoreCount = 0;
  let pointWeighted = 0;
  let creditSum = 0;
  for (const r of best.values()) {
    scoreSum += r.scoreNum;
    scoreCount += 1;
    if (r.pointNum !== null) {
      pointWeighted += r.credit * r.pointNum;
      creditSum += r.credit;
    }
  }

  return {
    rows,
    summary: {
      // 一门可统计的课都没有时给 null，而不是 0 —— 界面上 0 分和「算不出来」是两回事
      average: scoreCount ? round1(scoreSum / scoreCount) : null,
      gpa: creditSum > 0 ? round2(pointWeighted / creditSum) : null,
      counted: scoreCount,
      total: rows.length,
      // 列表里有、但被排除在统计外的条数（界面据此说明「为什么均分是按 N 门算的」）
      excluded: rows.length - scoreCount
    }
  };
}

/**
 * 成绩页的学期下拉：最前面多一项「全部学期」（id 为空串），其余与课表同源。
 *
 * 为什么不复用课表的 buildTerms：课表那份不该出现「全部学期」——
 * 课表按学期取数，没有「全部」这一档，多一个选项只会点出一份空课表。
 */
export function buildGradeTerms(terms, cachedTerms, currentId) {
  return [
    // current 恒为 false：「全部学期」不是教务标的「当前学期」。terms 里的 current 只用来
    // 给下拉项加「（当前学期）」后缀（见 academic.js 的 renderTermSelect），选中与否是
    // 拿 id 与传回来的当前值比较决定的 —— 这里若跟着 currentId 变，默认档就会显示成
    // 「全部学期（当前学期）」。
    { id: ALL_TERM_ID, name: '全部学期', current: false },
    ...buildTerms(terms, cachedTerms, currentId)
  ];
}

/**
 * 把某学期的成绩翻页取全。
 *
 * 「到底了没有」以教务自述的 rowCount 为准：它可能不认我们给的 pageSize 而按自己的页长
 * 返回（那样「返回不足一页」就是误判，会提前收工漏掉后面的课）。拿不到 rowCount 时才
 * 退回「不满一页即到底」，再不行还有 GRADE_MAX_PAGES 兜底。
 */
async function fetchAllGrades(client, xnxqId) {
  const all = [];
  let total = 0;
  for (let page = 1; page <= GRADE_MAX_PAGES; page++) {
    const data = await client.gradeList({ xnxqId, pageNumber: page, pageSize: GRADE_PAGE_SIZE });
    const items = (data && data.items) || [];
    if (!items.length) break;
    if (page === 1) total = num(data.rowCount);
    all.push(...items);
    if (total > 0 && all.length >= total) break;
    if (total <= 0 && items.length < GRADE_PAGE_SIZE) break;
  }
  return all;
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
      return { failure: { message: '教务登录态已过期，请重新登录教务系统', code: 'ACADEMIC_INVALID', status: 400 } };
    }
    // 用户侧只说「连不上」，具体原因（超时 / DNS / 上游 5xx）留在日志里
    console.error('教务接口不可达:', e.message);
    return { failure: { message: '暂时连不上教务系统，请稍后重试', code: 'ACADEMIC_UNREACHABLE', status: 502 } };
  }
  if (!info || !info.id) {
    console.error('教务返回的用户信息不完整:', JSON.stringify(info));
    return { failure: { message: '没能读到你的教务信息，请重新登录教务系统', code: 'ACADEMIC_INVALID', status: 400 } };
  }
  if (!sameStudentId(user.student_id, info.userAccount)) {
    console.error(`教务返回学号 ${info.userAccount || '空'} 与当前账号 ${user.student_id} 不一致`);
    return {
      failure: {
        message: '教务账号与当前登录的学号不一致，请用本人的教务账号绑定',
        code: 'ACADEMIC_IDENTITY_MISMATCH',
        status: 403
      }
    };
  }

  let sealed;
  try {
    sealed = await sealCookies(env, cookies);
  } catch (e) {
    console.error('教务会话封存失败:', e);
    return { failure: { message: '服务端暂时不可用，请稍后重试', code: 'VAULT_NOT_CONFIGURED', status: 500 } };
  }

  const model = new AcademicModel(env.DB);
  await model.saveBinding(user.id, {
    student_no: info.userAccount || '',
    real_name: info.userNameZh || '',
    school_uid: info.id,
    cookies: sealed
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
    return jsonResponse(error('没有拿到教务系统的登录凭据，请重新登录', 'MISSING_COOKIES'), 400);
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

  let session;
  try {
    session = await loginWithPassword(studentId, password);
  } catch (e) {
    if (e instanceof CasError) {
      // 需要验证码时用 409，前端据此提示改走手动绑定（401 会触发退出登录，不能用）
      const status = e.code === 'CAS_NEED_CAPTCHA' ? 409 : 400;
      return jsonResponse(error(e.message, e.code), status);
    }
    console.error('统一身份认证登录失败:', e.message);
    return jsonResponse(error('统一身份认证登录失败，请检查学号密码，或改用手动绑定', 'CAS_ERROR'), 502);
  }

  // 认证已通过，但要求多因子二次验证：暂存会话，让前端进入第二步
  if (session.mfaRequired) {
    const type = session.state.reAuthType;
    if (!isMfaCodeSupported(type)) {
      return jsonResponse(
        error('该账号的二次验证方式暂不支持，请改用手动绑定', 'MFA_UNSUPPORTED'),
        400
      );
    }
    const model = new AcademicModel(env.DB);
    await model.purgeExpiredMfaSessions(MFA_TTL);
    const token = randomToken();
    let sealedState;
    try {
      sealedState = await sealCookies(env, JSON.stringify(session.state));
    } catch (e) {
      console.error('MFA 中间态封存失败:', e);
      return jsonResponse(error('服务端暂时不可用，请稍后重试', 'VAULT_NOT_CONFIGURED'), 500);
    }
    await model.saveMfaSession(user.id, token, sealedState);
    return jsonResponse(success({
      mfaRequired: true,
      token,
      contact: session.contact || '',
      method: mfaMethodLabel(type)
    }));
  }

  const result = await bindWithCookies(env, user, session.cookies);
  if (result.failure) {
    // 代登录路径独有的诊断：Cookie 名与跳转链只写日志（只有名字，没有值）——
    // 用户看这串跳转没有任何可操作的信息，拼进提示只会把真正的原因淹掉
    console.error('代登录失败诊断：', `Cookie：${session.cookieNames.join(',') || '无'}；跳转：${session.hops.join(' → ')}`);
    return jsonResponse(error(result.failure.message, result.failure.code), result.failure.status);
  }
  return jsonResponse(success({ ...result.data, via: 'password' }));
}

/**
 * 中间态共用：取出本人在有效期内的 CAS 会话。
 *
 * claim=true 供「提交验证码」路径使用：先原子占一次尝试名额再验码（见 claimMfaAttempt），
 * 占不到（已达上限或已过期）就作废会话并按 MFA_EXPIRED 返回，并发下也只有前
 * MFA_MAX_ATTEMPTS 个请求拿得到名额。下发验证码等只读步骤不动名额，走普通读取。
 */
async function loadMfaState(env, user, token, { claim = false } = {}) {
  if (!token) return { failure: { message: '登录已超时，请重新输入学号与密码', code: 'MISSING_TOKEN', status: 400 } };
  const model = new AcademicModel(env.DB);

  if (claim) {
    if (!(await model.claimMfaAttempt(user.id, token, MFA_TTL))) {
      await model.deleteMfaSession(token);
      return { failure: { message: '登录已超时，请重新输入学号与密码', code: 'MFA_EXPIRED', status: 400 } };
    }
    const state = await model.getClaimedMfaSession(user.id, token, env);
    if (!state) {
      return { failure: { message: '登录已超时，请重新输入学号与密码', code: 'MFA_EXPIRED', status: 400 } };
    }
    return { model, state };
  }

  const state = await model.getMfaSession(user.id, token, MFA_TTL, env);
  if (!state) {
    return { failure: { message: '登录已超时，请重新输入学号与密码', code: 'MFA_EXPIRED', status: 400 } };
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

  try {
    const sent = await sendMfaCode(loaded.state);
    return jsonResponse(success({ sent: true, mobile: sent.mobile, label: sent.label }));
  } catch (e) {
    if (e instanceof CasError) return jsonResponse(error(e.message, e.code), 400);
    console.error('验证码发送失败:', e.message);
    return jsonResponse(error('验证码发送失败，请稍后重试', 'MFA_SEND_FAILED'), 502);
  }
}

/** 第三步：提交验证码完成二次验证，随后换取教务会话并绑定 */
export async function handleAcademicMfaVerify(request, env, user) {
  const body = await request.json().catch(() => ({}));
  const code = String(body.code || '').trim();
  if (!code) return jsonResponse(error('请填写验证码', 'MISSING_CODE'), 400);

  const loaded = await loadMfaState(env, user, String(body.token || ''), { claim: true });
  if (loaded.failure) {
    return jsonResponse(error(loaded.failure.message, loaded.failure.code), loaded.failure.status);
  }

  let session;
  try {
    session = await verifyMfaCode(loaded.state, code);
  } catch (e) {
    // 验证码错误时保留中间态，让用户直接重试；本次尝试名额已在验码前原子占掉，这里不再累加
    if (e instanceof CasError) return jsonResponse(error(e.message, e.code), 400);
    console.error('二次验证失败:', e.message);
    return jsonResponse(error('二次验证失败，请重试或改用手动绑定', 'MFA_ERROR'), 502);
  }

  const result = await bindWithCookies(env, user, session.cookies);
  await loaded.model.deleteMfaSession(String(body.token || ''));
  if (result.failure) {
    console.error('代登录失败诊断：', `Cookie：${session.cookieNames.join(',') || '无'}；跳转：${session.hops.join(' → ')}`);
    return jsonResponse(error(result.failure.message, result.failure.code), result.failure.status);
  }
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
  if (!binding) return jsonResponse(error('还没绑定教务系统，绑定后会自动同步', 'NOT_BOUND'), 400);

  const cachedTerms = await model.listTimetableTerms(user.id);

  // 1. 建客户端 → 取学期列表（顺带校验登录态是否还有效）。
  //    建客户端失败（会话解不开）、教务不可达、登录态被那边重置，都只记进 liveError、
  //    不在这里返回：缓存里那份课表照样能用（见下面的 2.）。登录态大概一天就会失效一次，
  //    每次都把人打回绑定页的话，这份课表根本没法看。
  //    会话解不开同理 —— 课表缓存 payload 是明文 JSON，与 COOKIE_SECRET 无关，
  //    密钥轮换或密文损坏不该把这一页锁死（学分接口本来就是先读缓存再建 client）。
  const opened = await schoolClientFromBinding(env, model, binding);
  const client = opened.client || null;
  let terms = null;
  let liveError = opened.failure || null;
  if (client) {
    try {
      terms = await client.termList();
    } catch (e) {
      liveError = e;
    }
  }
  if (liveError instanceof SchoolSessionExpired) await model.markExpired(user.id);

  const xnxqId = resolveCurrentTermId(terms, cachedTerms, url.searchParams.get('xnxq') || '');

  // 2. 缓存命中：教务那一趟没成（不可达 / 登录态被重置 / 会话解不开）就无条件把它给出去，
  //    否则只在「没手动刷新 + 缓存还新鲜」时用。
  //    学期没定下来时不必查缓存：能查到的学期就来自缓存本身（cachedTerms），
  //    这里定不下来就说明压根没有这份缓存。
  const cached = xnxqId ? await model.getTimetable(user.id, xnxqId) : null;
  const cachedData = cached
    ? await readCachePayload(cached, () => model.deleteTimetable(user.id, xnxqId))
    : null;
  const useCache = cacheDecision({
    hasCache: !!cachedData,
    liveError,
    refresh,
    fetchedAt: cached ? cached.fetched_at : null
  });
  if (useCache) {
    return jsonResponse(success({
      ...cachedData,
      terms: buildTerms(terms, cachedTerms, xnxqId),
      fetchedAt: toIso(cached.fetched_at),
      fromCache: true,
      stale: !!liveError,
      cacheReason: useCache.reason
    }));
  }
  if (liveError) {
    // 缓存也救不了 —— 到这一步才是真的给不出数据。
    // 会话解不开（密文损坏 / 密钥轮换）在这里才把绑定标成失效：上面那些靠缓存把课表
    // 给出去的请求不该动这个状态，否则「教务那边好好的、只是本地密文读不出来」也会
    // 在状态页上挂成「已失效」。
    if (liveError instanceof AcademicSessionError) {
      await model.markExpired(user.id);
      return jsonResponse(error(liveError.message, liveError.code), 400);
    }
    // 登录态过期仍然引导去重新绑定（状态上面已标过），教务不可达则只是稍后再试
    if (liveError instanceof SchoolSessionExpired) {
      return jsonResponse(error(liveError.message, 'ACADEMIC_EXPIRED'), 400);
    }
    console.error('教务接口不可达（课表）:', liveError.message);
    return jsonResponse(error('暂时连不上教务系统，请稍后重试', 'ACADEMIC_UNREACHABLE'), 502);
  }
  if (!xnxqId) return jsonResponse(error('暂时取不到学期信息，请稍后重试', 'NO_TERM'), 400);

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
    console.error('获取课表失败:', e.message);
    return jsonResponse(error('获取课表失败，请稍后重试', 'ACADEMIC_FETCH_FAILED'), 502);
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
  if (!binding) return jsonResponse(error('还没绑定教务系统，绑定后会自动同步', 'NOT_BOUND'), 400);

  const cached = await model.getCredits(user.id);
  const cachedData = cached ? await readCachePayload(cached, () => model.deleteCredits(user.id)) : null;
  if (cachedData && !refresh && isFresh(cached.fetched_at)) {
    return jsonResponse(success({
      ...cachedData,
      fetchedAt: toIso(cached.fetched_at),
      fromCache: true,
      stale: false
    }));
  }

  const opened = await schoolClientFromBinding(env, model, binding);
  if (opened.failure) {
    // 会话用不了（解不开 / 没有 Cookie），而上面也没能靠缓存把这一轮打发掉：这时候才标失效
    await model.markExpired(user.id);
    return jsonResponse(error(opened.failure.message, opened.failure.code), opened.failure.status);
  }
  const client = opened.client;
  try {
    const plan = await client.studentPlan(binding.school_uid || '');
    const pyfaid = plan && (plan.zxjhid || plan.pyfaid);
    if (!pyfaid) {
      console.error('教务未返回当前执行计划（zxjhid / pyfaid）');
      return jsonResponse(error('暂时取不到学业达成数据，请稍后重试', 'NO_PLAN'), 400);
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
    if (e instanceof SchoolSessionExpired) await model.markExpired(user.id);
    // 抓取失败但有旧缓存：先把旧数据给出去，页面标记为「缓存」并带上原因。
    // 登录态过期也走这一支 —— 课表与学分在同一页，课表能看而学分报错太割裂
    if (cachedData) {
      console.error('学业达成抓取失败，回缓存:', e.message);
      return jsonResponse(success({
        ...cachedData,
        fetchedAt: toIso(cached.fetched_at),
        fromCache: true,
        stale: true,
        cacheReason: cacheReasonOf(e),
        warning: '教务系统暂时不可用，显示的是上次同步的数据'
      }));
    }
    if (e instanceof SchoolSessionExpired) {
      return jsonResponse(error(e.message, 'ACADEMIC_EXPIRED'), 400);
    }
    console.error('获取学业达成数据失败:', e.message);
    return jsonResponse(error('获取学业达成数据失败，请稍后重试', 'ACADEMIC_FETCH_FAILED'), 502);
  }
}

// ===== 成绩 =====

/**
 * 课程成绩（默认走缓存，refresh=1 强制重抓）
 * 参数：xnxq=2026-2027-1 指定学期，**省略或留空 = 全部学期**；refresh=1 强制刷新
 *
 * 与课表的差别只有一处：课表的学期是「一定要有一个」，这里多一档「全部学期」，
 * 而且是默认档 —— 当前学期开学初通常一门成绩都没有，默认落在它上面等于让人看空页。
 *
 * 缓存决策、失败回缓存、登录态失效的标记，全部与课表/学分同一套（见 cacheDecision）：
 * 教务登录态大概一天重置一次，「抓不到就回缓存」在这里同样是常态而不是异常。
 */
export async function handleAcademicGrades(request, env, user) {
  const model = new AcademicModel(env.DB);
  const url = new URL(request.url);
  const refresh = url.searchParams.get('refresh') === '1';
  // 没给 xnxq 或给了空串都按「全部学期」（空串正是教务页面上那一项的 id）
  const xnxqId = url.searchParams.get('xnxq') || ALL_TERM_ID;

  const binding = await model.getBinding(user.id);
  if (!binding) return jsonResponse(error('还没绑定教务系统，绑定后会自动同步', 'NOT_BOUND'), 400);

  const cachedTerms = await model.listGradeTerms(user.id);
  const cached = await model.getGrades(user.id, xnxqId);
  const cachedData = cached ? await readCachePayload(cached, () => model.deleteGrades(user.id, xnxqId)) : null;

  // 建客户端 + 取学期列表（顺带校验登录态）。教务那一趟失败只记进 liveError，不在这里返回：
  // 缓存里那份成绩照样能用（与课表同一处考虑，注释见 handleAcademicTimetable）
  const opened = await schoolClientFromBinding(env, model, binding);
  const client = opened.client || null;
  let terms = null;
  let liveError = opened.failure || null;
  if (client) {
    try {
      terms = await client.termList();
    } catch (e) {
      liveError = e;
    }
  }
  if (liveError instanceof SchoolSessionExpired) await model.markExpired(user.id);

  const useCache = cacheDecision({
    hasCache: !!cachedData,
    liveError,
    refresh,
    fetchedAt: cached ? cached.fetched_at : null
  });
  if (useCache) {
    return jsonResponse(success({
      ...cachedData,
      xnxqId,
      terms: buildGradeTerms(terms, cachedTerms, xnxqId),
      fetchedAt: toIso(cached.fetched_at),
      fromCache: true,
      stale: !!liveError,
      cacheReason: useCache.reason
    }));
  }
  if (liveError) {
    // 缓存也救不了才是真的给不出数据。此时才把「会话解不开」记成绑定失效 ——
    // 上面那些靠缓存把成绩给出去的请求不该动这个状态
    if (liveError instanceof AcademicSessionError) {
      await model.markExpired(user.id);
      return jsonResponse(error(liveError.message, liveError.code), 400);
    }
    if (liveError instanceof SchoolSessionExpired) {
      return jsonResponse(error(liveError.message, 'ACADEMIC_EXPIRED'), 400);
    }
    console.error('教务接口不可达（成绩）:', liveError.message);
    return jsonResponse(error('暂时连不上教务系统，请稍后重试', 'ACADEMIC_UNREACHABLE'), 502);
  }

  try {
    const items = await fetchAllGrades(client, xnxqId);
    const payload = normalizeGrades(items);
    await model.saveGrades(user.id, xnxqId, JSON.stringify(payload));
    await model.touchBinding(user.id);

    return jsonResponse(success({
      ...payload,
      xnxqId,
      terms: buildGradeTerms(terms, cachedTerms, xnxqId),
      fetchedAt: new Date().toISOString(),
      fromCache: false,
      stale: false
    }));
  } catch (e) {
    if (e instanceof SchoolSessionExpired) await model.markExpired(user.id);
    // 抓取失败但有旧缓存：先把旧数据给出去，页面标成「缓存」并带上原因。
    // 与学业达成同一条原则 —— 课表/学分/成绩在同一页，一块报错整页看着就像坏了
    if (cachedData) {
      console.error('成绩抓取失败，回缓存:', e.message);
      return jsonResponse(success({
        ...cachedData,
        xnxqId,
        terms: buildGradeTerms(null, cachedTerms, xnxqId),
        fetchedAt: toIso(cached.fetched_at),
        fromCache: true,
        stale: true,
        cacheReason: cacheReasonOf(e)
      }));
    }
    if (e instanceof SchoolSessionExpired) {
      return jsonResponse(error(e.message, 'ACADEMIC_EXPIRED'), 400);
    }
    console.error('获取成绩失败:', e.message);
    return jsonResponse(error('获取成绩失败，请稍后重试', 'ACADEMIC_FETCH_FAILED'), 502);
  }
}
