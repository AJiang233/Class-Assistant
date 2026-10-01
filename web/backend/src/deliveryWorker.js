import { drainOutbox } from './services/outbox.js';

export default {
  async scheduled(_event, env, ctx) {
    ctx.waitUntil(drainOutbox(env));
  }
};
