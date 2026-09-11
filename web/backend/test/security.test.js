import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sameStudentId } from '../src/utils/identity.js';
import { clampInt, pageLimit, pageOffset } from '../src/utils/query.js';
import {
  ALLOWED_PERMISSIONS,
  assertCustomRoleName,
  isReservedRole,
  sanitizePermissions
} from '../src/utils/permissions.js';
import { hashPassword, verifyPassword } from '../src/utils/crypto.js';
import { sign, verify } from '../src/utils/jwt.js';
import { isSealed, openCookies, sealCookies } from '../src/utils/cookieVault.js';
import { nextRateState } from '../src/utils/rateLimit.js';

describe('sameStudentId', () => {
  it('trim 后精确匹配', () => {
    assert.equal(sameStudentId(' 2022103071 ', '2022103071'), true);
    assert.equal(sameStudentId('2022103071', '2022103072'), false);
    assert.equal(sameStudentId('', ''), false);
    assert.equal(sameStudentId(null, '1'), false);
  });
});

describe('query clamp', () => {
  it('把离谱的 limit/offset 收敛到合法范围', () => {
    assert.equal(clampInt('999999', 1, 100, 50), 100);
    assert.equal(clampInt('-3', 1, 100, 50), 1);
    assert.equal(clampInt('abc', 1, 100, 50), 50);
    const url = new URL('https://x.test/api/notices?limit=999999&offset=-10');
    assert.equal(pageLimit(url), 100);
    assert.equal(pageOffset(url), 0);
  });
});

describe('自定义职位', () => {
  it('预置职位名不能当自定义职位', () => {
    assert.equal(isReservedRole('学生'), true);
    assert.equal(isReservedRole('班长'), true);
    assert.equal(assertCustomRoleName('学生').ok, false);
    assert.equal(assertCustomRoleName('文艺委员').ok, true);
  });

  it('权限只保留白名单', () => {
    assert.deepEqual(
      sanitizePermissions(['content:write', 'admin', 'user:manage', 'content:write']),
      ['content:write', 'user:manage']
    );
    assert.ok(ALLOWED_PERMISSIONS.includes('content:write'));
  });
});

describe('密码哈希', () => {
  it('正确密码通过，错误密码拒绝', async () => {
    const { hash, salt } = await hashPassword('hello-world');
    assert.equal(await verifyPassword('hello-world', hash, salt), true);
    assert.equal(await verifyPassword('hello-world!', hash, salt), false);
  });
});

describe('JWT', () => {
  it('签发后能校验，过期或被改则失败', async () => {
    const token = await sign({ id: 1, student_id: '2022103071', ver: 3 }, 'test-secret', 60);
    const payload = await verify(token, 'test-secret');
    assert.equal(payload.id, 1);
    assert.equal(payload.ver, 3);

    const expired = await sign({ id: 1 }, 'test-secret', -10);
    assert.equal(await verify(expired, 'test-secret'), null);
    assert.equal(await verify(token, 'other-secret'), null);
  });
});

describe('Cookie 封存', () => {
  const env = { COOKIE_SECRET: 'unit-test-cookie-secret' };

  it('加密后再解开与原文一致', async () => {
    const raw = 'X-Qz-JSession=abc; INGRESSCOOKIE=xyz';
    const sealed = await sealCookies(env, raw);
    assert.equal(isSealed(sealed), true);
    assert.equal(sealed.includes('abc'), false);
    assert.equal(await openCookies(env, sealed), raw);
  });

  it('旧明文可以直接读出，方便平滑迁移', async () => {
    assert.equal(await openCookies(env, 'SESSION=plain'), 'SESSION=plain');
  });
});

describe('限流窗口', () => {
  it('窗口内超过上限拒绝，过期后重置', () => {
    const now = 1_000_000;
    const first = nextRateState(null, now, 3, 1000);
    assert.equal(first.allowed, true);
    assert.equal(first.count, 1);

    const blocked = nextRateState({ count: 3, reset_at: now + 500 }, now, 3, 1000);
    assert.equal(blocked.allowed, false);
    assert.equal(blocked.retryAfterMs, 500);

    const reset = nextRateState({ count: 3, reset_at: now - 1 }, now, 3, 1000);
    assert.equal(reset.allowed, true);
    assert.equal(reset.count, 1);
  });
});
