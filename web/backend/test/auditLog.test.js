import assert from 'node:assert/strict';
import { describe, it } from 'node:test';

import { createSqliteDb } from './helpers/sqlite.js';
import { authRoutes } from '../src/routes/auth.js';
import {
  handleCreateRole,
  handleDeleteRole,
  handleDeleteUser,
  handleUpdateUser
} from '../src/handlers/authHandler.js';
import { handleListAuditLogs } from '../src/handlers/auditHandler.js';
import { AUDIT_RETENTION_DAYS, AuditLogModel } from '../src/models/auditLogModel.js';
import { hashPassword } from '../src/utils/crypto.js';
import { sign } from '../src/utils/jwt.js';

/**
 * 管理操作审计日志（issue #108）。
 *
 * 覆盖的验收项：
 * - 重置密码 / 改邮箱 / 改资料 / 删成员 / 新建职位 / 改职位 / 删职位各写一条；
 * - detail 里没有密码、邮箱明文；删成员后日志仍能读出目标姓名与学号（快照，无外键）；
 * - 写日志失败（触发器强行 ABORT）不影响主操作返回成功；
 * - 普通成员访问 /api/auth/audit-logs 是 403，班长可以读；
 * - 筛选、分页与 180 天保留期清理。
 */

const SECRET = 'test-secret';
const ADMIN = { id: 1, name: '班长', student_id: '2022103071' };
const MEMBER = { id: 2, name: '同学', student_id: '2022103072' };
const IP = '203.0.113.9';

async function seedDb(t) {
  const db = createSqliteDb(t);
  const { hash, salt } = await hashPassword('pw123456');
  db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash,positions)
    VALUES (1,'2022103071','班长','${salt}:${hash}','班长')`);
  db.sqlite.exec(`INSERT INTO users(id,student_id,name,password_hash,positions)
    VALUES (2,'2022103072','同学','${salt}:${hash}','学生')`);
  return db;
}

function request(path, { method = 'GET', body, token, ip = IP } = {}) {
  const headers = { 'Content-Type': 'application/json', 'CF-Connecting-IP': ip, 'User-Agent': 'audit-test' };
  if (token) headers.Authorization = `Bearer ${token}`;
  return new Request('https://class.example' + path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body)
  });
}

function readLogs(db) {
  return db.sqlite.prepare('SELECT * FROM audit_logs ORDER BY id ASC').all();
}

async function tokenFor(account) {
  return sign({ id: account.id, student_id: account.student_id }, SECRET, 60);
}

describe('审计日志：成员管理', () => {
  it('删除成员写 member_deleted，目标姓名/学号是快照，删完仍可读', async (t) => {
    const db = await seedDb(t);
    const res = await handleDeleteUser(
      request('/api/auth/users/2', { method: 'DELETE' }),
      { DB: db, JWT_SECRET: SECRET },
      ADMIN,
      { id: '2' }
    );
    assert.equal(res.status, 200);

    const rows = readLogs(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'member_deleted');
    assert.equal(rows[0].actor_id, 1);
    assert.equal(rows[0].actor_name, '班长');
    assert.equal(rows[0].target_type, 'member');
    assert.equal(rows[0].target_id, '2');
    assert.equal(rows[0].ip, IP);

    const detail = JSON.parse(rows[0].detail);
    assert.deepEqual(detail, { name: '同学', student_id: '2022103072' });
    // 人已经删了，但日志里的目标信息仍然完整（audit_logs 刻意不设外键）
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
  });

  it('一次改密码+邮箱+姓名拆成三条，detail 只有字段名，不含明文', async (t) => {
    const db = await seedDb(t);
    const res = await handleUpdateUser(
      request('/api/auth/users/2', {
        method: 'PUT',
        body: { name: '新名字', email: 'new@example.com', password: 'newpw123' }
      }),
      { DB: db, JWT_SECRET: SECRET },
      ADMIN,
      { id: '2' }
    );
    assert.equal(res.status, 200);

    const rows = readLogs(db);
    assert.deepEqual(rows.map((r) => r.action), ['password_reset', 'email_changed', 'member_updated']);
    for (const row of rows) {
      const detail = JSON.parse(row.detail);
      assert.equal(detail.name, '同学');
      assert.equal(detail.student_id, '2022103072');
    }
    assert.deepEqual(JSON.parse(rows[0].detail).fields, ['password']);
    assert.deepEqual(JSON.parse(rows[1].detail).fields, ['email']);
    assert.deepEqual(JSON.parse(rows[2].detail).fields, ['name']);

    const allText = JSON.stringify(rows);
    assert.ok(!allText.includes('new@example.com'), '邮箱明文不能进日志');
    assert.ok(!allText.includes('newpw123'), '密码明文不能进日志');
    assert.ok(!allText.includes('new@example.com'.split('@')[1]), '邮箱域名同样不能进日志');
  });

  it('只改资料时只写一条 member_updated', async (t) => {
    const db = await seedDb(t);
    const res = await handleUpdateUser(
      request('/api/auth/users/2', { method: 'PUT', body: { contact: '13800000000' } }),
      { DB: db, JWT_SECRET: SECRET },
      ADMIN,
      { id: '2' }
    );
    assert.equal(res.status, 200);
    const rows = readLogs(db);
    assert.equal(rows.length, 1);
    assert.equal(rows[0].action, 'member_updated');
    assert.deepEqual(JSON.parse(rows[0].detail).fields, ['contact']);
  });

  it('写日志失败不阻断主流程（触发器 ABORT 仍返回成功）', async (t) => {
    const db = await seedDb(t);
    db.sqlite.exec(`CREATE TRIGGER audit_fail BEFORE INSERT ON audit_logs
      BEGIN SELECT RAISE(ABORT, 'audit unavailable'); END;`);

    const res = await handleDeleteUser(
      request('/api/auth/users/2', { method: 'DELETE' }),
      { DB: db, JWT_SECRET: SECRET },
      ADMIN,
      { id: '2' }
    );
    assert.equal(res.status, 200);
    assert.equal((await res.json()).success, true);
    assert.equal(db.sqlite.prepare('SELECT count(*) AS n FROM users').get().n, 1);
    assert.equal(readLogs(db).length, 0);
  });
});

describe('审计日志：职位管理', () => {
  it('新建/改权限/删除职位分别落 role_created / role_updated / role_deleted', async (t) => {
    const db = await seedDb(t);
    const env = { DB: db, JWT_SECRET: SECRET };

    const created = await handleCreateRole(
      request('/api/auth/roles', {
        method: 'POST',
        body: { name: '测试岗', permissions: ['content:write'] }
      }),
      env,
      ADMIN
    );
    assert.equal(created.status, 201);

    await handleCreateRole(
      request('/api/auth/roles', {
        method: 'POST',
        body: { name: '测试岗', permissions: ['content:write', 'class:exclude'] }
      }),
      env,
      ADMIN
    );

    const role = db.sqlite.prepare("SELECT id FROM roles WHERE name='测试岗'").get();
    const removed = await handleDeleteRole(
      request(`/api/auth/roles/${role.id}`, { method: 'DELETE' }),
      env,
      ADMIN,
      { id: String(role.id) }
    );
    assert.equal(removed.status, 200);
    assert.equal((await removed.json()).data.message, '职位已删除');

    const rows = readLogs(db);
    assert.deepEqual(rows.map((r) => r.action), ['role_created', 'role_updated', 'role_deleted']);
    // 职位名当 target_id：删掉之后光有自增 id 在审计里读不懂
    assert.deepEqual(rows.map((r) => r.target_id), ['测试岗', '测试岗', '测试岗']);
    assert.deepEqual(JSON.parse(rows[0].detail).permissions, ['content:write']);
    assert.deepEqual(JSON.parse(rows[1].detail).permissions, ['content:write', 'class:exclude']);
    assert.equal(JSON.parse(rows[2].detail).name, '测试岗');
  });
});

describe('审计日志：查询接口', () => {
  it('普通成员 403，班长可读并按动作筛选、分页', async (t) => {
    const db = await seedDb(t);
    const env = { DB: db, JWT_SECRET: SECRET };

    // 用「改资料」而不是「删成员」来造日志：本用例后面还要用成员 2 的令牌验证 403，
    // 先把人删了令牌就失效了（loadFreshUser 查不到人 → 401），测不到权限那一层。
    await handleUpdateUser(
      request('/api/auth/users/2', { method: 'PUT', body: { name: '新名字' } }),
      env,
      ADMIN,
      { id: '2' }
    );

    const memberToken = await tokenFor(MEMBER);
    const denied = await authRoutes(
      request('/api/auth/audit-logs', { token: memberToken }),
      env,
      {}
    );
    assert.equal(denied.status, 403);
    assert.equal((await denied.json()).code, 'FORBIDDEN');

    const adminToken = await tokenFor(ADMIN);
    const allowed = await authRoutes(
      request('/api/auth/audit-logs?action=member_updated&page=1&page_size=10', { token: adminToken }),
      env,
      {}
    );
    assert.equal(allowed.status, 200);
    const payload = await allowed.json();
    assert.equal(payload.success, true);
    assert.equal(payload.data.total, 1);
    assert.equal(payload.data.list[0].action, 'member_updated');
    assert.equal(payload.data.list[0].detail.name, '同学');
    assert.ok(payload.data.actions.includes('member_updated'));
  });

  it('非法的 action / 日期被忽略，不会 500', async (t) => {
    const db = await seedDb(t);
    const env = { DB: db, JWT_SECRET: SECRET };
    const adminToken = await tokenFor(ADMIN);
    const res = await authRoutes(
      request('/api/auth/audit-logs?action=<script>&from=2026-13-40&to=xyz', { token: adminToken }),
      env,
      {}
    );
    assert.equal(res.status, 200);
    const payload = await res.json();
    assert.equal(payload.data.total, 0);
  });

  it('保留期：purge 只删 180 天前的记录', async (t) => {
    const db = await seedDb(t);
    db.sqlite.exec(`INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,detail,ip,created_at)
      VALUES (1,'班长','member_deleted','member','9','{"name":"旧记录"}','1.1.1.1', datetime('now','-200 days'))`);
    db.sqlite.exec(`INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,detail,ip,created_at)
      VALUES (1,'班长','member_deleted','member','8','{"name":"新记录"}','1.1.1.1', datetime('now','-${AUDIT_RETENTION_DAYS - 10} days'))`);

    await new AuditLogModel(db).purge();

    const rows = readLogs(db);
    assert.equal(rows.length, 1);
    assert.equal(JSON.parse(rows[0].detail).name, '新记录');
  });

  it('list 支持按操作人姓名片段与时间范围筛选', async (t) => {
    const db = await seedDb(t);
    db.sqlite.exec(`INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,detail,ip,created_at)
      VALUES (1,'班长','role_created','role','A','{"name":"A"}','1.1.1.1','2026-01-10 08:00:00')`);
    db.sqlite.exec(`INSERT INTO audit_logs(actor_id,actor_name,action,target_type,target_id,detail,ip,created_at)
      VALUES (3,'团支书','role_created','role','B','{"name":"B"}','1.1.1.1','2026-02-10 08:00:00')`);

    const user = { id: 1, name: '班长' };
    const byActor = await handleListAuditLogs(
      request('/api/auth/audit-logs?actor=团支书'),
      { DB: db },
      user
    );
    const actorPayload = await byActor.json();
    assert.equal(actorPayload.data.total, 1);
    assert.equal(actorPayload.data.list[0].actor_name, '团支书');

    const byDate = await handleListAuditLogs(
      request('/api/auth/audit-logs?from=2026-01-01&to=2026-01-31'),
      { DB: db },
      user
    );
    const datePayload = await byDate.json();
    assert.equal(datePayload.data.total, 1);
    assert.equal(datePayload.data.list[0].target_id, 'A');
  });
});
