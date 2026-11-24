import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { handleCalendarFeed } from '../src/handlers/calendarHandler.js';
import { buildCalendar } from '../src/utils/ics.js';
import { createSqliteDb } from './helpers/sqlite.js';

// 北京时间 2026-09-30 00:30（周三）。窗口 past=0&future=20 → 2026-09-30 ~ 2026-10-21。
const NOW = new Date('2026-09-29T16:30:00Z');
const USER = { id: 1, student_id: '2026001', name: '小张', positions: '班长' };

/** 课表口径：firstDate 是第 1 周周一（2026-09-07），week = floor(距 firstDate 天数 / 7) + 1 */
const TIMETABLE = {
  firstDate: '2026-09-07',
  weekCount: 16,
  courses: [
    // 周三第 4、5 周有课；第 6、7 周（10-14、10-21）不在 weeks 里
    { name: '高等数学', room: 'A301', teacher: '王老师', weekday: 3, start: '08:00', end: '09:40', weeks: [1, 2, 3, 4, 5] },
    // 只有第 2 周上，窗口内不该出现
    { name: '只有第二周', room: 'B102', teacher: '李老师', weekday: 3, start: '14:00', end: '15:40', weeks: [2] },
    // 第 4 周周五（10-02）有课
    { name: '大学物理', room: 'C203', teacher: '赵老师', weekday: 5, start: '10:00', end: '11:40', weeks: [4] }
  ]
};

function setup(t, { timetable = TIMETABLE, api = null, token = 'internal-token' } = {}) {
  t.mock.timers.enable({ apis: ['Date'], now: NOW });
  const db = createSqliteDb(t);
  db.sqlite.prepare(
    'INSERT INTO users (id, student_id, name, password_hash, positions, auth_key) VALUES (?, ?, ?, ?, ?, ?)'
  ).run(USER.id, USER.student_id, USER.name, '测试摘要', USER.positions, 'calendar-test');

  const calls = [];
  const env = { DB: db };
  if (token !== null) env.INTERNAL_TOKEN = token;
  if (timetable !== null) {
    env.ACADEMIC_API = {
      fetch: async (url, init) => {
        calls.push({ url, init });
        if (api) return api(url, init);
        return new Response(JSON.stringify({ success: true, data: timetable }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' }
        });
      }
    };
  }
  return { db, env, calls };
}

const feedUrl = (query = '') =>
  `https://class.example/api/calendar.ics?key=calendar-test&past=0&future=20${query}`;

const feed = (env, query = '') => handleCalendarFeed(new Request(feedUrl(query)), env);

/** 拆出各 VEVENT 块，按 UID 建索引，避免整份 ICS 里跨块误匹配 */
function vevents(text) {
  const out = new Map();
  for (const chunk of text.split('BEGIN:VEVENT').slice(1)) {
    const block = chunk.split('END:VEVENT')[0];
    const uid = (block.match(/\r\nUID:([^\r\n]+)/) || [])[1];
    if (uid) out.set(uid, block);
  }
  return out;
}

function countEvents(text) {
  return text.split('BEGIN:VEVENT').length - 1;
}

describe('日历订阅补充课程', () => {
  it('按星期与周次展开每次课，UID 与描述符合约定', async (t) => {
    const { db, env } = setup(t);
    db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
    const response = await feed(env);
    assert.equal(response.status, 200);
    const text = await response.text();
    const events = vevents(text);

    const first = events.get('course-0-20260930@class.qxwkstudio.top');
    assert.ok(first, '第 4 周周三的课应进入日历');
    assert.match(first, /DTSTART:20260930T080000/);
    assert.match(first, /DTEND:20260930T094000/);
    assert.match(first, /SUMMARY:高等数学/);
    assert.match(first, /LOCATION:A301/);
    assert.match(first, /DESCRIPTION:.*教师：王老师/);
    assert.match(first, /DESCRIPTION:.*教室：A301/);
    assert.match(first, /第 4 周/);

    // 第 5 周周三（10-07）也在 weeks 里
    assert.ok(events.has('course-0-20261007@class.qxwkstudio.top'));
    // 第 6、7 周不在 weeks 里
    assert.equal(events.has('course-0-20261014@class.qxwkstudio.top'), false);
    assert.equal(events.has('course-0-20261021@class.qxwkstudio.top'), false);
    // 第 4 周周五的课
    assert.ok(events.has('course-2-20261002@class.qxwkstudio.top'));
    // 只有第 2 周上的课在窗口内不该出现
    assert.doesNotMatch(text, /只有第二周/);
    // 活动仍在（课程不会把活动挤掉）
    assert.match(text, /SUMMARY:班会/);
  });

  it('同一份窗口重复拉取 UID 保持一致', async (t) => {
    const { env } = setup(t);
    const first = vevents(await (await feed(env)).text());
    const second = vevents(await (await feed(env)).text());
    assert.deepEqual([...second.keys()].sort(), [...first.keys()].sort());
  });

  it('学期结束后（超过 weekCount）的课不进日历', async (t) => {
    const { env } = setup(t, { timetable: { ...TIMETABLE, weekCount: 4 } });
    const events = vevents(await (await feed(env)).text());
    assert.ok(events.has('course-0-20260930@class.qxwkstudio.top'));
    assert.equal(events.has('course-0-20261007@class.qxwkstudio.top'), false, '第 5 周已超出 weekCount=4');
  });

  it('向私有 Worker 取课表：头与路径正确，且不带 refresh', async (t) => {
    const { env, calls } = setup(t);
    await feed(env);
    assert.equal(calls.length, 1);
    const [{ url, init }] = calls;
    assert.equal(url, 'https://class.example/api/academic/timetable');
    assert.equal(init.method, 'GET');
    assert.equal(init.headers.get('X-Internal-Token'), 'internal-token');
    assert.equal(init.headers.get('X-User-Id'), '1');
    assert.equal(init.headers.get('X-Student-Id'), '2026001');
    assert.equal(url.includes('refresh'), false, '日历不能触发一次出网刷新');
  });

  it('管理员紧急停用教务后，日历不再请求课表，但其它内容照常', async (t) => {
    const { db, env, calls } = setup(t);
    db.sqlite.exec("INSERT INTO app_settings (key, value) VALUES ('academic_enabled', '0')");
    db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
    const response = await feed(env);
    assert.equal(response.status, 200);
    const text = await response.text();
    assert.equal(calls.length, 0, '停用后不应再读私有 Worker 的课表缓存');
    assert.doesNotMatch(text, /高等数学/);
    assert.match(text, /SUMMARY:班会/);
  });

  it('courses=0 时不请求课表，其余内容照常', async (t) => {
    const { db, env, calls } = setup(t);
    db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
    const text = await (await feed(env, '&courses=0')).text();
    assert.equal(calls.length, 0);
    assert.doesNotMatch(text, /高等数学/);
    assert.match(text, /SUMMARY:班会/);
  });

  for (const [label, api] of [
    ['上游返回失败', async () => new Response(JSON.stringify({ success: false, error: 'NOT_BOUND' }), { status: 400 })],
    ['上游不是 JSON', async () => new Response('<html>502</html>', { status: 502 })],
    ['绑定调用抛异常', async () => { throw new Error('binding down'); }]
  ]) {
    it(`${label}时降级为不含课程，返回 200 且活动不丢`, async (t) => {
      const { db, env } = setup(t, { api });
      db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
      const response = await feed(env);
      assert.equal(response.status, 200);
      const text = await response.text();
      assert.doesNotMatch(text, /高等数学/);
      assert.match(text, /SUMMARY:班会/);
    });
  }

  for (const [label, options] of [
    ['未配置 Service Binding', { timetable: null }],
    ['缺少内部令牌', { token: null }]
  ]) {
    it(`${label}时跳过课程，不报 500`, async (t) => {
      const { db, env } = setup(t, options);
      db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
      const response = await feed(env);
      assert.equal(response.status, 200);
      assert.match(await response.text(), /SUMMARY:班会/);
    });
  }
});

describe('日历订阅补充待办', () => {
  const insertTodo = (db, fields) => db.sqlite.prepare(
    `INSERT INTO todos (owner_id, title, description, due_at, status, tags, source, hidden)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`
  ).run(
    USER.id, fields.title, fields.description ?? null, fields.due_at,
    fields.status ?? 'open', fields.tags ?? null, fields.source ?? 'manual',
    fields.hidden ?? 0
  );

  it('本人 open 且截止时间在窗口内的待办成为事件，30 分钟窗口', async (t) => {
    const { db, env } = setup(t, { timetable: null });
    insertTodo(db, { title: '交作业', description: '第三章习题', due_at: '2026-10-02 18:00:00', tags: '["作业","数学"]' });
    const text = await (await feed(env)).text();
    const id = db.sqlite.prepare('SELECT id FROM todos WHERE title = ?').get('交作业').id;
    const block = vevents(text).get(`todo-${id}@class.qxwkstudio.top`);
    assert.ok(block, '待办应生成 UID 为 todo-<id>@ 的事件');
    assert.match(block, /SUMMARY:待办：交作业/);
    assert.match(block, /DTSTART:20261002T180000/);
    assert.match(block, /DTEND:20261002T183000/);
    assert.match(block, /DESCRIPTION:.*第三章习题/);
    assert.match(block, /标签：作业、数学/);
  });

  it('已完成、已隐藏、别人名下、窗口外的待办都不进日历', async (t) => {
    const { db, env } = setup(t, { timetable: null });
    insertTodo(db, { title: '已完成的事', due_at: '2026-10-02 18:00:00', status: 'done' });
    insertTodo(db, { title: '太远的事', due_at: '2030-01-01 18:00:00' });
    insertTodo(db, { title: '已收起的事', due_at: '2026-10-02 18:00:00', hidden: 1 });
    db.sqlite.prepare(
      'INSERT INTO users (id, student_id, name, password_hash, positions) VALUES (?, ?, ?, ?, ?)'
    ).run(2, '2026002', '小李', '测试摘要', '同学');
    db.sqlite.prepare(
      `INSERT INTO todos (owner_id, title, due_at) VALUES (2, '别人的待办', '2026-10-02 18:00:00')`
    ).run();
    const text = await (await feed(env)).text();
    assert.doesNotMatch(text, /已完成的事/);
    assert.doesNotMatch(text, /太远的事/);
    assert.doesNotMatch(text, /已收起的事/);
    assert.doesNotMatch(text, /别人的待办/);
  });

  it('todos=0 时不带出待办', async (t) => {
    const { db, env } = setup(t, { timetable: null });
    insertTodo(db, { title: '交作业', due_at: '2026-10-02 18:00:00' });
    const text = await (await feed(env, '&todos=0')).text();
    assert.doesNotMatch(text, /交作业/);
  });
});

describe('VALARM 的稳定标识', () => {
  it('提醒块带 UID 与 X-WR-ALARMUID，且保留触发语义', () => {
    const calendar = buildCalendar([
      { uid: 'activity-7@class.qxwkstudio.top', title: '班会', start: '2026-09-30 10:00:00', end: '2026-09-30 11:00:00' }
    ], '小张 - 班级助理', 30);
    const block = vevents(calendar).get('activity-7@class.qxwkstudio.top');
    assert.ok(block);
    assert.match(block, /\r\nBEGIN:VALARM/);
    assert.match(block, /UID:activity-7@class\.qxwkstudio\.top-alarm/);
    assert.match(block, /X-WR-ALARMUID:activity-7@class\.qxwkstudio\.top-alarm/);
    assert.match(block, /ACTION:DISPLAY/);
    assert.match(block, /TRIGGER:-PT30M/);
    // 提醒标识与事件标识不能是同一个（否则客户端会把 VALARM 当成重复事件）
    assert.doesNotMatch(block, /\r\nUID:activity-7@class\.qxwkstudio\.top\r\nX-WR-ALARMUID:activity-7@class\.qxwkstudio\.top\r\n/);
  });

  it('全天事件保留 PT9H 提醒', () => {
    const calendar = buildCalendar([
      { uid: 'notice-3@class.qxwkstudio.top', title: '通知：体检', start: '2026-10-01', end: '2026-10-02', allDay: true }
    ], '小张 - 班级助理', 30);
    const block = vevents(calendar).get('notice-3@class.qxwkstudio.top');
    assert.match(block, /DTSTART;VALUE=DATE:20261001/);
    assert.match(block, /UID:notice-3@class\.qxwkstudio\.top-alarm/);
    assert.match(block, /TRIGGER:PT9H/);
  });

  it('remind=0 时不产生 VALARM', async (t) => {
    const { db, env } = setup(t, { timetable: null });
    db.sqlite.exec("INSERT INTO activities (title, start_time, publisher) VALUES ('班会', '2026-09-30 10:00:00', '班长')");
    const text = await (await feed(env, '&remind=0')).text();
    assert.doesNotMatch(text, /BEGIN:VALARM/);
  });
});

describe('总事件上限', () => {
  it('活动与课程相加后仍不超过 200 条', async (t) => {
    const { db, env } = setup(t);
    const insert = db.sqlite.prepare('INSERT INTO activities (title, start_time, publisher) VALUES (?, ?, ?)');
    for (let i = 0; i < 150; i++) insert.run(`活动 ${i}`, '2026-10-01 12:00:00', '班长');
    const text = await (await feed(env)).text();
    assert.ok(countEvents(text) <= 200, `事件数 ${countEvents(text)} 超过 200`);
    assert.match(text, /高等数学/);
  });
});
