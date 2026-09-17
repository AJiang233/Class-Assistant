/**
 * Web Push 发送实现（不依赖任何 npm 包）。
 *
 * 为什么自己写：常用的 `web-push` 包依赖 Node 的 `crypto` 模块，在 Workers 里跑不了。
 * 这里只用 WebCrypto（RFC 8291 的 aes128gcm + RFC 8292 的 VAPID）。
 *
 * 关键点：WebCrypto 的 HKDF 一次完成 extract+expand，而 RFC 8291 需要
 * 先用 auth_secret 做一次完整 HKDF 拿到 IKM，再从同一份 PRK 分别 expand 出
 * CEK 与 NONCE。所以 extract / expand 在这里分开手写（都基于 HMAC-SHA256）。
 */

const encoder = new TextEncoder();

/** 推送端点由用户上报，慢或恶意的端点不能一直挂住尾部的 waitUntil 任务 */
const PUSH_TIMEOUT_MS = 10000;

/**
 * 允许投递的推送服务主机（含子域）。
 *
 * 为什么需要白名单（issue #21）：endpoint 完全由客户端提供，过去只校验了 `https:`，
 * 于是一个 `https://127.0.0.1:xxxx/`、内网主机名或任意公网地址都能存进库，之后由服务端
 * 带着 VAPID 头去 POST —— 盲 SSRF，而「测试推送」还会把状态码回读给用户，等于一个端口探测器。
 *
 * 白名单之外一律拒绝，所以不需要再单独判私网 / 环回 / 链路本地地址：那些地址本来就不在清单里。
 *
 * 代价说清楚：某个浏览器换了推送服务域名，那台设备就会订阅不上（现象是订阅被拒 + 日志里有域名），
 * 往清单里加一行即可。**每条只写厂商专属的推送区，或实测确认过的那一个主机 —— 别放行混着别的
 * 服务的宽域**（比如 `googleapis.com`：那底下不只有 FCM，放行等于把整个 Google API 域打开）。
 *
 * 为什么 Apple 那条是整段 `push.apple.com` 而不是只写 `web.push.apple.com`（后者是 Safari / iOS
 * 主屏 App 实测会给出的端点主机，见下）：清单写窄了的代价是**那台设备从此收不到通知**，而 iOS
 * 正是最依赖 Web Push 的平台，写错了没人会来报；`push.apple.com` 只承载 Apple 自己的推送，
 * 放宽的收益（不会漏）大于代价。同理 `notify.windows.com` 与 `push.services.mozilla.com` 也是整段区。
 * 拿不准的第三方域名宁可不加：少一台能收通知是可观测、可补救的。
 */
export const PUSH_HOST_SUFFIXES = Object.freeze([
  'fcm.googleapis.com',         // Chromium 系（Chrome / Edge / Opera…，安卓与桌面）
  'push.services.mozilla.com',  // Firefox（实测端点主机是它的子域 updates.push.services.mozilla.com）
  'push.apple.com',             // Apple 推送区：Safari / iOS 主屏 App 的端点是 web.push.apple.com
  'notify.windows.com'          // 旧版 Edge（WNS：实测端点是 <hash>.notify.windows.com）
]);

/**
 * 推送端点是否可信：必须是 https，且主机在白名单内（精确匹配或作为子域）。
 * 纯函数，便于单测。
 */
export function isAllowedPushEndpoint(endpoint) {
  let url;
  try {
    url = new URL(String(endpoint == null ? '' : endpoint));
  } catch {
    return false;
  }
  if (url.protocol !== 'https:') return false;
  const host = url.hostname.toLowerCase();
  return PUSH_HOST_SUFFIXES.some((s) => host === s || host.endsWith('.' + s));
}

/**
 * 端点的主机名，**只给日志和报错用**。
 *
 * 为什么只取主机名：endpoint 的路径里那串 token 就是发送凭据，谁能看到谁就能给这台设备发通知，
 * 所以它不能进日志。主机名足够定位「白名单少写了谁」这件事。
 * 解析失败（本来就是要拒掉的坏输入）时回一段截断的原文，且绝不因此抛错。
 */
export function hostOfEndpoint(endpoint) {
  const raw = String(endpoint == null ? '' : endpoint);
  try {
    return new URL(raw).hostname || '(取不到主机名)';
  } catch {
    return `(不是合法 URL) ${raw.slice(0, 40)}`;
  }
}

/** base64url 字符串 → 字节 */
export function b64uToBytes(input) {
  const s = String(input == null ? '' : input).replace(/-/g, '+').replace(/_/g, '/');
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  let bin;
  try {
    bin = atob(s + pad);
  } catch {
    // 交给调用方一个说人话的错误，而不是底层 atob 的 InvalidCharacterError
    throw new Error('推送密钥不是合法的 base64url');
  }
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

/** 字节 → base64url 字符串 */
export function bytesToB64u(bytes) {
  let bin = '';
  for (let i = 0; i < bytes.length; i++) bin += String.fromCharCode(bytes[i]);
  return btoa(bin).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function concat(...parts) {
  const total = parts.reduce((n, p) => n + p.length, 0);
  const out = new Uint8Array(total);
  let offset = 0;
  for (const p of parts) { out.set(p, offset); offset += p.length; }
  return out;
}

async function hmacSha256(keyBytes, dataBytes) {
  const key = await crypto.subtle.importKey('raw', keyBytes, { name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
  return new Uint8Array(await crypto.subtle.sign('HMAC', key, dataBytes));
}

/** HKDF-Extract(salt, ikm) = HMAC(salt, ikm) */
async function hkdfExtract(salt, ikm) {
  return hmacSha256(salt, ikm);
}

/** HKDF-Expand(prk, info, length)：T(n) = HMAC(prk, T(n-1) || info || n) */
async function hkdfExpand(prk, info, length) {
  const out = new Uint8Array(length);
  let block = new Uint8Array(0);
  let offset = 0;
  for (let counter = 1; offset < length; counter++) {
    block = await hmacSha256(prk, concat(block, info, new Uint8Array([counter])));
    const take = Math.min(block.length, length - offset);
    out.set(block.subarray(0, take), offset);
    offset += take;
  }
  return out;
}

/**
 * 按 RFC 8188 / RFC 8291 加密一条推送载荷。
 * @param {{p256dh: string, auth: string}} subscription 浏览器订阅里的公钥与认证密钥（base64url）
 * @param {string} plaintext 待发送内容（JSON 字符串）
 * @returns {Promise<Uint8Array>} aes128gcm 记录（含头部）
 */
export async function encryptPayload(subscription, plaintext) {
  const uaPublic = b64uToBytes(subscription.p256dh);
  const authSecret = b64uToBytes(subscription.auth);

  // 服务端一次性密钥对：私钥用于 ECDH，公钥要写进头部给浏览器解
  const asKeys = await crypto.subtle.generateKey({ name: 'ECDH', namedCurve: 'P-256' }, true, ['deriveBits']);
  const asPublic = new Uint8Array(await crypto.subtle.exportKey('raw', asKeys.publicKey));

  const uaKey = await crypto.subtle.importKey('raw', uaPublic, { name: 'ECDH', namedCurve: 'P-256' }, false, []);
  const ecdhSecret = new Uint8Array(await crypto.subtle.deriveBits({ name: 'ECDH', public: uaKey }, asKeys.privateKey, 256));

  const salt = crypto.getRandomValues(new Uint8Array(16));

  // IKM = HKDF(auth_secret, ecdh_secret, "WebPush: info" || 0 || ua_public || as_public)
  const keyInfo = concat(encoder.encode('WebPush: info'), new Uint8Array([0]), uaPublic, asPublic);
  const prkKey = await hkdfExtract(authSecret, ecdhSecret);
  const ikm = await hkdfExpand(prkKey, keyInfo, 32);

  // PRK = HKDF-Extract(salt, IKM)，再由它分别展开 CEK 与 NONCE
  const prk = await hkdfExtract(salt, ikm);
  const cek = await hkdfExpand(prk, concat(encoder.encode('Content-Encoding: aes128gcm'), new Uint8Array([0])), 16);
  const nonce = await hkdfExpand(prk, concat(encoder.encode('Content-Encoding: nonce'), new Uint8Array([0])), 12);

  // 单条记录：明文 + 0x02 分隔符（无额外补白）
  const data = concat(encoder.encode(plaintext), new Uint8Array([2]));
  const cekKey = await crypto.subtle.importKey('raw', cek, { name: 'AES-GCM' }, false, ['encrypt']);
  const cipher = new Uint8Array(await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv: nonce, tagLength: 128 }, cekKey, data
  ));

  // 头部：salt(16) || rs(4, 大端) || idlen(1) || keyid(as_public)
  const rs = 4096;
  const header = new Uint8Array(16 + 4 + 1 + asPublic.length);
  header.set(salt, 0);
  new DataView(header.buffer).setUint32(16, rs, false);
  header[20] = asPublic.length;
  header.set(asPublic, 21);

  return concat(header, cipher);
}

/**
 * 生成 VAPID 授权头（RFC 8292）：`vapid t=<ES256 JWT>, k=<公钥>`
 * @param {string} endpoint 订阅端点，JWT 的 aud 取它的 origin
 * @param {{publicKey: string, privateKey: string, subject: string}} vapid
 */
export async function buildVapidHeader(endpoint, vapid) {
  const aud = new URL(endpoint).origin;
  const header = bytesToB64u(encoder.encode(JSON.stringify({ typ: 'JWT', alg: 'ES256' })));
  const payload = bytesToB64u(encoder.encode(JSON.stringify({
    aud,
    exp: Math.floor(Date.now() / 1000) + 12 * 3600,
    sub: vapid.subject
  })));
  const signingInput = header + '.' + payload;

  // 私钥是 32 字节原始值，JWK 还缺 x/y，从公钥（未压缩点）里取
  const pub = b64uToBytes(vapid.publicKey);
  // 长度不对时 subarray(1,33)/(33,65) 会静默截断出错误的 x/y，
  // 最后抛一个难以理解的 importKey 错误 —— 这里先给出可定位的提示
  if (pub.length !== 65 || pub[0] !== 4) {
    throw new Error('VAPID 公钥必须是 65 字节的未压缩 P-256 点（0x04 开头），请检查 VAPID_PUBLIC_KEY');
  }
  const jwk = {
    kty: 'EC',
    crv: 'P-256',
    d: vapid.privateKey,
    x: bytesToB64u(pub.subarray(1, 33)),
    y: bytesToB64u(pub.subarray(33, 65))
  };
  const key = await crypto.subtle.importKey('jwk', jwk, { name: 'ECDSA', namedCurve: 'P-256' }, false, ['sign']);
  const sig = new Uint8Array(await crypto.subtle.sign(
    { name: 'ECDSA', hash: 'SHA-256' }, key, encoder.encode(signingInput)
  ));

  return 'vapid t=' + signingInput + '.' + bytesToB64u(sig) + ', k=' + vapid.publicKey;
}

/**
 * 发一条 Web Push。
 * 端点返回 404 / 410 表示订阅已失效，调用方应删除该订阅。
 */
export async function sendWebPush(subscription, payloadObject, vapid) {
  // 投递前再过一道白名单：库里的行可能是加白名单之前存下的（issue #21），
  // 而这里是「带着 VAPID 头往任意地址发 POST」的唯一出口，两个调用方都走它。
  if (!isAllowedPushEndpoint(subscription.endpoint)) {
    throw new Error(`推送端点不在白名单内，已跳过：${hostOfEndpoint(subscription.endpoint)}`);
  }
  const body = await encryptPayload(subscription, JSON.stringify(payloadObject));
  const authorization = await buildVapidHeader(subscription.endpoint, vapid);
  return fetch(subscription.endpoint, {
    method: 'POST',
    headers: {
      Authorization: authorization,
      'Content-Encoding': 'aes128gcm',
      'Content-Type': 'application/octet-stream',
      TTL: '86400'
    },
    body,
    signal: AbortSignal.timeout(PUSH_TIMEOUT_MS)
  });
}
