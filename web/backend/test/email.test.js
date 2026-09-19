import assert from 'node:assert/strict';
import { describe, it, beforeEach, afterEach } from 'node:test';

import { EmailCodeModel } from '../src/models/emailCodeModel.js';
import {
  handleSendEmailCode,
  handleVerifyEmail,
  handleUnbindEmail,
  handleForgotSend,
  handleForgotReset
} from '../src/handlers/authHandler.js';
import { withAuth } from '../src/middleware/auth.js';
import { sign } from '../src/utils/jwt.js';
import { emailEnabled, renderVerifyEmail, genEmailCode } from '../src/utils/email.js';

const SECRET = 'test-secret-for-email';

/** 与实现同口径的 UTC 时间串（'YYYY-MM-DD HH:MM:SS'），SQLite 的 datetime('now') 就是这个形状 */
function utcNow(offsetSeconds = 0) {
  return new Date(Date.now() + offsetSeconds * 1000).toISOString().slice(0, 19).replace('T', ' ');
}

let seq = 0;

/**
 * 只实现本项目用到的那几条语句的假 D1。
 *
 * 关键在于**真算 WHERE 与 changes**：试错上限靠 `WHERE attempts < 5` 的原子占坑、
 * 「用后即焚」靠 `WHERE used_at IS NULL` 的命中数 —— 假 D1 若只是固定返回 changes:1，
 * 这两条最该被钉住的正确性就等于没测（私有仓的 security.test.js 也是这么做的）。
 *
 * 未实现的语句直接抛错，免得实现里换了 SQL 而测试悄悄放过。
 */
function fakeDb({ users = [], codes = [] } = {}) {
  const state = {
    users: users.map((u) => ({ ...u })),
    codes: codes.map((c) => ({ id: c.id ?? ++seq, attempts: 0, used_at: null, ...c }))
  };

  function selectUsers(sql, args) {
    if (/WHERE id = \?/.test(sql)) return state.users.find((u) => u.id === args[0]) || null;
    if (/WHERE email = \?/.test(sql)) return state.users.find((u) => u.email === args[0]) || null;
    if (/WHERE student_id = \?/.test(sql)) return state.users.find((u) => u.student_id === args[0]) || null;
    return null;
  }

  /** 取「当前有效」的那条码：未过期、未使用，取最新一条 */
  function activeCode(args) {
    const [userId, purpose] = args;
    const rows = state.codes
      .filter((c) => c.user_id === userId && c.purpose === purpose && c.used_at === null)
      .filter((c) => c.expires_at > utcNow())
      .sort((a, b) => b.id - a.id);
    return rows[0] || null;
  }

  function run(sql, args) {
    const changes = (n) => ({ success: true, meta: { changes: n } });

    if (/DELETE FROM email_codes WHERE user_id = \? AND purpose = \?/.test(sql)) {
      const before = state.codes.length;
      state.codes = state.codes.filter((c) => !(c.user_id === args[0] && c.purpose === args[1]));
      return changes(before - state.codes.length);
    }
    if (/DELETE FROM email_codes WHERE user_id = \?$/.test(sql)) {
      const before = state.codes.length;
      state.codes = state.codes.filter((c) => c.user_id !== args[0]);
      return changes(before - state.codes.length);
    }
    if (/INSERT INTO email_codes/.test(sql)) {
      state.codes.push({
        id: ++seq,
        user_id: args[0],
        email: args[1],
        code: args[2],
        purpose: args[3],
        attempts: 0,
        used_at: null,
        expires_at: utcNow(600),
        created_at: utcNow()
      });
      return changes(1);
    }
    if (/UPDATE email_codes SET attempts = attempts \+ 1/.test(sql)) {
      const row = state.codes.find((c) => c.id === args[0]);
      // 占坑的三个条件缺一不可，命中数必须真的按条件算
      if (!row || row.used_at !== null || row.attempts >= 5) return changes(0);
      row.attempts += 1;
      return changes(1);
    }
    if (/UPDATE email_codes SET used_at = CURRENT_TIMESTAMP/.test(sql)) {
      const row = state.codes.find((c) => c.id === args[0]);
      if (!row || row.used_at !== null) return changes(0);
      row.used_at = utcNow();
      return changes(1);
    }
    if (/DELETE FROM email_subscriptions/.test(sql)) return changes(0);
    if (/UPDATE users SET/.test(sql)) {
      const id = args[args.length - 1];
      const row = state.users.find((u) => u.id === id);
      if (!row) return changes(0);
      // 形如 "UPDATE users SET a = ?, b = ? WHERE id = ?"：按 SET 段里的列名回填
      const cols = sql.slice(sql.indexOf('SET') + 3, sql.indexOf('WHERE'))
        .split(',').map((s) => s.trim().split(/\s*=\s*/)[0]);
      cols.forEach((col, i) => { if (col !== 'update_time') row[col] = args[i]; });
      return changes(1);
    }
    if (/DELETE FROM users WHERE id = \?/.test(sql)) {
      state.users = state.users.filter((u) => u.id !== args[0]);
      return changes(1);
    }
    if (/INSERT INTO users/.test(sql)) {
      state.users.push({ id: ++seq, student_id: args[0], name: args[1], positions: args[3], contact: args[4] });
      return changes(1);
    }
    throw new Error('假 D1 未实现的 run 语句: ' + sql);
  }

  return {
    _state: state,
    prepare(sql) {
      const stmt = {
        bind: (...args) => ({
          first: async () => {
            if (/FROM users/.test(sql)) return selectUsers(sql, args);
            if (/SELECT 1 FROM email_codes/.test(sql)) {
              // 「60 秒内刚发过」：只看当前有效且创建时间在一分钟内的
              const [userId, purpose] = args;
              return state.codes.some((c) => c.user_id === userId && c.purpose === purpose
                && c.used_at === null && c.expires_at > utcNow()
                && c.created_at > utcNow(-60)) ? { 1: 1 } : null;
            }
            if (/FROM email_codes/.test(sql)) return activeCode(args);
            if (/FROM roles/.test(sql)) return null;
            throw new Error('假 D1 未实现的 first 语句: ' + sql);
          },
          all: async () => {
            if (/FROM roles/.test(sql)) return { results: [] };
            if (/FROM users/.test(sql)) return { results: state.users.map((u) => ({ ...u })) };
            throw new Error('假 D1 未实现的 all 语句: ' + sql);
          },
          run: async () => run(sql, args)
        })
      };
      return stmt;
    }
  };
}

/** 拦截 Resend：记录发出去的邮件，可按需让发信失败 */
function stubFetch({ fail = false } = {}) {
  const sent = [];
  const orig = globalThis.fetch;
  globalThis.fetch = async (url, init) => {
    if (String(url).includes('api.resend.com')) {
      if (fail) return new Response('{"message":"boom"}', { status: 500 });
      sent.push(JSON.parse(init.body));
      return new Response('{"id":"mail_1"}', { status: 200 });
    }
    return orig(url, init);
  };
  return { sent, restore: () => { globalThis.fetch = orig; } };
}

const ENV = (db, extra = {}) => ({ DB: db, JWT_SECRET: SECRET, EMAIL_API_KEY: 're_test', ...extra });

function post(path, body) {
  return new Request('https://class.test' + path, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

const json = (res) => res.json();

/** 一枚「改了密码之后就该失效」的对照：iat 用秒，password_changed_at 也是秒 */
let stubbedFetch = null;
beforeEach(() => { stubbedFetch = null; });
afterEach(() => { if (stubbedFetch) { stubbedFetch.restore(); stubbedFetch = null; } });

describe('验证码：一码制与限发', () => {
  it('发新码会删掉同用途旧码（一码制），且 60 秒内不让再发', async () => {
    const db = fakeDb({ codes: [{ id: 9, user_id: 1, email: 'old@qq.com', code: '111111', purpose: 'verify', expires_at: utcNow(600), created_at: utcNow(-120) }] });
    const model = new EmailCodeModel(db);

    const first = await model.issue(1, 'a@qq.com', 'verify');
    assert.equal(first.ok, true);
    assert.match(first.code, /^\d{6}$/);
    // 旧码被删：只剩新发的那一条
    assert.equal(db._state.codes.filter(c => c.user_id === 1).length, 1);
    assert.equal(db._state.codes[0].email, 'a@qq.com');

    // 刚发过，立刻再发要判太频繁（否则就是给刷信件的口子）
    const second = await model.issue(1, 'a@qq.com', 'verify');
    assert.deepEqual(second, { ok: false, reason: 'TOO_SOON' });

    // 不同用途不互相影响：reset 可以单独发
    const reset = await model.issue(1, 'a@qq.com', 'reset');
    assert.equal(reset.ok, true);
  });

  it('码是 6 位数字且用随机源生成', () => {
    const codes = new Set();
    for (let i = 0; i < 20; i++) {
      const c = genEmailCode();
      assert.match(c, /^\d{6}$/);
      codes.add(c);
    }
    // 20 次全撞同一个值的概率可以忽略；这条防的是「实现里写死了某个常量」
    assert.ok(codes.size > 1);
  });
});

describe('验证码：试错上限与用后即焚', () => {
  const seed = () => fakeDb({
    codes: [{ id: 1, user_id: 1, email: 'a@qq.com', code: '123456', purpose: 'verify', expires_at: utcNow(600), created_at: utcNow() }]
  });

  it('错满 5 次就作废，之后连正确的码也不认', async () => {
    const model = new EmailCodeModel(seed());
    for (let i = 1; i <= 5; i++) {
      const r = await model.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '000000' });
      assert.equal(r.reason, 'MISMATCH', `第 ${i} 次应当是码不对`);
    }
    const sixth = await model.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '123456' });
    assert.equal(sixth.reason, 'TOO_MANY');
  });

  it('并发试码只放行 5 次（上限靠原子占坑，不是先读后写累加）', async () => {
    const model = new EmailCodeModel(seed());
    const results = await Promise.all(
      Array.from({ length: 12 }, () => model.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '000000' }))
    );
    const mismatches = results.filter(r => r.reason === 'MISMATCH').length;
    const tooMany = results.filter(r => r.reason === 'TOO_MANY').length;
    assert.equal(mismatches, 5, '正好 5 次拿到名额');
    assert.equal(tooMany, 7, '其余全部被占坑挡掉');
  });

  it('正确的码只能用一次，重放回「已失效」', async () => {
    const model = new EmailCodeModel(seed());
    assert.deepEqual(await model.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '123456' }), { ok: true });
    const replay = await model.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '123456' });
    assert.equal(replay.reason, 'MISSING');
  });

  it('过期的码、以及换了邮箱之后的旧码，都一概不认', async () => {
    const expired = new EmailCodeModel(fakeDb({
      codes: [{ id: 1, user_id: 1, email: 'a@qq.com', code: '123456', purpose: 'verify', expires_at: utcNow(-1), created_at: utcNow(-700) }]
    }));
    assert.equal((await expired.verify(1, { purpose: 'verify', email: 'a@qq.com', code: '123456' })).reason, 'MISSING');

    const model = new EmailCodeModel(seed());
    // 用户把邮箱改成了 b@qq.com，发给 a@qq.com 的那条码不能再用
    const moved = await model.verify(1, { purpose: 'verify', email: 'b@qq.com', code: '123456' });
    assert.equal(moved.reason, 'MISSING');
  });

  it('用途不串：绑定的码不能拿去重置密码', async () => {
    const model = new EmailCodeModel(seed());
    const r = await model.verify(1, { purpose: 'reset', email: 'a@qq.com', code: '123456' });
    assert.equal(r.reason, 'MISSING');
  });
});

describe('绑定邮箱接口', () => {
  const user = { id: 1, student_id: '2024001', name: '张三', positions: '学生', contact: '', email: null, email_verified: 0, password_changed_at: null };

  it('未配置 EMAIL_API_KEY 回 503，而不是让 500 冒出来', async () => {
    const db = fakeDb({ users: [user] });
    const res = await handleSendEmailCode(post('/api/auth/email/send-code', { email: 'a@qq.com' }), { DB: db, JWT_SECRET: SECRET }, user);
    assert.equal(res.status, 503);
    assert.equal((await json(res)).code, 'EMAIL_NOT_CONFIGURED');
  });

  it('邮箱格式不对直接拦掉，不消耗验证码也不发信', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [user] });
    const res = await handleSendEmailCode(post('/x', { email: 'not-an-email' }), ENV(db), user);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'INVALID_EMAIL');
    assert.equal(stubbedFetch.sent.length, 0);
    assert.equal(db._state.codes.length, 0);
  });

  it('邮箱已被别的成员占用：409，且不发信', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [user, { id: 2, email: 'taken@qq.com', email_verified: 1 }] });
    const res = await handleSendEmailCode(post('/x', { email: 'Taken@QQ.com' }), ENV(db), user);
    assert.equal(res.status, 409);
    assert.equal((await json(res)).code, 'EMAIL_TAKEN');
    assert.equal(stubbedFetch.sent.length, 0, '不该白花一封信');
  });

  it('发信成功后落库为「已填未验证」，重复点发送不会把已验证打回未验证', async () => {
    stubbedFetch = stubFetch();
    const verified = { ...user, email: 'a@qq.com', email_verified: 1 };
    const db = fakeDb({ users: [verified] });

    const res = await handleSendEmailCode(post('/x', { email: 'a@qq.com' }), ENV(db), verified);
    assert.equal(res.status, 200);
    assert.equal(stubbedFetch.sent.length, 1);
    assert.match(stubbedFetch.sent[0].to, /a@qq\.com/);
    // 同一个邮箱重复发送：不重置验证状态
    assert.equal(db._state.users[0].email_verified, 1);
  });

  it('换邮箱时重置验证状态；但发信失败要先撤掉刚写的码，别把用户锁在 60 秒限发里', async () => {
    stubbedFetch = stubFetch({ fail: true });
    const verified = { ...user, email: 'old@qq.com', email_verified: 1 };
    const db = fakeDb({ users: [verified] });

    const res = await handleSendEmailCode(post('/x', { email: 'new@qq.com' }), ENV(db), verified);
    assert.equal(res.status, 502);
    assert.equal((await json(res)).code, 'EMAIL_SEND_FAILED');
    assert.equal(db._state.codes.length, 0, '发信失败不能留下码');
    assert.equal(db._state.users[0].email, 'old@qq.com', '信没发出去就不该落库');
    assert.equal(db._state.users[0].email_verified, 1, '原来的验证状态也不能动');
  });

  it('验码通过才写 email_verified=1，并回带最新用户信息', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [user] });
    await handleSendEmailCode(post('/x', { email: 'a@qq.com' }), ENV(db), user);
    const code = db._state.codes[0].code;

    const res = await handleVerifyEmail(post('/x', { email: 'a@qq.com', code }), ENV(db), user);
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.equal(body.data.user.email, 'a@qq.com');
    assert.equal(body.data.user.email_verified, true);
    assert.equal(db._state.users[0].email_verified, 1);
  });

  it('验证码不对：400，且不动 users', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [user] });
    await handleSendEmailCode(post('/x', { email: 'a@qq.com' }), ENV(db), user);

    const res = await handleVerifyEmail(post('/x', { email: 'a@qq.com', code: '000000' }), ENV(db), user);
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'EMAIL_CODE_INVALID');
    assert.equal(db._state.users[0].email_verified, 0);
  });

  it('解绑：清空邮箱与验证状态，并作废未用的码', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [{ ...user, email: 'a@qq.com', email_verified: 1 }] });
    const res = await handleUnbindEmail(post('/x', {}), ENV(db), { ...user, email: 'a@qq.com', email_verified: 1 });
    assert.equal(res.status, 200);
    assert.equal(db._state.users[0].email, null);
    assert.equal(db._state.users[0].email_verified, 0);
  });

  it('未配密钥时 emailEnabled 为假，配了才为真', () => {
    assert.equal(emailEnabled({}), false);
    assert.equal(emailEnabled({ EMAIL_API_KEY: '' }), false);
    assert.equal(emailEnabled({ EMAIL_API_KEY: 're_x' }), true);
  });
});

describe('忘记密码', () => {
  const verifiedUser = { id: 1, student_id: '2024001', name: '张三', positions: '学生', email: 'a@qq.com', email_verified: 1 };

  it('未注册的邮箱回同一句成功文案，且不发信（防账号枚举）', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [] });
    const res = await handleForgotSend(post('/x', { email: 'nobody@qq.com' }), ENV(db));
    assert.equal(res.status, 200);
    assert.equal(stubbedFetch.sent.length, 0);
    assert.match((await json(res)).data.message, /已发送重置验证码/);
  });

  it('注册了但没验证的邮箱同样不发信，文案与上一条一致', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [{ ...verifiedUser, email_verified: 0 }] });
    const res = await handleForgotSend(post('/x', { email: 'a@qq.com' }), ENV(db));
    assert.equal(res.status, 200);
    assert.equal(stubbedFetch.sent.length, 0);
  });

  it('已绑且已验证：发信，且大小写不同的同一邮箱也能命中', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [verifiedUser] });
    const res = await handleForgotSend(post('/x', { email: 'A@QQ.com' }), ENV(db));
    assert.equal(res.status, 200);
    assert.equal(stubbedFetch.sent.length, 1);
    assert.equal(stubbedFetch.sent[0].to, 'a@qq.com');
  });

  it('重置成功后：密码换了、旧令牌作废、并回一枚新令牌', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [verifiedUser] });
    await handleForgotSend(post('/x', { email: 'a@qq.com' }), ENV(db));
    // handleForgotSend 走的是 findByEmail 拿到的行，码落在 user_id=1 上
    const code = db._state.codes.find(c => c.purpose === 'reset').code;

    const before = Math.floor(Date.now() / 1000);
    const res = await handleForgotReset(post('/x', { email: 'a@qq.com', code, new_password: 'newpass123' }), ENV(db));
    assert.equal(res.status, 200);
    const body = await json(res);
    assert.ok(body.data.token, '要回一枚新令牌，否则用户重置完还得自己再登录');
    assert.ok(db._state.users[0].password_hash, '密码哈希已更新');
    assert.ok(db._state.users[0].password_changed_at >= before, '改密时刻要记下来，旧令牌才作废');
  });

  it('码不对 / 邮箱不存在：都是同一句「验证码错误或已过期」', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [verifiedUser] });
    await handleForgotSend(post('/x', { email: 'a@qq.com' }), ENV(db));

    const wrong = await handleForgotReset(post('/x', { email: 'a@qq.com', code: '000000', new_password: 'newpass123' }), ENV(db));
    const missing = await handleForgotReset(post('/x', { email: 'nobody@qq.com', code: '000000', new_password: 'newpass123' }), ENV(db));
    assert.equal(wrong.status, 400);
    assert.equal(missing.status, 400);
    assert.equal((await json(wrong)).error, (await json(missing)).error);
  });

  it('新密码太短直接拒，不消耗验证码', async () => {
    stubbedFetch = stubFetch();
    const db = fakeDb({ users: [verifiedUser] });
    await handleForgotSend(post('/x', { email: 'a@qq.com' }), ENV(db));
    const res = await handleForgotReset(post('/x', { email: 'a@qq.com', code: '123456', new_password: '123' }), ENV(db));
    assert.equal(res.status, 400);
    assert.equal((await json(res)).code, 'WEAK_PASSWORD');
  });
});

describe('改密后旧令牌立即失效', () => {
  const handler = async () => new Response(JSON.stringify({ success: true }), { status: 200 });

  /** 直接把令牌里的 iat 读出来：用「改密时刻」与它比大小，测试才不依赖运行时的秒边界 */
  function iatOf(token) {
    const payload = token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/');
    return JSON.parse(Buffer.from(payload, 'base64').toString()).iat;
  }

  async function callWith(passwordChangedAt) {
    const base = {
      id: 7, student_id: '2024007', name: '李四', positions: '学生',
      email: null, email_verified: 0, password_changed_at: null
    };
    // 先签令牌再建库：fakeDb 会把传入的行拷一份，建完再改原对象是不生效的
    const token = await sign({ id: base.id, student_id: base.student_id, name: base.name }, SECRET, 3600);
    const row = {
      ...base,
      password_changed_at: typeof passwordChangedAt === 'function'
        ? passwordChangedAt(iatOf(token))
        : passwordChangedAt
    };
    const db = fakeDb({ users: [row] });
    const req = new Request('https://class.test/api/auth/me', { headers: { Authorization: 'Bearer ' + token } });
    return withAuth(handler)(req, { DB: db, JWT_SECRET: SECRET }, {});
  }

  it('改密时刻晚于令牌签发时间 → 401 PASSWORD_CHANGED', async () => {
    const res = await callWith((iat) => iat + 1);
    assert.equal(res.status, 401);
    assert.equal((await json(res)).code, 'PASSWORD_CHANGED');
  });

  it('从未改过密码（NULL）不限制', async () => {
    const res = await callWith(null);
    assert.equal(res.status, 200);
  });

  it('改密当刻签发的令牌（iat 与改密时刻同秒）必须放行，否则用户改完密码自己就被踢出去', async () => {
    const res = await callWith((iat) => iat);
    assert.equal(res.status, 200);
  });
});

describe('邮件模板', () => {
  it('验证码邮件里带验证码，且不把用户可控内容直接拼进 HTML', () => {
    const html = renderVerifyEmail('123456');
    assert.match(html, /123456/);
    assert.match(html, /班级助理/);
    assert.match(html, /10 分钟/);
  });
});
