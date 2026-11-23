/**
 * 全局功能开关（issue #106）。
 *
 * 两张开关只解决一个运维问题：教务 / 学习通的第三方接口哪天挂了、改版了、或者被校方
 * 风控盯上了，管理员要能在**不发版**的情况下立刻把出网流量掐掉，而不是等着改代码重部署。
 *
 * 三条设计取舍：
 *   1. **白名单键**：只认 academic_enabled / chaoxing_enabled 两个键，读取时也按这两键过滤。
 *      开关表不做通用 KV —— 真做成通用配置，谁都能往里塞东西，而这张表的读取点在下游路由，
 *      攻破一处就能改变行为。
 *   2. **缺省开启**：表里没有对应行时按「开」处理。开关的语义是「紧急停用」，不是「灰度发布」；
 *      升级后漏写初始行应该是原行为，而不是把全班功能一起关掉。
 *   3. **读失败也按开启**：读 app_settings 抛错（典型是 0006 迁移还没跑）只记日志、返回默认值。
 *      否则一次迁移遗漏会把教务功能整体打成 503，而页面看起来像服务挂了。
 *
 * 缓存 30 秒，减少每次请求一次 D1 读。缓存挂在 db 对象上（WeakMap），不是模块级单例：
 *   测试里每个用例各自建库，模块级缓存会把上一个库的开关带到下一个用例；
 *   Workers 里 env.DB 在同一 isolate 内是稳定的，WeakMap 等价于 isolate 级缓存。
 * 写开关时立即清掉本 isolate 的缓存，管理员点完「保存」后当次请求就能看到效果，不必等 30 秒。
 */
const CACHE_TTL_MS = 30 * 1000;

export const FEATURE_KEYS = {
  academic: 'academic_enabled',
  chaoxing: 'chaoxing_enabled'
};

const DEFAULT_VALUES = {
  academic_enabled: '1',
  chaoxing_enabled: '1'
};

const cacheByDb = new WeakMap();

export class SettingModel {
  constructor(db) {
    this.db = db;
  }

  /** 读全部开关（带 30 秒缓存）。返回值一定是两个键齐全的对象。 */
  async load() {
    const cached = cacheByDb.get(this.db);
    const now = Date.now();
    if (cached && now - cached.at < CACHE_TTL_MS) return cached.values;

    const values = { ...DEFAULT_VALUES };
    try {
      const { results } = await this.db
        .prepare('SELECT key, value FROM app_settings')
        .all();
      for (const row of results || []) {
        if (row && Object.prototype.hasOwnProperty.call(DEFAULT_VALUES, row.key)) {
          values[row.key] = String(row.value);
        }
      }
    } catch (e) {
      // 见文件头第 3 条：读不到就按开启，别让开关自己变成故障源。
      console.error('读取全局功能开关失败，按默认开启处理:', e && e.message);
      return { ...DEFAULT_VALUES };
    }

    cacheByDb.set(this.db, { at: now, values });
    return values;
  }

  /** feature: 'academic' | 'chaoxing'。未知 feature 一律视为开启（不在开关管辖范围）。 */
  async isEnabled(feature) {
    const key = FEATURE_KEYS[feature];
    if (!key) return true;
    const values = await this.load();
    return values[key] !== '0';
  }

  async all() {
    const values = await this.load();
    return {
      academic: values.academic_enabled !== '0',
      chaoxing: values.chaoxing_enabled !== '0'
    };
  }

  async set(feature, enabled) {
    const key = FEATURE_KEYS[feature];
    if (!key) throw new Error(`未知功能开关: ${feature}`);
    await this.db
      .prepare(
        `INSERT INTO app_settings(key, value) VALUES(?, ?)
         ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP`
      )
      .bind(key, enabled ? '1' : '0')
      .run();
    // 本 isolate 立即生效：管理员刚点完「停用」，下一次请求不该还走 30 秒旧缓存。
    cacheByDb.delete(this.db);
  }
}
