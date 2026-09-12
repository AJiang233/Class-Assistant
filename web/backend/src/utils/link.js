/**
 * 通知 link 只允许站内相对路径。
 * 允许 /forms.html?id=1 这类；拒绝 //evil.com（协议相对外站）、http(s):、javascript:、data:。
 */
const SAFE_LINK = /^\/[A-Za-z0-9._\-\/?=&%#]*$/;

export function isSafeLink(value) {
  const s = String(value == null ? '' : value).trim();
  if (!s) return true;                      // 空表示不带跳转
  if (s.startsWith('//')) return false;      // 协议相对地址等于外站，正则本身拦不住
  return SAFE_LINK.test(s);
}
