/**
 * 待办到点 Web Push 提醒（P1-4）。
 *
 * 这里最要紧的四条：
 *  - 提前量窗口之前一条都不能发；到点只发一次，重复 drain 不能重发
 *  - 发送前复核：待办完成 / 改期 / 关提醒 / 换订阅密钥后，旧记录只能 skipped
 *  - 404/410 必须删订阅，否则订阅表攒死行、每分钟白发一轮
 *  - 缺 VAPID 配置时保留 pending 且不消耗重试次数，等运维补齐
 */
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { createSqliteDb } from './helpers/sqlite.js';
import { hashPassword } from '../src/utils/crypto.js';
import { sign } from '../src/utils/jwt.js';
import { formatLocalDateTime, parseLocalDateTime } from '../src/utils/datetime.js';
import { drainTodoReminders } from '../src/services/todoReminders.js';

const SECRET = 'test-secret';
const DUE_MS = Date.parse('2027-03-01T12:00:00+08:00');
const DUE = formatLocalDateTime(DUE_MS);
const MINUTE = 60000;

async function seedUser(db, { id = 1, studentId = '2022103071', name = '张三', positions = '学生' } = {}) {
  const { hash, salt } = await hashPassword('pw123456');
  db.sqlite
    .prepare('INSERT INTO users(id,student_id,name,password_hash,positions) VALUES(?,?,?,?,?)')
    .run(id, studentId, name, `${salt}:${hash}`, positions);
  return { id, studentId };
}

function tokenFor(id, studentId) {
  return sign({ id, student_id: studentId }, SECRET, 60);
}

async function call(env, path, { method = 'GET', body, token } = {}) {
  const authToken = await (token || tokenFor(1, '2022103071'));
  const headers = { Authorization: `Bearer ${authToken}` };
  const init = { method, headers };
  if (body !== undefined) {
    init.body = JSON.stringify(body);
    headers['Content-Type'] = 'application/json';
  }
  const res = await worker.fetch(new Request('https://class.example' + path, init), env, {});
  const json = await res.json().catch(() => null);
  return { status: res.status, body: json, data: json && json.data };
}

/** 一条待办 + 提醒设置 + 一份推送订阅；返回待办 id。 */
function seedReminder(db, {
  userId = 1, enabled = 1, lead = 60, due = DUE, status = 'open',
  endpoint = 'https://push.example/1', p256dh = 'key', auth = 'auth', title = '交作业'
} = {}) {
  const todoId = Number(db.sqlite.prepare('INSERT INTO todos(owner_id,title,due_at,status) VALUES(?,?,?,?)')
    .run(userId, title, due, status).lastInsertRowid);
  db.sqlite.prepare('INSERT INTO todo_reminder_prefs(user_id,enabled,lead_minutes) VALUES(?,?,?)')
    .run(userId, enabled, lead);
  db.sqlite.prepare('INSERT INTO push_subscriptions(user_id,endpoint,p256dh,auth) VALUES(?,?,?,?)')
    .run(userId, endpoint, p256dh, auth);
  return todoId;
}

const rows = (db) => db.sqlite.prepare('SELECT * FROM todo_reminder_deliveries ORDER BY id').all();
const count = (db, table) => db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n;

describe('待办到点提醒：登记窗口与去重', () => {
  it('北京时间字符串可逆；窗口前不发，到点只发一次，重复 drain 不重发', async (t) => {
    assert.equal(parseLocalDateTime(DUE), DUE_MS);
    const db = createSqliteDb(t);
    await seedUser(db);
    const todoId = seedReminder(db);
    const env = { DB: db };
    let calls = 0;
    const transport = async () => { calls++; return { ok: true, status: 201 }; };

    // 提前 61 分钟：还没进窗口，一条都不能登记。
    let result = await drainTodoReminders(env, { nowMs: DUE_MS - 61 * MINUTE, transport });
    assert.equal(result.scheduled, 0);
    assert.equal(count(db, 'todo_reminder_deliveries'), 0);
    assert.equal(calls, 0);

    // 提前整 60 分钟：窗口起点，登记并立即发送。
    result = await drainTodoReminders(env, { nowMs: DUE_MS - 60 * MINUTE, transport });
    assert.equal(result.scheduled, 1);
    assert.equal(result.processed, 1);
    assert.equal(calls, 1);
    let [row] = rows(db);
    assert.equal(row.state, 'sent');
    assert.equal(row.todo_id, todoId);
    assert.equal(row.due_at, DUE);
    const payload = JSON.parse(row.payload);
    assert.deepEqual(payload.subscription, { endpoint: 'https://push.example/1', p256dh: 'key', auth: 'auth' });
    assert.deepEqual(payload.message, {
      title: '待办即将到期',
      body: `交作业 · ${DUE} 截止`,
      url: `/todos/?id=${todoId}`,
      tag: `todo-${todoId}`,
      kind: 'todo'
    });

    // 再跑一轮：已登记过的行不会再写库，已 sent 不会被重复领取。
    result = await drainTodoReminders(env, { nowMs: DUE_MS - 30 * MINUTE, transport });
    assert.equal(result.scheduled, 0, '已登记过的不再重复写库');
    assert.equal(result.processed, 0);
    assert.equal(calls, 1);
    assert.equal(rows(db).length, 1);
  });

  it('只登记开启提醒的本人订阅，别人的待办不受影响', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, studentId: '001', name: '张三' });
    await seedUser(db, { id: 2, studentId: '002', name: '李四' });
    seedReminder(db, { userId: 1, endpoint: 'https://push.example/1' });
    seedReminder(db, { userId: 2, enabled: 0, endpoint: 'https://push.example/2' });
    const seen = [];
    const result = await drainTodoReminders({ DB: db }, {
      nowMs: DUE_MS - 60 * MINUTE,
      transport: async (delivery) => { seen.push(delivery.user_id); return { ok: true }; }
    });
    assert.equal(result.scheduled, 1);
    assert.deepEqual(seen, [1]);
    assert.deepEqual(rows(db).map((x) => x.user_id), [1]);
  });
});

describe('待办到点提醒：发送前复核', () => {
  it('缺 VAPID 配置保留 pending 且不消耗次数；待办完成后 skipped', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const todoId = seedReminder(db);

    // 没有 transport 也没有 VAPID：只登记，发送前停在 pending 等运维补齐。
    let result = await drainTodoReminders({ DB: db }, { nowMs: DUE_MS - 60 * MINUTE });
    assert.equal(result.processed, 1);
    let [row] = rows(db);
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 0);
    assert.equal(row.last_error, '渠道尚未配置');

    db.sqlite.prepare("UPDATE todos SET status='done', completed_at=? WHERE id=?")
      .run(formatLocalDateTime(DUE_MS - 59 * MINUTE), todoId);
    const later = DUE_MS - 60 * MINUTE + 301000;
    let calls = 0;
    result = await drainTodoReminders({ DB: db }, { nowMs: later, transport: async () => { calls++; return { ok: true }; } });
    assert.equal(calls, 0, '已完成的待办不能再发提醒');
    assert.equal(rows(db)[0].state, 'skipped');
  });

  it('订阅密钥变更后不复用旧记录，记 skipped', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    seedReminder(db);
    await drainTodoReminders({ DB: db }, { nowMs: DUE_MS - 60 * MINUTE });
    db.sqlite.exec("UPDATE push_subscriptions SET p256dh='新密钥'");
    let calls = 0;
    const result = await drainTodoReminders({ DB: db }, {
      nowMs: DUE_MS - 60 * MINUTE + 301000,
      transport: async () => { calls++; return { ok: true }; }
    });
    assert.equal(result.processed, 1);
    assert.equal(calls, 0);
    assert.equal(rows(db)[0].state, 'skipped');
  });

  it('改期后旧记录 skipped，不会针对旧截止时间推送', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const todoId = seedReminder(db);
    await drainTodoReminders({ DB: db }, { nowMs: DUE_MS - 60 * MINUTE });
    // 改到 8 天后：超出检查窗口，本轮只可能领取到旧记录。
    db.sqlite.prepare('UPDATE todos SET due_at=? WHERE id=?')
      .run(formatLocalDateTime(DUE_MS + 8 * 24 * 3600 * 1000), todoId);
    let calls = 0;
    const result = await drainTodoReminders({ DB: db }, {
      nowMs: DUE_MS - 60 * MINUTE + 301000,
      transport: async () => { calls++; return { ok: true }; }
    });
    assert.equal(result.scheduled, 0);
    assert.equal(calls, 0);
    assert.equal(rows(db)[0].state, 'skipped');
  });
});

describe('待办到点提醒：失败处理与订阅清理', () => {
  it('503 按退避重试，成功后只发一次', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    seedReminder(db);
    const env = { DB: db };
    const start = DUE_MS - 60 * MINUTE;

    let result = await drainTodoReminders(env, { nowMs: start, transport: async () => ({ ok: false, status: 503 }) });
    assert.equal(result.processed, 1);
    let [row] = rows(db);
    assert.equal(row.state, 'pending');
    assert.equal(row.attempts, 1);
    assert.ok(row.next_at > Math.floor(start / 1000), '退避时间必须晚于当前时刻');

    // 退避期内不会被重新领取。
    result = await drainTodoReminders(env, { nowMs: start + 1000, transport: async () => ({ ok: true }) });
    assert.equal(result.processed, 0);

    // retryDelay(1) = 60 秒，过点后重试成功。
    result = await drainTodoReminders(env, { nowMs: start + 62000, transport: async () => ({ ok: true }) });
    assert.equal(result.processed, 1);
    assert.equal(rows(db)[0].state, 'sent');
  });

  it('404 终止并删除对应订阅，后续不再尝试', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    seedReminder(db);
    const env = { DB: db };
    const result = await drainTodoReminders(env, {
      nowMs: DUE_MS - 60 * MINUTE,
      transport: async () => ({ ok: false, status: 404 })
    });
    assert.equal(result.processed, 1);
    assert.equal(rows(db)[0].state, 'dead');
    assert.equal(count(db, 'push_subscriptions'), 0);
  });

  it('删待办级联清理投递记录', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const todoId = seedReminder(db);
    await drainTodoReminders({ DB: db }, { nowMs: DUE_MS - 60 * MINUTE });
    assert.equal(rows(db).length, 1);
    db.sqlite.prepare('DELETE FROM todos WHERE id=?').run(todoId);
    assert.equal(rows(db).length, 0);
  });
});

describe('待办提醒设置 API', () => {
  it('默认关闭、提前 60 分钟；保存后可读回；两个用户互不影响', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, studentId: '001' });
    await seedUser(db, { id: 2, studentId: '002', name: '李四' });
    const env = { DB: db, JWT_SECRET: SECRET };

    let res = await call(env, '/api/todos/reminder-prefs');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { prefs: { enabled: false, lead_minutes: 60 } });

    res = await call(env, '/api/todos/reminder-prefs', {
      method: 'PUT', body: { enabled: true, lead_minutes: 120 }
    });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data, { prefs: { enabled: true, lead_minutes: 120 } });

    res = await call(env, '/api/todos/reminder-prefs');
    assert.deepEqual(res.data.prefs, { enabled: true, lead_minutes: 120 });

    // 只改提前量时保留开关。
    res = await call(env, '/api/todos/reminder-prefs', { method: 'PUT', body: { lead_minutes: 30 } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.prefs, { enabled: true, lead_minutes: 30 });

    // 只改开关时保留提前量。
    res = await call(env, '/api/todos/reminder-prefs', { method: 'PUT', body: { enabled: false } });
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.prefs, { enabled: false, lead_minutes: 30 });

    res = await call(env, '/api/todos/reminder-prefs', {
      token: tokenFor(2, '002')
    });
    assert.deepEqual(res.data.prefs, { enabled: false, lead_minutes: 60 }, '默认值不能被别人设置污染');
  });

  it('提前量必须是 0–10080 的整数，开关必须是布尔值', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };

    for (const lead of [-1, 10081, 1.5, '60', null]) {
      const res = await call(env, '/api/todos/reminder-prefs', {
        method: 'PUT', body: { enabled: true, lead_minutes: lead }
      });
      assert.equal(res.status, 400, `lead_minutes=${JSON.stringify(lead)} 应被拒绝`);
      assert.equal(res.body.success, false);
    }
    for (const enabled of ['true', 1, null]) {
      const res = await call(env, '/api/todos/reminder-prefs', {
        method: 'PUT', body: { enabled, lead_minutes: 60 }
      });
      assert.equal(res.status, 400, `enabled=${JSON.stringify(enabled)} 应被拒绝`);
    }

    // 边界值 0 与 10080 都允许。
    for (const lead of [0, 10080]) {
      const res = await call(env, '/api/todos/reminder-prefs', {
        method: 'PUT', body: { enabled: true, lead_minutes: lead }
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.prefs.lead_minutes, lead);
    }
  });
});
