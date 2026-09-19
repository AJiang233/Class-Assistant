import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { sign } from '../src/utils/jwt.js';

// 教务相关的那几组（缓存自愈、教务响应体判定、教务接口同源）已随教务代码一起
// 搬到私有仓 class-assistant-private-api 的 test/resilience.test.js。

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
