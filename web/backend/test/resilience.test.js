import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { readCachePayload } from '../src/handlers/academicHandler.js';
import { sign } from '../src/utils/jwt.js';
import { SchoolClient, SchoolSessionExpired } from '../src/utils/schoolApi.js';

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

describe('全局错误边界', () => {
  it('handler 抛异常时返回统一的 JSON 错误结构，而不是裸 500', async () => {
    const secret = 'test-secret';
    // D1 连不上是真实会发生的：让 prepare 直接抛，模拟底层故障穿过 handler
    const env = { JWT_SECRET: secret, DB: { prepare() { throw new Error('D1 连接失败'); } } };
    const token = await sign({ id: 1, student_id: '2022103071' }, secret, 60);
    const request = new Request('https://class.example/api/notices', {
      headers: { Authorization: `Bearer ${token}` }
    });

    const res = await withSilencedErrors(() => worker.fetch(request, env, {}));

    assert.equal(res.status, 500);
    assert.match(res.headers.get('Content-Type') || '', /application\/json/);
    assert.deepEqual(await res.json(), {
      success: false,
      error: '服务器出错了，请稍后重试',
      code: 'INTERNAL_ERROR'
    });
  });

  it('没有路由认领时仍是 404 JSON（抽出 dispatch 没改到原行为）', async () => {
    const res = await worker.fetch(new Request('https://class.example/api/does-not-exist'), {}, {});

    assert.equal(res.status, 404);
    assert.deepEqual(await res.json(), {
      success: false,
      error: '接口不存在',
      code: 'NOT_FOUND'
    });
  });
});

describe('教务缓存自愈', () => {
  it('能解析时原样返回，且不触发清除', async () => {
    let cleared = 0;
    const value = await readCachePayload({ payload: '{"courses":[]}' }, () => { cleared += 1; });

    assert.deepEqual(value, { courses: [] });
    assert.equal(cleared, 0);
  });

  it('payload 坏掉时不抛异常，而是清掉缓存交给调用方重抓', async () => {
    let cleared = 0;
    const value = await withSilencedErrors(() =>
      readCachePayload({ payload: '{"courses":' }, () => { cleared += 1; })
    );

    assert.equal(value, null);
    assert.equal(cleared, 1);
  });

  it('JSON 合法但不是对象（数组 / 字符串 / null / 数字）同样按坏数据处理', async () => {
    for (const payload of ['[]', '"x"', 'null', '3']) {
      let cleared = 0;
      const value = await withSilencedErrors(() =>
        readCachePayload({ payload }, () => { cleared += 1; })
      );

      assert.equal(value, null, `payload=${payload}`);
      assert.equal(cleared, 1, `payload=${payload}`);
    }
  });

  it('清除缓存本身失败也得咽下去（这一轮靠重抓给出结果，不能变成新的 500）', async () => {
    const value = await withSilencedErrors(() =>
      readCachePayload({ payload: 'not json' }, () => { throw new Error('D1 写失败'); })
    );

    assert.equal(value, null);
  });
});

/**
 * 教务响应体判定。
 *
 * 教务把失败也包在 HTTP 200 里，用 body 的 status 字段表达，所以「算不算失败」
 * 全靠这里判定。判定必须看 status 的取值，而不是它的真值 —— 写成 `json.status &&`
 * 时，status 为 0 / '' 的失败响应会被整段跳过，调用方紧接着 `json.data || []`
 * 就静默降级成「这学期没有课」，用户看到的是空课表而不是「登录态过期」。
 */
describe('教务响应体判定', () => {
  /** 换掉全局 fetch 跑一段断言，跑完复原（不依赖任何 mock 库） */
  function withFetch(handler, fn) {
    const original = globalThis.fetch;
    globalThis.fetch = handler;
    try {
      return fn();
    } finally {
      globalThis.fetch = original;
    }
  }

  const jsonBody = (body) => async () => new Response(JSON.stringify(body), {
    status: 200,
    headers: { 'Content-Type': 'application/json' }
  });

  it('status 为 "200" 时正常返回 data', async () => {
    const client = new SchoolClient('a=1');
    const list = await withFetch(
      jsonBody({ status: '200', data: [{ id: '2026-2027-1' }] }),
      () => client.termList()
    );

    assert.deepEqual(list, [{ id: '2026-2027-1' }]);
  });

  it('status 是假值（0 / 空串）时不能当成成功吞掉', async () => {
    for (const status of [0, '']) {
      const client = new SchoolClient('a=1');
      await assert.rejects(
        () => withFetch(jsonBody({ status, message: '查询失败' }), () => client.termList()),
        /查询失败/,
        'status=' + JSON.stringify(status) + ' 时应当抛错，而不是静默返回空列表'
      );
    }
  });

  it('body 明确说登录失效时抛会话过期，交给上层引导重新绑定', async () => {
    const client = new SchoolClient('a=1');
    await assert.rejects(
      () => withFetch(jsonBody({ status: '500', message: '登录已失效' }), () => client.termList()),
      SchoolSessionExpired
    );
  });
});

/**
 * 教务接口的同源断言（issue #21）。
 *
 * `new URL(path, SCHOOL_ORIGIN)` 遇到绝对地址会**整体替换** origin，而请求头里带着教务会话 Cookie
 * —— 也就是说「path 被拼成外站 URL」的后果是把会话交出去。当前调用方全传硬编码常量，所以这条
 * 断言今天打不到，属于「一旦有人改动调用方式就变高危」的隐患，用一条用例把它钉住。
 */
describe('教务接口同源', () => {
  it('path 指向站外时抛错，且一个请求都不发出去', async () => {
    const client = new SchoolClient('SESSION=secret');
    let called = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { called++; return new Response('{}', { status: 200 }); };
    try {
      // 绝对外站地址、协议相对地址（//evil.com）、以及明文降级到 http 的同一个主机
      for (const bad of ['https://evil.com/x', '//evil.com/x', 'http://szjw.njau.edu.cn/x']) {
        await assert.rejects(() => client.request(bad), /不能指向站外/, bad);
      }
    } finally {
      globalThis.fetch = orig;
    }
    assert.equal(called, 0, '被拒的路径不能真的发出去：Cookie 就在头里');
  });
});
