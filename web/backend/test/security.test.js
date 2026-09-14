import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { sameStudentId } from '../src/utils/identity.js';
import { clampInt, pageLimit, pageOffset } from '../src/utils/query.js';
import {
  ALLOWED_PERMISSIONS,
  assertCustomRoleName,
  buildRoleMap,
  getPermissions,
  isReservedRole,
  sanitizePermissions
} from '../src/utils/permissions.js';
import { hashPassword, verifyPassword } from '../src/utils/crypto.js';
import { sign, verify } from '../src/utils/jwt.js';
import { isSealed, openCookies, sealCookies } from '../src/utils/cookieVault.js';
import { toLocalDateTime, parseLocalDateTime } from '../src/utils/datetime.js';
import { MFA_MAX_ATTEMPTS } from '../src/models/academicModel.js';

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
    assert.equal(clampInt('10abc', 1, 100, 50), 50);
    assert.equal(clampInt('1e9', 1, 100, 50), 50);
    assert.equal(clampInt(' 42 ', 1, 100, 50), 42);
    const url = new URL('https://x.test/api/notices?limit=999999&offset=-10');
    assert.equal(pageLimit(url), 100);
    assert.equal(pageOffset(url), 0);
  });
});

describe('本地时间解析', () => {
  it('格式正确但越界的值一律落空，不静默进位', () => {
    assert.equal(toLocalDateTime('2026-02-30 10:00'), null);
    assert.equal(toLocalDateTime('2026-13-01 10:00'), null);
    assert.equal(toLocalDateTime('2026-01-01 25:00'), null);
    assert.equal(toLocalDateTime('2026-01-01 10:60'), null);
    assert.equal(parseLocalDateTime('2026-02-30 10:00'), null);
  });

  it('合法值照常归一化，秒缺省补 00', () => {
    assert.equal(toLocalDateTime('2026-09-10T21:09'), '2026-09-10 21:09:00');
    assert.equal(toLocalDateTime('2026-09-10 21:09:30'), '2026-09-10 21:09:30');
    assert.equal(toLocalDateTime(''), null);
    assert.equal(toLocalDateTime('随便写的'), null);
    assert.equal(toLocalDateTime('2026-09-10 21:09 后面还有字'), null);
  });
});

describe('自定义职位', () => {
  it('预置职位名不能当自定义职位', () => {
    assert.equal(isReservedRole('学生'), true);
    assert.equal(isReservedRole('班长'), true);
    assert.equal(isReservedRole('团支书'), true);
    assert.equal(assertCustomRoleName('学生').ok, false);
    assert.equal(assertCustomRoleName('文艺委员').ok, true);
    assert.equal(assertCustomRoleName('').ok, false);
  });

  it('权限只保留白名单', () => {
    assert.deepEqual(
      sanitizePermissions(['content:write', 'admin', 'user:manage', 'content:write']),
      ['content:write', 'user:manage']
    );
    assert.ok(ALLOWED_PERMISSIONS.includes('content:write'));
  });
});

describe('权限查表健壮性', () => {
  it('职位名撞上原型链成员时不抛错，也不意外授权', () => {
    assert.deepEqual(Array.from(getPermissions(['constructor'])), []);
    assert.deepEqual(Array.from(getPermissions(['toString'])), []);
    assert.deepEqual(Array.from(getPermissions(['hasOwnProperty'])), []);
  });

  it('自定义职位名写成 __proto__ 既不改原型，也不误伤其它职位', () => {
    const map = buildRoleMap([{ name: '__proto__', permissions: '["content:write"]' }]);
    assert.equal(Object.getPrototypeOf(map), null);
    // 确实是本表登记过的职位，按登记权限返回
    assert.deepEqual(Array.from(getPermissions(['__proto__'], map)), ['content:write']);
    // 未登记的名字拿不到任何权限
    assert.deepEqual(Array.from(getPermissions(['文艺委员'], map)), []);
    // 内置职位不受自定义表影响
    assert.deepEqual(Array.from(getPermissions(['班长'], map)).sort(), ['content:write', 'user:manage']);
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
    const token = await sign({ id: 1, student_id: '2022103071' }, 'test-secret', 60);
    const payload = await verify(token, 'test-secret');
    assert.equal(payload.id, 1);
    assert.equal(payload.student_id, '2022103071');

    const expired = await sign({ id: 1 }, 'test-secret', -10);
    assert.equal(await verify(expired, 'test-secret'), null);
    assert.equal(await verify(token, 'other-secret'), null);
  });

  it('缺少 exp 或头部非 HS256 的令牌一律拒绝', async () => {
    const secret = 'test-secret';
    const b64u = (obj) => Buffer.from(JSON.stringify(obj)).toString('base64url');
    const rawSign = async (header, payload) => {
      const input = b64u(header) + '.' + b64u(payload);
      const key = await crypto.subtle.importKey(
        'raw',
        new TextEncoder().encode(secret),
        { name: 'HMAC', hash: 'SHA-256' },
        false,
        ['sign']
      );
      const sig = await crypto.subtle.sign('HMAC', key, new TextEncoder().encode(input));
      return input + '.' + Buffer.from(new Uint8Array(sig)).toString('base64url');
    };

    const now = Math.floor(Date.now() / 1000);
    const noExp = await rawSign({ alg: 'HS256', typ: 'JWT' }, { id: 1, iat: now });
    assert.equal(await verify(noExp, secret), null);

    const wrongAlg = await rawSign({ alg: 'none', typ: 'JWT' }, { id: 1, exp: now + 60 });
    assert.equal(await verify(wrongAlg, secret), null);
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

  it('后加 COOKIE_SECRET 时仍能解开用 JWT 派生密钥封存的旧记录', async () => {
    const raw = 'X-Qz-JSession=legacy';
    const oldEnv = { JWT_SECRET: 'jwt-secret-for-vault' };
    const sealed = await sealCookies(oldEnv, raw);
    const newEnv = { JWT_SECRET: 'jwt-secret-for-vault', COOKIE_SECRET: 'brand-new-cookie-secret' };
    assert.equal(await openCookies(newEnv, sealed), raw);
  });

  it('能解开 Go 调度进程封存的密文', async () => {
    const env = { COOKIE_SECRET: 'compat-secret-for-go' };
    const sealed = 'v1.Yzkjl59QocTwaLnh.4yMmGlESPclxP4shg6mBI4jIb5TY-UYYTf6uoqmNUfp2t3VMirrL7S2Mp-185kN5-EiVTw';
    assert.equal(await openCookies(env, sealed), 'X-Qz-JSession=abc; INGRESSCOOKIE=xyz');
  });

  it('密钥全部缺失时封存/解封都抛错（由 handler 转成 VAULT_NOT_CONFIGURED）', async () => {
    await assert.rejects(() => sealCookies({}, 'SESSION=x'));
    const sealed = await sealCookies(env, 'SESSION=x');
    await assert.rejects(() => openCookies({}, sealed));
  });
});

describe('MFA 尝试上限', () => {
  it('上限为 5 次', () => {
    assert.equal(MFA_MAX_ATTEMPTS, 5);
  });
});
