import { createSqliteDb } from './helpers/sqlite.js';
import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';
import { describe, it } from 'node:test';

import { handleCalendarFeed } from '../src/handlers/calendarHandler.js';
import { handleCreateForm, handleSubmitForm } from '../src/handlers/formHandler.js';
import { submitGate, validateAnswers } from '../src/handlers/formValidation.js';
import { handleCreateNotice, handleUpdateNotice } from '../src/handlers/noticeHandler.js';
import { handleCreateActivity, handleUpdateActivity } from '../src/handlers/activityHandler.js';
import { FormModel } from '../src/models/formModel.js';
import { listByAudience } from '../src/utils/audience.js';
import { addMinutes, parseLocalDateTime } from '../src/utils/datetime.js';

const user = { id: 1, student_id: '001', name: '小张', positions: '班长' };
const fields = JSON.stringify([{ key: 'note', label: '备注', type: 'text', required: true }]);

/** 只适配 D1 的接口形状，SQL 与表结构都由真实 SQLite 执行。 */
function createDb(t) {
  const db = createSqliteDb(t);
  db.sqlite.prepare('INSERT INTO users (id, student_id, name, password_hash, positions, auth_key) VALUES (?, ?, ?, ?, ?, ?)')
    .run(user.id, user.student_id, user.name, '测试摘要', user.positions, 'calendar-test');
  return db;
}

function request(path, body, method = 'POST') {
  return new Request('https://class.example/api/' + path, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(body)
  });
}

async function createForm(db, editPolicy = 'none') {
  return new FormModel(db).create({
    title: '测试表单', fields, edit_policy: editPolicy,
    creator_id: user.id, creator_name: user.name
  });
}

describe('班务时间与宿主时区无关', () => {
  it('北京时间转换为固定时间戳，截止后立即关闭', () => {
    const deadline = '2026-09-29 18:00:00';
    const at = Date.parse('2026-09-29T10:00:00Z');
    assert.equal(parseLocalDateTime(deadline), at);
    const form = { status: 'open', edit_policy: 'before_deadline', deadline };
    assert.equal(submitGate(form, false, at - 1).ok, true);
    assert.equal(submitGate(form, false, at + 1).ok, false);
    assert.equal(submitGate({ ...form, edit_policy: 'always' }, true, at + 1).ok, true);
  });

  it('夏令时切换日的有效北京时间不会被判成无效', () => {
    assert.equal(parseLocalDateTime('2026-03-08 02:30:00'), Date.parse('2026-03-07T18:30:00Z'));
    assert.equal(addMinutes('2026-03-08 01:30:00', 60), '2026-03-08 02:30:00');
    assert.equal(addMinutes('2026-12-31 23:30:00', 60), '2027-01-01 00:30:00');
    assert.equal(parseLocalDateTime('2026-02-30 10:00:00'), null);
  });
});

describe('受众过滤后的分页', () => {
  it('连续翻页不重复，偏移按可见行计算', async () => {
    const rows = Array.from({ length: 9 }, (_, id) => ({ id, remind_people: id % 2 ? '["小张"]' : null }));
    const viewer = { excluded: true, canManageUsers: false };
    const fetchPage = async (limit, offset) => rows.slice(offset, offset + limit);
    assert.deepEqual((await listByAudience(viewer, fetchPage, 2, 0)).map((r) => r.id), [1, 3]);
    assert.deepEqual((await listByAudience(viewer, fetchPage, 2, 2)).map((r) => r.id), [5, 7]);
    assert.deepEqual(await listByAudience(viewer, fetchPage, 2, 4), []);
  });
});

describe('真实数据库中的表单提交', () => {
  it('不可修改的表单同时首次提交，两次只能有一次成功', async (t) => {
    const db = createDb(t);
    const id = await createForm(db);
    const submit = (note) => handleSubmitForm(request('forms/' + id, { answers: { note } }), { DB: db }, user, { id });
    const responses = await Promise.all([submit('第一次'), submit('第二次')]);
    assert.deepEqual(responses.map((r) => r.status).sort(), [200, 409]);
    const saved = await new FormModel(db).findMySubmission(id, user.id);
    assert.equal(JSON.parse(saved.answers).note, '第一次');
  });

  for (const [label, change] of [
    ['字段已更换', (db, id) => db.sqlite.prepare('UPDATE forms SET fields = ? WHERE id = ?').run(fields.replaceAll('note', 'other'), id)],
    ['表单已关闭', (db, id) => db.sqlite.prepare("UPDATE forms SET status = 'closed' WHERE id = ?").run(id)],
    ['截止时间已提前', (db, id) => db.sqlite.prepare("UPDATE forms SET deadline = '2000-01-01 00:00:00' WHERE id = ?").run(id)],
    ['表单已删除', (db, id) => db.sqlite.prepare('DELETE FROM forms WHERE id = ?').run(id)],
    ['提交名单已变更', (db, id) => db.sqlite.prepare('UPDATE forms SET remind_people = ? WHERE id = ?').run('["其他同学"]', id)]
  ]) {
    it(`校验后${label}，不能再保存旧答案`, async (t) => {
      const db = createDb(t);
      const id = await createForm(db, 'before_deadline');
      const req = request('forms/' + id, {});
      req.json = async () => {
        change(db, id);
        return { answers: { note: '旧答案' } };
      };
      const response = await handleSubmitForm(req, { DB: db }, user, { id });
      assert.equal(response.status, 409);
      assert.equal(await new FormModel(db).findMySubmission(id, user.id), null);
    });
  }

  it('允许修改的表单保留首次提交时间并保存新答案', async (t) => {
    const db = createDb(t);
    const id = await createForm(db, 'always');
    db.sqlite.prepare("UPDATE forms SET deadline = '2000-01-01 00:00:00' WHERE id = ?").run(id);
    for (const note of ['原答案', '新答案']) {
      const response = await handleSubmitForm(request('forms/' + id, { answers: { note } }), { DB: db }, user, { id });
      assert.equal(response.status, 200);
      if (note === '原答案') db.sqlite.exec("UPDATE form_submissions SET created_at = '2001-01-01 00:00:00'");
    }
    const saved = await new FormModel(db).findMySubmission(id, user.id);
    assert.equal(JSON.parse(saved.answers).note, '新答案');
    assert.equal(saved.created_at, '2001-01-01 00:00:00');
  });

  it('提交先完成时，字段修改不能破坏已经保存的答案', async (t) => {
    const db = createDb(t);
    const id = await createForm(db);
    const model = new FormModel(db);
    assert.equal((await handleSubmitForm(request('forms/' + id, { answers: { note: '原答案' } }), { DB: db }, user, { id })).status, 200);
    assert.equal(await model.updateIfUnsubmitted(id, { fields: fields.replaceAll('note', 'other') }), false);
    assert.equal((await model.findById(id)).fields, fields);
  });
});

describe('日历按请求日期窗口取数', () => {
  function setup(t) {
    t.mock.timers.enable({ apis: ['Date'], now: new Date('2026-09-29T16:30:00Z') });
    const db = createDb(t);
    const feed = () => handleCalendarFeed(new Request(
      'https://class.example/api/calendar.ics?key=calendar-test&past=0&future=1&notices=1'
    ), { DB: db });
    return { db, feed };
  }

  it('窗口外超过 200 个远期活动，不会挤掉今天的活动', async (t) => {
    const { db, feed } = setup(t);
    const insert = db.sqlite.prepare('INSERT INTO activities (title, start_time, publisher) VALUES (?, ?, ?)');
    for (let i = 0; i < 201; i++) insert.run('远期活动', '2030-01-01 12:00:00', '班长');
    insert.run('今天的活动', '2026-09-30 10:00:00', '班长');
    const response = await feed();
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.match(text, /今天的活动/);
    assert.doesNotMatch(text, /远期活动/);
  });

  it('不可见活动不占有效名额，后续可见条目仍进入日历', async (t) => {
    const { db, feed } = setup(t);
    const insert = db.sqlite.prepare('INSERT INTO activities (title, start_time, publisher, remind_people) VALUES (?, ?, ?, ?)');
    for (let i = 0; i < 201; i++) insert.run('别人的活动', '2026-09-30 10:00:00', '班长', '["其他同学"]');
    insert.run('我的活动', '2026-09-30 10:00:00', '班长', null);
    const text = await (await feed()).text();
    assert.match(text, /我的活动/);
    assert.doesNotMatch(text, /别人的活动/);
  });

  it('未来通知进入订阅，past=0 以北京时间零点为边界', async (t) => {
    const { db, feed } = setup(t);
    const insert = db.sqlite.prepare('INSERT INTO notices (title, content, publish_time, publisher) VALUES (?, ?, ?, ?)');
    insert.run('明天的通知', '正文', '2026-10-01 12:00:00', '班长');
    insert.run('昨天的通知', '正文', '2026-09-29 12:00:00', '班长');
    const text = await (await feed()).text();
    assert.match(text, /明天的通知/);
    assert.doesNotMatch(text, /昨天的通知/);
  });

  it('过去范围内的已过期通知仍保留在订阅中', async (t) => {
    const { db } = setup(t);
    db.sqlite.exec("INSERT INTO notices (title, content, publish_time, expire_time, publisher) VALUES ('已过期的通知', '正文', '2026-09-28 12:00:00', '2026-09-28 13:00:00', '班长')");
    const response = await handleCalendarFeed(new Request(
      'https://class.example/api/calendar.ics?key=calendar-test&past=3&future=1&notices=1'
    ), { DB: db });
    assert.match(await response.text(), /已过期的通知/);
  });
});

describe('日期输入不污染已保存内容', () => {
  for (const [label, path, create, update, start, end] of [
    ['通知', 'notices', handleCreateNotice, handleUpdateNotice, 'publish_time', 'expire_time'],
    ['活动', 'activities', handleCreateActivity, handleUpdateActivity, 'start_time', 'end_time']
  ]) {
    it(`${label}的非法必填时间和非法结束时间返回 400`, async (t) => {
      const db = createDb(t);
      for (const times of [
        { [start]: '2026-02-30 10:00:00' },
        { [start]: '2026-09-30 10:00:00', [end]: '错误日期' },
        { [start]: '2026-09-30 10:00:00', [end]: '2026-09-29 10:00:00' }
      ]) {
        const response = await create(request(path, { title: '标题', content: '正文', ...times }), { DB: db }, user, {});
        assert.equal(response.status, 400);
      }
      assert.equal(db.sqlite.prepare(`SELECT COUNT(*) AS count FROM ${path}`).get().count, 0);
    });

    it(`${label}修改时间失败后原记录不变，清空可选时间仍可用`, async (t) => {
      const db = createDb(t);
      const body = { title: '标题', content: '正文', [start]: '2026-09-30 10:00:00', [end]: '2026-09-30 11:00:00' };
      assert.equal((await create(request(path, body), { DB: db }, user, {})).status, 201);
      for (const patch of [{ [end]: '错误日期' }, { [start]: null }, { [start]: '2026-10-01 10:00:00' }]) {
        const response = await update(request(path + '/1', patch, 'PUT'), { DB: db }, user, { id: 1 });
        assert.equal(response.status, 400);
      }
      assert.equal(db.sqlite.prepare(`SELECT ${end} AS value FROM ${path}`).get().value, body[end]);
      const response = await update(request(path + '/1', { [end]: null }, 'PUT'), { DB: db }, user, { id: 1 });
      assert.equal(response.status, 200);
      assert.equal(db.sqlite.prepare(`SELECT ${end} AS value FROM ${path}`).get().value, null);
    });
  }

  it('表单日期字段拒绝不存在的日期，接受闰年和空选填值', () => {
    const definition = [{ key: 'day', label: '日期', type: 'date' }];
    for (const day of ['2026-02-30', '2025-02-29', '2026-13-01']) {
      assert.equal(validateAnswers(definition, { day }).ok, false);
    }
    for (const day of ['2028-02-29', '']) {
      assert.equal(validateAnswers(definition, { day }).ok, true);
    }
  });

  it('表单联动通知的非法时间在写入前被拒绝', async (t) => {
    const db = createDb(t);
    for (const times of [
      { notice_publish_time: '错误时间' },
      { notice_publish_time: '2026-09-30 10:00:00', notice_expire_time: '2026-09-29 10:00:00' }
    ]) {
      const response = await handleCreateForm(request('forms', {
        title: '表单', fields: JSON.parse(fields), notice: true, ...times
      }), { DB: db }, user, {});
      assert.equal(response.status, 400);
    }
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM forms').get().count, 0);
    assert.equal(db.sqlite.prepare('SELECT COUNT(*) AS count FROM notices').get().count, 0);
  });
});
