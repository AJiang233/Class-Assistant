import { drainOutbox } from './services/outbox.js';
import { drainTodoReminders } from './services/todoReminders.js';

export default {
  async scheduled(_event, env, ctx) {
    // 两条队列都必须 await，否则 Cron 返回后未完成的 Promise 会被运行时取消。
    ctx.waitUntil(Promise.all([drainOutbox(env), drainTodoReminders(env)]));
  }
};
