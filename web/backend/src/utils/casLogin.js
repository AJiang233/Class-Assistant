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
const AUTH_HOST = 'authserver.njau.edu.cn';

/**
 * 统一身份认证入口：必须从教务侧的 SSO 地址进，不能直接拿 CAS 登录页当入口。
 *
 * 该地址取自教务的公开配置接口 POST /api/qsmart/common/sysConfig/white（key = SsoUrl），
 * 它带上了 platformCode 与回调 service。由教务侧生成的 service 才是「换会话」的那一环：
 * CAS 把 ticket 送回教务的 SSO 回调，由回调换取 accessToken / X-Qz-JSession 并下发。
 * 直接以登录页为 service 时，ticket 会落到一个不处理 ticket 的静态页，永远换不到会话。
 */
const SSO_ENTRY = `${SCHOOL_ORIGIN}/api/login/sso/cas/login?platformCode=DEF_CAS&service=${encodeURIComponent(`${SCHOOL_ORIGIN}/`)}`;

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

/** 无 Path 属性时，浏览器按「请求路径去掉最后一段」作为默认 Path */
function defaultCookiePath(pathname) {
  const p = pathname || '/';
  if (p[0] !== '/') return '/';
  const idx = p.lastIndexOf('/');
  return idx <= 0 ? '/' : p.slice(0, idx);
}

/** Path 必须是以 / 开头的前缀，否则按默认 / 处理 */
function normalizeCookiePath(path) {
  return path && path[0] === '/' ? path : '/';
}

/** RFC 6265 的路径匹配：完全相等，或前缀且边界为 / */
function cookiePathMatches(requestPath, cookiePath) {
  if (requestPath === cookiePath) return true;
  if (!requestPath.startsWith(cookiePath)) return false;
  return cookiePath.endsWith('/') || requestPath[cookiePath.length] === '/';
}

/**
 * 跳转链会横跨 authserver / workflow / szjw 三个域，这里按域分别记 Cookie。
 *
 * 必须带上 Path：workflow 网关会给同名 Cookie 下发多个 Path 版本
 * （如 INGRESSCOOKIE 分别在 /cas 与 /sso 各一份，还有 DEVICE_ID/TGC/JSESSIONID）。
 * 若只按名字存取，/sso 的值会覆盖 /cas 的值，访问 /cas/* 时就带错了
 * nginx-ingress 的会话保持 Cookie，导致 workflow 找不到会话、回跳 /sso/403。
 */
class CookieJar {
  constructor() {
    this.map = new Map(); // key: `${domain}\t${path}\t${name}`
  }

  add(response, url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return;
    }
    const host = parsed.hostname.toLowerCase();
    const defaultPath = defaultCookiePath(parsed.pathname);
    for (const raw of readSetCookies(response)) {
      const [pair, ...attrs] = raw.split(';');
      const eq = pair.indexOf('=');
      if (eq <= 0) continue;
      const name = pair.slice(0, eq).trim();
      const value = pair.slice(eq + 1).trim();
      let domain = host;
      let path = defaultPath;
      let maxAge = null;
      let expires = null;
      for (const attr of attrs) {
        const i = attr.indexOf('=');
        const k = (i < 0 ? attr : attr.slice(0, i)).trim().toLowerCase();
        const v = i < 0 ? '' : attr.slice(i + 1).trim();
        if (k === 'domain' && v) domain = v.replace(/^\./, '').toLowerCase();
        else if (k === 'path' && v) path = normalizeCookiePath(v);
        else if (k === 'max-age') maxAge = Number(v);
        else if (k === 'expires') expires = Date.parse(v);
      }
      const key = `${domain}\t${path}\t${name}`;
      const expired =
        value === '' ||
        (maxAge !== null && Number.isFinite(maxAge) && maxAge <= 0) ||
        (expires !== null && !Number.isNaN(expires) && expires <= Date.now());
      // 过期只删同域 + 同 Path + 同名的那一份，不波及其它 Path 的同名 Cookie
      if (expired) this.map.delete(key);
      else this.map.set(key, { name, value, domain, path });
    }
  }

  /** 选出对该 URL 生效的 Cookie（域匹配 + 路径匹配），更具体的 Path 优先 */
  matchesFor(url) {
    let parsed;
    try {
      parsed = new URL(url);
    } catch {
      return [];
    }
    const host = parsed.hostname.toLowerCase();
    const requestPath = parsed.pathname || '/';
    const out = [];
    for (const c of this.map.values()) {
      if (host !== c.domain && !host.endsWith(`.${c.domain}`)) continue;
      if (!cookiePathMatches(requestPath, c.path)) continue;
      out.push(c);
    }
    out.sort((a, b) => b.path.length - a.path.length);
    return out;
  }

  headerFor(url) {
    return this.matchesFor(url)
      .map((c) => `${c.name}=${c.value}`)
      .join('; ');
  }

  /** 只取 Cookie 名（不取值），用于失败时定位问题 */
  namesFor(url) {
    return this.matchesFor(url).map((c) => c.name);
  }

  /** 序列化：多因子认证要跨请求续用同一个 CAS 会话 */
  toJSON() {
    return Array.from(this.map.values());
  }

  static fromJSON(list) {
    const jar = new CookieJar();
    for (const c of list || []) {
      if (c && c.name && c.domain) {
        const path = normalizeCookiePath(c.path || '/');
        jar.map.set(`${c.domain}\t${path}\t${c.name}`, { name: c.name, value: c.value, domain: c.domain, path });
      }
    }
    return jar;
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
    // 跳转后降级为 GET，且不再带表单的 Content-Type / Origin / Referer：
    // 后续站点是 workflow/szjw，带着 authserver 的跨域头可能被网关当成异常请求
    res = await send(url, jar);
  }
  return { res, url, hops };
}

/** 跳转链里的地址可能带一次性 ticket，输出前打码 */
function safeUrl(u) {
  try {
    const x = new URL(u);
    const q = x.search ? x.search.replace(/(ticket=)[^&]*/i, '$1***') : '';
    return `${x.host}${x.pathname}${q.slice(0, 120)}`;
  } catch {
    return String(u).slice(0, 120);
  }
}

/** 记录每一跳的状态与下发 Cookie 名（诊断用） */
async function traceRedirects(startUrl, jar, maxHops = 10) {
  const chain = [];
  let url = startUrl;
  for (let i = 0; i < maxHops; i++) {
    const res = await send(url, jar, {});
    const location = res.headers.get('Location');
    const next = location ? new URL(location, url).toString() : '';
    chain.push({
      url,
      status: res.status,
      next,
      setCookies: readSetCookies(res).map((c) => c.split('=')[0])
    });
    if (!next || res.status < 300 || res.status >= 400) break;
    url = next;
  }
  return chain;
}

/** 一跳的可读描述 */
function describeHop(hop) {
  const sets = hop.setCookies.length ? ` set[${hop.setCookies.join(',')}]` : '';
  const next = hop.next ? ` → ${safeUrl(hop.next)}` : '';
  return `${safeUrl(hop.url)} [${hop.status}]${next}${sets}`;
}

function attrValue(html, id) {
  const m = html.match(new RegExp(`id="${id}"[^>]*value="([^"]*)"`));
  return m ? m[1] : '';
}

/**
 * 取 CAS 失败页里的真实错误文案。
 * 服务端把文案放在 <span id="showErrorTip"> 里（里面还套了一层 span，必须先剥标签再取文本），
 * 例如「图形动态码错误」；拿不到就返回空串
 */
function extractErrorText(html) {
  const m = html.match(/id="showErrorTip"[^>]*>([\s\S]{0,300}?)<\/div>/);
  if (!m) return '';
  return m[1]
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 60);
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

// ===== 多因子认证（MFA）=====

/** 支持的二次验证方式：3 = 短信验证码，11 = 邮箱验证码 */
const MFA_CODE_TYPES = {
  3: { name: 'reAuthDynamicCodeType', label: '短信验证码', field: 'phone' },
  11: { name: 'reAuthEmailDynamicCodeType', label: '邮箱验证码', field: 'email' }
};

/** 该二次验证方式能否由我们代答（短信 / 邮箱验证码可以，扫码/人脸等不行） */
export function isMfaCodeSupported(reAuthType) {
  return !!MFA_CODE_TYPES[String(reAuthType)];
}

/** 二次验证方式的中文名 */
export function mfaMethodLabel(reAuthType) {
  const type = MFA_CODE_TYPES[String(reAuthType)];
  return type ? type.label : '二次验证';
}

/** 从多因子页面里取出 reAuthParams（一段合法的 JSON 字面量） */
function parseReAuthParams(html) {
  const i = html.indexOf('reAuthParams');
  if (i < 0) return null;
  const start = html.indexOf('{', i);
  if (start < 0) return null;
  let depth = 0;
  for (let j = start; j < html.length; j++) {
    const c = html[j];
    if (c === '{') depth++;
    else if (c === '}') {
      depth--;
      if (depth === 0) {
        try {
          return JSON.parse(html.slice(start, j + 1));
        } catch {
          return null;
        }
      }
    }
  }
  return null;
}

/** 页面上的用户名输入框里带着掩码手机号，如 刘科江(132****8343) */
function parseMaskedContact(html) {
  const m = html.match(/id="username"[^>]*value="[^"]*?\(([^)]{4,30})\)/);
  return m ? m[1] : '';
}

/** 用中间态发起一次验证码下发 */
export async function sendMfaCode(state) {
  const type = MFA_CODE_TYPES[String(state.reAuthType)];
  if (!type) {
    throw new CasError('该账号的二次验证方式暂不支持代登录，请改用手动粘贴 Cookie 绑定', 'MFA_UNSUPPORTED');
  }
  const jar = CookieJar.fromJSON(state.jar);
  const mfaUrl = mfaPageUrl(state);
  const url = `${AUTH_ORIGIN}/authserver/dynamicCode/getDynamicCodeByReauth.do`;
  const res = await send(url, jar, {
    method: 'POST',
    body: new URLSearchParams({ userName: state.reAuthUserId, authCodeTypeName: type.name }).toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: AUTH_ORIGIN,
      Referer: mfaUrl,
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  });
  const text = await res.text();
  let json = null;
  try {
    json = JSON.parse(text);
  } catch {
    json = null;
  }
  if (!json || json.res !== 'success') {
    throw new CasError(
      (json && (json.returnMessage || json.msg)) || `验证码发送失败（HTTP ${res.status}）`,
      'MFA_SEND_FAILED'
    );
  }
  return { mobile: json.mobile || '', label: type.label, codeTime: json.codeTime || 120 };
}

/** 多因子页面的完整地址（Referer 要带查询串） */
function mfaPageUrl(state) {
  const q = new URLSearchParams({ isMultifactor: String(state.isMultifactor || 'true') });
  if (state.service) q.set('service', state.service);
  return `${AUTH_ORIGIN}/authserver/reAuthCheck/reAuthLoginView.do?${q.toString()}`;
}

/**
 * 提交二次验证码
 *
 * 这里固定提交 skipTmpReAuth=false（对应页面上的「仅本次登录」）：
 * 选「信任此设备」时 CAS 会尝试登记设备指纹，服务端代登录场景下这一步会静默失败，
 * 表现为 reAuthSubmit 回「认证成功」但随后 /login 又被要求二次验证，流程永远走不完。
 * 因此只用「仅本次登录」——安全性与浏览器一致，代价是会话失效后需重新验证一次。
 */
export async function verifyMfaCode(state, code) {
  const type = MFA_CODE_TYPES[String(state.reAuthType)];
  if (!type) {
    throw new CasError('该账号的二次验证方式暂不支持代登录，请改用手动粘贴 Cookie 绑定', 'MFA_UNSUPPORTED');
  }
  const jar = CookieJar.fromJSON(state.jar);
  const form = new URLSearchParams({
    service: state.service || '',
    reAuthType: String(state.reAuthType || ''),
    isMultifactor: String(state.isMultifactor || ''),
    password: '',
    dynamicCode: code,
    uuid: '',
    answer1: '',
    answer2: '',
    otpCode: '',
    skipTmpReAuth: 'false'
  });
  const res = await send(`${AUTH_ORIGIN}/authserver/reAuthCheck/reAuthSubmit.do`, jar, {
    method: 'POST',
    body: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
      Accept: 'application/json, text/javascript, */*; q=0.01',
      'Accept-Language': 'zh-CN,zh;q=0.9,en;q=0.8',
      'X-Requested-With': 'XMLHttpRequest',
      Origin: AUTH_ORIGIN,
      Referer: mfaPageUrl(state),
      'Sec-Fetch-Site': 'same-origin',
      'Sec-Fetch-Mode': 'cors',
      'Sec-Fetch-Dest': 'empty'
    }
  });
  const submitText = await res.text();
  let json = null;
  try {
    json = JSON.parse(submitText);
  } catch {
    json = null;
  }
  if (!json) {
    throw new CasError(`多因子认证返回异常：${submitText.slice(0, 160) || `HTTP ${res.status}`}`, 'MFA_ERROR');
  }
  if (json.code === 'reAuth_failed') {
    throw new CasError(json.msg || '验证码错误', 'MFA_CODE_INVALID');
  }
  if (json.code === 'reAuth_unauthorized') {
    throw new CasError(json.msg || '认证未通过', 'MFA_UNAUTHORIZED');
  }

  // 通过后照页面的做法跳到 /login?service=… 领 ticket，再一路跟到教务
  const loginUrl = `${AUTH_ORIGIN}/authserver/login?service=${encodeURIComponent(state.service || '')}`;
  const chain = await traceRedirects(loginUrl, jar);
  // 必须真的落到教务域（szjw）才算换到会话；停在 workflow 等中间域说明换会话失败
  const reachedSchool = hostOf(chain[chain.length - 1].url) === hostOf(SCHOOL_ORIGIN);
  const cookies = jar.headerFor(SCHOOL_ORIGIN);
  const cookieNames = jar.namesFor(SCHOOL_ORIGIN);

  if (reachedSchool && cookies) {
    return { cookies, hops: chain.map((h) => safeUrl(h.url)), cookieNames, trail: chain.map(describeHop) };
  }

  throw new CasError(
    `多因子认证已通过，但未换到教务会话（链路：${chain.map(describeHop).join(' | ')}；教务 Cookie：${cookieNames.join(',') || '无'}）`,
    'CAS_NO_SESSION'
  );
}

/**
 * 用学号 + 密码代理登录，返回可直接调用教务接口的会话 Cookie
 * @returns {Promise<{cookies: string, hops: string[]}>}
 * @throws {CasError}
 */
export async function loginWithPassword(studentId, password) {
  const jar = new CookieJar();

  // 1. 从教务的 SSO 入口出发，一路跟到 CAS 登录页。
  //    这一步很关键：CAS 的 service 由教务侧生成，之后 ticket 才会送回教务的 SSO 回调换会话。
  const page = await followRedirects(SSO_ENTRY, jar);

  // 已存在 CAS 会话时，这次 GET 会被直接带着 ticket 送回教务，无需再提交表单
  if (hostOf(page.url) !== AUTH_HOST) {
    const existing = jar.headerFor(SCHOOL_ORIGIN);
    if (existing) {
      return { cookies: existing, hops: page.hops.map(safeUrl), cookieNames: jar.namesFor(SCHOOL_ORIGIN) };
    }
  }

  // 提交表单要回到 CAS 实际给出的地址（带 service），而不是自己拼一个
  const casLoginUrl = page.url;
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

  const result = await followRedirects(casLoginUrl, jar, {
    method: 'POST',
    body: form.toString(),
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
      Referer: casLoginUrl,
      Origin: AUTH_ORIGIN
    }
  });

  const hops = result.hops.map(safeUrl);

  // 3. 还停在认证域：要么是凭据/验证码问题，要么是「认证已通过但要求多因子二次验证」
  if (hostOf(result.url) === AUTH_HOST) {
    const html = await result.res.text();

    // 多因子认证：把 CAS 会话与 reAuthParams 交给上层暂存，等用户回填验证码
    if (result.url.includes('reAuthLoginView.do')) {
      const params = parseReAuthParams(html);
      if (!params || !params.service) {
        throw new CasError('多因子认证页面结构变化，请改用手动粘贴 Cookie 绑定', 'MFA_PARSE_FAILED');
      }
      return {
        mfaRequired: true,
        contact: parseMaskedContact(html),
        state: {
          jar: jar.toJSON(),
          service: params.service,
          reAuthType: params.reAuthType,
          isMultifactor: params.isMultifactor,
          reAuthUserId: params.reAuthUserId
        }
      };
    }

    // 以服务端实际返回的文案为准（「图形动态码错误」= 要图形验证码）
    const text = extractErrorText(html);
    if (/验证码|动态码/.test(text)) {
      throw new CasError('教务登录需要图形验证码，请改用「手动粘贴 Cookie」绑定', 'CAS_NEED_CAPTCHA');
    }
    if (await needsCaptcha(jar, studentId)) {
      throw new CasError('当前账号或网络需要验证码，请改用「手动粘贴 Cookie」绑定', 'CAS_NEED_CAPTCHA');
    }
    throw new CasError(text || '学号或密码错误', 'CAS_LOGIN_FAILED');
  }

  // 4. 已回到教务域：ticket 落在教务的 SSO 回调上，由它换取会话并下发 Cookie
  //    必须真的落到 szjw；停在 workflow 等中间域只是拿到了中间站的 Cookie，换不到会话
  //    能不能用由调用方再用 sessionUserInfo 验一次
  if (hostOf(result.url) !== hostOf(SCHOOL_ORIGIN)) {
    throw new CasError(`登录流程未回到教务系统（跳转：${hops.join(' → ')}）`, 'CAS_NO_SESSION');
  }
  const cookies = jar.headerFor(SCHOOL_ORIGIN);
  if (!cookies) {
    throw new CasError(`登录已通过，但未取到教务会话（跳转：${hops.join(' → ')}）`, 'CAS_NO_SESSION');
  }
  return { cookies, hops, cookieNames: jar.namesFor(SCHOOL_ORIGIN) };
}
