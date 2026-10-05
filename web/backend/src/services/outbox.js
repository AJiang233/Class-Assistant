import { resolveRemindUsers, canView, loadViewer } from '../utils/audience.js';
import { PushSubscriptionModel } from '../models/pushSubscriptionModel.js';
import { EmailSubscriptionModel } from '../models/emailSubscriptionModel.js';
import { UserModel } from '../models/userModel.js';
import { vapidConfig } from '../utils/push.js';
import { sendWebPush } from '../utils/webpush.js';
import { emailEnabled, sendEmail, renderNoticeEmail, renderActivityEmail, renderFormEmail } from '../utils/email.js';

const KINDS = Object.freeze({ notices: 'notice', activities: 'activity', forms: 'form' });
const LABELS = Object.freeze({ notices: '通知', activities: '活动', forms: '表单' });

/** 展开与标记同事务提交。唯一键让多个消费者的重复展开收敛到同一份投递记录。 */
export async function expandEvent(env, event) {
  const row = JSON.parse(event.payload);
  const kind = event.kind;
  if (!KINDS[kind]) throw new Error('未知的投递事件类型');
  const users = await resolveRemindUsers(env, row.remind_people, { excludeUserId: row.created_by ?? row.creator_id });
  const ids = users.map((u) => u.id);
  const path = kind === 'forms' ? `/forms.html?id=${row.id}` : (row.link || `/?view=${kind}&id=${row.id}`);
  const link = new URL(path, env.SITE_ORIGIN).href;
  const render = { notices: renderNoticeEmail, activities: renderActivityEmail, forms: renderFormEmail }[kind];
  const subject = `【班级助理】新${LABELS[kind]}：${row.title}`;
  const subscribed = new Set(await new EmailSubscriptionModel(env.DB).subscribedIds(ids, kind));
  const targets = users.filter((u) => u.email && Number(u.email_verified) === 1 && subscribed.has(Number(u.id)))
    .map((u) => ({ user: u.id, channel: 'email', target: u.email,
      payload: { kind, itemId: row.id, subject, html: render({ ...row, link }) } }));
  // 联动通知仍按通知邮件订阅投递；设备只接收表单事件，避免双响。
  if (!(kind === 'notices' && row.source === 'form')) {
    const subs = await new PushSubscriptionModel(env.DB).listByUsers(ids);
    targets.push(...subs.map((sub) => ({ user: sub.user_id, channel: 'push', target: sub.endpoint,
      payload: { kind, itemId: row.id, subscription: sub, message: {
        title: row.title, body: String(row.content || row.description || '请及时查看').slice(0, 120),
        url: path, tag: `${KINDS[kind]}-${row.id}`, kind: KINDS[kind]
      } } })));
  }
  const statements = [];
  // 控制单条绑定大小，也避免每位收件人占用一条 SQL。
  for (let i = 0; i < targets.length; i += 50) {
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO outbox_deliveries(event_seq,user_id,channel,target,payload)
      SELECT ?,json_extract(value,'$.user'),json_extract(value,'$.channel'),
        json_extract(value,'$.target'),json_extract(value,'$.payload') FROM json_each(?)
        WHERE (SELECT expanded FROM outbox_events WHERE seq=?)=0`)
      .bind(event.seq, JSON.stringify(targets.slice(i, i + 50)), event.seq));
  }
  statements.push(env.DB.prepare('UPDATE outbox_events SET expanded=1 WHERE seq=?').bind(event.seq));
  await env.DB.batch(statements);
}

/** 原子领取，过期租约允许接管；完成写入必须携带本次租约，迟到的消费者不能覆盖新结果。 */
export async function claimDeliveries(db, now, token, limit = 4) {
  await db.prepare(`UPDATE outbox_deliveries SET state='dead',last_error='多次执行中断，请人工检查后重放'
    WHERE state='sending' AND lease_until<=? AND attempts>=8`).bind(now).run();
  const result = await db.prepare(`UPDATE outbox_deliveries
    SET state='sending', attempts=attempts+1, lease_token=?, lease_until=?
    WHERE id IN (SELECT id FROM outbox_deliveries
      WHERE (state='pending' AND next_at<=?) OR (state='sending' AND lease_until<=?)
      ORDER BY id LIMIT ?) RETURNING *`).bind(token, now + 120, now, now, limit).all();
  return result.results;
}

export function retryDelay(attempts) {
  return Math.min(3600, 30 * 2 ** Math.min(attempts, 10));
}

export async function completeDelivery(db, delivery, state, now, detail = null) {
  return db.prepare(`UPDATE outbox_deliveries SET state=?,next_at=?,lease_until=0,lease_token=NULL,last_error=?
    WHERE id=? AND lease_token=? AND state='sending'`)
    .bind(state, now + retryDelay(delivery.attempts), detail, delivery.id, delivery.lease_token).run();
}

/** 发送前再次读取订阅与归属，已退订、删除、改绑或退出受众的目标不再发送。 */
async function stillSubscribed(env, delivery, payload) {
  const user = await new UserModel(env.DB).findById(delivery.user_id);
  if (!user || !KINDS[payload.kind]) return false;
  const row = await env.DB.prepare(`SELECT remind_people FROM ${payload.kind} WHERE id=?`).bind(payload.itemId).first();
  if (!row || !canView(row.remind_people, await loadViewer(env, user))) return false;
  if (delivery.channel === 'push') {
    return !!await env.DB.prepare('SELECT id FROM push_subscriptions WHERE user_id=? AND endpoint=? AND p256dh=? AND auth=?')
      .bind(user.id, delivery.target, payload.subscription.p256dh, payload.subscription.auth).first();
  }
  if (user.email !== delivery.target || Number(user.email_verified) !== 1) return false;
  return (await new EmailSubscriptionModel(env.DB).subscribedIds([user.id], payload.kind)).length > 0;
}

export async function deliver(env, delivery, now, transport = null) {
  const payload = JSON.parse(delivery.payload);
  if (!await stillSubscribed(env, delivery, payload)) {
    await completeDelivery(env.DB, delivery, 'skipped', now, '内容或订阅已变更');
    return;
  }
  if (!transport && !(delivery.channel === 'email' ? emailEnabled(env) : vapidConfig(env))) {
    // 缺配置不耗尽重试次数；运维补齐配置后自动继续。
    await env.DB.prepare(`UPDATE outbox_deliveries SET state='pending',attempts=attempts-1,
      next_at=?,lease_token=NULL,lease_until=0,last_error='渠道尚未配置' WHERE id=? AND lease_token=?`)
      .bind(now + 300, delivery.id, delivery.lease_token).run();
    return;
  }
  try {
    let response;
    if (transport) response = await transport(delivery, payload);
    else if (delivery.channel === 'push') response = await sendWebPush(payload.subscription, payload.message, vapidConfig(env));
    else {
      await sendEmail(env, { to: delivery.target, subject: payload.subject, html: payload.html,
        idempotencyKey: `class-assistant/${delivery.event_seq}/${delivery.id}` });
      response = { ok: true, status: 200 };
    }
    if (!response.ok) {
      const failure = new Error('投递服务拒绝请求');
      failure.status = response.status;
      throw failure;
    }
    await completeDelivery(env.DB, delivery, 'sent', now);
  } catch (e) {
    const status = Number(e.status || 0);
    const permanent = status >= 400 && status < 500 && ![408, 429].includes(status);
    await completeDelivery(env.DB, delivery, permanent || delivery.attempts >= 8 ? 'dead' : 'pending', now,
      status ? `上游状态 ${status}` : '网络错误或请求超时');
    if (delivery.channel === 'push' && [404, 410].includes(status)) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND p256dh=? AND auth=?')
        .bind(delivery.target, delivery.user_id, payload.subscription.p256dh, payload.subscription.auth).run();
    }
  }
}

/** Cron 有持久数据库兜底；单轮限量、最多四路出网，未完成的记录留给下一轮。 */
export async function drainOutbox(env) {
  if (!env.SITE_ORIGIN) throw new Error('请配置投递 Worker 的 SITE_ORIGIN');
  const { results } = await env.DB.prepare(`SELECT c.* FROM outbox_events e
    JOIN content_changes c ON c.seq=e.seq WHERE e.expanded=0 ORDER BY e.seq LIMIT 10`).all();
  for (const event of results) await expandEvent(env, event);
  let processed = 0;
  for (let wave = 0; wave < 10; wave++) {
    const now = Math.floor(Date.now() / 1000);
    const deliveries = await claimDeliveries(env.DB, now, crypto.randomUUID());
    await Promise.all(deliveries.map((delivery) => deliver(env, delivery, now)));
    processed += deliveries.length;
    if (deliveries.length < 4) break;
  }
  return { expanded: results.length, processed };
}
