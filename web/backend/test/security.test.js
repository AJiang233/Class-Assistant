import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { clampInt, pageLimit, pageOffset } from '../src/utils/query.js';
import {
  ALLOWED_PERMISSIONS,
  assertCustomRoleName,
  buildRoleMap,
  getPermissions,
  isReservedRole,
  sanitizePermissions,
  positionsToStore,
  STUDENT_ROLE
} from '../src/utils/permissions.js';
import { hashPassword, verifyPassword } from '../src/utils/crypto.js';
import { hostOfEndpoint, isAllowedPushEndpoint } from '../src/utils/webpush.js';
import { sign, verify } from '../src/utils/jwt.js';
import { toLocalDateTime, parseLocalDateTime } from '../src/utils/datetime.js';

// 与教务相关的那几组（绑定身份校验、会话 Cookie 封存、代登录链路白名单、MFA 尝试上限）
// 已随教务代码一起搬到私有仓 class-assistant-private-api 的 test/security.test.js。

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

  it('没有职务只有一种存法：空的一律落到「学生」', () => {
    // 历史上三种写法都进过库：注册走 '学生'、编辑成员不勾任何职务走 '[]'、更早的还有空串 / NULL。
    // 注册与编辑成员两条写入路径现在共用 positionsToStore，所以这里逐个形状过一遍。
    for (const raw of [[], [''], '', '   ', '[]', null, undefined]) {
      assert.equal(positionsToStore(raw), STUDENT_ROLE, JSON.stringify(raw) + ' 应存成「学生」');
    }
    // 有职务的照旧：数组转 JSON 字符串；单个职位的纯字符串保持原样（老写法 parsePositions 仍能读）
    assert.equal(positionsToStore(['班长']), '["班长"]');
    assert.equal(positionsToStore(['班长', '学习委员']), '["班长","学习委员"]');
    assert.equal(positionsToStore('班长'), '班长');
    assert.equal(positionsToStore('["班长"]'), '["班长"]');
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

  it('预置职位行即使混进了 roles 表也不生效（尤其历史遗留的「学生」行）', () => {
    // 写入口已经拒绝写入预置名（见上一个 describe），但存量行可能还在库里。
    // 一行「学生」不会报错，只会顺着 buildRoleMap 叠加到全班默认成员身上 —— 这条就是防它。
    const map = buildRoleMap([
      { name: '学生', permissions: '["content:write","user:manage"]' },
      { name: ' 班长 ', permissions: '["class:exclude"]' },
      { name: '文艺委员', permissions: '["content:write"]' }
    ]);
    assert.deepEqual(Object.keys(map), ['文艺委员'], '预置名不该进映射表，且名字要先 trim');
    assert.deepEqual(Array.from(getPermissions([STUDENT_ROLE], map)), [], '默认的「学生」不能被提权');
    assert.deepEqual(
      Array.from(getPermissions(['班长'], map)).sort(),
      ['content:write', 'user:manage'],
      '班长只拿内置权限，行里多加的 class:exclude 不生效'
    );
    assert.deepEqual(
      Array.from(getPermissions([' 班长 '], map)).sort(),
      [],
      '查表不做 trim：职务名在写入时就已经归一，这里不额外宽容'
    );
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

/**
 * 推送端点白名单（issue #21）。
 *
 * endpoint 完全由客户端提供，服务端只负责拿它去 POST —— 不过白名单就是一个盲 SSRF：
 * 存一个 `https://127.0.0.1:8500/…` 再点「测试推送」，状态码还被回读给用户，等于端口探测器。
 */
describe('推送端点白名单', () => {
  it('主流浏览器的推送服务放行（含子域）', () => {
    assert.equal(isAllowedPushEndpoint('https://fcm.googleapis.com/fcm/send/abc'), true);
    assert.equal(isAllowedPushEndpoint('https://updates.push.services.mozilla.com/wpush/v2/x'), true);
    assert.equal(isAllowedPushEndpoint('https://web.push.apple.com/Qx'), true);
    assert.equal(isAllowedPushEndpoint('https://db5.notify.windows.com/w/?token=x'), true);
    // Apple 那条留给整段推送区：万一 Safari 的端点落在别的主机上（写窄了 iOS 就静默收不到通知，
    // 见 webpush.js 里的取舍说明），这里得兜住 —— 这条断言就是那次放宽的凭据
    assert.equal(isAllowedPushEndpoint('https://abcd1234.push.apple.com/Qx'), true);
  });

  it('混着别的服务的宽域不放行', () => {
    // FCM 只在 fcm.googleapis.com 这一个主机上，放行 googleapis.com 等于打开整个 Google API 域
    assert.equal(isAllowedPushEndpoint('https://storage.googleapis.com/bucket'), false);
    assert.equal(isAllowedPushEndpoint('https://www.googleapis.com/x'), false);
  });

  it('私网 / 环回 / 云元数据 / IP 字面量 / 任意域名一律拒绝', () => {
    for (const bad of [
      'https://127.0.0.1:8500/admin',
      'https://localhost/x',
      'https://10.0.0.5/x',
      'https://[::1]/x',
      'https://169.254.169.254/latest/meta-data/',   // 云厂商元数据地址，SSRF 的经典目标
      'http://fcm.googleapis.com/fcm/send/abc',      // 明文：推送服务也不会这么给
      'https://evil.com/x',
      'https://fcm.googleapis.com.evil.com/x',       // 把白名单域名当成前缀套
      'ftp://fcm.googleapis.com/x',
      'not a url',
      '',
      null,
      undefined
    ]) {
      assert.equal(isAllowedPushEndpoint(bad), false, JSON.stringify(bad));
    }
  });

  it('日志只取主机名：端点路径里的发送凭据不能进日志', () => {
    assert.equal(hostOfEndpoint('https://fcm.googleapis.com/fcm/send/secret-token'), 'fcm.googleapis.com');
    assert.ok(!hostOfEndpoint('https://evil.com/secret-token').includes('secret-token'));
    // 坏输入（本来就要拒掉）也得给得出定位用的字样，且不能因此抛错
    assert.match(hostOfEndpoint('不是 URL'), /^\(不是合法 URL\)/);
    assert.equal(hostOfEndpoint(null), '(不是合法 URL) ');
  });
});
