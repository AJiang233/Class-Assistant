/**
 * Web Push：收件人口径、投递与清理。
 *
 * 这里最能出事的两条：
 *  - 收件人必须与通知/活动列表同一口径（含 class:exclude），否则「列表里看不到却收到推送」
 *  - 端点 404/410 必须立即删行，否则订阅表会攒死行、每次发布都白发一轮
 */
import assert from 'node:assert/strict';
import { createDecipheriv, createECDH, hkdfSync, randomBytes } from 'node:crypto';
import { describe, it } from 'node:test';

import { parseRemindNames, resolveRemindUsers } from '../src/utils/audience.js';
import { pushEnabled, pushToRemindAudience, vapidConfig } from '../src/utils/push.js';
import { PushSubscriptionModel } from '../src/models/pushSubscriptionModel.js';
import { handlePushSubscribe, handlePushUnsubscribe } from '../src/handlers/pushHandler.js';
import { b64uToBytes, buildVapidHeader, encryptPayload, sendWebPush } from '../src/utils/webpush.js';

// 真实可用的订阅密钥：加密那步会真的做 ECDH + AES-GCM，随便编的字节过不了 importKey
const recipient = createECDH('prime256v1');
recipient.generateKeys();
const P256DH = Buffer.from(recipient.getPublicKey()).toString('base64url');
const AUTH = randomBytes(16).toString('base64url');

// ===== 假 D1：只认这几个 model 用到的 SQL =====

function fakeDb({ users = [], roles = [], subs = [] } = {}) {
  const state = { subs: subs.map((s) => ({ ...s })) };

  function run(sql, args) {
    if (/FROM users/i.test(sql)) return { kind: 'all', results: users };
    if (/FROM roles/i.test(sql)) return { kind: 'all', results: roles };
    if (/FROM push_subscriptions/i.test(sql) && /SELECT/i.test(sql) && /COUNT/i.test(sql)) {
      const n = state.subs.filter((s) => String(s.user_id) === String(args[0])).length;
      return { kind: 'first', row: { n } };
    }
    if (/FROM push_subscriptions/i.test(sql) && /SELECT/i.test(sql)) {
      const ids = args.map(String);
      return { kind: 'all', results: state.subs.filter((s) => ids.includes(String(s.user_id))) };
    }
    if (/INSERT INTO push_subscriptions/i.test(sql)) {
      const [userId, endpoint, p256dh, auth, ua] = args;
      const existing = state.subs.find((s) => s.endpoint === endpoint);
      if (existing) Object.assign(existing, { user_id: userId, p256dh, auth, ua });
      else state.subs.push({ id: state.subs.length + 1, user_id: userId, endpoint, p256dh, auth, ua });
      return { kind: 'run' };
    }
    if (/DELETE FROM push_subscriptions/i.test(sql)) {
      if (/user_id = \?/i.test(sql)) {
        const [userId, endpoint] = args;
        state.subs = state.subs.filter((s) => !(String(s.user_id) === String(userId) && String(s.endpoint) === String(endpoint)));
      } else {
        const set = new Set(args.map(String));
        state.subs = state.subs.filter((s) => !set.has(String(s.endpoint)));
      }
      return { kind: 'run' };
    }
    if (/UPDATE push_subscriptions/i.test(sql)) {
      const set = new Set(args.map(String));
      state.subs.forEach((s) => { if (set.has(String(s.endpoint))) s.last_ok_at = 'now'; });
      return { kind: 'run' };
    }
    throw new Error('假 D1 不认识的 SQL: ' + sql);
  }

  return {
    state,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async all() {
          const r = run(sql, stmt._args);
          return { results: r.results || [] };
        },
        async first() {
          const r = run(sql, stmt._args);
          return r.row !== undefined ? r.row : null;
        },
        async run() { return run(sql, stmt._args); }
      };
      return stmt;
    }
  };
}

const VAPID = (() => {
  const keys = createECDH('prime256v1');
  keys.generateKeys();
  return {
    VAPID_PUBLIC_KEY: Buffer.from(keys.getPublicKey()).toString('base64url'),
    VAPID_PRIVATE_KEY: Buffer.from(keys.getPrivateKey()).toString('base64url'),
    VAPID_SUBJECT: 'mailto:a@b.c'
  };
})();

describe('提醒对象名单解析', () => {
  it('空值一律算全班', () => {
    assert.deepEqual(parseRemindNames(null), []);
    assert.deepEqual(parseRemindNames(''), []);
    assert.deepEqual(parseRemindNames('[]'), []);
  });

  it('JSON 数组与逗号串都能解析', () => {
    assert.deepEqual(parseRemindNames('["张三","李四"]'), ['张三', '李四']);
    assert.deepEqual(parseRemindNames('张三, 李四'), ['张三', '李四']);
  });

  it('坏 JSON 保守按「有名单」处理，不会误判成全班', () => {
    assert.notEqual(parseRemindNames('["张三"').length, 0);
  });
});

describe('推送收件人口径', () => {
  const users = [
    { id: 1, name: '班长', positions: '班长' },
    { id: 2, name: '张三', positions: '学生' },
    { id: 3, name: '李四', positions: '学生' },
    { id: 4, name: '旁听', positions: '旁听生' }
  ];
  const roles = [{ name: '旁听生', permissions: '["class:exclude"]' }];

  it('提醒对象为空 = 全班减去「不计入班级管理」的人', async () => {
    const env = { DB: fakeDb({ users, roles }) };
    const list = await resolveRemindUsers(env, null);
    assert.deepEqual(list.map((u) => u.name), ['班长', '张三', '李四']);
  });

  it('被排除组的人被点名时仍然收到（与列表可见性一致）', async () => {
    const env = { DB: fakeDb({ users, roles }) };
    const list = await resolveRemindUsers(env, JSON.stringify(['旁听']));
    assert.deepEqual(list.map((u) => u.name), ['旁听']);
  });

  it('发布者本人不发给自己', async () => {
    const env = { DB: fakeDb({ users, roles }) };
    const list = await resolveRemindUsers(env, null, { excludeUserId: 1 });
    assert.deepEqual(list.map((u) => u.name), ['张三', '李四']);
  });

  it('名单支持按 id 指定', async () => {
    const env = { DB: fakeDb({ users, roles }) };
    const list = await resolveRemindUsers(env, JSON.stringify([3]));
    assert.deepEqual(list.map((u) => u.name), ['李四']);
  });
});

describe('推送发送', () => {
  it('未配置 VAPID 时整体关闭，且不发任何请求', async () => {
    assert.equal(pushEnabled({}), false);
    assert.equal(vapidConfig({}), null);

    const db = fakeDb({ users: [{ id: 2, name: '张三', positions: '学生' }] });
    let called = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { called++; return new Response('', { status: 201 }); };
    try {
      await pushToRemindAudience({ DB: db }, null, null, { title: 't', body: 'b', url: '/' });
      assert.equal(called, 0);
    } finally { globalThis.fetch = orig; }
  });

  it('按 endpoint 投递；404/410 的订阅立即删行，成功的记 last_ok_at', async () => {
    const db = fakeDb({
      users: [{ id: 2, name: '张三', positions: '学生' }],
      subs: [
        { id: 1, user_id: 2, endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh: P256DH, auth: AUTH },
        { id: 2, user_id: 2, endpoint: 'https://fcm.googleapis.com/fcm/send/dead', p256dh: P256DH, auth: AUTH }
      ]
    });

    const orig = globalThis.fetch;
    const seen = [];
    globalThis.fetch = async (url, init) => {
      seen.push({ url: String(url), auth: init.headers.Authorization, enc: init.headers['Content-Encoding'] });
      return new Response('', { status: String(url).endsWith('/dead') ? 410 : 201 });
    };
    try {
      await pushToRemindAudience({ DB: db, ...VAPID }, null, null, {
        title: '班级通知',
        body: '正文',
        url: '/?view=notices&id=9'
      });
    } finally { globalThis.fetch = orig; }

    assert.equal(seen.length, 2);
    assert.ok(seen.every((s) => s.enc === 'aes128gcm'));
    assert.ok(seen.every((s) => s.auth.startsWith('vapid t=')));

    const left = db.state.subs.map((s) => s.endpoint);
    assert.deepEqual(left, ['https://fcm.googleapis.com/fcm/send/ok']);
    assert.equal(db.state.subs[0].last_ok_at, 'now');
  });

  /**
   * 库里可能还留着「加白名单之前」存下的端点（issue #21）。投递是带着 VAPID 头出去的出口，
   * 所以 sendWebPush 里还有一道白名单：不在名单里的那条不发，其余照发。
   */
  it('库里遗留的非白名单端点不投递，其余照发', async () => {
    const db = fakeDb({
      users: [{ id: 2, name: '张三', positions: '学生' }],
      subs: [
        { id: 1, user_id: 2, endpoint: 'https://fcm.googleapis.com/fcm/send/ok', p256dh: P256DH, auth: AUTH },
        { id: 2, user_id: 2, endpoint: 'https://127.0.0.1:8500/steal', p256dh: P256DH, auth: AUTH }
      ]
    });

    const seen = [];
    const errors = [];
    const origFetch = globalThis.fetch;
    const origError = console.error;
    globalThis.fetch = async (url) => { seen.push(String(url)); return new Response('', { status: 201 }); };
    console.error = (...args) => errors.push(args.join(' '));
    try {
      await pushToRemindAudience({ DB: db, ...VAPID }, null, null, { title: 't', body: 'b', url: '/' });
    } finally {
      globalThis.fetch = origFetch;
      console.error = origError;
    }

    assert.deepEqual(seen, ['https://fcm.googleapis.com/fcm/send/ok'], '只该发白名单内的那条');
    // 行留着不删：404/410 才是「订阅失效」的证据，这里只是我们拒绝投递
    assert.equal(db.state.subs.length, 2);
    assert.ok(
      errors.some((e) => e.includes('127.0.0.1')),
      '被跳过的端点要留痕（含主机名），否则线上只看得到「没收到通知」'
    );
  });

  it('没有订阅时不发请求', async () => {
    const db = fakeDb({ users: [{ id: 2, name: '张三', positions: '学生' }] });
    let called = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => { called++; return new Response('', { status: 201 }); };
    try {
      await pushToRemindAudience({ DB: db, ...VAPID }, null, null, { title: 't', body: 'b', url: '/' });
      assert.equal(called, 0);
    } finally { globalThis.fetch = orig; }
  });

  /**
   * 一次班级通知可能几十上百台设备。全部并起来会撞 Worker 对同一主机的并发连接配额，
   * 所以投递必须分批推进 —— 这里用「同时在飞的请求数」把它钉住。
   */
  it('设备多时按批投递，同时在飞的请求不超过 6 个', async () => {
    const users = Array.from({ length: 20 }, (_, i) => ({ id: i + 1, name: 'u' + (i + 1), positions: '学生' }));
    const subs = users.map((u) => ({
      id: u.id, user_id: u.id, endpoint: 'https://fcm.googleapis.com/fcm/send/' + u.id, p256dh: P256DH, auth: AUTH
    }));
    const db = fakeDb({ users, subs });

    let inFlight = 0;
    let peak = 0;
    let done = 0;
    const orig = globalThis.fetch;
    globalThis.fetch = async () => {
      inFlight++;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 1));
      inFlight--;
      done++;
      return new Response('', { status: 201 });
    };
    try {
      await pushToRemindAudience({ DB: db, ...VAPID }, null, null, { title: 't', body: 'b', url: '/' });
    } finally { globalThis.fetch = orig; }

    assert.equal(done, 20, '每台设备都该收到');
    assert.ok(peak <= 6, '同时在飞的请求不应超过 6，实际 ' + peak);
    assert.ok(peak > 1, '不该退化成一个一个串行发');
    assert.ok(db.state.subs.every((s) => s.last_ok_at === 'now'), '全部投递成功都该记上时间');
  });
});

describe('订阅接口', () => {
  const user = { id: 7, name: '张三', positions: '学生' };

  function post(body) {
    return new Request('https://class.example/api/push/subscribe', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', 'User-Agent': 'TestAgent/1.0' },
      body: JSON.stringify(body)
    });
  }

  it('合法订阅落库，同一个端点在换账号后改绑', async () => {
    const db = fakeDb({ subs: [] });
    const env = { DB: db, ...VAPID };
    const payload = { endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'pk', auth: 'au' } };

    const res = await handlePushSubscribe(post(payload), env, user);
    assert.equal(res.status, 201);
    assert.equal(db.state.subs.length, 1);
    assert.equal(db.state.subs[0].user_id, 7);

    // 同一台设备换另一个账号登录并订阅 → 改绑，不再发给旧账号
    await handlePushSubscribe(post(payload), env, { id: 8, name: '李四', positions: '学生' });
    assert.equal(db.state.subs.length, 1);
    assert.equal(db.state.subs[0].user_id, 8);
  });

  it('非 https 或字段缺失被拒', async () => {
    const env = { DB: fakeDb(), ...VAPID };
    assert.equal((await handlePushSubscribe(post({ endpoint: 'http://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p', auth: 'a' } }), env, user)).status, 400);
    assert.equal((await handlePushSubscribe(post({ endpoint: 'https://fcm.googleapis.com/fcm/send/x', keys: { p256dh: 'p' } }), env, user)).status, 400);
    assert.equal((await handlePushSubscribe(post({}), env, user)).status, 400);
  });

  /**
   * 白名单之外的端点必须在这里就被拒（issue #21）：以往只校验 https，存进来之后服务端会
   * 带着 VAPID 头去 POST 它 —— 盲 SSRF，「测试推送」还把状态码回读给用户，等于端口探测器。
   * 顺带钉住日志口径：定位「白名单少写了谁」只要主机名，endpoint 路径里的发送凭据不能落日志。
   */
  it('白名单外的端点被拒，且一行都不落库', async () => {
    const db = fakeDb();
    const env = { DB: db, ...VAPID };
    const keys = { p256dh: 'p', auth: 'a' };

    const warned = [];
    const originalWarn = console.warn;
    console.warn = (...args) => warned.push(args.join(' '));
    try {
      for (const endpoint of [
        'https://127.0.0.1:8500/admin',
        'https://169.254.169.254/latest/meta-data/',
        'https://evil.com/x',
        'https://fcm.googleapis.com.evil.com/x'
      ]) {
        const res = await handlePushSubscribe(post({ endpoint, keys }), env, user);
        assert.equal(res.status, 400, endpoint);
        assert.equal((await res.json()).code, 'INVALID_SUBSCRIPTION', endpoint);
      }
    } finally {
      console.warn = originalWarn;
    }

    assert.equal(db.state.subs.length, 0, '被拒的端点一行都不该落库');
    assert.ok(warned.some((w) => w.includes('127.0.0.1')), '日志里要有主机名，否则不知道白名单少写了谁');
    assert.ok(warned.every((w) => !w.includes('secret')), '端点里的发送凭据不能进日志');
  });

  it('退订只删自己那一条', async () => {
    const db = fakeDb({
      subs: [
        { id: 1, user_id: 7, endpoint: 'https://fcm.googleapis.com/fcm/send/mine', p256dh: 'p', auth: 'a' },
        { id: 2, user_id: 8, endpoint: 'https://fcm.googleapis.com/fcm/send/other', p256dh: 'p', auth: 'a' }
      ]
    });
    const env = { DB: db };
    const res = await handlePushUnsubscribe(post({ endpoint: 'https://fcm.googleapis.com/fcm/send/mine' }), env, user);
    assert.equal(res.status, 200);
    assert.deepEqual(db.state.subs.map((s) => s.endpoint), ['https://fcm.googleapis.com/fcm/send/other']);
  });
});

describe('推送载荷加密（RFC 8291）', () => {
  /**
   * 用 Node 内置 crypto（OpenSSL 的 HKDF / AES-GCM）按浏览器那一侧解开我们自实现的载荷。
   * 这是唯一能证明「手写 HKDF + info 串没错」的办法 —— 写错的话浏览器只会静默收不到消息。
   * 首次实现时还额外用参考实现 http_ece（web-push 的底层）交叉验证过一次。
   */
  function decryptAsBrowser(record, uaEcdh, authSecret) {
    const salt = Buffer.from(record.subarray(0, 16));
    const keyidLen = record[20];
    const asPublic = Buffer.from(record.subarray(21, 21 + keyidLen));
    const ciphertext = Buffer.from(record.subarray(21 + keyidLen));

    const ecdhSecret = uaEcdh.computeSecret(asPublic);
    const ikm = Buffer.from(hkdfSync('sha256', ecdhSecret, authSecret,
      Buffer.concat([Buffer.from('WebPush: info\0'), Buffer.from(uaEcdh.getPublicKey()), asPublic]), 32));
    const cek = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: aes128gcm\0'), 16));
    const nonce = Buffer.from(hkdfSync('sha256', ikm, salt, Buffer.from('Content-Encoding: nonce\0'), 12));

    const decipher = createDecipheriv('aes-128-gcm', cek, nonce);
    // Node 不会自动把尾部 16 字节当 tag，必须显式 setAuthTag
    decipher.setAuthTag(ciphertext.subarray(ciphertext.length - 16));
    const padded = Buffer.concat([
      decipher.update(ciphertext.subarray(0, ciphertext.length - 16)),
      decipher.final()
    ]);
    // 单条记录：末尾是 0x02 分隔符，没有补白
    assert.equal(padded[padded.length - 1], 2, '末尾应为 0x02 分隔符');
    return padded.subarray(0, padded.length - 1).toString('utf8');
  }

  it('浏览器侧能解开，且原文一致', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const authSecret = randomBytes(16);

    const plaintext = JSON.stringify({ title: '班级通知', body: '明天交表', url: '/?view=notices&id=3' });
    const record = await encryptPayload({
      p256dh: Buffer.from(ua.getPublicKey()).toString('base64url'),
      auth: authSecret.toString('base64url')
    }, plaintext);

    assert.equal(record.length, 86 + Buffer.byteLength(plaintext) + 1 + 16);
    assert.equal(decryptAsBrowser(record, ua, authSecret), plaintext);
  });

  it('每次发送用新的临时密钥与 salt（同样的明文两次密文不同）', async () => {
    const ua = createECDH('prime256v1');
    ua.generateKeys();
    const sub = {
      p256dh: Buffer.from(ua.getPublicKey()).toString('base64url'),
      auth: randomBytes(16).toString('base64url')
    };
    const a = await encryptPayload(sub, '同样的内容');
    const b = await encryptPayload(sub, '同样的内容');
    assert.notDeepEqual(Array.from(a.subarray(0, 16)), Array.from(b.subarray(0, 16)), 'salt 应每次不同');
    assert.notDeepEqual(Array.from(a.subarray(21, 86)), Array.from(b.subarray(21, 86)), '临时公钥应每次不同');
  });
});

describe('推送发送加固', () => {
  /**
   * 端点由用户上报，慢或恶意的端点不能一直挂住 waitUntil 收尾任务；
   * VAPID 公钥长度不对时要给出可定位的报错，而不是底层 importKey 的含糊异常。
   */
  it('发送请求带超时信号', async () => {
    const inits = [];
    const orig = globalThis.fetch;
    globalThis.fetch = async (url, init) => { inits.push(init); return new Response('', { status: 201 }); };
    try {
      await sendWebPush(
        { endpoint: 'https://fcm.googleapis.com/fcm/send/x', p256dh: P256DH, auth: AUTH },
        { title: 't' },
        { publicKey: VAPID.VAPID_PUBLIC_KEY, privateKey: VAPID.VAPID_PRIVATE_KEY, subject: VAPID.VAPID_SUBJECT }
      );
    } finally { globalThis.fetch = orig; }

    assert.equal(inits.length, 1);
    assert.ok(inits[0].signal, '应带上 AbortSignal 超时信号');
  });

  it('VAPID 公钥不是 65 字节未压缩点时给出明确报错', async () => {
    await assert.rejects(
      () => buildVapidHeader('https://fcm.googleapis.com/fcm/send/x', {
        publicKey: 'AAAA',
        privateKey: VAPID.VAPID_PRIVATE_KEY,
        subject: VAPID.VAPID_SUBJECT
      }),
      /65 字节/
    );
  });

  it('非法 base64url 给出明确报错', () => {
    assert.throws(() => b64uToBytes('!!!not base64!!!'), /base64url/);
  });
});

describe('订阅表读写', () => {
  it('listByUsers 对空名单短路，不查库', async () => {
    const model = new PushSubscriptionModel({ prepare() { throw new Error('不该查库'); } });
    assert.deepEqual(await model.listByUsers([]), []);
  });

  it('removeByEndpoints 对空数组短路', async () => {
    const model = new PushSubscriptionModel({ prepare() { throw new Error('不该查库'); } });
    assert.equal(await model.removeByEndpoints([]), 0);
  });

  /**
   * D1 单条语句的绑定参数上限是 100（与套餐无关，超了直接报错）。
   * 一个班几十上百人、一人多机，`IN (...)` 必须分批，否则发布通知时整批投递静默失败。
   */
  it('收件人/端点超过上限时分批查询，且结果合并、每批不超过 50 个参数', async () => {
    const widths = [];
    const db = {
      prepare() {
        const stmt = {
          _args: [],
          bind(...args) { stmt._args = args; return stmt; },
          async all() {
            widths.push(stmt._args.length);
            return { results: stmt._args.map((v) => ({ user_id: v, endpoint: 'e' + v })) };
          },
          async run() { widths.push(stmt._args.length); return {}; }
        };
        return stmt;
      }
    };
    const model = new PushSubscriptionModel(db);
    const ids = Array.from({ length: 120 }, (_, i) => i + 1);

    const rows = await model.listByUsers(ids);
    assert.equal(rows.length, 120, '分批结果要合并，不能只返回最后一批');
    assert.ok(widths.every((n) => n <= 50), '单条 SQL 不超过 50 个绑定参数：' + widths.join(','));
    assert.ok(widths.length >= 3, '120 个 id 至少该分成 3 批');

    const eps = Array.from({ length: 120 }, (_, i) => 'e' + i);
    assert.equal(await model.removeByEndpoints(eps), 120);
    await model.markOk(eps);
    assert.ok(widths.every((n) => n <= 50), '删行/记成功同样要分批：' + widths.join(','));
  });
});
