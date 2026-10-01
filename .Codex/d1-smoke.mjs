import assert from 'node:assert/strict';
import { getPlatformProxy } from '../web/node_modules/wrangler/wrangler-dist/cli.js';
import { FormModel } from '../web/backend/src/models/formModel.js';
import { handleSync } from '../web/backend/src/handlers/syncHandler.js';

const platform = await getPlatformProxy({ configPath: 'web/wrangler.toml',
  persist: { path: '.Codex/d1-review/v3' } });
try {
  const db = platform.env.DB;
  const model = new FormModel(db);
  const data = { title: '本地 D1 冒烟', description: '', fields: '[]', edit_policy: 'always',
    anonymous: 0, deadline: null, creator_id: 233, creator_name: '测试', remind_people: null };
  const id = await model.createWithNotice(data, { title: '联动通知', content: '测试', publish_time: '2030-01-01 08:00:00' });
  const row = await model.findById(id);
  const notice = await db.prepare('SELECT link FROM notices WHERE id=?').bind(row.notice_id).first();
  assert.equal(notice.link, `/forms.html?id=${id}`);
  const before = (await db.prepare('SELECT count(*) AS n FROM forms').first()).n;
  await assert.rejects(model.createWithNotice(data, { title: null, content: '失败注入', publish_time: '2030-01-01 08:00:00' }));
  assert.equal((await db.prepare('SELECT count(*) AS n FROM forms').first()).n, before);
  await model.submit(row, 233, '233', '测试', '{}');
  await model.remove(id);
  assert.equal(await db.prepare('SELECT id FROM form_submissions WHERE form_id=?').bind(id).first(), null);
  const response = await handleSync(new Request('https://class.example/api/sync?snapshot=1'), { DB: db }, { id: 233, positions: '学生' });
  assert.equal(response.status, 200);
  assert.ok((await response.json()).data.changes.every((change) => typeof change.seq === 'number'));
  console.log('本地 D1：联动创建、失败回滚、级联删除、快照同步全部通过');
} finally {
  await platform.dispose();
}
