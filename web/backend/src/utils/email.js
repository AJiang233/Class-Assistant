/**
 * 邮件发送 —— 全仓唯一的出网口。
 *
 * 分层（与 utils/push.js 同一种形状）：
 *   1. 配置判定：emailConfig / emailEnabled（对应推送那边的 vapidConfig / pushEnabled）
 *   2. 传输：sendEmail —— 只有这里出现 api.resend.com。换服务商（Postmark / 自建 SMTP 网关）、
 *      改超时、加脱敏日志，都只动这一处。
 *   3. 模板：renderBrandEmail / renderCodeEmail —— table + 内联样式，兼容主流邮箱客户端。
 *
 * 两类调用方的等待语义**刻意不同**，所以不合并成一个「万能发信函数」：
 *   - 验证码 / 找回密码：用户就等这封信 → 同步 await，失败要如实回错（502）。
 *   - 将来的活动 / 通知订阅推送：失败不能影响发布本身 → 走 ctx.waitUntil，只记日志。
 *   把 waitFor 塞进参数做成一个函数是坏味道，需要时另建一个出口。
 *
 * 邮件正文与验证码**不进日志**：出问题时日志里只留收件人与状态码。
 */

const RESEND_ENDPOINT = 'https://api.resend.com/emails';

/** 单次发信的兜底超时：上游挂起时不能让发布接口一直等着 */
const EMAIL_TIMEOUT_MS = 15000;

/** 验证码有效期与重发间隔，供邮件模板与模型共用口径 */
export const CODE_TTL_MINUTES = 10;
export const RESEND_INTERVAL_SECONDS = 60;
export const MAX_CODE_ATTEMPTS = 5;

/**
 * 邮件发送失败的统一异常。handler 按 code 决定状态码：
 * EMAIL_NOT_CONFIGURED → 503（这一档要能让前端与「服务端崩了」分开）
 * EMAIL_SEND_FAILED    → 502
 */
export class EmailError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'EmailError';
    this.code = code;
  }
}

/**
 * 发信配置。缺 EMAIL_API_KEY 就视为整块未启用。
 * from 可在环境里覆盖（换发件子域时不必改代码），默认本项目的 no-reply 地址。
 */
export function emailConfig(env) {
  const key = env && env.EMAIL_API_KEY;
  if (!key) return null;
  return {
    key,
    from: (env && env.EMAIL_FROM) || '班级助理 <no-reply@class.qxwkstudio.top>'
  };
}

export function emailEnabled(env) {
  return emailConfig(env) !== null;
}

function timeoutSignal(ms) {
  try {
    if (typeof AbortSignal !== 'undefined' && typeof AbortSignal.timeout === 'function') {
      return AbortSignal.timeout(ms);
    }
  } catch (e) { /* 特性探测失败：退化成无超时，不影响请求本身 */ }
  return undefined;
}

/**
 * 发一封邮件（Resend）。失败一律抛 EmailError，调用方不需要认识 Resend 的错误体。
 *
 * 不在这里做限流 / 幂等 —— 那是业务的事（见 models/emailCodeModel.js 的重发间隔）。
 * 将来要一次给全班发订阅邮件时，在这里加一个 sendEmailBatch（Resend /emails/batch，
 * 一次 subrequest 发 100 封）：Worker 单请求的 subrequest 有配额，逐封发会撞上限，
 * 那一条必须与 pushToRemindAudience 一样走 ctx.waitUntil 分批推进。
 */
export async function sendEmail(env, { to, subject, html, replyTo } = {}) {
  const config = emailConfig(env);
  if (!config) {
    throw new EmailError('邮件服务未配置', 'EMAIL_NOT_CONFIGURED');
  }
  if (!to || !subject || !html) {
    throw new EmailError('邮件缺少收件人、主题或正文', 'EMAIL_SEND_FAILED');
  }

  let res;
  try {
    res = await fetch(RESEND_ENDPOINT, {
      method: 'POST',
      headers: {
        Authorization: `Bearer ${config.key}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        from: config.from,
        to,
        subject,
        html,
        ...(replyTo ? { reply_to: replyTo } : {})
      }),
      signal: timeoutSignal(EMAIL_TIMEOUT_MS)
    });
  } catch (e) {
    // 超时或断网：日志里只留收件人，不带正文
    console.error('邮件请求失败:', to, e && e.message);
    throw new EmailError('邮件发送失败，请稍后重试', 'EMAIL_SEND_FAILED');
  }

  if (!res.ok) {
    // 上游的错误体里可能带收件人等信息，只截前 200 字符，且不记正文
    const detail = await res.text().catch(() => '');
    console.error('邮件被拒:', res.status, String(detail).slice(0, 200));
    throw new EmailError('邮件发送失败，请稍后重试', 'EMAIL_SEND_FAILED');
  }

  return res.json().catch(() => ({}));
}

/** 订阅类型 → email_subscriptions 列名。新增订阅类目（如「成绩订阅」）时在这里加一行 */
const SUBSCRIPTION_COLUMNS = {
  activities: 'sub_activities',
  notices: 'sub_notices',
  forms: 'sub_forms'
};

/**
 * 订阅类邮件的统一发送入口 —— 「每次发信都先验证」就体现在这里：
 *   1. 邮箱必须已验证（email_verified=1）。未验证的邮箱收订阅邮件没有意义，
 *      验证码 / 找回密码那两类事务邮件不走这里（它们本来就该发）。
 *   2. 对应订阅位必须开着（email_subscriptions[kind]=1）。
 *
 * 现在还没有调用点：活动 / 通知 / 表单推送按订阅发信是下一期的事，
 * 先把两道校验钉在这个唯一的订阅发信口上，到时不至于每个推送处各写一遍。
 *
 * @returns {{ok:true} | {ok:false, reason:'UNVERIFIED'|'UNSUBSCRIBED'}}
 *   UNVERIFIED   用户邮箱未验证（或没绑）
 *   UNSUBSCRIBED 该订阅位没开
 */
export async function sendSubscribedEmail(env, db, { userId, kind, to, subject, html, replyTo } = {}) {
  const col = SUBSCRIPTION_COLUMNS[kind];
  if (!col) throw new EmailError(`未知的订阅类型: ${kind}`, 'EMAIL_SEND_FAILED');

  const user = await db.prepare(
    'SELECT email, email_verified FROM users WHERE id = ?'
  ).bind(userId).first();
  if (!user || Number(user.email_verified) !== 1) return { ok: false, reason: 'UNVERIFIED' };

  const sub = await db.prepare(
    `SELECT ${col} AS subscribed FROM email_subscriptions WHERE user_id = ?`
  ).bind(userId).first();
  if (!sub || Number(sub.subscribed) !== 1) return { ok: false, reason: 'UNSUBSCRIBED' };

  await sendEmail(env, { to: to || user.email, subject, html, replyTo });
  return { ok: true };
}

/**
 * 生成 6 位数字验证码。
 * 用 crypto.getRandomValues 而不是 Math.random：后者可预测，验证码被猜到等于账号被接管。
 */
export function genEmailCode() {
  const bytes = new Uint8Array(4);
  crypto.getRandomValues(bytes);
  const n = new DataView(bytes.buffer).getUint32(0);
  return String(n % 1000000).padStart(6, '0');
}

/** HTML 转义：模板里会插用户可控的值（将来的通知标题等），邮件客户端同样会被注入 */
export function escHtml(v) {
  return String(v == null ? '' : v)
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

/**
 * 品牌邮件外壳。三种块按需出现，同一份模板覆盖现在与将来：
 *   - code：验证码大号数字块（现在的绑定验证 / 找回密码）
 *   - body：正文段落（将来的通知 / 活动推送）
 *   - cta ：一个按钮（同上，落回站内页面）
 * footer 留给将来的退订说明：活动这类非事务邮件不带退订入口，
 * 被点举报会拖垮发件域名的信誉，届时把说明塞进这一块即可。
 */
export function renderBrandEmail({
  title = '',
  intro = '',
  code = '',
  body = '',
  cta = null,
  validity = `<b>${CODE_TTL_MINUTES} 分钟</b> 内有效，过期需重新获取。`,
  warn = '若非本人操作，请忽略本邮件，也不要将验证码告知他人。',
  footer = ''
} = {}) {
  const introBlock = intro ? `<tr>
            <td style="padding:20px 32px 0;font-size:14px;line-height:1.7;color:#334155;">${intro}</td>
          </tr>` : '';

  const codeBlock = code ? `<tr>
            <td style="padding:18px 32px 0;">
              <div style="background:#eff6ff;border:1px solid #bfdbfe;border-radius:12px;padding:18px;text-align:center;">
                <div style="font-size:11px;color:#64748b;letter-spacing:1px;">验证码</div>
                <div style="font-size:32px;font-weight:800;letter-spacing:6px;color:#2563eb;margin-top:4px;">${code}</div>
              </div>
            </td>
          </tr>
          <tr>
            <td style="padding:16px 32px 0;font-size:12px;color:#64748b;text-align:center;">验证码 ${validity}</td>
          </tr>` : '';

  const bodyBlock = body ? `<tr>
            <td style="padding:20px 32px 0;font-size:14px;line-height:1.7;color:#334155;">${body}</td>
          </tr>` : '';

  const ctaBlock = cta && cta.url ? `<tr>
            <td style="padding:20px 32px 0;text-align:center;">
              <a href="${cta.url}" style="display:inline-block;background:#2563eb;color:#ffffff;text-decoration:none;font-size:14px;font-weight:600;padding:11px 26px;border-radius:10px;">${cta.label || '查看详情'}</a>
            </td>
          </tr>` : '';

  const warnBlock = warn ? `<tr>
            <td style="padding:16px 32px 0;">
              <div style="background:#fffbeb;border:1px solid #fde68a;border-radius:10px;padding:12px 14px;font-size:12px;color:#92400e;line-height:1.6;">${warn}</div>
            </td>
          </tr>` : '';

  const footerBlock = footer ? `<tr>
            <td style="padding:16px 32px 0;font-size:11px;color:#94a3b8;text-align:center;line-height:1.6;">${footer}</td>
          </tr>` : '';

  const subtitle = title ? `<div style="font-size:12px;color:#64748b;margin-top:2px;">${title}</div>` : '';

  return `<div style="background:#f1f5f9;margin:0;padding:32px 16px;font-family:'Segoe UI',system-ui,-apple-system,Arial,sans-serif;color:#0f172a;">
  <table role="presentation" width="100%" cellpadding="0" cellspacing="0">
    <tr>
      <td align="center">
        <table role="presentation" width="100%" style="max-width:420px;background:#ffffff;border-radius:16px;overflow:hidden;border:1px solid #e2e8f0;">
          <tr>
            <td style="background:#2563eb;padding:6px 0;"></td>
          </tr>
          <tr>
            <td style="padding:28px 32px 0;text-align:center;">
              <div style="font-size:17px;font-weight:700;color:#0f172a;letter-spacing:.3px;">Class Assistant · 班级助理</div>
              ${subtitle}
            </td>
          </tr>
          ${introBlock}
          ${codeBlock}
          ${bodyBlock}
          ${ctaBlock}
          ${warnBlock}
          ${footerBlock}
          <tr>
            <td style="padding:20px 32px 24px;font-size:11px;color:#94a3b8;text-align:center;">此邮件由系统自动发送，请勿直接回复。</td>
          </tr>
        </table>
      </td>
    </tr>
  </table>
</div>`;
}

/** 绑定邮箱的验证码邮件 */
export function renderVerifyEmail(code) {
  return renderBrandEmail({
    title: '班级助理 · 邮箱验证',
    intro: '你好，我们收到了你的邮箱验证申请。请在页面输入下方验证码以完成绑定：',
    code,
    footer: '此类邮件不可在设置内退订，若非本人反复收到，请与我们（QxwkStudio@outlook.com）联系。'
  });
}

/** 找回密码的重置码邮件 */
export function renderResetEmail(code) {
  return renderBrandEmail({
    title: '班级助理 · 重置密码',
    intro: '你好，我们收到了你的密码重置申请。请在页面输入下方验证码以设置新密码：',
    code,
    footer: '此类邮件不可在设置内退订，若非本人反复收到，请与我们（QxwkStudio@outlook.com）联系。'
  });
}

/** 订阅推送邮件的统一退订说明。活动 / 通知 / 表单都是订阅类邮件，不像验证码那样「不可退订」—— footer 给出去向，免得收件人点举报伤发件域名信誉 */
const SUBSCRIPTION_FOOTER =
  '此类邮件可在设置内退订（个人中心 → 邮箱管理 → 订阅通知），不想再收到可随时关闭。若非本人反复收到，请与我们（QxwkStudio@outlook.com）联系。';

/** 库里的时间串是 'YYYY-MM-DD HH:MM:SS'（utils/datetime.js 的 toLocalDateTime），邮件里只留到分钟 */
function emailTime(value) {
  return String(value == null ? '' : value).replace('T', ' ').slice(0, 16);
}

/**
 * 活动推送模板。参数与活动行字段同名（见 activityHandler），推送接入时把列表 / 详情行
 * 原样传进来即可，调用点不用做字段翻译。content / location / title 是用户可控内容，
 * 一律经 escHtml 转义再拼进邮件，防客户端注入（与验证码模板同一口径）。
 */
export function renderActivityEmail({ title = '', content = '', location = '', start_time = '', link = '' } = {}) {
  const head = [emailTime(start_time), String(location).trim()].filter(Boolean).join(' · ');
  const text = String(content).replace(/\s+/g, ' ').trim();
  const body = [head, text].filter(Boolean).map(escHtml).join('<br>');
  return renderBrandEmail({
    title: '班级助理 · 新活动',
    intro: `班里发布了新活动《${escHtml(title)}》：`,
    body,
    cta: link ? { url: link, label: '查看活动' } : null,
    warn: '',
    footer: SUBSCRIPTION_FOOTER
  });
}

/** 通知推送模板。参数与通知行字段同名（见 noticeHandler）；link 给到站内通知页或表单页 */
export function renderNoticeEmail({ title = '', content = '', link = '' } = {}) {
  const text = String(content).replace(/\s+/g, ' ').trim();
  return renderBrandEmail({
    title: '班级助理 · 新通知',
    intro: `班里发布了新通知《${escHtml(title)}》：`,
    body: escHtml(text),
    cta: link ? { url: link, label: '查看详情' } : null,
    warn: '',
    footer: SUBSCRIPTION_FOOTER
  });
}

/** 表单推送模板。参数与表单行字段同名（见 formHandler）；deadline 是截止时间，link 到填写页 */
export function renderFormEmail({ title = '', description = '', deadline = '', link = '' } = {}) {
  const parts = [];
  if (deadline) parts.push(`截止时间：${emailTime(deadline)}`);
  const text = String(description).replace(/\s+/g, ' ').trim();
  if (text) parts.push(text);
  return renderBrandEmail({
    title: '班级助理 · 新表单',
    intro: `有一份待填表单《${escHtml(title)}》：`,
    body: parts.map(escHtml).join('<br>'),
    cta: link ? { url: link, label: '去填写' } : null,
    warn: '',
    footer: SUBSCRIPTION_FOOTER
  });
}
