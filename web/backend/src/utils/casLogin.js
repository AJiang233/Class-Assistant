/**
 * 统一身份认证（金智 CAS）代登录
 *
 * 登录链路：authserver.njau.edu.cn（CAS）→ workflow.njau.edu.cn → szjw.njau.edu.cn
 * 这里在服务端复刻整条链路，成功后只把「教务域的会话 Cookie」交给绑定逻辑，
 * 密码用完即弃——不落库、不打日志、不返回给前端。
 *
 * 密码加密（复刻自 authserver 的 encrypt.js，保持完全一致）：
 *   明文 = 随机 64 位串 + 密码，key = 登录页里的 pwdEncryptSalt，
 *   iv = 随机 16 位串，AES-CBC / Pkcs7，输出 Base64（不含 iv）。
 *   同时按页面的行为一并提交 passwordText（明文），由服务端决定取哪个。
 *
 * 验证码：由服务端按账号/风控决定，正常登录不校验（实测 isNeed=false）。
 * 一旦触发验证码（图片或滑块），服务端代答不了，直接抛 CAS_NEED_CAPTCHA，引导用户改用手动粘贴。
 */

import { DESKTOP_UA, SCHOOL_ORIGIN } from './schoolApi.js';

const AUTH_ORIGIN = 'https://authserver.njau.edu.cn';
const LOGIN_URL = `${AUTH_ORIGIN}/authserver/login`;

/** 与 authserver 的 randomString 保持同一字符集 */
const RANDOM_CHARS = 'ABCDEFGHJKMNPQRSTWXYZabcdefhijkmnprstwxyz2345678';

export class CasError extends Error {
  constructor(message, code) {
    super(message);
    this.name = 'CasError';
    this.code = code;
  }
}

// ===== 加密 =====

function randomString(length) {
  const bytes = new Uint8Array(length);
  crypto.getRandomValues(bytes);
  let out = '';
  for (let i = 0; i < length; i++) out += RANDOM_CHARS[bytes[i] % RANDOM_CHARS.length];
  return out;
}

function toBase64(buffer) {
  const bytes = new Uint8Array(buffer);
  let binary = '';
  for (let i = 0; i < bytes.length; i++) binary += String.fromCharCode(bytes[i]);
  return btoa(binary);
}

/** 密码加密；盐值缺失或长度不合法时与页面一样回退为明文 */
async function encryptPassword(password, salt) {
  const key = new TextEncoder().encode(String(salt || '').trim());
  if (!key.length || ![16, 24, 32].includes(key.length)) return password;

  const iv = new TextEncoder().encode(randomString(16));
  const data = new TextEncoder().encode(randomString(64) + password);
  const cryptoKey = await crypto.subtle.importKey('raw', key, { name: 'AES-CBC' }, false, ['encrypt']);
  const encrypted = await crypto.subtle.encrypt({ name: 'AES-CBC', iv }, cryptoKey, data);
  return toBase64(encrypted);
}

// ===== 会话 Cookie 罐 =====

/** 兼容不支持 Headers.getSetCookie 的运行时 */
function readSetCookies(response) {
  if (typeof response.headers.getSetCookie === 'function') return response.headers.getSetCookie();
  const single = response.headers.get('set-cookie');
  if (!single) return [];
  return single.split(/,(?=\s*[^;,\s]+=)/);
}

/** 跳转链会横跨 authserver / workflow / szjw 三个域，这里按域分别记 Cookie */
class CookieJar {
  constructor() {
    this.map = new Map();
  }

  add(response, url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return;
    }
    for (const raw of readSetCookies(response)) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      for (const attr of attrs) {
        const [k, v] = attr.split('=');
        if (v && k && k.trim().toLowerCase() === 'domain') {
          domain = v.trim().replace(/^\./, '').toLowerCase();
        }
      }
      const key = `${domain}\t${name}`;
      if (value) this.map.set(key, { name, value, domain });
      else this.map.delete(key);
    }
  }

  headerFor(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return '';
    }
    const out = [];
    for (const c of this.map.values()) {
      if (host === c.domain || host.endsWith(`.${c.domain}`)) out.push(`${c.name}=${c.value}`);
    }
    return out.join('; ');
  }

  /** 只取 Cookie 名（不取值），用于失败时定位问题 */
  namesFor(url) {
    let host;
    try {
      host = new URL(url).hostname.toLowerCase();
    } catch {
      return [];
    }
    const out = [];
    for (const c of this.map.values()) {
      if (host === c.domain || host.endsWith(`.${c.domain}`)) out.push(c.name);
    }
    return out;
  }
}

// ===== 请求 =====

function hostOf(url) {
  try {
    return new URL(url).host;
  } catch {
    return url;
  }
}

async function send(url, jar, options = {}) {
  const headers = { 'User-Agent': DESKTOP_UA, Accept: '*/*', ...(options.headers || {}) };
  const cookie = jar.headerFor(url);
  if (cookie) headers.Cookie = cookie;
  const res = await fetch(url, {
    method: options.method || 'GET',
    headers,
    body: options.body,
    redirect: 'manual'
  });
  jar.add(res, url);
  return res;
}

/** 手动跟随跳转：沿途收集各域下发的 Set-Cookie */
async function followRedirects(startUrl, jar, options = {}, maxHops = 10) {
  const hops = [];
  let url = startUrl;
  let res = await send(url, jar, options);
  hops.push(url);

  let left = maxHops;
  while (res.status >= 300 && res.status < 400 && left-- > 0) {
    const location = res.headers.get('Location');
    if (!location) break;
    url = new URL(location, url).toString();
    hops.push(url);
    // 跳转后降级为 GET，避免把登录凭据重发到后续站点
    res = await send(url, jar, { headers: options.headers });
  }
  return { res, url, hops };
}

function attrValue(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
  return m ? m[1] : '';
}

function extractErrorText(html) {
  for (const re of [/id="showErrorTip"[^>]*>([^<]{2,80})</, /class="[^"]*(?:error|msg)[^"]*"[^>]*>([^<]{2,80})</]) {
    const m = html.match(re);
    if (m) {
      const text = m[1].replace(/&nbsp;/g, ' ').trim();
      if (text) return text;
    }
  }
  return '';
}

/** 登录失败后问一次：是不是被要求验证码了 */
async function needsCaptcha(jar, studentId) {
  try {
    const url = `${AUTH_ORIGIN}/authserver/checkNeedCaptcha.htl?username=${encodeURIComponent(studentId)}`;
    const res = await send(url, jar, { headers: { 'X-Requested-With': 'XMLHttpRequest' } });
    const json = await res.json();
    return !!(json && json.isNeed);
  } catch {
    return false;
  }
}

/**
 * 用学号 + 密码代理登录，返回可直接调用教务接口的会话 Cookie
 * @returns {Promise<{cookies: string, hops: string[]}>}
 * @throws {CasError}
 */
export async function loginWithPassword(studentId, password) {
  const jar = new CookieJar();

  // 1. 取登录页：拿盐值 / lt / execution，同时建立 CAS 会话
  const page = await followRedirects(LOGIN_URL, jar);
  const html = await page.res.text();
  const salt = attrValue(html, 'pwdEncryptSalt');
  const lt = attrValue(html, 'lt');
  const execution = attrValue(html, 'execution') || 'e1s1';

  // 2. 提交登录表单（字段与页面的 pwdFromId 表单一致）
  const form = new URLSearchParams({
    username: studentId,
    password: await encryptPassword(password, salt),
    passwordText: password,
    lt,
    execution,
    _eventId: 'submit',
    cllt: 'userNameLogin',
    dllt: 'generalLogin',
    captcha: ''
  });

  const result = await followRedirects(LOGIN_URL, jar, {
    method: 'POST',
    body: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: LOGIN_URL,
      Origin: AUTH_ORIGIN
    }
  });

  const hops = result.hops.map(hostOf);

  // 3. 判定结果：拿到教务域会话即成功（后续由 sessionUserInfo 再校验一次）
  const cookies = jar.headerFor(SCHOOL_ORIGIN);
  if (cookies) return { cookies, hops };

  // 已经跳到教务/中转域却没有会话 —— 是链路问题，不是账号密码问题
  if (result.url.startsWith(SCHOOL_ORIGIN) || hops.some((h) => h.includes('workflow.njau.edu.cn'))) {
    const names = jar.namesFor(SCHOOL_ORIGIN);
    throw new CasError(
      `登录已通过，但未取到教务会话（已拿到：${names.join(',') || '无'}；跳转：${hops.join(' → ')}）`,
      'CAS_NO_SESSION'
    );
  }

  // 停在认证域：要么被要求验证码，要么账号密码不对
  if (await needsCaptcha(jar, studentId)) {
    throw new CasError('当前账号或网络需要验证码，请改用「手动粘贴 Cookie」绑定', 'CAS_NEED_CAPTCHA');
  }
  const text = extractErrorText(await result.res.text());
  throw new CasError(text || '学号或密码错误', 'CAS_LOGIN_FAILED');
}
