import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import {
  canManageItem,
  canView,
  listByAudience,
  loadViewer,
  pickAudience,
  withoutRemindPeople
} from '../src/utils/audience.js';
import {
  handleCreateNotice,
  handleDeleteNotice,
  handleGetNotice,
  handleUpdateNotice
} from '../src/handlers/noticeHandler.js';
import { handleGetActivity, handleUpdateActivity } from '../src/handlers/activityHandler.js';
import { handleGetForm, handleSubmitForm } from '../src/handlers/formHandler.js';
import { handleCalendarFeed } from '../src/handlers/calendarHandler.js';

/**
 * 可见性与归属（issue #18 / #17）
 *
 * #18：「不计入班级管理」的规则此前只在列表接口实现过，单条读取 / 日历订阅 /
 *      表单详情三条路径完全绕过。这里把三条路径的验收逐条钉住。
 * #17：通知/活动的改与删此前只校验 content:write、不校验归属，
 *      且 publisher 能由请求体直接写进去。
 */

// ===== 假 D1：只认这些用例用到的 SQL =====

/** 一个「不计入班级管理」的自定义职位 */
const 旁听生 = { name: '旁听生', permissions: '["class:exclude"]' };

const 班长 = { id: 1, name: '班长', positions: '班长' };        // content:write + user:manage
const 小张 = { id: 2, name: '小张', positions: '学生' };
const 小李 = { id: 3, name: '小李', positions: '旁听生' };      // 不计入班级管理

/** 每个用例都能从 env.DB.calls 里翻出实际发出去的 SQL 与参数 */
function fakeDb(rows = {}) {
  const calls = [];
  return {
    calls,
    prepare(sql) {
      const stmt = {
        _args: [],
        bind(...args) { stmt._args = args; return stmt; },
        async first() {
          calls.push({ sql, args: stmt._args });
          if (/INSERT INTO notices/i.test(sql)) return { id: 99 };
          if (/FROM users/i.test(sql)) return rows.user || null;
          if (/FROM notices/i.test(sql)) return rows.notice || null;
          if (/FROM activities/i.test(sql)) return rows.activity || null;
          if (/FROM forms/i.test(sql)) return rows.form || null;
          return null;   // form_submissions 之类：这些用例不需要
        },
        async all() {
          calls.push({ sql, args: stmt._args });
          if (/FROM roles/i.test(sql)) return { results: rows.roles || [] };
          if (/FROM users/i.test(sql)) return { results: rows.users || [] };
          if (/FROM activities/i.test(sql)) return { results: rows.activities || [] };
          if (/FROM notices/i.test(sql)) return { results: rows.notices || [] };
          return { results: [] };
        },
        async run() {
          calls.push({ sql, args: stmt._args });
          return {};
        }
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

  it('文案不写死「不存在」：被名单挡在外面的人会以为是链接点错了', async () => {
    const env = { DB: fakeDb({ roles: [旁听生], notice: { id: 5, title: '全班通知', remind_people: null } }) };

    const res = await handleGetNotice(req('/api/notices/5'), env, 小李, { id: '5' });
    const { error } = await json(res);

    assert.equal(error.includes('不存在'), false, '两种情形共用一句，不能说死是不存在');
    assert.ok(error.includes('提醒对象'), '要给出「没提醒你」这个可能');
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

  it('存在但看不到 / 根本不存在：文案必须逐字相同', async () => {
    // 分开写的两句话一旦不一致，这个差别本身就等于回答「表单存在吗」
    const hidden = await handleGetForm(req('/api/forms/9'),
      { DB: fakeDb({ roles: [旁听生], form: baseForm }) }, 小李, { id: '9' });
    const missing = await handleGetForm(req('/api/forms/9'), { DB: fakeDb({}) }, 小李, { id: '9' });

    assert.equal((await json(hidden)).error, (await json(missing)).error);
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

  /**
   * 管理面板点「提交明细」要先 GET 这条表单拿字段定义。只按「在不在定向名单」放行的话，
   * 班长点别人的表单就是 404 —— 列表上看得见、点进去打不开。放行的是「能管的人」，
   * 不是所有 content:write：学习委员没有理由打开班长的表单。
   */
  it('持 user:manage 的班委能打开别人的表单', async () => {
    const env = { DB: fakeDb({ form: baseForm }) };

    const res = await handleGetForm(req('/api/forms/9'), env, 班长, { id: '9' });

    assert.equal(res.status, 200);
  });

  it('只有 content:write 的学习委员打不开别人的表单：仍是 404', async () => {
    const env = { DB: fakeDb({ form: baseForm }) };
    const 学习委员 = { id: 4, name: '学习委员', positions: '学习委员' };

    const res = await handleGetForm(req('/api/forms/9'), env, 学习委员, { id: '9' });

    assert.equal(res.status, 404);
    assert.equal((await json(res)).code, 'FORM_NOT_FOUND');
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

// ===== 内容归属（issue #17） =====

describe('内容归属', () => {
  const 学习委员 = { id: 4, name: '学习委员', positions: '学习委员' };   // 只有 content:write
  const 团支书 = { id: 5, name: '团支书', positions: '团支书' };       // content:write + user:manage

  const 班长的通知 = {
    id: 5, title: '班长的通知', publisher: '班长', remind_people: null, created_by: 班长.id
  };

  const reqJson = (path, method, payload) => new Request('https://class.example' + path, {
    method,
    body: JSON.stringify(payload),
    headers: { 'Content-Type': 'application/json' }
  });

  it('拿不到归属时，user:manage 说话；是老内容就放宽', async () => {
    const viewer = (u) => loadViewer({ DB: fakeDb() }, u);

    assert.equal(canManageItem({ created_by: 班长.id }, await viewer(班长)), true);
    assert.equal(canManageItem({ created_by: 班长.id }, await viewer(学习委员)), false);
    assert.equal(canManageItem({ created_by: 班长.id }, await viewer(团支书)), true);
    // 迁移前的老内容（created_by 为空）：只有 user:manage 能管，不能谁都改不了
    assert.equal(canManageItem({ created_by: null }, await viewer(学习委员)), false);
    assert.equal(canManageItem({ created_by: null }, await viewer(团支书)), true);
  });

  /**
   * 表单的本意与通知 / 活动相同，只是字段名叫 creator_id（表单表建得更早）。
   * 这条判据要是漏认了 creator_id，创建者反而动不了自己的表单 —— 而 user:manage 的人
   * 却能管，正好是反的。所以两个字段名都钉一遍。
   */
  it('表单的 creator_id 与通知/活动的 created_by 是同一条判据', async () => {
    const viewer = (u) => loadViewer({ DB: fakeDb() }, u);

    assert.equal(canManageItem({ creator_id: 学习委员.id }, await viewer(学习委员)), true);
    assert.equal(canManageItem({ creator_id: 班长.id }, await viewer(学习委员)), false);
    assert.equal(canManageItem({ creator_id: 班长.id }, await viewer(班长)), true);
  });

  it('学习委员改班长发布的通知：403', async () => {
    const env = { DB: fakeDb({ notice: 班长的通知 }) };

    const res = await handleUpdateNotice(
      reqJson('/api/notices/5', 'PUT', { title: '被篡改' }), env, 学习委员, { id: '5' });

    assert.equal(res.status, 403);
    assert.equal((await res.json()).code, 'FORBIDDEN');
  });

  it('学习委员删班长发布的通知：403', async () => {
    const env = { DB: fakeDb({ notice: 班长的通知 }) };

    const res = await handleDeleteNotice(
      new Request('https://class.example/api/notices/5', { method: 'DELETE' }), env, 学习委员, { id: '5' });

    assert.equal(res.status, 403);
  });

  it('创建者本人能改，且 UPDATE 里不含 publisher', async () => {
    const db = fakeDb({ notice: 班长的通知 });

    const res = await handleUpdateNotice(
      reqJson('/api/notices/5', 'PUT', { title: '改好了' }), { DB: db }, 班长, { id: '5' });

    assert.equal(res.status, 200);
    const update = db.calls.find((c) => /UPDATE notices/i.test(c.sql));
    assert.ok(update, '应该发出 UPDATE notices');
    assert.equal(/publisher/i.test(update.sql), false);
    assert.deepEqual(update.args, ['改好了', 5]);
  });

  it('请求体里带 publisher / created_by 一律不生效', async () => {
    const db = fakeDb({ notice: 班长的通知 });

    const res = await handleUpdateNotice(
      reqJson('/api/notices/5', 'PUT', { title: 'T', publisher: '李鬼', created_by: 9 }),
      { DB: db }, 班长, { id: '5' });

    assert.equal(res.status, 200);
    const update = db.calls.find((c) => /UPDATE notices/i.test(c.sql));
    assert.equal(update.args.includes('李鬼'), false);
    assert.equal(update.args.includes(9), false);
  });

  it('活动同一条规则：别人发的改不了', async () => {
    const activity = { id: 7, title: '班长的活动', publisher: '班长', remind_people: null, created_by: 班长.id };
    const env = { DB: fakeDb({ activity }) };

    const res = await handleUpdateActivity(
      reqJson('/api/activities/7', 'PUT', { title: '被篡改' }), env, 学习委员, { id: '7' });

    assert.equal(res.status, 403);
  });

  it('发布时署名与归属都由服务端写，请求体里的同名字段被忽略', async () => {
    const db = fakeDb();

    const res = await handleCreateNotice(
      reqJson('/api/notices', 'POST', {
        title: 'T', content: 'C', publish_time: '2026-09-15 10:00', publisher: '李鬼', created_by: 9
      }),
      { DB: db }, 学习委员, {});

    assert.equal(res.status, 201);
    const insert = db.calls.find((c) => /INSERT INTO notices/i.test(c.sql));
    assert.ok(insert, '应该发出 INSERT INTO notices');
    // 参数顺序：title, content, publish_time, publisher, remind_people, source, expire_time, link, created_by
    assert.equal(insert.args[3], '学习委员');
    assert.equal(insert.args[insert.args.length - 1], 学习委员.id);
    assert.equal(insert.args.includes('李鬼'), false);
  });
});
