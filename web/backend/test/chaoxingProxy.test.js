import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { academicRoutes } from '../src/routes/academic.js';
import { chaoxingRoutes } from '../src/routes/chaoxing.js';
import { AGREEMENT_VERSION } from '../src/utils/consent.js';
import { sign } from '../src/utils/jwt.js';

/**
 * 学习通转发层。
 *
 * 与 academicProxy.test.js 同一形态：教务 / 学习通的实现都在私有 Worker 里，门户这层
 * 转发承担三件事，每件都要有断言钉着：
 *   · 身份与内部令牌必须送到位 —— 送错了就是「谁都能拿到别人的学习通数据」
 *   · 请求要原样过去（方法 / 查询串 / body），响应要原样回来（状态码 / 错误码）
 *   · 未登录、功能停用、未授权、绑定或令牌没配好时，给得出明确的错误码且**不调上游**
 */

const SECRET = 'test-secret';
const TOKEN = 'test-internal-token';
const USER_ROW = { id: 1, student_id: '2022103071', name: '张三', positions: '学生', contact: '' };

/**
 * 默认的同意记录：已同意当前版本、且开了学习通授权。
 * 原有转发用例都跑在这个前提上，免得全被授权拦截挡在门外。
 */
const CONSENT_ROW = {
  user_id: USER_ROW.id,
  version: AGREEMENT_VERSION,
  terms: 1,
  chaoxing: 1,
  academic: 0,
  terms_agreed_at: '2026-10-19 10:00:00',
  chaoxing_agreed_at: '2026-10-19 10:00:00',
  academic_agreed_at: null,
  created_at: '2026-10-19 10:00:00',
  updated_at: '2026-10-19 10:00:00'
};

/**
 * 假 D1：withAuth 查一次 users，学习通准入再查一次 user_consents；
 * 功能开关查一次 app_settings（默认没有行 = 开启，与 SettingModel 的缺省语义一致）。
 * 传入的 settingsRows 用来模拟管理员主动停用。
 */
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
  return { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, CHAOXING_API: binding, DB: fakeDb(), ...extra };
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
  it('把内部令牌与调用者身份放在请求头里送过去，查询串一起带过去', async () => {
    const binding = fakeBinding();
    const res = await worker.fetch(
      await authedRequest('/api/chaoxing/works?courseId=123456&refresh=1'),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
    const sent = binding.calls[0];
    // 查询串要一起带过去，否则课程 ID 与强制刷新都会丢
    assert.match(sent.url, /\/api\/chaoxing\/works\?courseId=123456&refresh=1$/);
    assert.equal(sent.method, 'GET');
    assert.equal(sent.headers.get('X-Internal-Token'), TOKEN);
    assert.equal(sent.headers.get('X-User-Id'), String(USER_ROW.id));
    // 学号是字符串，不能被当成数字处理
    assert.equal(sent.headers.get('X-Student-Id'), USER_ROW.student_id);
    // 姓名要 URL 编码后转交：HTTP 头不能直接放中文，私有 Worker 会解码回来
    assert.equal(sent.headers.get('X-User-Name'), encodeURIComponent(USER_ROW.name));
  });

  it('POST 的 body 与 Content-Type 原样转交', async () => {
    const binding = fakeBinding();
    const payload = JSON.stringify({ cookies: '_uid=1; _d=abc', account: '2022103071' });
    await worker.fetch(
      await authedRequest('/api/chaoxing/bind', {
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

  it('POST /bind/preview 也走同一条转发（预览不写库是上游的事，门户不特殊对待）', async () => {
    const binding = fakeBinding();
    const payload = JSON.stringify({ cookies: '_uid=1; _d=abc' });
    const res = await worker.fetch(
      await authedRequest('/api/chaoxing/bind/preview', {
        method: 'POST',
        body: payload,
        headers: { 'Content-Type': 'application/json' }
      }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 200);
    assert.match(binding.calls[0].url, /\/api\/chaoxing\/bind\/preview$/);
    assert.equal(binding.calls[0].body, payload);
  });

  it('DELETE 解绑不带 body 时也不会凭空造一个', async () => {
    const binding = fakeBinding();
    await worker.fetch(
      await authedRequest('/api/chaoxing/bind', { method: 'DELETE' }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(binding.calls[0].method, 'DELETE');
    assert.equal(binding.calls[0].body, undefined);
  });
});

describe('转发的响应形状', () => {
  it('状态码与错误码原样透传（前端就是靠这两个分支决定要不要弹验证码）', async () => {
    const binding = fakeBinding(() => new Response(JSON.stringify({
      success: false,
      error: '学习通要求完成验证码，请重新登录',
      code: 'CHAOXING_NEED_CAPTCHA'
    }), { status: 409, headers: { 'Content-Type': 'application/json' } }));

    const res = await worker.fetch(
      await authedRequest('/api/chaoxing/login', {
        method: 'POST',
        body: JSON.stringify({ account: '2022103071', password: 'pw' }),
        headers: { 'Content-Type': 'application/json' }
      }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 409);
    assert.deepEqual(await res.json(), {
      success: false,
      error: '学习通要求完成验证码，请重新登录',
      code: 'CHAOXING_NEED_CAPTCHA'
    });
  });
});

describe('转发层的准入与故障', () => {
  it('未登录时不碰学习通服务，直接 401', async () => {
    const binding = fakeBinding();
    const res = await worker.fetch(
      await authedRequest('/api/chaoxing/courses', { anonymous: true }),
      upstreamEnv(binding),
      {}
    );

    assert.equal(res.status, 401);
    assert.equal(binding.calls.length, 0, '没登录就不该产生任何一次上游调用');
  });

  it('缺 CHAOXING_API 绑定时给 503，而不是让 500 冒出来', async () => {
    const request = await authedRequest('/api/chaoxing/status');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, DB: fakeDb() },
      {}
    ));

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'CHAOXING_UNAVAILABLE');
  });

  it('缺 INTERNAL_TOKEN 时拒绝（否则会拿着空令牌去敲上游）', async () => {
    const binding = fakeBinding();
    const request = await authedRequest('/api/chaoxing/status');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      { JWT_SECRET: SECRET, CHAOXING_API: binding, DB: fakeDb() },
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
    const request = await authedRequest('/api/chaoxing/status');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      upstreamEnv(binding),
      {}
    ));

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'CHAOXING_UNAVAILABLE');
  });

  it('管理员停用学习通后直接 503 FEATURE_DISABLED，且不调用私有 Worker', async () => {
    const binding = fakeBinding();
    const env = upstreamEnv(binding, {
      DB: fakeDb(CONSENT_ROW, [{ key: 'chaoxing_enabled', value: '0' }])
    });

    const res = await worker.fetch(await authedRequest('/api/chaoxing/status'), env, {});

    assert.equal(res.status, 503);
    assert.equal(res.headers.get('Retry-After'), '30');
    const body = await res.json();
    assert.equal(body.code, 'FEATURE_DISABLED');
    assert.equal(body.data.feature, 'chaoxing');
    assert.equal(binding.calls.length, 0, '停用是门户侧止血，不能再去打私有 Worker');
  });
});

describe('学习通授权准入', () => {
  it('没同意学习通授权时，绑定 / 预览 / 代登录全部 403，且不产生任何一次上游调用', async () => {
    const binding = fakeBinding();
    const env = upstreamEnv(binding, { DB: fakeDb({ ...CONSENT_ROW, chaoxing: 0 }) });

    for (const path of ['/api/chaoxing/bind', '/api/chaoxing/bind/preview', '/api/chaoxing/login']) {
      const res = await worker.fetch(
        await authedRequest(path, {
          method: 'POST',
          body: JSON.stringify({ cookies: '_uid=1', account: '2022103071', password: 'pw' }),
          headers: { 'Content-Type': 'application/json' }
        }),
        env,
        {}
      );
      assert.equal(res.status, 403, path);
      const body = await res.json();
      assert.equal(body.code, 'CHAOXING_CONSENT_REQUIRED', path);
      assert.match(body.error, /个人中心/, '文案要指路到个人中心');
    }
    assert.equal(binding.calls.length, 0, '没授权就不该去敲学习通');
  });

  it('没有同意记录（null）同样按未授权处理', async () => {
    const binding = fakeBinding();
    const res = await worker.fetch(
      await authedRequest('/api/chaoxing/bind', {
        method: 'POST',
        body: JSON.stringify({ cookies: '_uid=1' }),
        headers: { 'Content-Type': 'application/json' }
      }),
      upstreamEnv(binding, { DB: fakeDb(null) }),
      {}
    );

    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'CHAOXING_CONSENT_REQUIRED');
    assert.equal(binding.calls.length, 0);
  });

  it('撤权后缓存读取、状态查询与解绑仍放行，只有强制重抓被拦下', async () => {
    const binding = fakeBinding();
    const env = upstreamEnv(binding, { DB: fakeDb({ ...CONSENT_ROW, chaoxing: 0 }) });

    // 不出网的读：读的是私有 Worker 里的缓存，撤权后依然可看
    for (const path of [
      '/api/chaoxing/status',
      '/api/chaoxing/courses',
      '/api/chaoxing/works?courseId=123456',
      '/api/chaoxing/exams?courseId=123456',
      '/api/chaoxing/progress?courseId=123456'
    ]) {
      const res = await worker.fetch(await authedRequest(path), env, {});
      assert.equal(res.status, 200, path);
    }
    // 撤权之后还得让人能解绑
    const unbind = await worker.fetch(await authedRequest('/api/chaoxing/bind', { method: 'DELETE' }), env, {});
    assert.equal(unbind.status, 200);
    assert.equal(binding.calls.length, 6);

    // refresh=1 会真的去学习通重新抓，必须拦
    for (const path of [
      '/api/chaoxing/courses?refresh=1',
      '/api/chaoxing/works?courseId=123456&refresh=1',
      '/api/chaoxing/exams?refresh=true',
      '/api/chaoxing/progress?courseId=123456&refresh=1'
    ]) {
      const res = await worker.fetch(await authedRequest(path), env, {});
      assert.equal(res.status, 403, path);
      assert.equal((await res.json()).code, 'CHAOXING_CONSENT_REQUIRED', path);
    }
    assert.equal(binding.calls.length, 6, '被拦下的请求不能透到上游');
  });
});

describe('路由归属', () => {
  it('非 /api/chaoxing/ 的路径不由本路由接管（尤其不能被教务的转发吃掉）', async () => {
    assert.equal(await chaoxingRoutes(new Request('https://class.example/api/notices'), {}, {}), null);
    assert.equal(await chaoxingRoutes(new Request('https://class.example/api/academic/status'), {}, {}), null);
    assert.equal(await academicRoutes(new Request('https://class.example/api/chaoxing/status'), {}, {}), null);
  });

  it('只有 ACADEMIC_API 绑定也照样按学习通路由处理，不会串到教务转发', async () => {
    // 若 dispatch 把 /api/chaoxing/* 交给了 academicRoutes，这里会拿着 ACADEMIC_API 返回 200；
    // 正确行为是学习通路由发现缺 CHAOXING_API，给出 503 CHAOXING_UNAVAILABLE。
    const academicBinding = fakeBinding();
    const request = await authedRequest('/api/chaoxing/status');
    const res = await withSilencedErrors(() => worker.fetch(
      request,
      { JWT_SECRET: SECRET, INTERNAL_TOKEN: TOKEN, ACADEMIC_API: academicBinding, DB: fakeDb() },
      {}
    ));

    assert.equal(res.status, 503);
    assert.equal((await res.json()).code, 'CHAOXING_UNAVAILABLE');
    assert.equal(academicBinding.calls.length, 0);
  });
});
