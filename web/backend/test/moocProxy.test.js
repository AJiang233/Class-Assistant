import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { moocRoutes } from '../src/routes/mooc.js';
import { AGREEMENT_VERSION } from '../src/utils/consent.js';
import { sign } from '../src/utils/jwt.js';

/**
 * 中国大学MOOC 转发层。
 *
 * 和 chaoxingProxy.test.js 同一形态：真正的抓取在私有 Worker 里，门户只做转发，但四件事
 * 必须有断言钉着：
 *   · 身份与内部令牌送到位（否则就是谁都能拿到别人的 MOOC 数据）
 *   · 请求方法 / 路径 / 查询串 / body 原样过去，状态码原样回来
 *   · 未登录、功能停用、未授权时给明确错误码，且**不调上游**
 *   · 只认 /api/mooc/ 前缀，其他路径返回 null 交给后续路由
 */

const SECRET = 'test-secret';
const TOKEN = 'test-internal-token';
const USER_ROW = { id: 1, student_id: '2022103071', name: '张三', positions: '学生', contact: '' };

/** 已同意当前版本、开了 MOOC 授权（学习通没开）。 */
const CONSENT_ROW = {
  user_id: USER_ROW.id,
  version: AGREEMENT_VERSION,
  terms: 1,
  chaoxing: 0,
  academic: 0,
  mooc: 1,
  terms_agreed_at: '2026-10-19 10:00:00',
  chaoxing_agreed_at: null,
  academic_agreed_at: null,
  mooc_agreed_at: '2026-10-19 10:00:00',
  created_at: '2026-10-19 10:00:00',
  updated_at: '2026-10-19 10:00:00'
};

function fakeDb(consentRow = CONSENT_ROW, settingsRows = []) {
  return {
    prepare(sql) {
      let row;
      if (/FROM user_consents/i.test(sql)) row = consentRow;
      else if (/FROM users/i.test(sql)) row = USER_ROW;
      else if (!/FROM app_settings/i.test(sql)) throw new Error('假 D1 不认识的 SQL: ' + sql);
      const stmt = {
        bind() { return stmt; },
        async first() { return row; },
        async all() { return { results: settingsRows }; }
      };
      return stmt;
    }
  };
}

function fakeBinding(respond) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url: String(url), method: init.method, headers: new Headers(init.headers), body: init.body });
      if (respond) return respond();
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

function upstreamEnv(binding, extra = {}) {
  return { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, MOOC_API: binding, DB: fakeDb(), ...extra };
}

async function authedRequest(path, { method = 'GET', body, headers = {}, anonymous = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (!anonymous) {
    const token = await sign({ id: USER_ROW.id, student_id: USER_ROW.student_id }, SECRET, 60);
    init.headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) init.body = body;
  return new Request('https://class.example' + path, init);
}

async function withSilencedErrors(fn) {
  const original = console.error;
  console.error = () => {};
  try {
    return await fn();
  } finally {
    console.error = original;
  }
}

describe('中国大学MOOC 转发的请求形状', () => {
  it('GET /api/mooc/courses 带上身份并原样转发查询串', async () => {
    const binding = fakeBinding(() => new Response(
      JSON.stringify({ success: true, data: { courses: [{ courseId: '1001752041', name: '植物学' }] } }),
      { status: 200, headers: { 'Content-Type': 'application/json' } }
    ));
    const res = await worker.fetch(
      await authedRequest('/api/mooc/courses?refresh=1'),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
    const call = binding.calls[0];
    assert.equal(call.url, 'https://class.example/api/mooc/courses?refresh=1');
    assert.equal(call.method, 'GET');
    assert.equal(call.headers.get('X-Internal-Token'), TOKEN);
    assert.equal(call.headers.get('X-User-Id'), String(USER_ROW.id));
    assert.equal(call.headers.get('X-Student-Id'), USER_ROW.student_id);
    assert.equal(call.headers.get('X-User-Name'), encodeURIComponent(USER_ROW.name));
    assert.deepEqual(await res.json(), { success: true, data: { courses: [{ courseId: '1001752041', name: '植物学' }] } });
  });

  it('POST /api/mooc/bind/preview 把 Cookie body 原样送过去', async () => {
    const binding = fakeBinding();
    const body = JSON.stringify({ cookies: 'NTESSTUDYSI=abc; utid=xyz' });
    const res = await worker.fetch(
      await authedRequest('/api/mooc/bind/preview', {
        method: 'POST',
        body,
        headers: { 'Content-Type': 'application/json' }
      }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
    assert.equal(binding.calls[0].method, 'POST');
    assert.equal(binding.calls[0].body, body);
    assert.equal(binding.calls[0].headers.get('Content-Type'), 'application/json');
  });

  it('上游的错误状态与错误码原样返回', async () => {
    const binding = fakeBinding(() => new Response(
      JSON.stringify({ success: false, error: '会话已过期', code: 'MOOC_EXPIRED' }),
      { status: 400, headers: { 'Content-Type': 'application/json' } }
    ));
    const res = await worker.fetch(
      await authedRequest('/api/mooc/progress?courseId=1001752041'),
      upstreamEnv(binding),
      {}
    );
    assert.equal(res.status, 400);
    assert.equal((await res.json()).code, 'MOOC_EXPIRED');
  });

  it('只在 /api/mooc/ 前缀上接管，其他路径返回 null', async () => {
    const binding = fakeBinding();
    const request = await authedRequest('/api/todos');
    assert.equal(await moocRoutes(request, upstreamEnv(binding), {}), null);
    assert.equal(binding.calls.length, 0);
  });
});

describe('中国大学MOOC 转发的准入控制', () => {
  it('未登录直接 401，不调上游', async () => {
    const binding = fakeBinding();
    const res = await withSilencedErrors(() => worker.fetch(
      new Request('https://class.example/api/mooc/courses'),
      upstreamEnv(binding),
      {}
    ));
    assert.equal(res.status, 401);
    assert.equal(binding.calls.length, 0);
  });

  it('未同意 MOOC 授权时 403 MOOC_CONSENT_REQUIRED，不调上游', async () => {
    const binding = fakeBinding();
    const noMooc = { ...CONSENT_ROW, mooc: 0, mooc_agreed_at: null };
    const env = { ...upstreamEnv(binding), DB: fakeDb(noMooc) };
    const res = await worker.fetch(await authedRequest('/api/mooc/courses?refresh=1'), env, {});
    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'MOOC_CONSENT_REQUIRED');
    assert.equal(binding.calls.length, 0);
  });

  it('读取缓存（不带 refresh）不需要授权', async () => {
    const binding = fakeBinding();
    const noMooc = { ...CONSENT_ROW, mooc: 0, mooc_agreed_at: null };
    const env = { ...upstreamEnv(binding), DB: fakeDb(noMooc) };
    const res = await worker.fetch(await authedRequest('/api/mooc/courses'), env, {});
    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
  });

  it('功能停用时 503 FEATURE_DISABLED，不调上游', async () => {
    const binding = fakeBinding();
    const env = {
      ...upstreamEnv(binding),
      DB: fakeDb(CONSENT_ROW, [{ key: 'mooc_enabled', value: '0' }])
    };
    const res = await worker.fetch(await authedRequest('/api/mooc/courses'), env, {});
    assert.equal(res.status, 503);
    const body = await res.json();
    assert.equal(body.code, 'FEATURE_DISABLED');
    assert.equal(body.data.feature, 'mooc');
    assert.equal(binding.calls.length, 0);
  });

  it('没有内部令牌时 500 SERVER_MISCONFIGURED', async () => {
    const binding = fakeBinding();
    const env = { ...upstreamEnv(binding), INTERNAL_TOKEN: '' };
    const request = await authedRequest('/api/mooc/courses');
    const res = await withSilencedErrors(() => worker.fetch(request, env, {}));
    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'SERVER_MISCONFIGURED');
    assert.equal(binding.calls.length, 0);
  });

  it('没有配 Service Binding 时 503 MOOC_UNAVAILABLE', async () => {
    const env = { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, DB: fakeDb() };
    const res = await worker.fetch(await authedRequest('/api/mooc/courses'), env, {});
    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'MOOC_UNAVAILABLE');
  });
});
