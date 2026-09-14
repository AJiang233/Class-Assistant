/**
 * 基于职位的权限系统
 *
 * positions 字段存储形式：
 *   - 普通字符串，如 "班长"
 *   - JSON 字符串数组，如 '["班长","学习委员"]'
 *
 * 权限点：
 *   - content:write   发布/取消 通知、活动，创建与管理表单
 *   - user:manage     注册账号、管理班级成员（列表/删除/重置密码）、添加与管理自定义职位
 *   - class:exclude   不计入班级管理：提醒对象为空（默认全班）时不算全班的一员，
 *                     只有被明确勾选（提醒对象里写了姓名或用户 id）才通知
 *
 * 读取权限默认对所有已登录用户开放，无需额外权限。
 */

/** 「不计入班级管理」权限码（见 utils/audience.js 的可见性过滤） */
export const PERM_EXCLUDE = 'class:exclude';

/** 发布/修改内容权限码 */
export const PERM_CONTENT_WRITE = 'content:write';

/** 管理班级成员权限码 */
export const PERM_USER_MANAGE = 'user:manage';

export const ROLE_PERMISSIONS = {
  '班长': [PERM_CONTENT_WRITE, PERM_USER_MANAGE],
  '团支书': [PERM_CONTENT_WRITE, PERM_USER_MANAGE],
  '学习委员': [PERM_CONTENT_WRITE]
};

/** 系统预置职位：不允许写进 roles 表覆盖全班权限 */
export const RESERVED_ROLES = Object.freeze(['学生', '班长', '团支书', '学习委员']);

/** 自定义职位只能拥有这几个权限点，禁止东拼出 admin 之类 */
export const ALLOWED_PERMISSIONS = Object.freeze([PERM_CONTENT_WRITE, PERM_USER_MANAGE, PERM_EXCLUDE]);

/**
 * 提醒对象是否等于「默认全班」：null / 空串 / [] 都算全班。
 * 与前端 index.html 的 remindMe()、以及 utils/audience.js 的可见性判定同一口径。
 * 坏 JSON 保守按「有名单」处理，避免把定向通知误判成全班。
 */
export function isEveryoneRemind(raw) {
  if (raw == null) return true;
  const s = String(raw).trim();
  if (!s) return true;
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      return !Array.isArray(arr) || arr.filter((x) => String(x).trim()).length === 0;
    } catch {
      return false;
    }
  }
  return false;
}

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
    return { ok: false, message: '系统预置职位不能改为自定义职位', code: 'RESERVED_ROLE' };
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
  if (Array.isArray(positions)) return positions.filter(Boolean).map(String);
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
 * 取某个职位的权限数组。
 * 职位名来自用户可填的自由文本，一律只认自身属性且必须是数组：
 * 否则 'constructor' / 'toString' 这类键会顺着原型链取到函数，导致迭代抛错。
 */
function rolePermissionList(map, role) {
  if (!map || !Object.prototype.hasOwnProperty.call(map, role)) return [];
  const value = map[role];
  return Array.isArray(value) ? value : [];
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
    for (const perm of rolePermissionList(ROLE_PERMISSIONS, role)) {
      set.add(perm);
    }
    for (const perm of rolePermissionList(customMap, role)) {
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
 *
 * 用无原型对象承载：职位名可直接来自客户端（自定义职位），写成 '__proto__' 时
 * 普通对象会被改掉原型，后续所有查表结果都会跟着错。
 * @param {Array} roleRows - [{ name, permissions }]
 * @returns {Object}
 */
export function buildRoleMap(roleRows) {
  const map = Object.create(null);
  for (const r of (roleRows || [])) {
    const name = String(r && r.name != null ? r.name : '').trim();
    if (!name) continue;
    map[name] = parsePermissionJson(r.permissions);
  }
  return map;
}

/** roles.permissions 是 JSON 数组字符串；坏数据一律按空权限处理 */
function parsePermissionJson(raw) {
  try {
    const arr = JSON.parse(raw);
    return Array.isArray(arr) ? arr : [];
  } catch {
    return [];
  }
}
