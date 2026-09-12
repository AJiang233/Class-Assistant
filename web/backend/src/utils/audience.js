/**
 * 「提醒对象」可见性过滤
 *
 * 规则：提醒对象为空（null / '' / []）= 默认全班；但带「不计入班级管理」权限（class:exclude）
 * 的人不算全班的一员 —— 只有在提醒对象里被明确勾选（写了姓名或用户 id）才通知。
 *
 * 网页列表与安卓推送读的都是 /api/notices 与 /api/activities，所以这条规则只在这里实现一次，
 * 安卓侧不需要再写一遍（SyncWorker 原有的 remind_people 判断保留即可）。
 * 表单的「我的待办 / 未交名单」是同一口径，复用 permissions.js 的 isEveryoneRemind。
 */
import { RoleModel } from '../models/roleModel.js';
import { buildRoleMap, hasPermission, isEveryoneRemind, PERM_EXCLUDE } from './permissions.js';

/** roles 表 → { 职位名: [权限] }。职位权限现算现用，避免吃旧会话里的职位 */
export async function loadRoleMap(env) {
  return buildRoleMap(await new RoleModel(env.DB).list());
}

/** 该用户是否「不计入班级管理」（权限可能来自自定义职位，所以要看 roleMap） */
export function isExcludedFromClass(positions, roleMap) {
  return hasPermission(positions, PERM_EXCLUDE, roleMap);
}

/**
 * 过滤一页列表：排除组的人看不到「提醒对象为空」的条目。
 * 判断必须查一次 roles 表（权限可能挂在自定义职位上），固定多一个轻量查询。
 */
export async function filterByAudience(env, positions, list) {
  const roleMap = await loadRoleMap(env);
  if (!isExcludedFromClass(positions, roleMap)) return list;
  return list.filter((row) => !isEveryoneRemind(row.remind_people));
}
