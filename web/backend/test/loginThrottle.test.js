import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqliteDb } from './helpers/sqlite.js';
import { handleLogin } from '../src/handlers/authHandler.js';
import { hashPassword } from '../src/utils/crypto.js';
import { AGREEMENT_VERSION } from '../src/utils/consent.js';
import {
  FAILURE_THRESHOLD,
  IP_FAILURE_LIMIT,
  IP_WINDOW_SECONDS,
  LoginAttemptModel,
  RESET_AFTER_SECONDS,
  backoffSeconds,
  hashClientIp,
  nowSeconds
} from '../src/models/loginAttemptModel.js';

/**
 * 登录失败限流与退避（issue #104）。
 *
 * 这里覆盖的验收项：
 * - 同一学号连续失败到阈值后进入指数退避，成功登录后清零；
 * - 同一 IP 高频失败返回 429 + Retry-After；
 * - 正常用户输错一两次密码没有任何感知变化（还是普通 401）。
 *
 * 时间不靠 sleep：模型的方法都收显式 now，退避档位、静默期、窗口过期
 * 这些要「等很久」的分支直接推进时间戳来测。
 */

const SECRET = 'test-secret';
const STUDENT_ID = '2022103071';
const PASSWORD = 'correct-horse';
const IP = '203.0.113.9';

async function seedUser(t, { studentId = STUDENT_ID, password = PASSWORD } = {}) {
  const db = createSqliteDb(t);
  const { hash, salt } = await hashPassword(password);
  db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash,positions)
    VALUES (1,'${studentId}','同学','${salt}:${hash}','学生')`);
  // 种一条「当前版本且已同意」的协议记录：成功登录路径要过协议检查，
  // 否则密码对了也只能拿到 412，验不到「成功清零」以外的成功语义。
  db.sqlite.exec(`INSERT INTO user_consents(user_id,version,terms)
    VALUES (1,'${AGREEMENT_VERSION}',1)`);
  return db;
}

function login(db, body, { ip = IP, secret = SECRET } = {}) {
  const headers = { 'Content-Type': 'application/json' };
  if (ip) headers['CF-Connecting-IP'] = ip;
  return handleLogin(new Request('https://class.example/api/auth/login', {
    method: 'POST',
    headers,
    body: JSON.stringify(body)
  }), { DB: db, JWT_SECRET: secret });
}

/** 连续打 n 次错误密码，返回每次的状态码（同时把响应体读掉，避免未消费的 body） */
async function failTimes(db, n, body = { student_id: STUDENT_ID, password: 'wrong-password' }, opts = {}) {
  const statuses = [];
  for (let i = 0; i < n; i += 1) {
    const res = await login(db, body, opts);
    statuses.push(res.status);
    await res.text();
  }
  return statuses;
}

describe('退避档位', () => {
  it('阈值以下不挡人，达到阈值后 30s → 2min → 10min → 1 小时封顶', () => {
    for (let n = 0; n < FAILURE_THRESHOLD; n += 1) assert.equal(backoffSeconds(n), 0, `第 ${n} 次不该挡`);
    assert.equal(backoffSeconds(FAILURE_THRESHOLD), 30);
    assert.equal(backoffSeconds(FAILURE_THRESHOLD + 1), 120);
    assert.equal(backoffSeconds(FAILURE_THRESHOLD + 2), 600);
    assert.equal(backoffSeconds(FAILURE_THRESHOLD + 3), 3600);
    // issue 里明确写了「不要长期硬锁定」：再错一万次也只等 1 小时，不是永久锁死
    assert.equal(backoffSeconds(10000), 3600);
  });
});

describe('按学号的失败计数与退避', () => {
  it('前 5 次错误都是普通 401，第 6 次起 429 + Retry-After', async (t) => {
    const db = await seedUser(t);

    assert.deepEqual(await failTimes(db, FAILURE_THRESHOLD), [401, 401, 401, 401, 401]);

    const res = await login(db, { student_id: STUDENT_ID, password: 'wrong-again' });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, 'LOGIN_BACKOFF');
    assert.equal(body.data.retry_after, 30);
    assert.equal(res.headers.get('Retry-After'), '30');
    // 文案里也要有秒数：前端只显示 error 文本，不读响应头
    assert.match(body.error, /30 秒/);
  });

  it('退避期间即使密码是对的也拦下，且拦在查库之前', async (t) => {
    const db = await seedUser(t);
    await failTimes(db, FAILURE_THRESHOLD);
    // 把用户整行删掉：如果闸门在查库之后，这里会变成 401（查无此人）；
    // 拿到 429 说明「被挡的请求」根本没走到用户表和 PBKDF2。
    db.sqlite.exec('DELETE FROM users');

    const res = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(res.status, 429);
    await res.text();
  });

  it('退避随时间逐档升级，到期自动放行', async (t) => {
    const db = createSqliteDb(t);
    const model = new LoginAttemptModel(db);
    const t0 = 1_700_000_000;

    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) await model.recordAccountFailure(STUDENT_ID, t0);
    assert.equal(await model.accountRetryAfter(STUDENT_ID, t0), 30);

    // 等到期后又被挡：档位升到 2min
    await model.recordAccountFailure(STUDENT_ID, t0 + 31);
    assert.equal(await model.accountRetryAfter(STUDENT_ID, t0 + 31), 120);
    // 已经过去 9 秒：剩下的就是 120 - 9，不是重新从 120 开始
    assert.equal(await model.accountRetryAfter(STUDENT_ID, t0 + 40), 111);
    // 到期时刻那一刻就该放行（边界取「还剩 0 秒」）
    assert.equal(await model.accountRetryAfter(STUDENT_ID, t0 + 31 + 120), 0);
  });

  it('成功后清零：接着再手滑仍是普通 401', async (t) => {
    const db = await seedUser(t);
    await failTimes(db, FAILURE_THRESHOLD);

    // 此时正好在退避窗口里 —— 先推进时间让它过期，再正常登录
    db.sqlite.exec(`UPDATE login_attempts SET last_failed_at = last_failed_at - ${backoffSeconds(FAILURE_THRESHOLD) + 1}`);
    const ok = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(ok.status, 200);
    assert.ok((await ok.json()).data.token);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM login_attempts').get().n, 0);

    // 清零之后重新从 1 开始数，不会一上来就 429
    assert.deepEqual(await failTimes(db, 2), [401, 401]);
  });

  it('静默 24 小时后旧账失效，不用等管理员清库', async (t) => {
    const db = createSqliteDb(t);
    const model = new LoginAttemptModel(db);
    const t0 = 1_700_000_000;
    for (let i = 0; i < FAILURE_THRESHOLD; i += 1) await model.recordAccountFailure(STUDENT_ID, t0);

    assert.equal(await model.accountRetryAfter(STUDENT_ID, t0 + RESET_AFTER_SECONDS), 0);
    assert.ok(await model.accountRetryAfter(STUDENT_ID, t0));
  });

  it('不存在的学号同样计数退避 —— 429 不能变成学号探测器', async (t) => {
    const db = await seedUser(t);
    const ghost = { student_id: '9999999999', password: 'whatever' };

    // 不存在的学号：前 5 次 401，第 6 次 429，与真实学号完全一样的形状
    assert.deepEqual(await failTimes(db, FAILURE_THRESHOLD, ghost), [401, 401, 401, 401, 401]);
    const res = await login(db, ghost);
    assert.equal(res.status, 429);
    assert.equal((await res.json()).code, 'LOGIN_BACKOFF');
  });
});

describe('按 IP 的失败限流', () => {
  it('同一 IP 失败打满后 429，Retry-After 落在窗口内', async (t) => {
    const db = await seedUser(t);
    const model = new LoginAttemptModel(db);
    const ipHash = await hashClientIp(IP);
    const now = nowSeconds();
    for (let i = 0; i < IP_FAILURE_LIMIT; i += 1) await model.recordIpFailure(ipHash, now);

    const res = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(res.status, 429);
    const body = await res.json();
    assert.equal(body.code, 'LOGIN_RATE_LIMITED');
    const retryAfter = Number(res.headers.get('Retry-After'));
    assert.ok(retryAfter > 0 && retryAfter <= IP_WINDOW_SECONDS, 'Retry-After 应在窗口内');
    assert.equal(body.data.retry_after, retryAfter);
  });

  it('窗口过期后放行；换一个 IP 本来就不受影响', async (t) => {
    const db = await seedUser(t);
    const model = new LoginAttemptModel(db);
    const ipHash = await hashClientIp(IP);
    const t0 = 1_700_000_000;
    for (let i = 0; i < IP_FAILURE_LIMIT; i += 1) await model.recordIpFailure(ipHash, t0);
    assert.equal(await model.ipRetryAfter(ipHash, t0 + IP_WINDOW_SECONDS), 0);

    // 另一个来源 IP：同样的请求直接通过（这个 IP 没失败过）
    const other = await login(db, { student_id: STUDENT_ID, password: PASSWORD }, { ip: '198.51.100.7' });
    assert.equal(other.status, 200);
    assert.ok((await other.json()).data.token);
  });

  it('没有 CF-Connecting-IP 时只靠按学号的闸，不报错', async (t) => {
    const db = await seedUser(t);
    assert.deepEqual(await failTimes(db, 2, { student_id: STUDENT_ID, password: 'nope' }, { ip: null }), [401, 401]);
    const ok = await login(db, { student_id: STUDENT_ID, password: PASSWORD }, { ip: null });
    assert.equal(ok.status, 200);
    await ok.text();
  });
});

describe('正常用户无感知', () => {
  it('输错一两次密码再输对：只有 401 和最后的 200，没有任何 429', async (t) => {
    const db = await seedUser(t);
    assert.deepEqual(await failTimes(db, 2), [401, 401]);
    const ok = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(ok.status, 200);
    const payload = await ok.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.user.student_id, STUDENT_ID);
  });
});
