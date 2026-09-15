import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import {
  AcademicSessionError,
  cacheDecision,
  cacheReasonOf,
  isFresh
} from '../src/handlers/academicHandler.js';
import { SchoolSessionExpired } from '../src/utils/schoolApi.js';
import { sign } from '../src/utils/jwt.js';

const DAY = 24 * 60 * 60 * 1000;

/** 预期内的异常会打日志，这里临时静音，免得把 CI 输出刷满 */
async function withSilencedErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

/** D1 的 CURRENT_TIMESTAMP 是 UTC 的 "YYYY-MM-DD HH:MM:SS"，测试按同一格式造时间 */
function sqlTimeAgo(ms) {
  return new Date(Date.now() - ms).toISOString().replace('T', ' ').replace(/\.\d+Z$/, '');
}

/**
 * 课表缓存的新鲜期。
 *
 * 为什么盯这个：教务登录态大概一天就会被那边重置一次，抓不到新数据是常态，
 * 所以「多久算新鲜」直接决定用户平时打开课表到底走不走教务。窗口被人改小，
 * 表现不是报错而是「每次打开都慢一拍、偶尔还得重新登录」，很难联想到这里，
 * 所以把当前口径钉在测试里。
 */
describe('课表缓存新鲜期', () => {
  it('三天以内算新鲜，超过三天要重新抓', () => {
    assert.equal(isFresh(sqlTimeAgo(2 * DAY)), true);
    assert.equal(isFresh(sqlTimeAgo(4 * DAY)), false);
  });

  it('时间读不出来（空值 / 坏串）一律当作不新鲜', () => {
    // 宁可多抓一次，也不要把「不知道多久以前」的缓存当成新鲜的用
    assert.equal(isFresh(''), false);
    assert.equal(isFresh(null), false);
    assert.equal(isFresh('不是时间'), false);
  });
});

/**
 * 「这一轮为什么给的是缓存」。页面靠它决定说哪句话：
 * 登录态过期要给重新登录的入口，教务不可达只要说一句「等会儿会自己更新」。
 * 两者混成一句的话，用户不知道该不该动手，所以分开钉住。
 */
describe('回缓存的原因', () => {
  it('登录态过期报 expired，教务不可达报 unreachable', () => {
    assert.equal(cacheReasonOf(new SchoolSessionExpired('登录态失效')), 'expired');
    assert.equal(cacheReasonOf(new Error('fetch failed')), 'unreachable');
  });

  it('本地密文解不开也是 expired：用户能做的同样是重新绑定', () => {
    assert.equal(cacheReasonOf(new AcademicSessionError('ACADEMIC_DECRYPT_FAILED')), 'expired');
  });
});

/**
 * 「这次把缓存给不给用户」。这是本次改动的核心分支，也是那个让用户难受了很久的 bug：
 * 教务登录态一天左右就被重置，以前一过期就直接报「请重新绑定」，手上明明有课表也不给看。
 */
describe('要不要把缓存给出去', () => {
  const fresh = sqlTimeAgo(2 * DAY);
  const stale = sqlTimeAgo(4 * DAY);

  it('教务拉不动时缓存无条件优先 —— 过期、手动刷新都给', () => {
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: new SchoolSessionExpired('登录态失效'), refresh: true, fetchedAt: stale }),
      { reason: 'expired' }
    );
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: new Error('fetch failed'), refresh: false, fetchedAt: stale }),
      { reason: 'unreachable' }
    );
  });

  it('教务好着时：只有「没手动刷新 + 缓存新鲜」才用缓存', () => {
    assert.deepEqual(
      cacheDecision({ hasCache: true, liveError: null, refresh: false, fetchedAt: fresh }),
      { reason: null }
    );
    // 手动刷新就是用户明确要最新的，不能再拿旧的糊弄
    assert.equal(
      cacheDecision({ hasCache: true, liveError: null, refresh: true, fetchedAt: fresh }),
      null
    );
    // 缓存过了新鲜期，该去重抓
    assert.equal(
      cacheDecision({ hasCache: true, liveError: null, refresh: false, fetchedAt: stale }),
      null
    );
  });

  it('压根没有缓存时不给，调用方去重抓或报错', () => {
    assert.equal(
      cacheDecision({ hasCache: false, liveError: new SchoolSessionExpired('登录态失效'), refresh: false, fetchedAt: null }),
      null
    );
  });
});

// ===== 会话解不开（密钥轮换 / 密文损坏）时的课表 =====
//
// 现场：COOKIE_SECRET 轮换过、或者密文被写坏之后，academic_bindings.cookies 解不开。
// 课表缓存的 payload 存的是明文 JSON，和这个密钥半点关系没有 —— 手上这份课表完全可用，
// 但「建客户端」原来排在读缓存之前，解密一失败就直接 400「教务登录态已过期」，
// 用户明明有课表却什么都看不到（同一故障下学分倒是照常显示，因为学分是先读缓存）。

/** 密文前缀是 v1，里面那两段却是垃圾：一定解不开，也不会被当成旧明文回写 */
const CORRUPT_COOKIES = 'v1.bm90LWl2.bm90LWNpcGhlcnRleHQ';
const TERM = '2026-2027-1';
const SECRET = 'test-secret';

const USER_ROW = {
  id: 1,
  student_id: '2022103071',
  name: '张三',
  positions: '学生',
  contact: '',
  update_time: null
};

const BINDING_ROW = {
  user_id: 1,
  student_no: '2022103071',
  real_name: '张三',
  school_uid: 'u-1',
  cookies: CORRUPT_COOKIES,
  status: 'ok',
  bound_at: '2026-09-10 08:00:00',
  checked_at: '2026-09-10 08:00:00'
};

/** 假 D1：只认这一条链路上的 SQL；发出去的语句都留在 calls 里供断言 */
function fakeDb(timetable = null) {
  const calls = [];
  function route(sql) {
    if (/FROM users/i.test(sql)) return { kind: 'first', row: USER_ROW };
    if (/FROM academic_bindings/i.test(sql)) return { kind: 'first', row: BINDING_ROW };
    if (/FROM academic_timetable/i.test(sql) && /ORDER BY/i.test(sql)) {
      const results = timetable ? [{ xnxq_id: TERM, fetched_at: timetable.fetched_at }] : [];
      return { kind: 'all', results };
    }
    if (/FROM academic_timetable/i.test(sql)) return { kind: 'first', row: timetable };
    if (/UPDATE academic_bindings/i.test(sql)) return { kind: 'run' };
    if (/DELETE FROM academic_timetable/i.test(sql)) return { kind: 'run' };
    throw new Error('假 D1 不认识的 SQL: ' + sql);
  }
  return {
    calls,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          calls.push({ sql, args: stmt._args });
          const r = route(sql);
          return r.row !== undefined ? r.row : null;
        },
        async all() {
          calls.push({ sql, args: stmt._args });
          const r = route(sql);
          return { results: r.results || [] };
        },
        async run() {
          calls.push({ sql, args: stmt._args });
          return route(sql);
        }
      };
      return stmt;
    }
  };
}

/** 一份早就过了新鲜期的课表缓存：新鲜与否不影响这一组用例，反正缓存无条件优先 */
function cachedTimetable() {
  return {
    payload: JSON.stringify({
      xnxqId: TERM,
      periods: [],
      courses: [],
      unscheduled: [],
      firstDate: '2026-09-01',
      weekCount: 20
    }),
    fetched_at: sqlTimeAgo(5 * DAY)
  };
}

async function requestTimetable(db) {
  const token = await sign({ id: USER_ROW.id, student_id: USER_ROW.student_id }, SECRET, 60);
  const request = new Request('https://class.example/api/academic/timetable', {
    headers: { Authorization: `Bearer ${token}` }
  });
  return withSilencedErrors(() => worker.fetch(request, { JWT_SECRET: SECRET, DB: db }, {}));
}

describe('会话解不开时的课表', () => {
  it('缓存可用就先给缓存：200 + fromCache + stale，而不是 400', async () => {
    const db = fakeDb(cachedTimetable());
    const res = await requestTimetable(db);
    const body = await res.json();

    assert.equal(res.status, 200);
    assert.equal(body.success, true);
    assert.equal(body.data.xnxqId, TERM);
    assert.equal(body.data.fromCache, true);
    assert.equal(body.data.stale, true);
    // 密文解不开对用户就是「得重新绑定」，与登录态被教务重置同一句话
    assert.equal(body.data.cacheReason, 'expired');
  });

  it('缓存给得出去就不动绑定状态：别把「本地读不出密钥」挂成账号失效', async () => {
    const db = fakeDb(cachedTimetable());
    await requestTimetable(db);

    const expired = db.calls.filter((c) => /UPDATE academic_bindings/i.test(c.sql));
    assert.equal(expired.length, 0);
  });

  it('连缓存都没有时才报 400 ACADEMIC_DECRYPT_FAILED，并把绑定标成失效', async () => {
    const db = fakeDb(null);
    const res = await requestTimetable(db);

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      success: false,
      error: '教务登录态已过期，请重新登录教务系统',
      code: 'ACADEMIC_DECRYPT_FAILED'
    });
    const expired = db.calls.filter((c) => /UPDATE academic_bindings/i.test(c.sql));
    assert.equal(expired.length, 1);
  });
});
