/**
 * 订阅邮件推送：把一条内容按订阅发邮件给「它的提醒对象」。
 *
 * 与 utils/push.js 同一种形状，三条硬约束一致：
 *  1. 收件人必须走 utils/audience.js 的 resolveRemindUsers —— 和通知/活动/表单列表、WebPush
 *     同一口径，否则会出现「列表里看不到却收到邮件」。
 *  2. 发送在 ctx.waitUntil 里，不拖慢发布接口的响应。
 *  3. 单封失败只记日志，不影响发布本身，也不给用户回错 —— 订阅邮件是广播，
 *     不是用户正等着的那封（验证码 / 找回密码才是同步等结果的）。
 *
 * 发信本身（配置判定 / 传输 / 模板）在 utils/email.js，这里的职责只有
 * 「收件人是谁」和「逐封发并隔离失败」。
 */
import { resolveRemindUsers } from './audience.js';
import { emailEnabled, sendSubscribedEmail } from './email.js';

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

  // 班级规模小（几十人），逐封串行发即可；每一封都过 sendSubscribedEmail 的两道校验
  // （email_verified=1 + 对应订阅位=1），未验证 / 没开订阅的被挡掉是常态，静默跳过。
  // 将来订阅人多到会撞 Worker 的 subrequest 配额时，换成 Resend /emails/batch 一次发 100 封
  // （见 utils/email.js 里 sendEmail 的注释），现在没必要为假想的规模加复杂度。
  for (const u of users) {
    try {
      await sendSubscribedEmail(env, env.DB, { userId: u.id, kind, subject, html });
    } catch (e) {
      console.error('订阅邮件单封失败:', u.id, e && e.message);
    }
  }
}
