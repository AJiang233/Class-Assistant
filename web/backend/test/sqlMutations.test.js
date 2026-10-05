import assert from 'node:assert/strict';
import { cpSync, mkdirSync, mkdtempSync, readFileSync, writeFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';
import { it } from 'node:test';

const root = fileURLToPath(new URL('../../../', import.meta.url));
const mutations = [
  ['受众比较失效', 'backend/src/utils/recipients.js', 'CAST(value AS TEXT) = ?', 'CAST(value AS TEXT) != ?'],
  ['旧消费者错误确认', 'backend/src/services/outbox.js', "lease_token=? AND state='sending'", "lease_token IS NOT NULL AND ? IS NOT NULL AND state='sending'"],
  ['游标重复读取', 'backend/src/handlers/syncHandler.js', 'WHERE seq>? AND seq<=?', 'WHERE seq>=? AND seq<=?'],
  ['缺失级联删除', 'schema.sql', 'REFERENCES forms(id) ON DELETE CASCADE', 'REFERENCES forms(id) ON DELETE RESTRICT']
];

it('关键 SQL 变异均被真实数据库回归断言捕获', () => {
  const base = resolve(root, '.Codex/mutations');
  mkdirSync(base, { recursive: true });
  const dir = mkdtempSync(join(base, 'run-'));
  try {
    for (const name of ['backend/src', 'backend/test/helpers', 'migrations-v2']) {
      cpSync(join(root, 'web', name), join(dir, name), { recursive: true });
    }
    for (const name of ['schema.sql', 'package.json', 'backend/test/architecture.test.js']) {
      cpSync(join(root, 'web', name), join(dir, name));
    }
    for (const [label, path, before, after] of mutations) {
      const file = join(dir, path);
      const original = readFileSync(file, 'utf8');
      assert.ok(original.includes(before), `变异目标存在：${label}`);
      writeFileSync(file, original.replace(before, after));
      const env = { ...process.env };
      // 子进程是独立测试运行器，不能继承父 node:test 的内部工作进程标记。
      delete env.NODE_TEST_CONTEXT;
      const run = spawnSync(process.execPath, ['--test', 'backend/test/architecture.test.js'], {
        cwd: dir, encoding: 'utf8', timeout: 30000, env
      });
      writeFileSync(file, original);
      assert.equal(run.error, undefined, `测试可执行：${label}`);
      assert.notEqual(run.status, 0, `断言必须捕获：${label}`);
      assert.match(run.stdout + run.stderr, /AssertionError|ERR_ASSERTION/, `由行为断言捕获：${label}`);
    }
  } finally {
    // mkdtempSync 的返回值固定在当前项目验证目录中。
    assert.ok(dir.startsWith(base + '\\') || dir.startsWith(base + '/'));
    rmSync(dir, { recursive: true, force: true });
  }
});
