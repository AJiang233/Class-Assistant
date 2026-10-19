/**
 * 用户协议（含学习通 / 教务系统两项可选授权）的版本与读写口径。
 *
 * 这里只放纯函数：能不能登录、要不要弹窗，全由「库里那条记录 + 当前协议版本号」算出来，
 * 不依赖客户端缓存 —— 换设备、清缓存、多端同时登录都得到同一个结论。
 */

/**
 * 协议版本号。
 *
 * 每次改动协议正文（web/legal 下的页面）都要把它换成新日期：老账号下一次登录就会
 * 重新弹窗、重新勾选，不用手工刷库。日期型字符串便于对照协议页面上印的「更新日期」。
 */
export const AGREEMENT_VERSION = '2026-10-19';

/**
 * 这条记录是否算「已同意、且同意的是当前版本」。
 *
 * 只认 terms（必选项）：没同意过用户协议就没有使用资格。学习通 / 教务是两项可选授权，
 * 不影响能否登录，由各业务路由单独把关（例如教务转发前检查 academic）。
 */
export function isCurrentConsent(row) {
  if (!row) return false;
  if (row.version !== AGREEMENT_VERSION) return false;
  return Number(row.terms) === 1;
}

/**
 * 把库里的行转成给前端的摘要（0/1 → true/false，时间为空给 null）。
 *
 * row 为 null（从没同意过）时返回 null：这样前端能区分「没有记录」和「有记录但三项全关」，
 * 后者不需要再弹一次协议。
 */
export function summarizeConsent(row) {
  if (!row) return null;
  return {
    version: row.version,
    terms: Number(row.terms) === 1,
    chaoxing: Number(row.chaoxing) === 1,
    academic: Number(row.academic) === 1,
    terms_agreed_at: row.terms_agreed_at || null,
    chaoxing_agreed_at: row.chaoxing_agreed_at || null,
    academic_agreed_at: row.academic_agreed_at || null,
    updated_at: row.updated_at || null
  };
}

/**
 * 校验登录 / 修改授权请求体里的 consent 字段。
 *
 * 返回 null 表示「形状不合法」，调用方据此回 400。terms 必须显式为 true（或数字 1）：
 * 缺省、false、"true" 一律不认 —— 免得客户端漏传字段被当成「同意」。
 * chaoxing / academic 是可选项，没传或非 true 就当不同意。
 */
export function parseConsentPayload(payload) {
  if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return null;
  const terms = payload.terms;
  if (!(terms === true || terms === 1)) return null;
  return {
    terms: true,
    chaoxing: payload.chaoxing === true || payload.chaoxing === 1,
    academic: payload.academic === true || payload.academic === 1
  };
}
