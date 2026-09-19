import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { academicRoutes } from '../src/routes/academic.js';
import { sign } from '../src/utils/jwt.js';

/**
 * 教务转发层。
 *
 * 教务实现搬到私有 Worker 之后，本站与它之间只剩这一层薄薄的转发，它承担三件事，
 * 每件都要有断言钉着：
 *   · 身份与内部令牌必须送到位 —— 送错了就是「谁都能拿到别人的课表」或者「谁都拿不到」
 *   · 请求要原样过去（方法 / 查询串 / body），响应要原样回来（状态码 / 错误码）
 *   · 绑定或令牌没配好时给得出明确的错误码，而不是 500
 */

const SECRET = 'test-secret';
const TOKEN = 'test-internal-token';
const USER_ROW = { id: 1, student_id: '2022103071', name: '张三', positions: '学生', contact: '' };

/** 假 D1：withAuth 只查一次 users */
function fakeDb() {
  return {
    prepare(sql) {
      if (!/FROM users/i.test(sql)) throw new Error('假 D1 不认识的 SQL: ' + sql);
      const stmt = {
        bind() { return stmt; },
        async first() { return USER_ROW; }
      };
      return stmt;
    }
  };
}

/** 假 Service Binding：记录每一次调用，可指定返回什么 */
function fakeBinding(respond) {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({
        url: String(url),
        method: init.method,
        headers: new Headers(init.headers),
        body: init.body
      });
      if (respond) return respond();
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

function upstreamEnv(binding, extra = {}) {
  return { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, ACADEMIC_API: binding, DB: fakeDb(), ...extra };
}

/** 带登录态的请求（未指定 headers 时自动签一个有效 JWT） */
async function authedRequest(path, { method = 'GET', body, headers = {}, anonymous = false } = {}) {
  const init = { method, headers: { ...headers } };
  if (!anonymous) {
    const token = await sign({ id: USER_ROW.id, student_id: USER_ROW.student_id }, SECRET, 60);
    init.headers.Authorization = `Bearer ${token}`;
  }
  if (body !== undefined) init.body = body;
  return new Request('https://class.example' + path, init);
}

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

describe('转发的请求形状', () => {
  it('把内部令牌与调用者身份放在请求头里送过去', async () => {
    const binding = fakeBinding();
    const res = await worker.fetch(
      await authedRequest('/api/academic/timetable?xnxq=2026-2027-1&refresh=1'),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
    const sent = binding.calls[0];
    // 查询串要一起带过去，否则学期与强制刷新都会丢
    assert.match(sent.url, /\/api\/academic\/timetable\?xnxq=2026-2027-1&refresh=1$/);
    assert.equal(sent.method, 'GET');
    assert.equal(sent.headers.get('X-Internal-Token'), TOKEN);
    assert.equal(sent.headers.get('X-User-Id'), String(USER_ROW.id));
    // 学号是字符串，不能被当成数字处理
    assert.equal(sent.headers.get('X-Student-Id'), USER_ROW.student_id);
  });

  it('POST 的 body 与 Content-Type 原样转交', async () => {
    const binding = fakeBinding();
    const payload = JSON.stringify({ cookies: 'X-Qz-JSession=abc' });
    await worker.fetch(
      await authedRequest('/api/academic/bind', {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' }
      }),
      upstreamEnv(binding),
      {}
    );

    const sent = binding.calls[0];
    assert.equal(sent.method, 'POST');
    assert.equal(sent.body, payload);
    assert.equal(sent.headers.get('Content-Type'), 'application/json');
  });

  it('DELETE 解绑不带 body 时也不会凭空造一个', async () => {
    const binding = fakeBinding();
    await worker.fetch(
      await authedRequest('/api/academic/bind', { method: 'DELETE' }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(binding.calls[0].method, 'DELETE');
    assert.equal(binding.calls[0].body, undefined);
  });
});

describe('转发的响应形状', () => {
  it('状态码与错误码原样透传（前端就是靠这两个分支决定给不给重新绑定的入口）', async () => {
    const binding = fakeBinding(() => new Response(JSON.stringify({
      success: false,
      error: '教务登录态已过期，请重新登录教务系统',
      code: 'ACADEMIC_EXPIRED'
    }), { status: 400, headers: { 'Content-Type': 'application/json' } }));

    const res = await worker.fetch(
      await authedRequest('/api/academic/timetable'),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 400);
    assert.deepEqual(await res.json(), {
      success: false,
      error: '教务登录态已过期，请重新登录教务系统',
      code: 'ACADEMIC_EXPIRED'
    });
  });
});

describe('转发层的准入与故障', () => {
  it('未登录时不碰教务服务，直接 401', async () => {
    const binding = fakeBinding();
    const res = await worker.fetch(
      await authedRequest('/api/academic/timetable', { anonymous: true }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 401);
    assert.equal(binding.calls.length, 0, '没登录就不该产生任何一次上游调用');
  });

  it('缺 ACADEMIC_API 绑定时给 503，而不是让 500 冒出来', async () => {
    // 某个环境没配这条绑定时的兜底（两个环境现在都配了，这条路径是给将来新环境留的）
    const request = await authedRequest('/api/academic/timetable');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, DB: fakeDb() },
      {}
    ));

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ACADEMIC_UNAVAILABLE');
  });

  it('缺 INTERNAL_TOKEN 时拒绝（否则会拿着空令牌去敲上游）', async () => {
    const binding = fakeBinding();
    const request = await authedRequest('/api/academic/timetable');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      { JWT_SECRET: SECRET, ACADEMIC_API: binding, DB: fakeDb() },
      {}
    ));

    assert.equal(res.status, 500);
    assert.equal((await res.json()).code, 'SERVER_MISCONFIGURED');
    assert.equal(binding.calls.length, 0);
  });

  it('上游调用本身失败时给 503，不把异常抛成 500', async () => {
    const binding = {
      async fetch() { throw new Error('service binding unavailable'); }
    };
    const request = await authedRequest('/api/academic/timetable');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      upstreamEnv(binding),
      {}
    ));

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'ACADEMIC_UNAVAILABLE');
  });
});

describe('路由归属', () => {
  it('非 /api/academic/ 的路径不由本路由接管', async () => {
    const res = await academicRoutes(new Request('https://class.example/api/notices'), {}, {});
    assert.equal(res, null);
  });
});
