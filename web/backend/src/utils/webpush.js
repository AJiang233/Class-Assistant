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
