/**
 * 「提醒对象」可见性过滤
 *
 * 规则：提醒对象为空（null / '' / []）= 默认全班；但带「不计入班级管理」权限（class:exclude）
 * 的人不算全班的一员 —— 只有在提醒对象里被明确勾选（写了姓名或用户 id）才通知。
 *
 * 网页列表与安卓推送读的都是 /api/notices 与 /api/activities，所以这条规则只在这里实现一次，
 * 安卓侧不需要再写一遍（SyncWorker 原有的 remind_people 判断保留即可）。
 * 表单的「我的待办 / 未交名单」口径相同，但那边要按姓名 / id 逐个匹配，
 * 走的是 formHandler 里的 parseRemindNames，没有复用本文件的判定。
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
 * 按可见性取一页列表：排除组的人看不到「提醒对象为空」的条目。
 *
 * 过滤发生在取数之后，被滤掉的行会占掉这一页的名额，所以凑不满 limit 时继续取下一页——
 * 否则排在后面的「明确勾选」条目会永远取不到（客户端通常一次只拉一页）。
 *
 * ponytail: 排除组可能多查几次 D1。没把谓词下推到 SQL，是为了不让这份筛选口径在
 * 4 个查询里各复制一份（容易和 isEveryoneRemind 走偏）；排除组本身稀有，够用。
 *
 * @param {(limit:number, offset:number) => Promise<Array>} fetchPage 取原始一页
 */
export async function listByAudience(env, positions, fetchPage, limit, offset = 0) {
  const roleMap = await loadRoleMap(env);
  if (!isExcludedFromClass(positions, roleMap)) return fetchPage(limit, offset);

  const out = [];
  let rawOffset = offset;
  while (out.length < limit) {
    const rows = await fetchPage(limit, rawOffset);
    if (!rows.length) break;
    for (const row of rows) {
      if (out.length >= limit) break;
      if (!isEveryoneRemind(row.remind_people)) out.push(row);
    }
    rawOffset += rows.length;
    if (rows.length < limit) break;
  }
  return out;
}
