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
 * @returns {Set<string>}
 */
export function getPermissions(positions) {
  const set = new Set();
  for (const role of parsePositions(positions)) {
    for (const perm of (ROLE_PERMISSIONS[role] || [])) {
      set.add(perm);
    }
  }
  return set;
}

/**
 * 判断某用户是否拥有指定权限
 * @param {string|string[]} positions
 * @param {string} perm
 * @returns {boolean}
 */
export function hasPermission(positions, perm) {
  return getPermissions(positions).has(perm);
}
