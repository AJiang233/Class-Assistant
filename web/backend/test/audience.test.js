import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canView,
  listByAudience,
  loadViewer,
  pickAudience,
  withoutRemindPeople
} from '../src/utils/audience.js';
import { handleGetNotice } from '../src/handlers/noticeHandler.js';
import { handleGetActivity } from '../src/handlers/activityHandler.js';
import { handleGetForm, handleSubmitForm } from '../src/handlers/formHandler.js';
import { handleCalendarFeed } from '../src/handlers/calendarHandler.js';

/**
 * 可见性判定（issue #18）：
 * 「不计入班级管理」的规则只在列表接口实现过，单条读取 / 日历订阅 / 表单详情
 * 三条路径完全绕过。这里把三条路径的验收逐条钉住。
 */

// ===== 假 D1：只认这些用例用到的 SQL =====

/** 一个「不计入班级管理」的自定义职位 */
const 旁听生 = { name: '旁听生', permissions: '["class:exclude"]' };

const 班长 = { id: 1, name: '班长', positions: '班长' };        // content:write + user:manage
const 小张 = { id: 2, name: '小张', positions: '学生' };
const 小李 = { id: 3, name: '小李', positions: '旁听生' };      // 不计入班级管理

function fakeDb(rows = {}) {
  return {
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          if (/FROM users/i.test(sql)) return rows.user || null;
          if (/FROM notices/i.test(sql)) return rows.notice || null;
          if (/FROM activities/i.test(sql)) return rows.activity || null;
          if (/FROM forms/i.test(sql)) return rows.form || null;
          return null;   // form_submissions 之类：这些用例不需要
        },
        async all() {
          if (/FROM roles/i.test(sql)) return { results: rows.roles || [] };
          if (/FROM users/i.test(sql)) return { results: rows.users || [] };
          if (/FROM activities/i.test(sql)) return { results: rows.activities || [] };
          if (/FROM notices/i.test(sql)) return { results: rows.notices || [] };
          return { results: [] };
        },
        async run() { return {}; }
      };
      return stmt;
    }
  };
}

const req = (path) => new Request('https://class.example' + path);
const json = (res) => res.json();

// ===== 判定本身 =====

describe('可见性判定', () => {
  const viewerFor = (user, roles = []) => loadViewer({ DB: fakeDb({ roles }) }, user);

  it('提醒对象为空 = 全班可见，但「不计入班级管理」的人除外', async () => {
    const normal = await viewerFor(小张);
    const excluded = await viewerFor(小李, [旁听生]);

    for (const raw of [null, '', '[]']) {
      assert.equal(canView(raw, normal), true, `raw=${raw}`);
      assert.equal(canView(raw, excluded), false, `raw=${raw}`);
    }
  });

  it('定向名单里写了姓名或用户 id 才对 ta 可见', async () => {
    const excluded = await viewerFor(小李, [旁听生]);
    const normal = await viewerFor(小张);

    assert.equal(canView(JSON.stringify(['小李']), excluded), true);
    assert.equal(canView(JSON.stringify(['小李']), normal), false);
    assert.equal(canView(JSON.stringify(['刘科江']), normal), false);
    // 名单里也可以写用户 id（提醒对象选择器两种都写）
    assert.equal(canView('3', excluded), true);
  });

  it('坏 JSON 按「有名单」处理，对不上的人看不到（不会误当全班放出去）', async () => {
    const normal = await viewerFor(小张);
    assert.equal(canView('["小张"', normal), false);
  });

  it('应交名单：空 = 全班减去被排除的人，定向 = 只按名单挑', () => {
    const all = [班长, 小张, 小李];
    const isExcluded = (u) => u.positions === '旁听生';

    assert.deepEqual(pickAudience(all, null, isExcluded).map((u) => u.name), ['班长', '小张']);
    assert.deepEqual(pickAudience(all, JSON.stringify(['小李']), isExcluded).map((u) => u.name), ['小李']);
  });

  it('定向名单只交给能发文的人（编辑表单要用它预填）', async () => {
    const writer = await loadViewer({ DB: fakeDb() }, 班长);
    const reader = await loadViewer({ DB: fakeDb() }, 小张);
    const row = { id: 5, title: 'T', remind_people: '["小李"]' };

    assert.equal(withoutRemindPeople(row, writer).remind_people, '["小李"]');
    assert.equal('remind_people' in withoutRemindPeople(row, reader), false);
  });

  it('列表排除组的人：跳过不可见的行并继续取下一页，别把名额浪费掉', async () => {
    // 每页两行、其中一行对排除组不可见：两页之后才凑够 2 条
    const page = () => [{ remind_people: null }, { remind_people: JSON.stringify(['小李']) }];
    const excludedViewer = await loadViewer({ DB: fakeDb({ roles: [旁听生] }) }, 小李);

    const out = await listByAudience(excludedViewer, async (l, o) => (o < 4 ? page() : []), 2, 0);

    assert.equal(out.length, 2);
    assert.ok(out.every((r) => r.remind_people));
  });
});

// ===== 三条被绕过的读取路径 =====

describe('单条读取', () => {
  it('被排除的成员按 id 取全班通知：404', async () => {
    const env = { DB: fakeDb({ roles: [旁听生], notice: { id: 5, title: '全班通知', remind_people: null } }) };

    const res = await handleGetNotice(req('/api/notices/5'), env, 小李, { id: '5' });

    assert.equal(res.status, 404);
    assert.equal((await json(res)).code, 'NOTICE_NOT_FOUND');
  });

  it('班上同学取得到，但响应里不带定向名单', async () => {
    const env = { DB: fakeDb({ notice: { id: 5, title: '全班通知', remind_people: null } }) };

    const res = await handleGetNotice(req('/api/notices/5'), env, 小张, { id: '5' });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body.data.title, '全班通知');
    assert.equal('remind_people' in body.data, false);
  });

  it('班委没被定向到也能打开（编辑入口要用），并拿到定向名单', async () => {
    const env = { DB: fakeDb({ notice: { id: 5, title: '定向通知', remind_people: '["小李"]' } }) };

    const res = await handleGetNotice(req('/api/notices/5'), env, 班长, { id: '5' });
    const body = await json(res);

    assert.equal(res.status, 200);
    assert.equal(body.data.remind_people, '["小李"]');
  });

  it('活动同一条规则', async () => {
    const activity = { id: 7, title: '全班活动', remind_people: null };
    const res = await handleGetActivity(req('/api/activities/7'),
      { DB: fakeDb({ roles: [旁听生], activity }) }, 小李, { id: '7' });

    assert.equal(res.status, 404);
    assert.equal((await json(res)).code, 'ACTIVITY_NOT_FOUND');
  });
});

describe('表单详情与提交', () => {
  const baseForm = {
    id: 9,
    title: '聚餐报名',
    fields: '[]',
    status: 'open',
    edit_policy: 'always',
    anonymous: 0,
    creator_id: 2,          // 小张建的
    creator_name: '小张',
    remind_people: JSON.stringify(['小张']),
    deadline: null
  };

  it('不在定向名单里的人打开详情：404', async () => {
    const env = { DB: fakeDb({ roles: [旁听生], form: baseForm }) };

    const res = await handleGetForm(req('/api/forms/9'), env, 小李, { id: '9' });

    assert.equal(res.status, 404);
    assert.equal((await json(res)).code, 'FORM_NOT_FOUND');
  });

  it('不在定向名单里的人提交：403', async () => {
    const env = { DB: fakeDb({ roles: [旁听生], form: baseForm }) };

    const res = await handleSubmitForm(req('/api/forms/9/submit'), env, 小李, { id: '9' });

    assert.equal(res.status, 403);
    assert.equal((await json(res)).code, 'FORBIDDEN');
  });

  it('名单里的人能打开', async () => {
    const env = { DB: fakeDb({ form: baseForm }) };

    const res = await handleGetForm(req('/api/forms/9'), env, 小张, { id: '9' });

    assert.equal(res.status, 200);
    assert.equal((await json(res)).data.form.title, '聚餐报名');
  });

  it('创建者不在自己的名单里也能打开（否则看不了进度、导不了表）', async () => {
    const env = { DB: fakeDb({ roles: [旁听生], form: { ...baseForm, creator_id: 3, remind_people: JSON.stringify(['小张']) } }) };

    const res = await handleGetForm(req('/api/forms/9'), env, 小李, { id: '9' });

    assert.equal(res.status, 200);
  });
});

describe('日历订阅源', () => {
  const activities = [
    { id: 1, title: '全班活动', start_time: '2026-09-15 10:00:00', end_time: '2026-09-15 11:00:00', remind_people: null },
    { id: 2, title: '定向活动', start_time: '2026-09-16 10:00:00', end_time: '', remind_people: JSON.stringify(['小李']) }
  ];
  // 把时间窗口放到最宽，免得用例随日期推移失效
  const feed = (user) => handleCalendarFeed(
    req('/api/calendar.ics?key=k&past=365&future=730'),
    { DB: fakeDb({ roles: [旁听生], users: [user], user, activities }) }
  );

  it('只包含该用户可见的条目（班上同学）', async () => {
    const text = await (await feed(小张)).text();

    assert.match(text, /BEGIN:VCALENDAR/);
    assert.match(text, /全班活动/);
    assert.equal(text.includes('定向活动'), false);
  });

  it('只包含该用户可见的条目（被排除的成员，只拿被点名的那些）', async () => {
    const text = await (await feed(小李)).text();

    assert.equal(text.includes('全班活动'), false);
    assert.match(text, /定向活动/);
  });
});
