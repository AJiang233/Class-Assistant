/**
 * 「提醒对象」可见性与内容归属 —— 「谁看得到 / 谁能改」只在这里实现一次
 *
 * 可见性：提醒对象为空（null / '' / []）= 默认全班；但带「不计入班级管理」权限（class:exclude）
 * 的人不算全班的一员 —— 只有在提醒对象里被明确勾选（写了姓名或用户 id）才可见 / 才通知。
 *
 * 网页列表、安卓推送、日历订阅、表单读的都是这一条规则。判定必须只有一份：
 * 任何「按 id 取一条」「按名单挑人」「按页取列表」的地方都从这里取，
 * 别在各自的 handler 里重写 —— 之前单条读取、日历订阅、表单详情三处各写各的，
 * 结果就是「不计入班级管理」的规则只挡住了列表，其余三条路径全绕过去了。
 *
 * 归属：通知/活动的改与删只认创建者本人，或持有 user:manage 的班委（见 canManageItem）。
 */
import { RoleModel } from '../models/roleModel.js';
import { UserModel } from '../models/userModel.js';
import {
  PERM_CONTENT_WRITE,
  PERM_EXCLUDE,
  PERM_USER_MANAGE,
  buildRoleMap,
  hasPermission,
  isEveryoneRemind
} from './permissions.js';

/** roles 表 → { 职位名: [权限] }。职位权限现算现用，避免吃旧会话里的职位 */
export async function loadRoleMap(env) {
  return buildRoleMap(await new RoleModel(env.DB).list());
}

/** 该用户是否「不计入班级管理」（权限可能来自自定义职位，所以要看 roleMap） */
export function isExcludedFromClass(positions, roleMap) {
  return hasPermission(positions, PERM_EXCLUDE, roleMap);
}

/**
 * 解析提醒对象名单（姓名或用户 id）。空 = 全班。
 * 与前端 remindMe() 同一口径，所以放在这里只写一份。
 */
export function parseRemindNames(raw) {
  if (!raw) return [];
  const s = String(raw).trim();
  if (!s) return [];
  if (s.charAt(0) === '[') {
    try {
      const arr = JSON.parse(s);
      if (Array.isArray(arr)) return arr.map((x) => String(x).trim()).filter(Boolean);
    } catch {
      // 坏 JSON 走下面的逗号分支，保守按「有名单」处理
    }
  }
  return s.split(',').map((x) => x.trim()).filter(Boolean);
}

/**
 * 读出这位用户的读取上下文：可见性要用到的 excluded，以及接口要顺势用到的权限位。
 *
 * 每个请求只查一次 roles 表 —— 单条读取既要判「这条 ta 能不能看」，又要决定
 * 「要不要把定向名单给出去」，分头算会把同一次查询做两三遍。
 *
 * @returns {Promise<{user: Object, excluded: boolean, canWrite: boolean, canManageUsers: boolean}>}
 */
export async function loadViewer(env, user) {
  const roleMap = await loadRoleMap(env);
  return {
    user,
    excluded: isExcludedFromClass(user.positions, roleMap),
    canWrite: hasPermission(user.positions, PERM_CONTENT_WRITE, roleMap),
    canManageUsers: hasPermission(user.positions, PERM_USER_MANAGE, roleMap)
  };
}

/**
 * 这条内容对这位用户可见吗 —— 单条读取、日历订阅、表单详情都过这里。
 * 列表走 listByAudience（分页版，多一步「凑不满就继续取下一页」）。
 */
export function canView(raw, viewer) {
  if (isEveryoneRemind(raw)) return !viewer.excluded;
  const names = parseRemindNames(raw);
  return names.includes(String(viewer.user.name)) || names.includes(String(viewer.user.id));
}

/**
 * 「按 id 取一条」用的判定：在 canView 之上给能发文的人放行 ——
 * 班委要能打开一条自己没被定向到的通知/活动去修改或删除，否则编辑入口就断了。
 * 真能不能改由 canManageItem 决定。
 *
 * 日历订阅不要用这个：班委的日历里不该出现全班的定向内容。
 */
export function canViewItem(raw, viewer) {
  return viewer.canWrite || canView(raw, viewer);
}

/**
 * 这条内容能不能被修改 / 删除：创建者本人，或持有 user:manage 的班委。
 *
 * row.created_by 为空的记录 = 迁移（migrations/2026-09-14-content-owner.sql）之前发的，
 * 不知道归谁，一律按「需要 user:manage」处理 —— 不一刀切拒绝，否则老内容谁都动不了。
 */
export function canManageItem(row, viewer) {
  if (!row || row.created_by == null) return viewer.canManageUsers;
  return Number(row.created_by) === Number(viewer.user.id) || viewer.canManageUsers;
}

/**
 * 条目的定向名单只给能发文的人看（编辑表单要拿它预填），普通读者不需要。
 * 名单里是姓名与用户 id，不必让每个登录用户都能拉到。
 */
export function withoutRemindPeople(row, viewer) {
  if (viewer.canWrite) return row;
  const { remind_people, ...rest } = row;
  return rest;
}

/**
 * 单条响应的形状：按上面两条规则裁剪，并附上 canManage 给前端决定
 * 显不显示「修改 / 删除」按钮（不附的话，学习委员会看到一个必然 403 的按钮）。
 */
export function itemForViewer(row, viewer) {
  return { ...withoutRemindPeople(row, viewer), canManage: canManageItem(row, viewer) };
}

/**
 * 从一批用户里挑出该内容的受众 —— 与 canView 是同一判定的反方向：
 * 那边问「这条内容 ta 看不看得到」，这边问「这条内容该通知谁」。
 *
 * @param {Array} users 全班用户
 * @param {string} raw 原始 remind_people
 * @param {(u: Object) => boolean} [isExcluded] 判断某个用户是否「不计入班级管理」
 */
export function pickAudience(users, raw, isExcluded = () => false) {
  const names = parseRemindNames(raw);
  if (!names.length) return users.filter((u) => !isExcluded(u));
  return users.filter((u) => names.includes(String(u.name)) || names.includes(String(u.id)));
}

/**
 * 「谁该收到推送」：
 *  - 提醒对象为空 = 全班减去「不计入班级管理」的人
 *  - 提醒对象非空 = 名单里被明确写到的姓名或 id（含被排除组的人，只要被点名）
 *
 * 推送和列表读的必须是同一份判定，否则会出现「列表里看不到却收到推送」。
 *
 * @param {string} remindPeople 原始 remind_people 字段
 * @param {{excludeUserId?: number}} [options] 排除某个用户（发布者不发给自己）
 */
export async function resolveRemindUsers(env, remindPeople, options = {}) {
  const users = await new UserModel(env.DB).list();

  let out;
  if (parseRemindNames(remindPeople).length) {
    // 有名单时不必查 roles：被点名的人一律算在内
    out = pickAudience(users, remindPeople);
  } else {
    const roleMap = await loadRoleMap(env);
    out = pickAudience(users, remindPeople, (u) => isExcludedFromClass(u.positions, roleMap));
  }

  if (options.excludeUserId != null) {
    out = out.filter((u) => Number(u.id) !== Number(options.excludeUserId));
  }
  return out;
}

/**
 * 按可见性取一页列表：排除组的人看不到「提醒对象为空」的条目。
 * 定向条目不在这一层按姓名过滤（那是前端与 App 各自的 remindMe 判断），
 * 这里只处理「不计入班级管理」这一条服务端规则。
 *
 * 过滤发生在取数之后，被滤掉的行会占掉这一页的名额，所以凑不满 limit 时继续取下一页——
 * 否则排在后面的「明确勾选」条目会永远取不到（客户端通常一次只拉一页）。
 *
 * ponytail: 排除组可能多查几次 D1。没把谓词下推到 SQL，是为了不让这份筛选口径在
 * 4 个查询里各复制一份；排除组本身稀有，够用。
 *
 * @param {(limit:number, offset:number) => Promise<Array>} fetchPage 取原始一页
 */
export async function listByAudience(viewer, fetchPage, limit, offset = 0) {
  if (!viewer.excluded) return fetchPage(limit, offset);

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
