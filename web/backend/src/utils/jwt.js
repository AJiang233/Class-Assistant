/**
 * JWT 工具 - 使用 Web Crypto API 实现 HS256
 * 无外部依赖，Worker 原生支持
 */

const encoder = new TextEncoder();

/**
 * Base64 URL 编码
 */
function base64UrlEncode(buffer) {
  return btoa(String.fromCharCode(...new Uint8Array(buffer)))
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/, '');
}

/**
 * Base64 URL 解码
 */
function base64UrlDecode(str) {
  str = str.replace(/-/g, '+').replace(/_/g, '/');
  while (str.length % 4) str += '=';
  return Uint8Array.from(atob(str), c => c.charCodeAt(0));
}

/**
 * 生成 JWT
 * @param {Object} payload - 载荷数据
 * @param {string} secret - 密钥
 * @param {number} expiresIn - 过期时间（秒），默认 7 天
 * @returns {Promise<string>}
 */
export async function sign(payload, secret, expiresIn = 604800) {
  const header = { alg: 'HS256', typ: 'JWT' };
  const now = Math.floor(Date.now() / 1000);

  const data = {
    ...payload,
    iat: now,
    exp: now + expiresIn
  };

  const headerEncoded = base64UrlEncode(encoder.encode(JSON.stringify(header)));
  const payloadEncoded = base64UrlEncode(encoder.encode(JSON.stringify(data)));

  const signatureInput = `${headerEncoded}.${payloadEncoded}`;
  const key = await crypto.subtle.importKey(
    'raw',
    encoder.encode(secret),
    { name: 'HMAC', hash: 'SHA-256' },
    false,
    ['sign']
  );
  const signatureBuffer = await crypto.subtle.sign(
    'HMAC',
    key,
    encoder.encode(signatureInput)
  );
  const signature = base64UrlEncode(signatureBuffer);

  return `${signatureInput}.${signature}`;
}

/**
 * 验证并解码 JWT
 * @param {string} token - JWT 字符串
 * @param {string} secret - 密钥
 * @returns {Promise<Object|null>} 解码后的 payload，验证失败返回 null
 */
export async function verify(token, secret) {
  try {
    const parts = token.split('.');
    if (parts.length !== 3) return null;

    const [headerEncoded, payloadEncoded, signature] = parts;
    const signatureInput = `${headerEncoded}.${payloadEncoded}`;

    const key = await crypto.subtle.importKey(
      'raw',
      encoder.encode(secret),
      { name: 'HMAC', hash: 'SHA-256' },
      false,
      ['verify']
    );

    const signatureBuffer = base64UrlDecode(signature);
    const isValid = await crypto.subtle.verify(
      'HMAC',
      key,
      signatureBuffer,
      encoder.encode(signatureInput)
    );

    if (!isValid) return null;

    const payload = JSON.parse(new TextDecoder().decode(base64UrlDecode(payloadEncoded)));

    // 检查过期时间
    const now = Math.floor(Date.now() / 1000);
    if (payload.exp && payload.exp < now) return null;

    return payload;
  } catch {
    return null;
  }
}
