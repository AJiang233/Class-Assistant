import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { readCachePayload } from '../src/handlers/academicHandler.js';
import { sign } from '../src/utils/jwt.js';

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
      error: '服务器内部错误',
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
