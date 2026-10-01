/** 推送配置。业务广播统一交给 services/outbox.js，测试推送由 pushHandler 同步发送。 */
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
