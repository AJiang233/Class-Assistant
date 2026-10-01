import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { describe, it } from 'node:test';
import { createSqliteDb } from './helpers/sqlite.js';
import { FormModel } from '../src/models/formModel.js';
import { NoticeModel } from '../src/models/noticeModel.js';
import { PushSubscriptionModel } from '../src/models/pushSubscriptionModel.js';
import { UserModel } from '../src/models/userModel.js';
import { sendEmail } from '../src/utils/email.js';
import { handleCreateForm, handleListMyForms } from '../src/handlers/formHandler.js';
import { handleListNotices } from '../src/handlers/noticeHandler.js';
import { handleSync } from '../src/handlers/syncHandler.js';
import { normalizeRecipients } from '../src/utils/recipients.js';
import { canView } from '../src/utils/audience.js';
import { expandEvent, claimDeliveries, completeDelivery, deliver } from '../src/services/outbox.js';

const me = { id: 1, name: '同名', student_id: '001', positions: '学生' };
const fields = '[{"key":"note","label":"备注","type":"text"}]';
const baseline = readFileSync(new URL('../../migrations-v2/0001_baseline.sql', import.meta.url), 'utf8');
const upgrade = readFileSync(new URL('../../migrations-v2/0002_lifecycle.sql', import.meta.url), 'utf8');
const formData = { title: '填写报名', description: '', fields, edit_policy: 'always', anonymous: 0,
  deadline: null, creator_id: 2, creator_name: '发布人', remind_people: '[1]' };
const noticeData = { title: '通知', content: '内容', publish_time: '2026-09-30 08:00:00',
  publisher: '发布人', created_by: 2, remind_people: '[1]' };

function seed(db) {
  db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash,positions,email,email_verified)
    VALUES(1,'001','同名','测试','学生','one@example.com',1),(2,'002','同名','测试','学生','two@example.com',1);
    INSERT INTO email_subscriptions(user_id,sub_notices,sub_activities,sub_forms) VALUES(1,1,1,1);`);
}
function setup(t) { const db = createSqliteDb(t); seed(db); return db; }
async function sync(db, query = '') {
  const res = await handleSync(new Request('https://class.example/api/sync' + query), { DB: db }, me);
  assert.equal(res.status, 200);
  return (await res.json()).data;
}
function count(db, table) { return db.sqlite.prepare(`SELECT count(*) AS n FROM ${table}`).get().n; }

describe('迁移与生命周期的数据库契约', () => {
  it('删除成员的附属清理与删除本身原子提交，历史答案保留', async (t) => {
    const db = setup(t);
    await new PushSubscriptionModel(db).upsert({ userId: 1, endpoint: 'https://push.example/1', p256dh: '密钥', auth: '验证' });
    const form = new FormModel(db);
    const id = await form.create(formData);
    await form.submit(await form.findById(id), 1, '001', me.name, '{}');
    db.sqlite.exec("CREATE TRIGGER fail_user BEFORE DELETE ON users BEGIN SELECT RAISE(ABORT,'注入失败'); END;");
    await assert.rejects(new UserModel(db).delete(1), /注入失败/);
    assert.equal(count(db, 'push_subscriptions'), 1);
    assert.equal(count(db, 'email_subscriptions'), 1);
    db.sqlite.exec('DROP TRIGGER fail_user');
    await new UserModel(db).delete(1);
    assert.equal(count(db, 'push_subscriptions'), 0);
    assert.equal(count(db, 'email_subscriptions'), 0);
    assert.equal(count(db, 'form_submissions'), 1);
  });
  it('新库含推送表，与历史基线迁移后的结构一致', async (t) => {
    const fresh = setup(t);
    await new PushSubscriptionModel(fresh).upsert({ userId: 1, endpoint: 'https://push.example/1', p256dh: 'key', auth: 'auth' });
    assert.equal(count(fresh, 'push_subscriptions'), 1);
    const old = createSqliteDb(t, false);
    old.sqlite.exec(baseline); old.sqlite.exec(upgrade);
    const structure = (db) => db.sqlite.prepare("SELECT type,name,sql FROM sqlite_master WHERE name NOT LIKE 'sqlite_%' ORDER BY name").all();
    assert.deepEqual(structure(old), structure(fresh));
    assert.deepEqual(old.sqlite.prepare('PRAGMA foreign_key_check').all(), []);
  });

  it('唯一姓名转 ID；同名和不存在姓名留待修订，不能自动发给全班', (t) => {
    const db = createSqliteDb(t, false); db.sqlite.exec(baseline); seed(db);
    db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash) VALUES(3,'003','唯一姓名','测试');
      INSERT INTO notices(title,content,publish_time,publisher,remind_people) VALUES
      ('唯一','内容','2026-09-30','发布人','["唯一姓名"]'),
      ('歧义','内容','2026-09-30','发布人','["同名"]'),
      ('失联','内容','2026-09-30','发布人','["已删除"]');`);
    db.sqlite.exec(upgrade);
    assert.deepEqual(db.sqlite.prepare('SELECT remind_people FROM notices ORDER BY id').all().map((x) => x.remind_people), ['[3]', '[0]', '[0]']);
    assert.equal(count(db, 'audience_migration_issues'), 2);
    assert.equal(count(db, 'outbox_events'), 0, '迁移历史不补发提醒');
  });

  it('联动表单创建与投递事件一起提交，删除级联清理通知及答案', async (t) => {
    const db = setup(t); const model = new FormModel(db);
    const id = await model.createWithNotice(formData, noticeData);
    const row = await model.findById(id);
    const notice = await new NoticeModel(db).findById(row.notice_id);
    assert.equal(notice.link, `/forms.html?id=${id}`);
    assert.equal(count(db, 'outbox_events'), 2);
    await model.submit(row, 1, '001', me.name, '{}');
    await model.remove(id);
    assert.equal(count(db, 'form_submissions'), 0);
    assert.equal(count(db, 'notices'), 0);
    assert.equal(await model.submit(row, 1, '001', me.name, '{}'), false);
    assert.throws(() => db.sqlite.prepare('INSERT INTO form_submissions(form_id,user_id,answers) VALUES(?,?,?)').run(id, 1, '{}'), /FOREIGN KEY/);
  });

  for (const target of ['forms', 'form_notice_links', 'notices', 'outbox_events']) {
    it(`${target} 写入失败回滚整个联动业务`, async (t) => {
      const db = setup(t);
      db.sqlite.exec(`CREATE TRIGGER inject_failure BEFORE INSERT ON ${target} BEGIN SELECT RAISE(ABORT,'注入失败'); END;`);
      await assert.rejects(new FormModel(db).createWithNotice(formData, noticeData), /注入失败/);
      for (const table of ['forms', 'notices', 'form_notice_links', 'outbox_events', 'content_changes']) assert.equal(count(db, table), 0, table);
    });
  }

  it('回写关联失败时 handler 返回失败，数据库没有半成品', async (t) => {
    const db = setup(t);
    db.sqlite.exec("CREATE TRIGGER inject_failure BEFORE UPDATE OF notice_id ON forms BEGIN SELECT RAISE(ABORT,'注入失败'); END;");
    const res = await handleCreateForm(new Request('https://class.example/api/forms', { method: 'POST',
      body: JSON.stringify({ title: '报名', fields: JSON.parse(fields), notice: true }) }), { DB: db }, me);
    assert.equal(res.status, 500);
    assert.equal(count(db, 'forms'), 0); assert.equal(count(db, 'notices'), 0);
    assert.equal(count(db, 'content_changes'), 0);
  });
});

describe('稳定受众与个人分页', () => {
  it('写入只接受现存 ID；改名和同名都不会改变受众', async (t) => {
    const db = setup(t);
    assert.equal(await normalizeRecipients(db, [1, '1']), '[1]');
    assert.equal(await normalizeRecipients(db, ['同名']), false);
    assert.equal(await normalizeRecipients(db, [999]), false);
    for (const raw of [[true], [null], [{}], '坏 JSON', '1', [0], [-1], [1.1]]) {
      assert.equal(await normalizeRecipients(db, raw), false);
    }
    assert.equal(canView('[1]', { user: { ...me, name: '新姓名' }, excluded: false }), true);
    assert.equal(canView('[1]', { user: { id: 2, name: me.name }, excluded: false }), false);
  });

  it('超过一页别人的通知不会挤掉自己的通知', async (t) => {
    const db = setup(t); const model = new NoticeModel(db);
    const id = await model.create(noticeData);
    for (let i = 0; i < 105; i++) await model.create({ ...noticeData, remind_people: '[2]', publish_time: '2026-09-30 09:00:00' });
    const res = await handleListNotices(new Request('https://class.example/api/notices?audience=mine&date=2026-09-30&limit=50'), { DB: db }, me);
    assert.deepEqual((await res.json()).data.list.map((x) => x.id), [id]);
  });

  it('表单先过滤受众与截止时间，再分页', async (t) => {
    const db = setup(t); const model = new FormModel(db);
    const id = await model.create(formData);
    for (let i = 0; i < 105; i++) await model.create({ ...formData, remind_people: '[2]' });
    const res = await handleListMyForms(new Request('https://class.example/api/forms/mine'), { DB: db }, me);
    assert.deepEqual((await res.json()).data.pending.map((x) => x.id), [id]);
  });
});

describe('持久投递的恢复语义', () => {
  it('邮件实际传输携带稳定幂等键，并保留可判定重试的上游状态', async (t) => {
    const original = globalThis.fetch;
    t.after(() => { globalThis.fetch = original; });
    const seen = [];
    globalThis.fetch = async (_url, options) => { seen.push(options); return new Response('{}', { status: 429 }); };
    await assert.rejects(sendEmail({ EMAIL_API_KEY: '本地测试' }, {
      to: 'one@example.com', subject: '测试', html: '正文', idempotencyKey: 'event/1/1'
    }), (error) => error.status === 429);
    assert.equal(seen[0].headers['Idempotency-Key'], 'event/1/1');
  });
  async function prepared(t) {
    const db = setup(t); await new NoticeModel(db).create(noticeData);
    const event = db.sqlite.prepare('SELECT * FROM content_changes').get();
    const env = { DB: db, SITE_ORIGIN: 'https://class.example' };
    await Promise.all([expandEvent(env, event), expandEvent(env, event)]);
    return { db, env };
  }
  it('重复展开只登记一条邮件，租约互斥，过期接管不接受旧确认', async (t) => {
    const { db } = await prepared(t);
    assert.equal(count(db, 'outbox_deliveries'), 1);
    const [a] = await claimDeliveries(db, 1000, '甲');
    assert.equal((await claimDeliveries(db, 1000, '乙')).length, 0);
    const [b] = await claimDeliveries(db, 1121, '乙');
    await completeDelivery(db, a, 'sent', 1122);
    assert.equal(db.sqlite.prepare('SELECT state FROM outbox_deliveries').get().state, 'sending');
    await completeDelivery(db, b, 'sent', 1123);
    assert.equal((await claimDeliveries(db, 9999, '丙')).length, 0);
  });
  it('临时失败退避后恢复，成功记录不重复消费', async (t) => {
    const { db, env } = await prepared(t);
    const [a] = await claimDeliveries(db, 1000, '甲');
    await deliver(env, a, 1000, async () => ({ ok: false, status: 503 }));
    assert.equal((await claimDeliveries(db, 1001, '乙')).length, 0);
    const [b] = await claimDeliveries(db, 1100, '乙');
    await deliver(env, b, 1100, async () => ({ ok: true }));
    assert.equal(db.sqlite.prepare('SELECT state FROM outbox_deliveries').get().state, 'sent');
  });
  it('永久错误终止，退订后跳过，缺配置保留等待', async (t) => {
    const { db, env } = await prepared(t);
    const [a] = await claimDeliveries(db, 1000, '甲');
    await deliver(env, a, 1000);
    assert.equal(db.sqlite.prepare('SELECT attempts FROM outbox_deliveries').get().attempts, 0);
    const [b] = await claimDeliveries(db, 1400, '乙');
    await deliver(env, b, 1400, async () => ({ ok: false, status: 422 }));
    assert.equal(db.sqlite.prepare('SELECT state FROM outbox_deliveries').get().state, 'dead');
    db.sqlite.exec("UPDATE outbox_deliveries SET state='pending'; UPDATE email_subscriptions SET sub_notices=0");
    const [c] = await claimDeliveries(db, 9999, '丙');
    await deliver(env, c, 9999, async () => { assert.fail('退订后不应发送'); });
    assert.equal(db.sqlite.prepare('SELECT state FROM outbox_deliveries').get().state, 'skipped');
  });

  it('设备改绑后不发送，410 终止并删除同一份过期订阅', async (t) => {
    const db = setup(t); const env = { DB: db, SITE_ORIGIN: 'https://class.example' };
    const model = new PushSubscriptionModel(db);
    await model.upsert({ userId: 1, endpoint: 'https://push.example/1', p256dh: '旧密钥', auth: '验证' });
    await new NoticeModel(db).create(noticeData);
    await expandEvent(env, db.sqlite.prepare('SELECT * FROM content_changes').get());
    db.sqlite.exec("UPDATE outbox_deliveries SET state='skipped' WHERE channel='email'");
    const [first] = await claimDeliveries(db, 1000, '甲');
    await model.upsert({ userId: 2, endpoint: first.target, p256dh: '新密钥', auth: '验证' });
    await deliver(env, first, 1000, async () => { assert.fail('改绑后不应发送'); });
    assert.equal(db.sqlite.prepare("SELECT state FROM outbox_deliveries WHERE channel='push'").get().state, 'skipped');
    await model.upsert({ userId: 1, endpoint: first.target, p256dh: '旧密钥', auth: '验证' });
    db.sqlite.exec("UPDATE outbox_deliveries SET state='pending' WHERE channel='push'");
    const [second] = await claimDeliveries(db, 9999, '乙');
    await deliver(env, second, 9999, async () => ({ ok: false, status: 410 }));
    assert.equal(count(db, 'push_subscriptions'), 0);
    assert.equal(db.sqlite.prepare("SELECT state FROM outbox_deliveries WHERE channel='push'").get().state, 'dead');
  });

  it('展开失败不产生半份收件人，重复展开不会把后来订阅的人加入旧事件', async (t) => {
    const db = setup(t); const env = { DB: db, SITE_ORIGIN: 'https://class.example' };
    await new NoticeModel(db).create({ ...noticeData, remind_people: null, created_by: null });
    const event = db.sqlite.prepare('SELECT * FROM content_changes').get();
    db.sqlite.exec("CREATE TRIGGER fail_expand BEFORE UPDATE ON outbox_events BEGIN SELECT RAISE(ABORT,'注入展开失败'); END;");
    await assert.rejects(expandEvent(env, event), /注入展开失败/);
    assert.equal(count(db, 'outbox_deliveries'), 0);
    db.sqlite.exec('DROP TRIGGER fail_expand');
    await expandEvent(env, event);
    db.sqlite.exec('INSERT INTO email_subscriptions(user_id,sub_notices) VALUES(2,1)');
    await expandEvent(env, event);
    assert.equal(count(db, 'outbox_deliveries'), 1);
  });

  it('进程连续中断超过上限时进入待处理状态', async (t) => {
    const { db } = await prepared(t);
    for (let i = 0; i < 8; i++) assert.equal((await claimDeliveries(db, 1000 + i * 121, `租约${i}`)).length, 1);
    assert.equal((await claimDeliveries(db, 9999, '后续')).length, 0);
    assert.equal(db.sqlite.prepare('SELECT state FROM outbox_deliveries').get().state, 'dead');
  });
});

describe('增量同步协议', () => {
  it('初始化快照只返回固定上界内最后版本，跨页写入不改变该快照', async (t) => {
    const db = setup(t); const model = new NoticeModel(db);
    const id = await model.create(noticeData);
    for (let i = 0; i < 20; i++) await model.update(id, { title: `修订${i}` });
    const other = await model.create(noticeData);
    const first = await sync(db, '?snapshot=1&limit=1');
    assert.equal(first.changes[0].row.title, '修订19');
    await model.update(other, { title: '下一轮才能看到' });
    const last = await sync(db, `?snapshot=1&limit=1&after=${first.cursor}&until=${first.until}&rules=${first.rules}`);
    assert.equal(last.changes[0].row.title, noticeData.title);
    assert.equal(last.hasMore, false);
  });
  it('固定上界、删除标记、同秒写入与分页期间的新写入互不丢失', async (t) => {
    const db = setup(t); const model = new NoticeModel(db);
    const id = await model.create(noticeData); await model.create(noticeData);
    const first = await sync(db, '?limit=1');
    await model.update(id, { title: '修改后' }); await model.delete(id);
    const second = await sync(db, `?after=${first.cursor}&until=${first.until}&rules=${first.rules}&limit=1`);
    assert.equal(second.hasMore, false); assert.equal(second.changes.length, 1);
    const delta = await sync(db, `?after=${second.cursor}&rules=${first.rules}`);
    assert.deepEqual(delta.changes.map((c) => c.deleted), [false, true]);
    assert.equal(delta.changes[0].row.title, '修改后');
  });
  it('名单撤回返回删除标记，规则变化要求重建，答案不进入同步响应', async (t) => {
    const db = setup(t); const model = new FormModel(db); const id = await model.create(formData);
    const first = await sync(db);
    await model.submit(await model.findById(id), 1, '001', me.name, '{"note":"私有答案"}');
    let next = await sync(db, `?after=${first.cursor}&rules=${first.rules}`);
    assert.equal(next.changes[0].row.submitted, true);
    assert.equal(JSON.stringify(next).includes('私有答案'), false);
    await model.update(id, { remind_people: '[2]' });
    next = await sync(db, `?after=${next.cursor}&rules=${first.rules}`);
    assert.equal(next.changes[0].deleted, true);
    assert.equal('row' in next.changes[0], false);
    assert.equal((await sync(db, '?after=1&rules=旧规则')).reset, true);
  });

  it('状态序列模型：创建、编辑、删除、改受众与分页重放均收敛到个人投影', async (t) => {
    const db = setup(t); const model = new NoticeModel(db);
    const expected = new Map(); const actual = new Map();
    let seed = 233, cursor = 0, rules = '';
    const random = () => { seed ^= seed << 13; seed ^= seed >>> 17; seed ^= seed << 5; return seed >>> 0; };
    for (let step = 0; step < 160; step++) {
      const ids = [...expected.keys()]; const id = ids.length ? ids[random() % ids.length] : null;
      const action = random() % 4;
      if (id == null || action === 0) {
        const mine = random() % 2 === 0; const title = `记录${step}`;
        const created = await model.create({ ...noticeData, title, remind_people: mine ? '[1]' : '[2]' });
        expected.set(created, { title, mine });
      } else if (action === 1) { await model.delete(id); expected.delete(id); }
      else if (action === 2) { await model.update(id, { title: `修改${step}` }); expected.get(id).title = `修改${step}`; }
      else { expected.get(id).mine = !expected.get(id).mine; await model.update(id, { remind_people: expected.get(id).mine ? '[1]' : '[2]' }); }
      let until;
      do {
        const page = await sync(db, `?after=${cursor}&limit=3${rules ? '&rules=' + rules : ''}${until == null ? '' : '&until=' + until}`);
        for (const c of page.changes) c.deleted ? actual.delete(c.id) : actual.set(c.id, c.row.title);
        cursor = page.cursor; rules = page.rules; until = page.until;
        if (!page.hasMore) break;
      } while (true);
      assert.deepEqual([...actual].sort(), [...expected].filter(([, r]) => r.mine).map(([key, r]) => [key, r.title]).sort(), `种子233，步骤${step}`);
    }
  });
});
