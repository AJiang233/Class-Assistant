import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { createSqliteDb } from './helpers/sqlite.js';
import { academicRoutes } from '../src/routes/academic.js';
import { settingRoutes } from '../src/routes/settings.js';
import { SettingModel } from '../src/models/settingModel.js';
import { sign } from '../src/utils/jwt.js';
import { hashPassword } from '../src/utils/crypto.js';

const SECRET = 'test-secret';
const STUDENT_ID = '2022103071';

async function seedUser(db, { id = 1, studentId = STUDENT_ID, positions = '学生', name = '测试' } = {}) {
  const { hash, salt } = await hashPassword('pw123456');
  db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash,positions)
    VALUES(${id},'${studentId}','${name}','${salt}:${hash}','${positions}')`);
}

async function tokenFor(id = 1, studentId = STUDENT_ID) {
  return sign({ id, student_id: studentId }, SECRET, 60);
}

async function authed(path, { method = 'GET', body, id = 1, studentId = STUDENT_ID } = {}) {
  const token = await tokenFor(id, studentId);
  return new Request('https://class.example' + path, {
    method,
    headers: { Authorization: `Bearer ${token}` },
    ...(body === undefined ? {} : { body: JSON.stringify(body) })
  });
}

/** 记录 binding.fetch 的假私有 Worker：断言「停用时根本不发请求」 */
function fakeBinding() {
  const calls = [];
  return {
    calls,
    async fetch(url, init) {
      calls.push({ url, init });
      return new Response(JSON.stringify({ success: true, data: { ok: true } }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' }
      });
    }
  };
}

function envOf(db, binding) {
  return { DB: db, JWT_SECRET: SECRET, ACADEMIC_API: binding, INTERNAL_TOKEN: 'internal-token' };
}

async function settingsOf(db, method, body, { id = 1, studentId = STUDENT_ID } = {}) {
  const binding = fakeBinding();
  const env = envOf(db, binding);
  const res = await settingRoutes(
    await authed('/api/admin/settings', { method, body, id, studentId }),
    env,
    {}
  );
  return { res, binding };
}

describe('全局功能开关（issue #106-A）', () => {
  it('没有配置记录时默认开启，并正常转发到私有 Worker', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const binding = fakeBinding();
    const res = await academicRoutes(
      await authed('/api/academic/status'),
      envOf(db, binding),
      {}
    );
    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1, '默认开启时应调用私有 Worker');
  });

  it('停用教务后直接 503 FEATURE_DISABLED，且不调用私有 Worker', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    await new SettingModel(db).set('academic', false);

    const binding = fakeBinding();
    const res = await academicRoutes(
      await authed('/api/academic/status'),
      envOf(db, binding),
      {}
    );
    const body = await res.json();
    assert.equal(res.status, 503);
    assert.equal(body.code, 'FEATURE_DISABLED');
    assert.equal(body.data.feature, 'academic');
    assert.equal(res.headers.get('Retry-After'), '30');
    assert.equal(binding.calls.length, 0, '停用是门户侧止血，不能再去打私有 Worker');
  });

  it('恢复开关立即生效，不用等 30 秒缓存过期', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    const model = new SettingModel(db);
    await model.set('academic', false);

    const first = await academicRoutes(await authed('/api/academic/status'), envOf(db, fakeBinding()), {});
    assert.equal(first.status, 503);

    await model.set('academic', true);
    const second = await academicRoutes(await authed('/api/academic/status'), envOf(db, fakeBinding()), {});
    assert.equal(second.status, 200, '写开关要清掉本 isolate 缓存');
  });

  it('读开关表失败时按开启处理（迁移没跑也不能把功能整体打死）', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    db.sqlite.exec('DROP TABLE app_settings');

    const binding = fakeBinding();
    const res = await academicRoutes(await authed('/api/academic/status'), envOf(db, binding), {});
    assert.equal(res.status, 200);
    assert.equal(binding.calls.length, 1);
    assert.equal(await new SettingModel(db).isEnabled('academic'), true);
  });

  it('未知 feature 不在开关管辖范围，按开启处理', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db);
    assert.equal(await new SettingModel(db).isEnabled('chaoxing'), true);
    assert.equal(await new SettingModel(db).isEnabled('other'), true);
  });

  it('普通成员读写开关都是 403，班长可读可写', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { id: 1, positions: '班长', name: '班长' });
    await seedUser(db, { id: 2, studentId: '2022103072', positions: '学生', name: '同学' });

    const student = await settingsOf(db, 'GET', undefined, { id: 2, studentId: '2022103072' });
    assert.equal(student.res.status, 403);
    const studentWrite = await settingsOf(db, 'PUT', { academic: false }, { id: 2, studentId: '2022103072' });
    assert.equal(studentWrite.res.status, 403);

    const read = await settingsOf(db, 'GET');
    assert.equal(read.res.status, 200);
    const readBody = await read.res.json();
    assert.equal(readBody.data.academic, true);
    assert.equal(readBody.data.chaoxing, true);
    assert.equal(readBody.data.chaoxing_available, false, '门户还没接学习通路由，要如实告诉前端');

    const write = await settingsOf(db, 'PUT', { academic: false });
    assert.equal(write.res.status, 200);
    const writeBody = await write.res.json();
    assert.equal(writeBody.data.settings.academic, false);
    assert.equal(await new SettingModel(db).isEnabled('academic'), false);

    const log = db.sqlite.prepare("SELECT * FROM audit_logs WHERE action='settings_updated'").get();
    assert.ok(log, '改开关必须写审计');
    assert.equal(log.actor_id, 1);
    assert.equal(log.target_type, 'settings');
    assert.equal(JSON.parse(log.detail).changed.academic, false);
  });

  it('学习通开关先保存不报错（等门户路由接上即生效）', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { positions: '班长' });
    const { res } = await settingsOf(db, 'PUT', { chaoxing: false });
    assert.equal(res.status, 200);
    const row = db.sqlite.prepare("SELECT value FROM app_settings WHERE key='chaoxing_enabled'").get();
    assert.equal(row.value, '0');
    assert.equal(await new SettingModel(db).isEnabled('chaoxing'), false);
  });

  it('非法开关值一律 400，不会把字符串 "false" 当成关闭', async (t) => {
    const db = createSqliteDb(t);
    await seedUser(db, { positions: '班长' });
    const bad = await settingsOf(db, 'PUT', { academic: 'false' });
    assert.equal(bad.res.status, 400);
    assert.equal((await bad.res.json()).code, 'INVALID_SETTINGS');

    const empty = await settingsOf(db, 'PUT', {});
    assert.equal(empty.res.status, 400);
    assert.equal((await empty.res.json()).code, 'MISSING_FIELDS');
  });
});
