/**
 * 密码哈希工具 - 使用 Web Crypto API (PBKDF2)
 * 无需额外依赖，Worker 原生支持
 */

const ITERATIONS = 100000;
const KEY_LENGTH = 64;
const HASH_ALGORITHM = 'SHA-256';

/**
 * 生成密码哈希
 * @param {string} password - 明文密码
 * @param {string} salt - 盐值（可选，不传则自动生成 16 字节随机盐）
 * @returns {Promise<{hash: string, salt: string}>}
 */
export async function hashPassword(password, salt = null) {
  const encoder = new TextEncoder();

  // 如果未传入 salt，生成 16 字节随机盐
  if (!salt) {
    const saltBuffer = crypto.getRandomValues(new Uint8Array(16));
    salt = Array.from(saltBuffer).map(b => b.toString(16).padStart(2, '0')).join('');
  }

  const keyMaterial = await crypto.subtle.importKey(
    'raw',
    encoder.encode(password),
    'PBKDF2',
    false,
    ['deriveBits']
  );

  const hashBuffer = await crypto.subtle.deriveBits(
    {
      name: 'PBKDF2',
      salt: encoder.encode(salt),
      iterations: ITERATIONS,
      hash: HASH_ALGORITHM
    },
    keyMaterial,
    KEY_LENGTH * 8
  );

  const hashArray = Array.from(new Uint8Array(hashBuffer));
  const hash = hashArray.map(b => b.toString(16).padStart(2, '0')).join('');

  return { hash, salt };
}

/**
 * 验证密码
 * @param {string} password - 明文密码
 * @param {string} hash - 存储的哈希值
 * @param {string} salt - 存储的盐值
 * @returns {Promise<boolean>}
 */
/** 定长字符串比较，避免按字符短路返回 */
export function timingSafeEqual(left, right) {
  const a = String(left || '');
  const b = String(right || '');
  if (a.length !== b.length) return false;
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a.charCodeAt(i) ^ b.charCodeAt(i);
  return diff === 0;
}

export async function verifyPassword(password, hash, salt) {
  const result = await hashPassword(password, salt);
  return timingSafeEqual(result.hash, hash);
}
