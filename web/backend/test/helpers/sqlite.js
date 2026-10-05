import { readFileSync } from 'node:fs';
import { DatabaseSync } from 'node:sqlite';

/** D1 的准备语句与 batch 接口适配；所有约束、触发器和事务均交给真实 SQLite。 */
export function createSqliteDb(t, schema = true) {
  const sqlite = new DatabaseSync(':memory:');
  t.after(() => sqlite.close());
  sqlite.exec('PRAGMA foreign_keys=ON');
  if (schema) sqlite.exec(readFileSync(new URL('../../../schema.sql', import.meta.url), 'utf8'));
  const db = {
    sqlite,
    prepare(sql) {
      const statement = sqlite.prepare(sql);
      let args = [];
      const execute = () => {
        const results = statement.all(...args);
        return { results, meta: { changes: sqlite.prepare('SELECT changes() AS n').get().n } };
      };
      return {
        bind(...values) { args = values; return this; },
        async first() { return statement.get(...args) ?? null; },
        async all() { return execute(); },
        async run() { return execute(); },
        execute
      };
    },
    async batch(statements) {
      sqlite.exec('BEGIN');
      try {
        const results = statements.map((stmt) => stmt.execute());
        sqlite.exec('COMMIT');
        return results;
      } catch (e) {
        sqlite.exec('ROLLBACK');
        throw e;
      }
    }
  };
  return db;
}
