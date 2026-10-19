import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { handleLogin } from '../src/handlers/authHandler.js';
import { ConsentModel } from '../src/models/consentModel.js';
import { UserModel } from '../src/models/userModel.js';
import { createSqliteDb } from './helpers/sqlite.js';
import {
  AGREEMENT_VERSION,
  isCurrentConsent,
  parseConsentPayload,
  summarizeConsent
} from '../src/utils/consent.js';
import { hashPassword } from '../src/utils/crypto.js';
import { sign } from '../src/utils/jwt.js';

const SECRET = 'test-secret';
const INTERNAL_TOKEN = 'test-internal-token';
const STUDENT_ID = '2022103071';
const PASSWORD = 'pw123456';

const baseline = readFileSync(new URL('../../migrations-v2/0001_baseline.sql', import.meta.url), 'utf8');
const lifecycle = readFileSync(new URL('../../migrations-v2/0002_lifecycle.sql', import.meta.url), 'utf8');
const consentUpgrade = readFileSync(new URL('../../migrations-v2/0003_consent.sql', import.meta.url), 'utf8');

function count(db, table) {
  return db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;
}

/**
 * 造一个能登录的用户。
 * password_hash 的存储格式是「盐值:哈希」——与 authHandler 里 `split(':')` 的读法对齐，
 * 写反了会变成「永远密码错误」，且错得很安静。
 */
async function seedUser(db, { id = 1, studentId = STUDENT_ID, password = PASSWORD } = {}) {
  const { hash, salt } = await hashPassword(password);
  db.sqlite
    .prepare('INSERT INTO users(id,student_id,name,password_hash,positions) VALUES(?,?,?,?,?)')
    .run(id, studentId, '张三', `${salt}:${hash}`, '学生');
  return { id, studentId };
}

async function login(db, body) {
  const request = new Request('https://class.example/api/auth/login', {
    method: 'POST',
    body: JSON.stringify(body)
  });
  const res = await handleLogin(request, { DB: db, JWT_SECRET: SECRET });
  return { status: res.status, body: await res.json() };
}

/** 带登录态的请求：JWT 用同一个 SECRET 现签，走完整 worker 路由 */
async function authedRequest(path, { method = 'GET', body, token } = {}) {
  const headers = {
    Authorization: `Bearer ${token || (await sign({ id: 1, student_id: STUDENT_ID }, SECRET, 60))}`
  };
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  return new Request('https://class.example' + path, init);
}

/** 假 Service Binding：只记录调用，不真的出网 */
function fakeBinding() {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), method: init.method });
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

describe('user_consents 迁移与级联', () => {
  it('0003 能在「基线 + 0002」的旧库上执行，删成员时级联清掉同意记录', async (t) => {
    const db = createSqliteDb(t, false);
    db.sqlite.exec(baseline);
    db.sqlite.exec(lifecycle);
    db.sqlite.exec(consentUpgrade);

    await seedUser(db);
    await new ConsentModel(db).upsert(1, { terms: true, chaoxing: true, academic: true });
    assert.equal(count(db, 'user_consents'), 1);

    await new UserModel(db).delete(1);
    assert.equal(count(db, 'user_consents'), 0, '删成员要靠外键级联把同意记录一起清掉');
  });

  it('新库快照里也有这张表，删成员同样级联', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    await new ConsentModel(db).upsert(1, { terms: true, chaoxing: false, academic: false });
    assert.equal(count(db, 'user_consents'), 1);
    await new UserModel(db).delete(1);
    assert.equal(count(db, 'user_consents'), 0);
  });
});

describe('同意口径的纯函数', () => {
  it('isCurrentConsent 只认「版本一致且 terms=1」', () => {
    assert.equal(isCurrentConsent(null), false);
    assert.equal(isCurrentConsent({ version: AGREEMENT_VERSION, terms: 0 }), false);
    assert.equal(isCurrentConsent({ version: '2020-01-01', terms: 1 }), false);
    assert.equal(isCurrentConsent({ version: AGREEMENT_VERSION, terms: 1 }), true);
  });

  it('summarizeConsent 把 0/1 转成布尔、空时间转 null', () => {
    assert.equal(summarizeConsent(null), null);
    const summary = summarizeConsent({
      version: AGREEMENT_VERSION, terms: 1, chaoxing: 0, academic: 1,
      terms_agreed_at: '2026-10-19 10:00:00', chaoxing_agreed_at: null,
      academic_agreed_at: '2026-10-19 11:00:00', updated_at: '2026-10-19 11:00:00'
    });
    assert.deepEqual(summary, {
      version: AGREEMENT_VERSION,
      terms: true,
      chaoxing: false,
      academic: true,
      terms_agreed_at: '2026-10-19 10:00:00',
      chaoxing_agreed_at: null,
      academic_agreed_at: '2026-10-19 11:00:00',
      updated_at: '2026-10-19 11:00:00'
    });
  });

  it('parseConsentPayload 不认漏传的 terms，可选项缺省即不同意', () => {
    assert.equal(parseConsentPayload(null), null);
    assert.equal(parseConsentPayload([]), null);
    assert.equal(parseConsentPayload({}), null);
    assert.equal(parseConsentPayload({ terms: false }), null);
    assert.equal(parseConsentPayload({ terms: 'true' }), null);
    assert.deepEqual(parseConsentPayload({ terms: true }), { terms: true, chaoxing: false, academic: false });
    assert.deepEqual(parseConsentPayload({ terms: true, chaoxing: true, academic: 1 }), {
      terms: true, chaoxing: true, academic: true
    });
    assert.deepEqual(parseConsentPayload({ terms: 1, chaoxing: true }), {
      terms: true, chaoxing: true, academic: false
    });
  });
});

describe('ConsentModel 的时间戳语义', () => {
  it('首次同意写入三项时间，重复同意保留历史时间', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const model = new ConsentModel(db);

    const first = await model.upsert(1, { terms: true, chaoxing: true, academic: false });
    assert.equal(first.version, AGREEMENT_VERSION);
    assert.equal(Number(first.terms), 1);
    assert.equal(Number(first.chaoxing), 1);
    assert.equal(Number(first.academic), 0);
    assert.ok(first.terms_agreed_at);
    assert.ok(first.chaoxing_agreed_at);
    assert.equal(first.academic_agreed_at, null, '本次没开的项不写时间');

    // 把时间改成固定历史值，再重复同意：时间戳必须原样保留（只有 updated_at 前进）
    db.sqlite.exec("UPDATE user_consents SET terms_agreed_at='2020-01-01 00:00:00', chaoxing_agreed_at='2020-01-02 00:00:00'");
    const second = await model.upsert(1, { terms: true, chaoxing: true, academic: true });
    assert.equal(second.terms_agreed_at, '2020-01-01 00:00:00');
    assert.equal(second.chaoxing_agreed_at, '2020-01-02 00:00:00');
    assert.ok(second.academic_agreed_at, '原本为 0、本次为 1 的项要补上时间');
  });

  it('撤回授权不清历史时间，重新开启才刷新', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const model = new ConsentModel(db);
    await model.upsert(1, { terms: true, chaoxing: true, academic: true });
    db.sqlite.exec("UPDATE user_consents SET chaoxing_agreed_at='2020-01-02 00:00:00', academic_agreed_at='2020-01-03 00:00:00'");

    const revoked = await model.upsert(1, { terms: true, chaoxing: false, academic: false });
    assert.equal(Number(revoked.chaoxing), 0);
    assert.equal(Number(revoked.academic), 0);
    assert.equal(revoked.chaoxing_agreed_at, '2020-01-02 00:00:00', '撤回只关开关，不改写「什么时候授权过」');
    assert.equal(revoked.academic_agreed_at, '2020-01-03 00:00:00');

    const again = await model.upsert(1, { terms: true, chaoxing: true, academic: true });
    assert.notEqual(again.chaoxing_agreed_at, '2020-01-02 00:00:00', '重新开启才刷新时间');
    assert.notEqual(again.academic_agreed_at, '2020-01-03 00:00:00');
  });
});

describe('登录前的协议同意检查', () => {
  it('密码正确但没同意过：412 CONSENT_REQUIRED，不签 token 也不落库', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);

    const { status, body } = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(status, 412);
    assert.deepEqual(body, {
      success: false,
      error: '请先阅读并同意用户协议',
      code: 'CONSENT_REQUIRED',
      data: { version: AGREEMENT_VERSION }
    });
    assert.equal(body.token, undefined);
    assert.equal(count(db, 'user_consents'), 0, '被拦下的登录不能留下半条同意记录');
  });

  it('密码错误永远是 401 INVALID_CREDENTIALS，不会变成「要同意协议」', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);

    const { status, body } = await login(db, { student_id: STUDENT_ID, password: 'wrong-password' });
    assert.equal(status, 401, '错误密码绝不能透出「这个学号存在、只是没同意」');
    assert.equal(body.code, 'INVALID_CREDENTIALS');
  });

  it('consent 形状不对（漏了必选 terms）→ 400 CONSENT_TERMS_REQUIRED', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);

    const { status, body } = await login(db, {
      student_id: STUDENT_ID,
      password: PASSWORD,
      consent: { chaoxing: true }
    });
    assert.equal(status, 400);
    assert.equal(body.code, 'CONSENT_TERMS_REQUIRED');
    assert.equal(count(db, 'user_consents'), 0);
  });

  it('带着同意信息登录：200 + token + 摘要 + 落库', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);

    const { status, body } = await login(db, {
      student_id: STUDENT_ID,
      password: PASSWORD,
      consent: { terms: true, chaoxing: true, academic: false }
    });
    assert.equal(status, 200);
    assert.ok(body.data.token, '通过协议检查后要正常签发登录态');
    assert.equal(body.data.user.student_id, STUDENT_ID);
    assert.equal(body.data.consent.version, AGREEMENT_VERSION);
    assert.equal(body.data.consent.terms, true);
    assert.equal(body.data.consent.chaoxing, true);
    assert.equal(body.data.consent.academic, false);
    assert.ok(body.data.consent.terms_agreed_at);
    assert.equal(body.data.consent.academic_agreed_at, null);

    const row = await new ConsentModel(db).get(1);
    assert.equal(row.version, AGREEMENT_VERSION);
    assert.equal(Number(row.terms), 1);
    assert.equal(Number(row.chaoxing), 1);
    assert.equal(Number(row.academic), 0);
    assert.equal(count(db, 'user_consents'), 1);
  });

  it('同意过之后再登录就不弹窗（服务端记录说了算），且不再写库', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    await login(db, {
      student_id: STUDENT_ID,
      password: PASSWORD,
      consent: { terms: true, chaoxing: false, academic: false }
    });
    // 把时间改成固定历史值：如果免弹窗那次又写了一遍库，这个值会被刷新
    db.sqlite.exec("UPDATE user_consents SET terms_agreed_at='2020-01-01 00:00:00'");

    const { status, body } = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(status, 200);
    assert.ok(body.data.token);
    assert.equal(body.data.consent.terms, true);

    const row = await new ConsentModel(db).get(1);
    assert.equal(row.terms_agreed_at, '2020-01-01 00:00:00', '已同意时不该更新数据库');
    assert.equal(count(db, 'user_consents'), 1);
  });

  it('协议版本过期：同一条记录也要求重新同意', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    await login(db, {
      student_id: STUDENT_ID,
      password: PASSWORD,
      consent: { terms: true, chaoxing: true, academic: true }
    });
    db.sqlite.exec("UPDATE user_consents SET version='2020-01-01'");

    const { status, body } = await login(db, { student_id: STUDENT_ID, password: PASSWORD });
    assert.equal(status, 412);
    assert.equal(body.code, 'CONSENT_REQUIRED');
    assert.equal(body.data.version, AGREEMENT_VERSION);

    // 重新同意后版本被覆盖成当前版本，下一次登录恢复正常
    const retried = await login(db, {
      student_id: STUDENT_ID,
      password: PASSWORD,
      consent: { terms: true }
    });
    assert.equal(retried.status, 200);
    assert.equal((await new ConsentModel(db).get(1)).version, AGREEMENT_VERSION);
  });
});

describe('GET / POST /api/auth/consent', () => {
  it('读状态 → 首次必须带 terms → 改两项授权 → 必选项不可撤回', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };

    let res = await worker.fetch(await authedRequest('/api/auth/consent'), env, {});
    assert.equal(res.status, 200);
    let json = await res.json();
    assert.equal(json.data.version, AGREEMENT_VERSION);
    assert.equal(json.data.agreed, false);
    assert.equal(json.data.consent, null, '没有记录时给 null，而不是全 false 的对象');

    // 还没同意过：不带 terms 不允许写入
    res = await worker.fetch(await authedRequest('/api/auth/consent', {
      method: 'POST',
      body: { chaoxing: true }
    }), env, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'CONSENT_TERMS_REQUIRED');
    assert.equal(count(db, 'user_consents'), 0);

    res = await worker.fetch(await authedRequest('/api/auth/consent', {
      method: 'POST',
      body: { terms: true, chaoxing: true }
    }), env, {});
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(json.data.agreed, true);
    assert.equal(json.data.consent.chaoxing, true);
    assert.equal(json.data.consent.academic, false);

    // 已同意之后只改一项：没传的字段保持原值，不能被悄悄关掉
    res = await worker.fetch(await authedRequest('/api/auth/consent', {
      method: 'POST',
      body: { academic: true }
    }), env, {});
    assert.equal(res.status, 200);
    json = await res.json();
    assert.equal(json.data.consent.terms, true);
    assert.equal(json.data.consent.chaoxing, true);
    assert.equal(json.data.consent.academic, true);

    // 必选项不可撤回：400，且库里状态不变
    res = await worker.fetch(await authedRequest('/api/auth/consent', {
      method: 'POST',
      body: { terms: false }
    }), env, {});
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'CANNOT_REVOKE_TERMS');
    assert.equal(Number((await new ConsentModel(db).get(1)).terms), 1);
  });
});

describe('教务接口的授权拦截', () => {
  it('没同意教务授权：出网的接口全部 403，缓存读取 / 状态 / 解绑放行', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    await new ConsentModel(db).upsert(1, { terms: true, chaoxing: true, academic: false });

    const binding = fakeBinding();
    const env = { DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN, ACADEMIC_API: binding };

    const blocked = [
      ['/api/academic/bind', 'POST'],
      ['/api/academic/login', 'POST'],
      ['/api/academic/mfa/send', 'POST'],
      ['/api/academic/mfa/verify', 'POST'],
      ['/api/academic/timetable?refresh=1', 'GET'],
      ['/api/academic/credits?refresh=1', 'GET'],
      ['/api/academic/grades?refresh=1', 'GET']
    ];
    for (const [path, method] of blocked) {
      const res = await worker.fetch(
        await authedRequest(path, { method, body: method === 'POST' ? {} : undefined }),
        env,
        {}
      );
      assert.equal(res.status, 403, `${method} ${path} 应该被拦下`);
      assert.equal((await res.json()).code, 'ACADEMIC_CONSENT_REQUIRED', `${method} ${path}`);
    }
    assert.equal(binding.calls.length, 0, '被拦下的请求不能透到上游');

    // 放行：读缓存（不带 refresh）、状态查询、解绑。撤权之后这些还得能用，
    // 否则想解绑都做不到。
    const passed = [
      ['/api/academic/status', 'GET'],
      ['/api/academic/timetable', 'GET'],
      ['/api/academic/credits', 'GET'],
      ['/api/academic/grades?xnxq=2026-2027-1', 'GET'],
      ['/api/academic/bind', 'DELETE']
    ];
    for (const [path, method] of passed) {
      const res = await worker.fetch(await authedRequest(path, { method }), env, {});
      assert.equal(res.status, 200, `${method} ${path} 应该放行`);
    }
    assert.equal(binding.calls.length, passed.length);
  });

  it('开了教务授权就照旧转发；撤权后同一请求变成 403', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const model = new ConsentModel(db);
    await model.upsert(1, { terms: true, academic: true });

    const binding = fakeBinding();
    const env = { DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN, ACADEMIC_API: binding };

    let res = await worker.fetch(await authedRequest('/api/academic/timetable?refresh=1'), env, {});
    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);

    await model.upsert(1, { terms: true, academic: false });
    res = await worker.fetch(await authedRequest('/api/academic/timetable?refresh=1'), env, {});
    assert.equal(res.status, 403);
    assert.equal(binding.calls.length, 1, '撤权后不能再出网');
  });
});
