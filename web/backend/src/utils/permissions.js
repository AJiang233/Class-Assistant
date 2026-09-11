/**
 * 基于职位的权限系统
 *
 * positions 字段存储形式：
 *   - 普通字符串，如 "班长"
 *   - JSON 字符串数组，如 '["班长","学习委员"]'
 *
 * 权限点：
 *   - content:write   发布/取消 通知、活动
 *   - user:manage     注册账号、管理班级成员（列表/删除）
 *
 * 读取权限默认对所有已登录用户开放，无需额外权限。
 */

export const ROLE_PERMISSIONS = {
  '班长': ['content:write', 'user:manage'],
  '团支书': ['content:write', 'user:manage'],
  '学习委员': ['content:write']
};

/** 系统预置职位：不允许写进 roles 表覆盖全班权限 */
export const RESERVED_ROLES = Object.freeze(['学生', '班长', '团支书', '学习委员']);

/** 自定义职位只能拥有这两个权限点，禁止东拼出 admin 之类 */
export const ALLOWED_PERMISSIONS = Object.freeze(['content:write', 'user:manage']);

export function isReservedRole(name) {
  return RESERVED_ROLES.includes(String(name || '').trim());
}

export function sanitizePermissions(list) {
  if (!Array.isArray(list)) return [];
  const out = [];
  for (const item of list) {
    const perm = String(item || '');
    if (ALLOWED_PERMISSIONS.includes(perm) && !out.includes(perm)) out.push(perm);
  }
  return out;
}

export function assertCustomRoleName(name) {
  const trimmed = String(name || '').trim();
  if (!trimmed) return { ok: false, message: '职位名称不能为空', code: 'INVALID_ROLE' };
  if (isReservedRole(trimmed)) {
    return { ok: false, message: '不能把系统预置职位当自定义职位写入权限表', code: 'RESERVED_ROLE' };
  }
  if (trimmed.length > 20) {
    return { ok: false, message: '职位名称最多 20 个字符', code: 'ROLE_TOO_LONG' };
  }
  return { ok: true, name: trimmed };
}

/**
 * 把 positions 解析为角色数组（兼容字符串与 JSON 数组）
 */
export function parsePositions(positions) {
  if (positions == null || positions === '') return [];
  const v = String(positions);
  if (v.charAt(0) === '[') {
    try {
      const arr = JSON.parse(v);
      return Array.isArray(arr) ? arr.filter(Boolean) : [v];
    } catch {
      return [v];
    }
  }
  return [v];
}

/**
 * 汇总某用户可拥有的所有权限
 * @param {string|string[]} positions
 * @param {Object} [customMap] - 自定义职位权限映射 { 职位名: [权限...] }，来自 roles 表
 * @returns {Set<string>}
 */
export function getPermissions(positions, customMap = {}) {
  const set = new Set();
  for (const role of parsePositions(positions)) {
    for (const perm of (ROLE_PERMISSIONS[role] || [])) {
      set.add(perm);
    }
    for (const perm of (customMap[role] || [])) {
      set.add(perm);
    }
  }
  return set;
}

/**
 * 判断某用户是否拥有指定权限
 * @param {string|string[]} positions
 * @param {string} perm
 * @param {Object} [customMap]
 * @returns {boolean}
 */
export function hasPermission(positions, perm, customMap = {}) {
  return getPermissions(positions, customMap).has(perm);
}

/**
 * 把 roles 表行记录构建为 职位名->权限数组 映射
 * @param {Array} roleRows - [{ name, permissions }]
 * @returns {Object}
 */
export function buildRoleMap(roleRows) {
  const map = {};
  for (const r of (roleRows || [])) {
    try {
      const arr = JSON.parse(r.permissions);
      map[r.name] = Array.isArray(arr) ? arr : [];
    } catch {
      map[r.name] = [];
    }
  }
  return map;
}
