/**
 * 推送发送：把一条内容推给「它的提醒对象」。
 *
 * 三条硬约束：
 *  1. 收件人必须走 utils/audience.js 的 resolveRemindUsers —— 和通知/活动/表单列表同一口径，
 *     否则会出现「列表里看不到却收到推送」（pre-mortem 第 9 条）。
 *  2. 发送在 ctx.waitUntil 里，不拖慢发布接口的响应。
 *  3. 端点 404/410 表示订阅已死，立即删行，后续不再尝试。
 *
 * 未配置 VAPID 密钥时整体静默关闭：不发、不报错、也不告诉用户「已开启」。
 */
import { PushSubscriptionModel } from '../models/pushSubscriptionModel.js';
import { resolveRemindUsers } from './audience.js';
import { sendWebPush } from './webpush.js';

/** VAPID 配置（来自 Pages Secrets）；缺任何一个都视为未启用 */
export function vapidConfig(env) {
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return null;
  return {
    publicKey: env.VAPID_PUBLIC_KEY,
    privateKey: env.VAPID_PRIVATE_KEY,
    subject: env.VAPID_SUBJECT || 'mailto:admin@qxwkstudio.top'
  };
}

export function pushEnabled(env) {
  return vapidConfig(env) !== null;
}

/**
 * 给「这条内容的提醒对象」发推送。
 *
 * @param {Object} env
 * @param {Object} ctx Pages Functions 的 ctx（提供 waitUntil）
 * @param {string} remindPeople 原始 remind_people 字段（空 = 全班）
 * @param {{title:string, body:string, url:string, tag?:string, excludeUserId?:number}} payload
 */
export async function pushToRemindAudience(env, ctx, remindPeople, payload) {
  const vapid = vapidConfig(env);
  if (!vapid) return;

  const task = sendAll(env, vapid, remindPeople, payload).catch((e) => {
    // 推送失败不能影响发布本身
    console.error('推送发送失败:', e);
  });

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

async function sendAll(env, vapid, remindPeople, payload) {
  const users = await resolveRemindUsers(env, remindPeople, { excludeUserId: payload.excludeUserId });
  if (!users.length) return;

  const model = new PushSubscriptionModel(env.DB);
  const subs = await model.listByUsers(users.map((u) => u.id));
  if (!subs.length) return;

  // 按 endpoint 去重：同一事件同一设备只发一次
  const seen = new Set();
  const targets = subs.filter((s) => (seen.has(s.endpoint) ? false : (seen.add(s.endpoint), true)));

  const message = {
    title: payload.title,
    body: payload.body || '',
    url: payload.url || '/'
  };
  if (payload.tag) message.tag = payload.tag;

  const dead = [];
  const ok = [];

  // 分批顺序推进，而不是 targets.map 一把梭。
  // 一次班级通知可能几十上百台设备，全部并起来会撞上 Worker 对同一主机的并发连接上限
  // （同时打开的连接数是有配额的），而且一旦中途抛错，已经发出去的那部分状态就丢了。
  // ponytail: 6 是照 Worker 的并发连接配额取的，别再改成无上限的 Promise.all。
  const BATCH = 6;
  for (let i = 0; i < targets.length; i += BATCH) {
    await Promise.all(targets.slice(i, i + BATCH).map(async (sub) => {
      try {
        const res = await sendWebPush(sub, message, vapid);
        if (res.status === 404 || res.status === 410) {
          dead.push(sub.endpoint);
          return;
        }
        if (res.ok) {
          ok.push(sub.endpoint);
          return;
        }
        const text = await res.text().catch(() => '');
        console.error('推送被拒:', res.status, String(text).slice(0, 200));
      } catch (e) {
        console.error('推送请求失败:', e);
      }
    }));
  }

  if (dead.length) await model.removeByEndpoints(dead);
  if (ok.length) await model.markOk(ok);
}
