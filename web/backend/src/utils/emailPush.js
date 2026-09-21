/**
 * 订阅邮件推送：把一条内容按订阅发邮件给「它的提醒对象」。
 *
 * 与 utils/push.js 同一种形状，三条硬约束一致：
 *  1. 收件人必须走 utils/audience.js 的 resolveRemindUsers —— 和通知/活动/表单列表、WebPush
 *     同一口径，否则会出现「列表里看不到却收到邮件」。
 *  2. 发送在 ctx.waitUntil 里，不拖慢发布接口的响应。
 *  3. 发送失败只记日志，不影响发布本身，也不给用户回错 —— 订阅邮件是广播，
 *     不是用户正等着的那封（验证码 / 找回密码才是同步等结果的）。
 *
 * 发信本身（配置判定 / 传输 / 模板）在 utils/email.js，这里的职责只有「收件人是谁」与
 * 「这一批怎么发出去」—— 筛人和发信都刻意做成**批量**的：D1 的每条查询与每次 fetch 都算
 * Worker 的 subrequest，免费版一次调用只有 50 个，按人头来会撞上限、撞上之后那部分静默漏发。
 */
import { resolveRemindUsers } from './audience.js';
import { EmailSubscriptionModel } from '../models/emailSubscriptionModel.js';
import { emailEnabled, sendEmailBatch } from './email.js';

/**
 * @param {Object} env
 * @param {Object} ctx Pages Functions 的 ctx（提供 waitUntil）
 * @param {'activities'|'notices'|'forms'} kind 订阅类型（决定查 email_subscriptions 哪一列）
 * @param {{remindPeople?: string, excludeUserId?: number, subject: string, html: string}} opts
 */
export async function pushSubscribedEmails(env, ctx, kind, { remindPeople, excludeUserId, subject, html } = {}) {
  // 未配置 EMAIL_API_KEY 就整体静默关闭：不发、不报错（与推送的 VAPID 关闭同一态度）
  if (!emailEnabled(env)) return;

  const task = sendAll(env, kind, { remindPeople, excludeUserId, subject, html }).catch((e) => {
    console.error('订阅邮件发送失败:', e);
  });

  if (ctx && typeof ctx.waitUntil === 'function') ctx.waitUntil(task);
  else await task;
}

async function sendAll(env, kind, { remindPeople, excludeUserId, subject, html }) {
  const users = await resolveRemindUsers(env, remindPeople, { excludeUserId });
  if (!users.length) return;

  // 收件人 = 提醒对象 ∩ 邮箱已验证 ∩ 开了这一类订阅。
  // 前两条用 resolveRemindUsers 返回的行就能判（里面本就带 email / email_verified），
  // 订阅那条一次问完（subscribedIds）—— 逐个用户查订阅就是每人一条 D1 查询，也就是每个
  // 收件人多烧一个 subrequest，正是这里要避开的。
  const subscribed = new Set(
    await new EmailSubscriptionModel(env.DB).subscribedIds(users.map((u) => u.id), kind)
  );
  const emails = users
    .filter((u) => Number(u.email_verified) === 1 && u.email && subscribed.has(Number(u.id)))
    .map((u) => ({ to: u.email, subject, html }));
  if (!emails.length) return;

  // 批量发（见 utils/email.js 的 sendEmailBatch）：N 封压成 ceil(N/100) 个 subrequest；
  // 某一批失败会退回逐封重发，避免一个写错的邮箱把整批带走
  const result = await sendEmailBatch(env, emails);
  if (result.failed) console.error('订阅邮件部分未发出:', result.failed + '/' + emails.length);
}
