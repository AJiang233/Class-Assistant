import { formatLocalDateTime, parseLocalDateTime } from '../utils/datetime.js';
import { vapidConfig } from '../utils/push.js';
import { sendWebPush } from '../utils/webpush.js';
import { retryDelay } from './outbox.js';

/**
 * 待办到点 Web Push 提醒（P1-4）。
 *
 * 浏览器关闭后没有任何本地定时能力（iOS 主屏 PWA 也一样），所以「提前 N 分钟提醒」
 * 只能由 deliveryWorker 的每分钟 Cron 驱动：
 *
 *   1. 登记：找出 7 天内到期、`todo_reminder_prefs.enabled=1` 的本人待办，若当前时间
 *      已进入 `[due - lead_minutes, due)` 窗口，就给每个推送订阅 INSERT OR IGNORE 一条
 *      投递（UNIQUE(todo_id,user_id,due_at,endpoint) 保证重复跑不重复登记）。
 *   2. 领取：沿用 outbox 的租约语义（120 秒租约、每波 4 条、最多 10 波），过期租约可被
 *      下一轮接管，attempts>=8 的中断记录直接判死。
 *   3. 发送前复核：待办仍 open、归属未变、due_at 未改、提醒仍开启、订阅四元组仍在，
 *      任何一条不满足就记 skipped，绝不发一条已经过时的提醒。
 *   4. 发送失败按 30*2^n 退避；4xx（408/429 除外）或 attempts>=8 记 dead；
 *      404/410 顺手删掉对应的 push_subscriptions；缺 VAPID 配置回 pending 等运维补齐。
 *
 * 时间列是北京时间字符串，due_at 用 parseLocalDateTime 换成真实毫秒；nowMs 可注入，
 * 测试不需要等真实时间。
 */

const LEASE_SECONDS = 120;
const WAVE_SIZE = 4;
const MAX_WAVES = 10;
const MAX_ATTEMPTS = 8;
const LOOKAHEAD_MS = 7 * 24 * 3600 * 1000;

function reminderPayload(row) {
  return {
    subscription: { endpoint: row.endpoint, p256dh: row.p256dh, auth: row.auth },
    message: {
      title: '待办即将到期',
      body: `${row.title} · ${row.due_at} 截止`,
      url: `/todos/?id=${row.id}`,
      tag: `todo-${row.id}`,
      kind: 'todo'
    }
  };
}

/**
 * 登记窗口内的到点提醒。只处理本人待办（owner_id 即收件人），不走受众名单。
 * 返回本轮实际提交的 INSERT 条数（重复登记会被唯一键忽略，不代表新增行数）。
 */
export async function scheduleTodoReminders(env, nowMs, now) {
  const { results } = await env.DB.prepare(`SELECT t.id, t.owner_id, t.title, t.due_at,
      p.lead_minutes, s.endpoint, s.p256dh, s.auth
    FROM todos t
    JOIN todo_reminder_prefs p ON p.user_id = t.owner_id
    JOIN push_subscriptions s ON s.user_id = t.owner_id
    WHERE t.status = 'open' AND p.enabled = 1 AND t.due_at >= ? AND t.due_at <= ?
      -- 已经登记过的（含已发送/已终止）不再重复写库：Cron 每分钟跑一轮，
      -- 只靠 INSERT OR IGNORE 会把 D1 写入额度全花在无变化的重复插入上。
      AND NOT EXISTS (SELECT 1 FROM todo_reminder_deliveries d
        WHERE d.todo_id = t.id AND d.user_id = t.owner_id
          AND d.due_at = t.due_at AND d.endpoint = s.endpoint)
    ORDER BY t.due_at, t.id`).bind(formatLocalDateTime(nowMs), formatLocalDateTime(nowMs + LOOKAHEAD_MS)).all();

  const statements = [];
  for (const row of results) {
    const dueMs = parseLocalDateTime(row.due_at);
    if (dueMs == null) continue;
    const leadMs = Number(row.lead_minutes) * 60000;
    // 只发「窗口内且还没到截止时间」的：已过期的待办留给列表侧的 expireOverdue 处理。
    if (nowMs < dueMs - leadMs || nowMs >= dueMs) continue;
    statements.push(env.DB.prepare(`INSERT OR IGNORE INTO todo_reminder_deliveries
      (user_id, todo_id, due_at, endpoint, payload, next_at)
      VALUES (?, ?, ?, ?, ?, ?)`)
      .bind(row.owner_id, row.id, row.due_at, row.endpoint, JSON.stringify(reminderPayload(row)), now));
  }
  // 控制单条 batch 大小；50 条一批足够覆盖一个班的所有待办 × 设备。
  for (let i = 0; i < statements.length; i += 50) await env.DB.batch(statements.slice(i, i + 50));
  return statements.length;
}

/** 原子领取，语义与 outbox.claimDeliveries 一致。 */
export async function claimTodoReminders(db, now, token, limit = WAVE_SIZE) {
  await db.prepare(`UPDATE todo_reminder_deliveries SET state='dead',last_error='多次执行中断，请人工检查后重放'
    WHERE state='sending' AND lease_until<=? AND attempts>=?`).bind(now, MAX_ATTEMPTS).run();
  const result = await db.prepare(`UPDATE todo_reminder_deliveries
    SET state='sending', attempts=attempts+1, lease_token=?, lease_until=?
    WHERE id IN (SELECT id FROM todo_reminder_deliveries
      WHERE (state='pending' AND next_at<=?) OR (state='sending' AND lease_until<=?)
      ORDER BY id LIMIT ?) RETURNING *`)
    .bind(token, now + LEASE_SECONDS, now, now, limit).all();
  return result.results;
}

async function completeDelivery(db, delivery, state, now, detail = null) {
  return db.prepare(`UPDATE todo_reminder_deliveries
    SET state=?, next_at=?, lease_until=0, lease_token=NULL, last_error=?, updated_at=CURRENT_TIMESTAMP
    WHERE id=? AND lease_token=? AND state='sending'`)
    .bind(state, now + retryDelay(delivery.attempts), detail, delivery.id, delivery.lease_token).run();
}

/** 发送前复核：待办、归属、截止时间、提醒开关、订阅四元组任何一项变了都不能发。 */
async function stillWanted(env, delivery, payload) {
  const row = await env.DB.prepare(`SELECT t.owner_id, t.status, t.due_at, p.enabled
    FROM todos t LEFT JOIN todo_reminder_prefs p ON p.user_id = t.owner_id
    WHERE t.id = ?`).bind(delivery.todo_id).first();
  if (!row) return false;
  if (Number(row.owner_id) !== Number(delivery.user_id)) return false;
  if (row.status !== 'open') return false;
  if (row.due_at !== delivery.due_at) return false;
  if (Number(row.enabled) !== 1) return false;
  const subscription = payload.subscription || {};
  return !!await env.DB.prepare(`SELECT id FROM push_subscriptions
    WHERE user_id=? AND endpoint=? AND p256dh=? AND auth=?`)
    .bind(delivery.user_id, delivery.endpoint, subscription.p256dh, subscription.auth).first();
}

export async function deliverTodoReminder(env, delivery, now, transport = null) {
  const payload = JSON.parse(delivery.payload);
  if (!await stillWanted(env, delivery, payload)) {
    await completeDelivery(env.DB, delivery, 'skipped', now, '待办或订阅已变更');
    return;
  }
  const vapid = vapidConfig(env);
  if (!transport && !vapid) {
    // 缺配置不耗尽重试次数；运维补齐后自动继续。
    await env.DB.prepare(`UPDATE todo_reminder_deliveries SET state='pending', attempts=attempts-1,
      next_at=?, lease_token=NULL, lease_until=0, last_error='渠道尚未配置' WHERE id=? AND lease_token=?`)
      .bind(now + 300, delivery.id, delivery.lease_token).run();
    return;
  }
  try {
    const response = transport
      ? await transport(delivery, payload)
      : await sendWebPush(payload.subscription, payload.message, vapid);
    if (!response.ok) {
      const failure = new Error('推送服务拒绝请求');
      failure.status = response.status;
      throw failure;
    }
    await completeDelivery(env.DB, delivery, 'sent', now);
  } catch (e) {
    const status = Number(e.status || 0);
    const permanent = status >= 400 && status < 500 && ![408, 429].includes(status);
    await completeDelivery(env.DB, delivery, permanent || delivery.attempts >= MAX_ATTEMPTS ? 'dead' : 'pending',
      now, status ? `上游状态 ${status}` : '网络错误或请求超时');
    if ([404, 410].includes(status)) {
      await env.DB.prepare('DELETE FROM push_subscriptions WHERE endpoint=? AND user_id=? AND p256dh=? AND auth=?')
        .bind(delivery.endpoint, delivery.user_id, payload.subscription.p256dh, payload.subscription.auth).run();
    }
  }
}

/** Cron 每分钟调用；单轮限量，未完成的记录留给下一轮。 */
export async function drainTodoReminders(env, { nowMs = Date.now(), transport = null } = {}) {
  const now = Math.floor(nowMs / 1000);
  const scheduled = await scheduleTodoReminders(env, nowMs, now);
  let processed = 0;
  for (let wave = 0; wave < MAX_WAVES; wave++) {
    const deliveries = await claimTodoReminders(env.DB, now, crypto.randomUUID());
    await Promise.all(deliveries.map((delivery) => deliverTodoReminder(env, delivery, now, transport)));
    processed += deliveries.length;
    if (deliveries.length < WAVE_SIZE) break;
  }
  return { scheduled, processed };
}
