import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import worker from '../src/index.js';
import { createSqliteDb } from './helpers/sqlite.js';
import { hashPassword } from '../src/utils/crypto.js';
import { sign } from '../src/utils/jwt.js';
import { formatLocalDateTime } from '../src/utils/datetime.js';

/**
 * issue #99 待办功能的后端契约测试。
 *
 * 走完整 worker 路由（真实 JWT + 权限中间件），只把 D1 换成内存 SQLite；
 * 时间统一用北京时间的本地字符串，和线上写库口径一致。
 */

const SECRET = 'test-secret';

async function seedUser(db, { id = 1, studentId = '2022103071', positions = '学生', name = '张三' } = {}) {
  const { hash, salt } = await hashPassword('pw123456');
  db.sqlite
    .prepare('INSERT INTO users(id,student_id,name,password_hash,positions) VALUES(?,?,?,?,?)')
    .run(id, studentId, name, `${salt}:${hash}`, positions);
  return { id, studentId };
}

async function tokenFor(id, studentId) {
  return sign({ id, student_id: studentId }, SECRET, 60);
}

async function call(env, path, { method = 'GET', body, token } = {}) {
  // token 既可以传字符串，也可以传 sign() 返回的 Promise（避免每处都写 await）
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

function future(hours = 48) {
  return formatLocalDateTime(Date.now() + hours * 3600 * 1000);
}

function past(hours = 1) {
  return formatLocalDateTime(Date.now() - hours * 3600 * 1000);
}

describe('待办：新建 / 列表 / 完成 / 删除', () => {
  it('新建后按截止时间升序；完成后进历史；标签去重', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };

    const later = await call(env, '/api/todos', {
      method: 'POST',
      body: { title: '晚一点', due_at: future(72), tags: ['作业', '考试', '作业'] }
    });
    assert.equal(later.status, 201);
    assert.deepEqual(later.data.todo.tags, ['作业', '考试'], '重复标签只留一个');
    assert.equal(later.data.todo.status, 'open');
    assert.equal(later.data.todo.source, 'manual');

    const sooner = await call(env, '/api/todos', {
      method: 'POST',
      body: { title: '先做的', due_at: future(24), description: '说明', start_at: future(1) }
    });
    assert.equal(sooner.status, 201);

    let res = await call(env, '/api/todos');
    assert.equal(res.status, 200);
    assert.deepEqual(res.data.list.map((x) => x.title), ['先做的', '晚一点'], '进行中按截止时间升序');
    assert.equal(res.data.counts.open, 2);
    assert.equal(res.data.counts.history, 0);
    assert.equal(res.data.prefs.urgent_hours, 24);
    assert.equal(res.data.prefs.warn_hours, 36);

    // 完成靠前的这条：completed_at 要写、状态变 done
    res = await call(env, `/api/todos/${sooner.data.todo.id}/status`, { method: 'POST', body: { status: 'done' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.todo.status, 'done');
    assert.ok(res.data.todo.completed_at);

    res = await call(env, '/api/todos?status=history');
    assert.deepEqual(res.data.list.map((x) => x.title), ['先做的']);
    assert.equal(res.data.counts.open, 1);
    assert.equal(res.data.counts.history, 1);

    // 再打开：completed_at 清空
    res = await call(env, `/api/todos/${sooner.data.todo.id}/status`, { method: 'POST', body: { status: 'open' } });
    assert.equal(res.status, 200);
    assert.equal(res.data.todo.status, 'open');
    assert.equal(res.data.todo.completed_at, null);

    // 删除
    res = await call(env, `/api/todos/${later.data.todo.id}`, { method: 'DELETE' });
    assert.equal(res.status, 200);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM todos').get().n, 1);
  });

  it('校验：标题必填、截止时间必须晚于现在、标签数量与长度上限', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };

    const noTitle = await call(env, '/api/todos', { method: 'POST', body: { due_at: future() } });
    assert.equal(noTitle.status, 400);
    assert.equal(noTitle.body.code, 'INVALID_TODO_TITLE');

    const noDue = await call(env, '/api/todos', { method: 'POST', body: { title: '没有截止' } });
    assert.equal(noDue.status, 400);
    assert.equal(noDue.body.code, 'INVALID_TODO_TIME');

    const pastDue = await call(env, '/api/todos', { method: 'POST', body: { title: '已经晚了', due_at: past() } });
    assert.equal(pastDue.status, 400);
    assert.equal(pastDue.body.code, 'TODO_DUE_PAST');

    const badRange = await call(env, '/api/todos', {
      method: 'POST',
      body: { title: '倒着来', start_at: future(10), due_at: future(5) }
    });
    assert.equal(badRange.status, 400);
    assert.equal(badRange.body.code, 'INVALID_TODO_TIME');

    const tooManyTags = await call(env, '/api/todos', {
      method: 'POST',
      body: { title: '标签太多', due_at: future(), tags: ['a', 'b', 'c', 'd', 'e'] }
    });
    assert.equal(tooManyTags.status, 400);
    assert.equal(tooManyTags.body.code, 'INVALID_TODO_TAGS');

    const longTag = await call(env, '/api/todos', {
      method: 'POST',
      body: { title: '标签太长', due_at: future(), tags: ['一二三四五六七八九十十一十二'] }
    });
    assert.equal(longTag.status, 400);
    assert.equal(longTag.body.code, 'INVALID_TODO_TAGS');

    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM todos').get().n, 0, '校验失败不能落库');
  });

  it('懒过期：过了截止时间的进行中待办在查询时变超时，之后不能再完成', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };
    db.sqlite.prepare(
      "INSERT INTO todos(owner_id,title,due_at,status) VALUES(1,'拖过头了',?,'open')"
    ).run(past(2));

    const res = await call(env, '/api/todos');
    assert.equal(res.status, 200);
    assert.equal(res.data.counts.open, 0);
    assert.equal(res.data.counts.overdue, 1, '超时要计入历史');
    assert.equal(res.data.counts.history, 1);

    const history = await call(env, '/api/todos?status=history');
    assert.equal(history.data.list[0].status, 'expired');
    assert.equal(history.data.list[0].urgency, 'overdue');

    const done = await call(env, '/api/todos/1/status', { method: 'POST', body: { status: 'done' } });
    assert.equal(done.status, 400);
    assert.equal(done.body.code, 'TODO_EXPIRED');

    const edit = await call(env, '/api/todos/1', { method: 'PUT', body: { title: '改个名' } });
    assert.equal(edit.status, 400);
    assert.equal(edit.body.code, 'TODO_LOCKED');
  });

  it('只能看和改自己的待办：别人的改、删、完成都是 403', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, name: '张三' });
    await seedUser(db, { id: 2, studentId: '2022103072', name: '李四' });
    const env = { DB: db, JWT_SECRET: SECRET };

    const created = await call(env, '/api/todos', { method: 'POST', body: { title: '张三的', due_at: future() } });
    const id = created.data.todo.id;
    const asLi = await tokenFor(2, '2022103072');

    const list = await call(env, '/api/todos', { token: asLi });
    assert.equal(list.data.list.length, 0);
    assert.equal(list.data.counts.open, 0);

    for (const [method, path, body] of [
      ['PUT', `/api/todos/${id}`, { title: '偷改' }],
      ['DELETE', `/api/todos/${id}`, undefined],
      ['POST', `/api/todos/${id}/status`, { status: 'done' }]
    ]) {
      const res = await call(env, path, { method, body, token: asLi });
      assert.equal(res.status, 403, `${method} ${path}`);
    }
    assert.equal(db.sqlite.prepare("SELECT status FROM todos WHERE id=?").get(id).status, 'open');
  });
});

describe('待办：班委代加与撤回', () => {
  it('一次给多人加；学生只看得到自己的；代加人只能撤回未完成的', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, studentId: '2022103001', positions: '班长', name: '班长' });
    await seedUser(db, { id: 2, studentId: '2022103002', name: '李四' });
    await seedUser(db, { id: 3, studentId: '2022103003', name: '王五' });
    const env = { DB: db, JWT_SECRET: SECRET };
    const officer = await tokenFor(1, '2022103001');

    const delegated = await call(env, '/api/todos/delegate', {
      method: 'POST',
      token: officer,
      body: { user_ids: [2, 3, 2], title: '交班会材料', due_at: future(30), tags: ['材料'] }
    });
    assert.equal(delegated.status, 201);
    assert.equal(delegated.data.created, 2, '重复 id 要去重');
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM todos').get().n, 2);

    const li = await call(env, '/api/todos', { token: tokenFor(2, '2022103002') });
    assert.equal(li.data.list.length, 1);
    assert.equal(li.data.list[0].created_by_name, '班长');

    // 学生没权限代加
    const forbidden = await call(env, '/api/todos/delegate', {
      method: 'POST',
      token: tokenFor(2, '2022103002'),
      body: { user_ids: [3], title: '越权', due_at: future() }
    });
    assert.equal(forbidden.status, 403);

    // 不存在的成员要整批拒绝，不能只加成功一半
    const missing = await call(env, '/api/todos/delegate', {
      method: 'POST',
      token: officer,
      body: { user_ids: [2, 999], title: '有幽灵', due_at: future() }
    });
    assert.equal(missing.status, 400);
    assert.equal(missing.body.code, 'INVALID_MEMBERS');
    assert.equal(db.sqlite.prepare("SELECT count(*) AS n FROM todos WHERE title='有幽灵'").get().n, 0);

    // 李四把自己的完成掉，班长就不能撤回了
    const liTodoId = li.data.list[0].id;
    await call(env, `/api/todos/${liTodoId}/status`, {
      method: 'POST', token: tokenFor(2, '2022103002'), body: { status: 'done' }
    });
    const cannotWithdraw = await call(env, `/api/todos/${liTodoId}`, { method: 'DELETE', token: officer });
    assert.equal(cannotWithdraw.status, 403);

    // 王五还没完成，班长可以撤回
    const wang = await call(env, '/api/todos', { token: tokenFor(3, '2022103003') });
    const withdraw = await call(env, `/api/todos/${wang.data.list[0].id}`, { method: 'DELETE', token: officer });
    assert.equal(withdraw.status, 200);
    assert.equal((await call(env, '/api/todos', { token: tokenFor(3, '2022103003') })).data.list.length, 0);
  });
});

describe('待办：通知/活动附带的一键加入', () => {
  it('发布时带 todo、详情回传、加入一次后再加是 duplicate、删通知清掉模板', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, studentId: '2022103001', positions: '班长', name: '班长' });
    await seedUser(db, { id: 2, studentId: '2022103002', name: '李四' });
    const env = { DB: db, JWT_SECRET: SECRET };
    const officer = await tokenFor(1, '2022103001');
    const li = await tokenFor(2, '2022103002');

    const created = await call(env, '/api/notices', {
      method: 'POST',
      token: officer,
      body: {
        title: '提交实验报告',
        content: '本周五前交',
        publish_time: '2026-11-23 08:00:00',
        todo: { title: '交实验报告', due_at: future(48), tags: ['作业'] }
      }
    });
    assert.equal(created.status, 201);
    assert.equal(created.data.todo_saved, true);
    const noticeId = db.sqlite.prepare('SELECT id FROM notices ORDER BY id DESC').get().id;
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM content_todos').get().n, 1);

    const detail = await call(env, `/api/notices/${noticeId}`, { token: li });
    assert.equal(detail.status, 200);
    assert.equal(detail.data.todo.title, '交实验报告');
    assert.deepEqual(detail.data.todo.tags, ['作业']);
    assert.equal(detail.data.todo.joined, false);

    const joined = await call(env, '/api/todos/from-source', {
      method: 'POST', token: li, body: { kind: 'notice', id: noticeId }
    });
    assert.equal(joined.status, 201);
    assert.equal(joined.data.todo.source, 'notice');
    assert.equal(joined.data.todo.source_id, noticeId);
    assert.equal(joined.data.todo.status, 'open');

    const dup = await call(env, '/api/todos/from-source', {
      method: 'POST', token: li, body: { kind: 'notice', id: noticeId }
    });
    assert.equal(dup.status, 200);
    assert.equal(dup.data.duplicate, true);
    assert.equal((await call(env, '/api/todos', { token: li })).data.list.length, 1);

    const detailAfter = await call(env, `/api/notices/${noticeId}`, { token: li });
    assert.equal(detailAfter.data.todo.joined, true);

    // 删通知：触发器要连带删掉待办模板，之后再加入是 404
    const removed = await call(env, `/api/notices/${noticeId}`, { method: 'DELETE', token: officer });
    assert.equal(removed.status, 200);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM content_todos').get().n, 0);
    const gone = await call(env, '/api/todos/from-source', {
      method: 'POST', token: li, body: { kind: 'notice', id: noticeId }
    });
    assert.equal(gone.status, 404);
    assert.equal(gone.body.code, 'SOURCE_TODO_NOT_FOUND');
  });

  it('附带待办的截止时间不合法时整条通知都不发布', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, studentId: '2022103001', positions: '班长', name: '班长' });
    const env = { DB: db, JWT_SECRET: SECRET };

    const res = await call(env, '/api/notices', {
      method: 'POST',
      token: tokenFor(1, '2022103001'),
      body: {
        title: '不该发出去',
        content: '内容',
        publish_time: '2026-11-23 08:00:00',
        todo: { title: '已经过期', due_at: past(2) }
      }
    });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'TODO_DUE_PAST');
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM notices').get().n, 0);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM content_todos').get().n, 0);
  });
});

describe('待办：学习通作业 / 考试自动同步', () => {
  /** 假的私有学习通 Worker：按路径返回课程 / 作业 / 考试，状态由外层 state 控制。 */
  function chaoxingFetch(state) {
    return async (url) => {
      const path = new URL(url).pathname;
      let data;
      if (path === '/api/chaoxing/courses') {
        data = { courses: [{ courseId: '101', clazzId: 'c1', name: '高等数学', teacher: '王老师' }] };
      } else if (path === '/api/chaoxing/exams') {
        const start = formatLocalDateTime(Date.now() + 24 * 3600 * 1000);
        const end = formatLocalDateTime(Date.now() + 48 * 3600 * 1000);
        data = {
          items: [{
            examId: 'e1', courseId: '101', courseName: '高等数学', title: '期末考试',
            status: state.examStatus, time: `${start} 至 ${end}`, url: 'https://mooc.example/e1'
          }]
        };
      } else if (path === '/api/chaoxing/works') {
        const items = [{
          workId: 'w1', title: '第三章作业', status: state.workStatus,
          deadline: '剩余 47 小时 0 分钟', url: 'https://mooc.example/w1'
        }];
        // 新私有 API 会给未交作业补绝对截止时间；这里按需造第二条验证优先级
        if (state.deadlineAt) {
          items.push({
            workId: 'w2', title: '第四章作业', status: '未交',
            deadline: '', deadlineAt: state.deadlineAt, url: 'https://mooc.example/w2'
          });
        }
        // 详情页也没解析出截止时间的作业：不能静默丢掉，要计数提示
        if (state.noDeadline) {
          items.push({
            workId: 'w3', title: '没有截止的作业', status: '未交',
            deadline: '', url: 'https://mooc.example/w3'
          });
        }
        data = { courseId: '101', courseName: '高等数学', items };
      } else {
        return new Response(JSON.stringify({ success: false, error: '未知接口', code: 'NOT_FOUND' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
  }

  function bindChaoxing(db) {
    db.sqlite.prepare(
      "INSERT INTO user_consents(user_id,version,terms,chaoxing,academic) VALUES(1,'v1',1,1,0)"
    ).run();
  }

  it('新建、去重、完成后并进历史、隐藏与取消隐藏、60 秒冷却', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindChaoxing(db);
    const state = { workStatus: '未交', examStatus: '未交' };
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      CHAOXING_API: { fetch: chaoxingFetch(state) }
    };

    // 第一批：课程 1 门 → 作业 + 考试各一条
    let res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0, batch: 8 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.bound, true);
    assert.equal(res.data.done, true);
    assert.equal(res.data.created, 2);
    assert.equal(res.data.total_courses, 1);

    let list = await call(env, '/api/todos');
    assert.deepEqual(
      list.data.list.map((x) => x.title).sort(),
      ['[高等数学] 第三章作业', '[高等数学] 期末考试'].sort()
    );
    assert.equal(list.data.list[0].source, 'academic');
    assert.equal(list.data.sync.synced_today, true);
    assert.ok(list.data.sync.last_synced_at);
    assert.ok(db.sqlite.prepare('SELECT external_id FROM todos ORDER BY id').all()
      .every((row) => /^(work|exam):/.test(row.external_id)));

    // 同一天再拉一次：external_id 去重，不能重复建
    db.sqlite.prepare('UPDATE todo_sync_state SET last_attempt_at = ?').run(past(2));
    res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0, batch: 8 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 0);
    assert.equal(res.data.updated, 2);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM todos').get().n, 2);

    // 学习通显示已交 / 已考：本地进行中的两条自动并进历史
    state.workStatus = '已交';
    state.examStatus = '已考';
    db.sqlite.prepare('UPDATE todo_sync_state SET last_attempt_at = ?').run(past(2));
    res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0, batch: 8 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.completed, 2);

    const history = await call(env, '/api/todos?status=history');
    assert.equal(history.status, 200);
    assert.equal(history.data.list.length, 2);
    assert.ok(history.data.list.every((x) => x.status === 'done'));
    assert.equal(history.data.counts.history, 2);

    // 隐藏一条：历史列表少一条，隐藏视图能看到，计数单独给出
    const hideId = history.data.list[0].id;
    const hide = await call(env, `/api/todos/${hideId}/hide`, { method: 'POST', body: { hidden: true } });
    assert.equal(hide.status, 200);
    assert.equal(hide.data.hidden, true);

    const visible = await call(env, '/api/todos?status=history');
    assert.equal(visible.data.list.length, 1);
    assert.equal(visible.data.counts.history, 1);
    assert.equal(visible.data.counts.hidden, 1);

    const hidden = await call(env, '/api/todos?status=history&hidden=1');
    assert.equal(hidden.data.list.length, 1);
    assert.equal(hidden.data.list[0].id, hideId);

    const unhide = await call(env, `/api/todos/${hideId}/hide`, { method: 'POST', body: { hidden: false } });
    assert.equal(unhide.status, 200);
    assert.equal((await call(env, '/api/todos?status=history')).data.list.length, 2);

    // 刚跑完一轮，60 秒内再点同步要被服务端拦住
    const cooled = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(cooled.status, 429);
    assert.equal(cooled.body.code, 'SYNC_COOLDOWN');
    assert.ok(cooled.body.data.retry_after > 0);
  });

  it('作业优先用详情页的绝对截止时间；「待提交」也算未交', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindChaoxing(db);
    const due = formatLocalDateTime(Date.now() + 72 * 3600 * 1000);
    const state = { workStatus: '待提交', examStatus: '未交', deadlineAt: due };
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      CHAOXING_API: { fetch: chaoxingFetch(state) }
    };

    const res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 3);

    const rows = db.sqlite.prepare(
      'SELECT external_id,status,due_at FROM todos ORDER BY external_id'
    ).all();
    const w2 = rows.find((row) => row.external_id === 'work:w2');
    assert.ok(w2, '带 deadlineAt 的作业要建出来');
    assert.equal(w2.due_at, due, 'due_at 必须原样采用 deadlineAt');
    assert.equal(w2.status, 'open');

    const w1 = rows.find((row) => row.external_id === 'work:w1');
    assert.ok(w1, '待提交状态不能被当成已完成');
  });

  it('作业没有截止时间时跳过并明确提示，不静默吞掉', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindChaoxing(db);
    const state = { workStatus: '未交', examStatus: '未交', noDeadline: true };
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      CHAOXING_API: { fetch: chaoxingFetch(state) }
    };

    const res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.no_deadline, 1);
    assert.match(res.data.message, /没有截止时间/);
    assert.equal(
      db.sqlite.prepare("SELECT count(*) AS n FROM todos WHERE external_id='work:w3'").get().n,
      0
    );
  });

  it('已截止但没交的作业也进历史，不能假装没抓到', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindChaoxing(db);
    const pastDue = formatLocalDateTime(Date.now() - 3600 * 1000);
    const state = { workStatus: '未交', examStatus: '未交', deadlineAt: pastDue };
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      CHAOXING_API: { fetch: chaoxingFetch(state) }
    };

    const res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 3);
    const row = db.sqlite.prepare(
      "SELECT status,due_at FROM todos WHERE external_id='work:w2'"
    ).get();
    assert.equal(row.status, 'expired');
    assert.equal(row.due_at, pastDue);

    const history = await call(env, '/api/todos?status=history');
    assert.ok(history.data.list.some((x) => x.external_id === 'work:w2'));
  });

  it('未同意返回 403；未绑定返回 bound=false；只有学业历史待办能隐藏', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, name: '张三' });
    await seedUser(db, { id: 2, studentId: '2022103072', name: '李四' });
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      CHAOXING_API: {
        fetch: async () => new Response(JSON.stringify({
          success: false, error: '还没绑定学习通', code: 'NOT_BOUND'
        }), { status: 400, headers: { 'Content-Type': 'application/json' } })
      }
    };

    let res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'CHAOXING_CONSENT_REQUIRED');

    bindChaoxing(db);
    res = await call(env, '/api/todos/sync-chaoxing', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.bound, false);
    assert.equal(res.data.done, true);

    // 手动待办不能隐藏
    const manual = await call(env, '/api/todos', { method: 'POST', body: { title: '自己的事', due_at: future() } });
    const manualHide = await call(env, `/api/todos/${manual.data.todo.id}/hide`, {
      method: 'POST', body: { hidden: true }
    });
    assert.equal(manualHide.status, 400);
    assert.equal(manualHide.body.code, 'TODO_NOT_HIDEABLE');

    // 别人的学业历史待办也不能隐藏
    db.sqlite.prepare(
      `INSERT INTO todos(owner_id,title,due_at,status,source,external_id)
       VALUES(2,'李四的作业',?,'done','academic','work:other')`
    ).run(past(1));
    const otherId = db.sqlite.prepare("SELECT id FROM todos WHERE owner_id=2").get().id;
    const otherHide = await call(env, `/api/todos/${otherId}/hide`, { method: 'POST', body: { hidden: true } });
    assert.equal(otherHide.status, 403);
  });
});

describe('待办：每人自定义红黄阈值', () => {
  it('默认 24/36；改阈值后同一个待办的紧急度跟着变', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const env = { DB: db, JWT_SECRET: SECRET };

    const defaults = await call(env, '/api/todos/prefs');
    assert.equal(defaults.status, 200);
    assert.deepEqual(defaults.data.prefs, { urgent_hours: 24, warn_hours: 36 });

    const saved = await call(env, '/api/todos/prefs', {
      method: 'PUT',
      body: { urgent_hours: 2, warn_hours: 5 }
    });
    assert.equal(saved.status, 200);
    assert.deepEqual(saved.data.prefs, { urgent_hours: 2, warn_hours: 5 });

    // 4 小时后截止：阈值 2/5 → 黄
    const created = await call(env, '/api/todos', { method: 'POST', body: { title: '快到了', due_at: future(4) } });
    const id = created.data.todo.id;
    assert.equal(created.data.todo.urgency, 'warn');

    // 阈值改成 6/9 → 4 小时进入红色区间
    await call(env, '/api/todos/prefs', { method: 'PUT', body: { urgent_hours: 6, warn_hours: 9 } });
    const relisted = await call(env, '/api/todos');
    const row = relisted.data.list.find((x) => x.id === id);
    assert.equal(row.urgency, 'urgent');
    assert.deepEqual(relisted.data.prefs, { urgent_hours: 6, warn_hours: 9 });

    for (const bad of [
      { urgent_hours: 0, warn_hours: 10 },
      { urgent_hours: 10, warn_hours: 10 },
      { urgent_hours: 3, warn_hours: 2 },
      { urgent_hours: 1.5, warn_hours: 10 },
      { urgent_hours: '2', warn_hours: 10 }
    ]) {
      const res = await call(env, '/api/todos/prefs', { method: 'PUT', body: bad });
      assert.equal(res.status, 400, JSON.stringify(bad));
      assert.equal(res.body.code, 'INVALID_PREFS');
    }
  });
});

describe('待办：中国大学MOOC 作业 / 测验自动同步', () => {
  /** 假的私有 MOOC Worker：课程 1 门，作业 1 条 + 测验 1 条，状态由 state 控制。 */
  function moocFetch(state) {
    return async (url) => {
      const path = new URL(url).pathname;
      const iso = (hours) => new Date(Date.now() + hours * 3600 * 1000).toISOString();
      let data;
      if (path === '/api/mooc/courses') {
        data = { courses: [{ courseId: '1001752041', name: '植物学' }] };
      } else if (path === '/api/mooc/works') {
        data = {
          courseId: '1001752041',
          courseName: '植物学',
          items: [{
            testId: '9001', kind: 'homework', name: '绪论作业', chapterName: '第一章 绪论',
            releaseTime: iso(-48), deadline: iso(48), userScore: state.homeScore
          }]
        };
      } else if (path === '/api/mooc/exams') {
        data = {
          courseId: '1001752041',
          courseName: '植物学',
          items: [{
            testId: '9002', kind: 'quiz', name: '绪论测验', chapterName: '第一章 绪论',
            releaseTime: iso(-48), deadline: iso(24), usedTryCount: state.tryCount
          }]
        };
      } else {
        return new Response(JSON.stringify({ success: false, error: '未知接口', code: 'NOT_FOUND' }), {
          status: 404, headers: { 'Content-Type': 'application/json' }
        });
      }
      return new Response(JSON.stringify({ success: true, data }), {
        status: 200, headers: { 'Content-Type': 'application/json' }
      });
    };
  }

  function bindMooc(db, mooc = 1) {
    db.sqlite.prepare(
      "INSERT INTO user_consents(user_id,version,terms,chaoxing,academic,mooc) VALUES(1,'v1',1,0,0,?)"
    ).run(mooc);
  }

  it('新建、去重、测验作答后并进历史、缺授权时拦截', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindMooc(db);
    const state = { homeScore: null, tryCount: 0 };
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      MOOC_API: { fetch: moocFetch(state) }
    };

    let res = await call(env, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0, batch: 4 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.bound, true);
    assert.equal(res.data.done, true);
    assert.equal(res.data.created, 2);
    assert.equal(res.data.total_courses, 1);

    const list = await call(env, '/api/todos');
    assert.deepEqual(
      list.data.list.map((x) => x.title).sort(),
      ['[植物学] 单元作业：绪论作业', '[植物学] 单元测验：绪论测验'].sort()
    );
    assert.ok(db.sqlite.prepare('SELECT external_id FROM todos ORDER BY id').all()
      .every((row) => /^mooc:/.test(row.external_id)));

    // 同日再同步：external_id 去重，只刷新
    db.sqlite.prepare('UPDATE todo_sync_state SET last_attempt_at = ?').run(past(2));
    res = await call(env, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.created, 0);
    assert.equal(res.data.updated, 2);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM todos').get().n, 2);

    // 测验已作答：本地进行中的那条并进历史
    state.tryCount = 1;
    db.sqlite.prepare('UPDATE todo_sync_state SET last_attempt_at = ?').run(past(2));
    res = await call(env, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.completed, 1);
    const history = await call(env, '/api/todos?status=history');
    assert.deepEqual(history.data.list.map((x) => x.title), ['[植物学] 单元测验：绪论测验']);

    // 撤掉 MOOC 授权：同步被 403 拦住，且不调上游
    db.sqlite.prepare('UPDATE user_consents SET mooc = 0').run();
    let calls = 0;
    const guardedEnv = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      MOOC_API: { fetch: async (url, init) => { calls += 1; return moocFetch(state)(url, init); } }
    };
    res = await call(guardedEnv, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 403);
    assert.equal(res.body.code, 'MOOC_CONSENT_REQUIRED');
    assert.equal(calls, 0);
  });

  it('会话失效时不逐门重试，直接给出错误码', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindMooc(db);
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      MOOC_API: {
        fetch: async (url) => {
          if (new URL(url).pathname === '/api/mooc/courses') {
            return new Response(JSON.stringify({ success: false, error: '会话已过期', code: 'MOOC_EXPIRED' }), {
              status: 400, headers: { 'Content-Type': 'application/json' }
            });
          }
          throw new Error('不应该继续请求上游');
        }
      }
    };
    const res = await call(env, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 400);
    assert.equal(res.body.code, 'MOOC_EXPIRED');
  });

  it('未绑定时返回 NOT_BOUND 且文案是 MOOC，不是学习通', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    bindMooc(db);
    const env = {
      DB: db, JWT_SECRET: SECRET, INTERNAL_TOKEN: 'internal',
      MOOC_API: {
        fetch: async () => new Response(
          JSON.stringify({ success: false, error: '还没绑定中国大学MOOC', code: 'NOT_BOUND' }),
          { status: 400, headers: { 'Content-Type': 'application/json' } }
        )
      }
    };
    const res = await call(env, '/api/todos/sync-mooc', { method: 'POST', body: { cursor: 0 } });
    assert.equal(res.status, 200);
    assert.equal(res.data.bound, false);
    assert.equal(res.data.done, true);
    assert.match(res.data.message, /中国大学MOOC/);
    assert.doesNotMatch(res.data.message, /学习通/);
  });
});
