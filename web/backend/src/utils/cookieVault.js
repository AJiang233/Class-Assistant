/**
 * 教务会话 Cookie 落库前加密。
 *
 * 密文格式：v1.<iv>.<ciphertext>，AES-256-GCM。
 * 密钥优先用 COOKIE_SECRET；本地没配时退回 JWT_SECRET 派生，避免开发环境直接挂掉。
 * 读旧数据时若还是明文，原样返回，下次写入再封存。
 */

const PREFIX = 'v1.';

function bytesToB64(bytes) {
  const arr = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes);
  let binary = '';
  for (let i = 0; i < arr.length; i++) binary += String.fromCharCode(arr[i]);
  return btoa(binary).replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/, '');
}

function b64ToBytes(str) {
  const padded = str.replace(/-/g, '+').replace(/_/g, '/');
  const pad = padded.length % 4 === 0 ? '' : '='.repeat(4 - (padded.length % 4));
  return Uint8Array.from(atob(padded + pad), (c) => c.charCodeAt(0));
}

export function isSealed(value) {
  return String(value || '').startsWith(PREFIX);
}

export function vaultSecret(env) {
  const dedicated = env && env.COOKIE_SECRET;
  if (dedicated) return String(dedicated);
  const jwt = env && env.JWT_SECRET;
  if (jwt) return `${jwt}:academic-cookie-v1`;
  throw new Error('缺少 COOKIE_SECRET / JWT_SECRET，无法封存教务会话');
}

/** 解密时按这个顺序试：现用密钥 → 旧的 JWT 派生密钥。后加 COOKIE_SECRET 不能把已封存记录锁死。 */
function vaultSecrets(env) {
  const list = [];
  if (env && env.COOKIE_SECRET) list.push(String(env.COOKIE_SECRET));
  if (env && env.JWT_SECRET) list.push(`${env.JWT_SECRET}:academic-cookie-v1`);
  return [...new Set(list)];
}

async function importKey(secret) {
  const raw = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(String(secret)));
  return crypto.subtle.importKey('raw', raw, { name: 'AES-GCM' }, false, ['encrypt', 'decrypt']);
}

/** 明文 Cookie → 密文；已经是密文则原样返回 */
export async function sealCookies(env, cookies) {
  const text = String(cookies || '');
  if (!text) return text;
  if (isSealed(text)) return text;
  const key = await importKey(vaultSecret(env));
  const iv = crypto.getRandomValues(new Uint8Array(12));
  const cipher = await crypto.subtle.encrypt(
    { name: 'AES-GCM', iv },
    key,
    new TextEncoder().encode(text)
  );
  return `${PREFIX}${bytesToB64(iv)}.${bytesToB64(cipher)}`;
}

/** 密文 → 明文；旧的明文记录兼容读取 */
export async function openCookies(env, stored) {
  const text = String(stored || '');
  if (!text) return '';
  if (!isSealed(text)) return text;
  const parts = text.split('.');
  if (parts.length !== 3 || parts[0] !== 'v1') {
    throw new Error('教务会话密文损坏');
  }
  const iv = b64ToBytes(parts[1]);
  const data = b64ToBytes(parts[2]);
  const secrets = vaultSecrets(env);
  if (!secrets.length) throw new Error('缺少 COOKIE_SECRET / JWT_SECRET，无法解封教务会话');

  let lastErr = null;
  for (const secret of secrets) {
    try {
      const key = await importKey(secret);
      const plain = await crypto.subtle.decrypt({ name: 'AES-GCM', iv }, key, data);
      return new TextDecoder().decode(plain);
    } catch (e) {
      lastErr = e;
    }
  }
  throw lastErr || new Error('教务会话密文损坏');
}
