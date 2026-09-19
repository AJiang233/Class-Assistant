import { UserModel } from '../models/userModel.js';
import { RoleModel } from '../models/roleModel.js';
import { EmailCodeModel } from '../models/emailCodeModel.js';
import { EmailSubscriptionModel } from '../models/emailSubscriptionModel.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { sign } from '../utils/jwt.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { sendEmail, EmailError, renderVerifyEmail, renderResetEmail } from '../utils/email.js';
import {
  parsePositions,
  getPermissions,
  buildRoleMap,
  isReservedRole,
  sanitizePermissions,
  assertCustomRoleName,
  positionsToStore,
  STUDENT_ROLE,
  ROLE_PERMISSIONS
} from '../utils/permissions.js';

const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72;
const NAME_MAX = 40;
const CONTACT_MAX = 60;
const EMAIL_MAX = 120;
/** 邮箱格式故意宽松：只挡明显不是邮箱的输入，真正的「这个邮箱是不是你的」靠验证码 */
const EMAIL_RE = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

/**
 * 对外暴露的用户信息（登录响应、/api/auth/me、成员列表共用）
 * 这里不再带 update_time：它原本唯一的消费点是个人资料卡片上的「更新时间」那一行，
 * 那行已按需求删除，全仓再没有读它的地方。数据库那一列照旧保留
 * （userModel.update 每次写入都会刷新它），删的是响应字段，不是表结构。
 */
function publicUser(user, permissions) {
  return {
    id: user.id,
    student_id: user.student_id,
    name: user.name,
    positions: user.positions,
    contact: user.contact,
    // 未绑定给空串而不是 null：前端判断「填没填」只用真值判断，少一层 null 分支
    email: user.email || '',
    email_verified: Number(user.email_verified) === 1,
    permissions
  };
}

/**
 * 邮箱归一化：去空白 + 转小写。
 *
 * 必须统一，否则 `A@qq.com` 与 `a@qq.com` 会被当成两个账号 ——
 * 一份邮箱两个账号的后果是找回密码时分不清该重置谁。
 * 唯一索引上另有 COLLATE NOCASE 兜底（migrations/2026-09-19-email.sql），那道是防绕过的，
 * 不是这里的替代品。
 */
function normalizeEmail(v) {
  return String(v == null ? '' : v).trim().toLowerCase();
}

/** 邮箱格式校验：返回错误文案，通过返回 null */
function validateEmail(email) {
  if (!email) return '请填写邮箱地址';
  if (email.length > EMAIL_MAX) return `邮箱最多 ${EMAIL_MAX} 个字符`;
  if (!EMAIL_RE.test(email)) return '请输入正确的邮箱地址';
  return null;
}

/**
 * 把「通不过的验证码」翻译成响应。
 * 文案刻意不区分「没有这个码」与「码填错了」：能区分就等于告诉试探者「这个邮箱确实在等他验证」。
 */
function codeRejected(reason) {
  if (reason === 'TOO_MANY') {
    return jsonResponse(error('验证码错误次数过多，请重新获取', 'EMAIL_CODE_TOO_MANY'), 429);
  }
  if (reason === 'MISMATCH') {
    return jsonResponse(error('验证码不正确', 'EMAIL_CODE_INVALID'), 400);
  }
  return jsonResponse(error('验证码已失效，请重新获取', 'EMAIL_CODE_EXPIRED'), 400);
}

/**
 * 发信失败：未配置与发送失败要分成两档 —— 前者找管理员，后者过会儿再试。
 */
function emailFailure(e) {
  const code = e instanceof EmailError ? e.code : 'EMAIL_SEND_FAILED';
  if (code === 'EMAIL_NOT_CONFIGURED') {
    console.error('未配置 EMAIL_API_KEY，邮箱相关功能不可用');
    return jsonResponse(error('邮件服务未配置，请联系管理员', 'EMAIL_NOT_CONFIGURED'), 503);
  }
  return jsonResponse(error('邮件发送失败，请稍后重试', 'EMAIL_SEND_FAILED'), 502);
}

/**
 * 记下改密时刻（Unix 秒），让此前签发的令牌全部作废 —— 比对逻辑在 middleware/auth.js。
 * 三条改密路径都必须过它：用户自助改密、忘记密码重置、管理员重置成员密码。
 * 漏掉任何一条，那位用户手上的旧令牌就能继续用满 7 天。
 */
function passwordChangedAtNow() {
  return Math.floor(Date.now() / 1000);
}

function jwtExpiresIn(env) {
  const n = parseInt(env && env.JWT_EXPIRES_IN, 10);
  return Number.isFinite(n) && n > 0 ? n : 604800;
}

/**
 * 计算某用户的权限集合（含自定义职位，来自 roles 表）
 */
async function computePermissions(env, positions) {
  try {
    const roleModel = new RoleModel(env.DB);
    const customMap = buildRoleMap(await roleModel.list());
    return Array.from(getPermissions(positions, customMap));
  } catch (e) {
    // roles 表读不出来时降级为内置权限，但必须留痕：
    // 否则返回给前端的权限集与 middleware 实际鉴权结果不一致，问题无从观测
    console.error('读取自定义职位权限失败，本次按内置职位计算:', e);
    return Array.from(getPermissions(positions));
  }
}

/**
 * 用户注册
 */
export async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { student_id, name, password, positions = STUDENT_ROLE, contact = '', role_permissions, role_name } = body;

    // 校验必填字段
    if (!student_id || !name || !password) {
      return jsonResponse(error('请填写学号、姓名和密码', 'MISSING_FIELDS'), 400);
    }
    // 姓名与联系方式会进成员列表、提醒对象选择器与 CSV 导出，长度必须有上限
    const nameText = String(name).trim();
    if (!nameText) {
      return jsonResponse(error('姓名不能为空', 'MISSING_FIELDS'), 400);
    }
    if (nameText.length > NAME_MAX) {
      return jsonResponse(error(`姓名最多 ${NAME_MAX} 个字符`, 'NAME_TOO_LONG'), 400);
    }
    const contactText = String(contact == null ? '' : contact).trim();
    if (contactText.length > CONTACT_MAX) {
      return jsonResponse(error(`联系方式最多 ${CONTACT_MAX} 个字符`, 'CONTACT_TOO_LONG'), 400);
    }
    const passwordText = String(password);
    if (passwordText.length < PASSWORD_MIN || passwordText.length > PASSWORD_MAX) {
      return jsonResponse(error(`密码长度须为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`, 'WEAK_PASSWORD'), 400);
    }

    // 自定义职位且指定了权限时，先在 roles 表登记该职位。
    // role_name 指定职位名；兼容旧客户端：未传 role_name 时回退到字符串形式的 positions。
    // 系统预置名一旦被写进 roles 表，全班同名职位都会被提权，这里必须挡住。
    if (role_permissions && Array.isArray(role_permissions) && role_permissions.length) {
      const customName = role_name || (typeof positions === 'string' ? positions : '');
      if (customName) {
        if (isReservedRole(customName)) {
          return jsonResponse(error('系统预置职位不能改为自定义职位', 'RESERVED_ROLE'), 400);
        }
        const named = assertCustomRoleName(customName);
        if (!named.ok) {
          return jsonResponse(error(named.message, named.code), 400);
        }
        const roleModel = new RoleModel(env.DB);
        await roleModel.upsert(named.name, JSON.stringify(sanitizePermissions(role_permissions)));
      }
    }

    // D1 不接受 object 类型，且「没有职务」的历史写法（[] / '' / '[]'）都在这里归一成 '学生'，
    // 与编辑成员那条路共用同一个函数（utils/permissions.js 的 positionsToStore）
    const positionsValue = positionsToStore(positions);

    const userModel = new UserModel(env.DB);

    // 检查学号是否已存在
    const existing = await userModel.findByStudentId(student_id);
    if (existing) {
      return jsonResponse(error('该学号已注册，请直接登录，或换一个学号', 'STUDENT_ID_EXISTS'), 409);
    }

    // 哈希密码
    const { hash, salt } = await hashPassword(passwordText);
    const passwordHash = `${salt}:${hash}`;  // 存储格式：盐值:哈希

    // 创建用户
    await userModel.create({
      student_id,
      name: nameText,
      password_hash: passwordHash,
      positions: positionsValue,
      contact: contactText
    });

    return jsonResponse(success({ message: '注册成功' }), 201);
  } catch (e) {
    console.error('注册失败:', e);
    return jsonResponse(error('注册失败，请稍后重试', 'REGISTER_FAILED'), 500);
  }
}

/**
 * 用户登录
 */
export async function handleLogin(request, env) {
  try {
    const body = await request.json();
    const { student_id, password } = body;

    if (!student_id || !password) {
      return jsonResponse(error('请填写学号和密码', 'MISSING_FIELDS'), 400);
    }
    if (!env.JWT_SECRET) {
      console.error('未配置 JWT_SECRET，无法签发登录态');
      return jsonResponse(error('服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED'), 500);
    }

    const userModel = new UserModel(env.DB);
    const user = await userModel.findByStudentId(student_id);

    if (!user) {
      return jsonResponse(error('学号或密码不正确', 'INVALID_CREDENTIALS'), 401);
    }

    // 验证密码（格式：盐值:哈希）
    const [salt, hash] = user.password_hash.split(':');
    const isValid = await verifyPassword(password, hash, salt);

    if (!isValid) {
      return jsonResponse(error('学号或密码不正确', 'INVALID_CREDENTIALS'), 401);
    }

    const token = await sign(
      {
        id: user.id,
        student_id: user.student_id,
        name: user.name
      },
      env.JWT_SECRET,
      jwtExpiresIn(env)
    );

    const permissions = await computePermissions(env, user.positions);

    return jsonResponse(success({
      token,
      user: publicUser(user, permissions)
    }));
  } catch (e) {
    console.error('登录失败:', e);
    return jsonResponse(error('登录失败，请稍后重试', 'LOGIN_FAILED'), 500);
  }
}

/**
 * 获取当前用户信息（需登录）
 */
export async function handleMe(request, env, userPayload) {
  try {
    const userModel = new UserModel(env.DB);
    const user = await userModel.findById(userPayload.id);

    if (!user) {
      return jsonResponse(error('成员不存在', 'USER_NOT_FOUND'), 404);
    }

    const permissions = await computePermissions(env, user.positions);

    return jsonResponse(success(publicUser(user, permissions)));
  } catch (e) {
    console.error('获取用户信息失败:', e);
    return jsonResponse(error('获取用户信息失败', 'FETCH_USER_FAILED'), 500);
  }
}

/**
 * 更新当前用户自己的资料（联系方式，任何登录用户可改自己的）
 */
export async function handleUpdateProfile(request, env, user) {
  try {
    const body = await request.json();
    const { contact } = body;
    if (contact === undefined) {
      return jsonResponse(error('没有需要保存的修改', 'MISSING_FIELDS'), 400);
    }

    const value = String(contact).trim();
    if (value.length > 60) {
      return jsonResponse(error('联系方式最多 60 个字符', 'CONTACT_TOO_LONG'), 400);
    }

    const userModel = new UserModel(env.DB);
    await userModel.update(user.id, { contact: value });

    const fresh = await userModel.findById(user.id);
    return jsonResponse(success({
      message: '已保存',
      contact: fresh ? fresh.contact : value
    }));
  } catch (e) {
    console.error('更新个人资料失败:', e);
    return jsonResponse(error('更新个人资料失败，请稍后重试', 'UPDATE_PROFILE_FAILED'), 500);
  }
}

/**
 * 修改当前用户密码（任何登录用户可修改自己的）
 */
export async function handleChangePassword(request, env, user) {
  try {
    const body = await request.json();
    const { old_password, new_password } = body;

    if (!old_password || !new_password) {
      return jsonResponse(error('请填写旧密码和新密码', 'MISSING_FIELDS'), 400);
    }
    // 先转字符串再比长度：非字符串入参的 .length 是 undefined，两个比较会同时为假而绕过校验
    const newPassword = String(new_password);
    if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      return jsonResponse(error(`新密码长度须为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`, 'WEAK_PASSWORD'), 400);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findByStudentId(user.student_id);
    if (!existing) {
      return jsonResponse(error('成员不存在', 'USER_NOT_FOUND'), 404);
    }

    const [salt, hash] = existing.password_hash.split(':');
    const isValid = await verifyPassword(old_password, hash, salt);
    if (!isValid) {
      return jsonResponse(error('旧密码不正确', 'INVALID_OLD_PASSWORD'), 400);
    }

    const { hash: newHash, salt: newSalt } = await hashPassword(newPassword);
    await userModel.update(existing.id, {
      password_hash: `${newSalt}:${newHash}`,
      // 改密即作废此前签发的所有令牌，含当前这台设备上的那一枚 ——
      // 前端本来就要求「改密后重新登录」（account.js 的改密表单），所以这里不回带新令牌，
      // 与既有行为一致。哪天改成「改完直接留在登录态」，再把这枚新令牌返回给前端存下即可。
      password_changed_at: passwordChangedAtNow()
    });

    return jsonResponse(success({ message: '密码修改成功' }));
  } catch (e) {
    console.error('修改密码失败:', e);
    return jsonResponse(error('修改密码失败，请稍后重试', 'CHANGE_PASSWORD_FAILED'), 500);
  }
}

/**
 * 获取班级成员列表（需 user:manage 权限）
 */
export async function handleListUsers(request, env, user) {
  try {
    const userModel = new UserModel(env.DB);
    const list = await userModel.list();
    // 邮箱形状与 publicUser 对齐（空串 + 布尔），免得前端在成员列表与个人中心之间写两套判断
    const members = list.map(u => ({
      ...u,
      positions: parsePositions(u.positions),
      email: u.email || '',
      email_verified: Number(u.email_verified) === 1
    }));
    return jsonResponse(success({ list: members, total: members.length }));
  } catch (e) {
    console.error('获取成员列表失败:', e);
    return jsonResponse(error('获取成员列表失败', 'LIST_USERS_FAILED'), 500);
  }
}

/**
 * 删除班级成员（需 user:manage 权限）
 */
export async function handleDeleteUser(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('成员不存在', 'INVALID_ID'), 400);
    }
    if (id === user.id) {
      return jsonResponse(error('不能删除自己的账号', 'CANNOT_DELETE_SELF'), 400);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findById(id);
    if (!existing) {
      return jsonResponse(error('成员不存在', 'USER_NOT_FOUND'), 404);
    }

    await userModel.delete(id);
    return jsonResponse(success({ message: '成员已删除' }));
  } catch (e) {
    console.error('删除成员失败:', e);
    return jsonResponse(error('删除成员失败', 'DELETE_USER_FAILED'), 500);
  }
}

/**
 * 更新班级成员资料（姓名/职务/联系方式/重置密码，需 user:manage 权限）
 */
export async function handleUpdateUser(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('成员不存在', 'INVALID_ID'), 400);
    }

    const body = await request.json();
    const { name, positions, contact, password } = body;
    if (name === undefined && positions === undefined && contact === undefined && password === undefined) {
      return jsonResponse(error('没有需要保存的修改', 'MISSING_FIELDS'), 400);
    }

    // 职位名与注册同规则：预置名可以写（那是正常任职），自定义名不能冒用预置名、不能超长
    let positionsValue;
    if (positions !== undefined) {
      const list = Array.isArray(positions) ? positions : [positions];
      for (const p of list) {
        if (isReservedRole(p)) continue;
        const named = assertCustomRoleName(p);
        if (!named.ok) {
          return jsonResponse(error(named.message, named.code), 400);
        }
      }
      // 与注册同一口径：空的一律存 '学生'，别在这里自己 stringify 出一个 '[]'
      positionsValue = positionsToStore(positions);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findById(id);
    if (!existing) {
      return jsonResponse(error('成员不存在', 'USER_NOT_FOUND'), 404);
    }

    const data = {};
    if (name !== undefined) {
      const value = String(name).trim();
      if (!value) {
        return jsonResponse(error('姓名不能为空', 'MISSING_FIELDS'), 400);
      }
      if (value.length > NAME_MAX) {
        return jsonResponse(error(`姓名最多 ${NAME_MAX} 个字符`, 'NAME_TOO_LONG'), 400);
      }
      data.name = value;
    }
    if (positions !== undefined) data.positions = positionsValue;
    if (contact !== undefined) {
      const value = String(contact == null ? '' : contact).trim();
      if (value.length > CONTACT_MAX) {
        return jsonResponse(error(`联系方式最多 ${CONTACT_MAX} 个字符`, 'CONTACT_TOO_LONG'), 400);
      }
      data.contact = value;
    }
    if (password !== undefined && password !== null && password !== '') {
      const pwd = String(password);
      if (pwd.length < PASSWORD_MIN || pwd.length > PASSWORD_MAX) {
        return jsonResponse(error(`密码长度须为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`, 'WEAK_PASSWORD'), 400);
      }
      const { hash, salt } = await hashPassword(pwd);
      data.password_hash = `${salt}:${hash}`;
      // 重置密码同样要作废那位同学手上的旧令牌，否则他在接下来 7 天里还能继续用
      data.password_changed_at = passwordChangedAtNow();
    }

    await userModel.update(id, data);
    return jsonResponse(success({ message: '已保存' }));
  } catch (e) {
    console.error('更新成员失败:', e);
    return jsonResponse(error('更新成员失败', 'UPDATE_USER_FAILED'), 500);
  }
}

/**
 * 获取成员精简列表（任何登录用户可用，用于提醒对象选择）
 */
export async function handleListMembersPick(request, env, user) {
  try {
    const userModel = new UserModel(env.DB);
    const list = await userModel.listPicks();
    return jsonResponse(success({ list }));
  } catch (e) {
    console.error('获取成员列表失败:', e);
    return jsonResponse(error('获取成员列表失败', 'LIST_USERS_FAILED'), 500);
  }
}

/**
 * 获取全部自定义职位（供注册/编辑成员时作为可选项，需 user:manage 权限）
 */
export async function handleListRoles(request, env, user) {
  try {
    const roleModel = new RoleModel(env.DB);
    const rows = await roleModel.list();
    const list = rows.map((r) => ({ id: r.id, name: r.name, permissions: r.permissions }));
    // presets 是系统预置职位的权限表（ROLE_PERMISSIONS 的直接投影）：前端「管理职位」列表
    // 展示默认职位权限时用这份，不再手抄一份硬编码（issue #84 项 9）
    return jsonResponse(success({ list, presets: ROLE_PERMISSIONS }));
  } catch (e) {
    console.error('获取自定义职位失败:', e);
    return jsonResponse(error('获取自定义职位失败', 'LIST_ROLES_FAILED'), 500);
  }
}

/**
 * 新增/更新自定义职位（需 user:manage 权限；同名则更新权限）
 * 与注册时同一套校验：预置职位名不能写进 roles 表，权限只保留白名单
 */
export async function handleCreateRole(request, env, user) {
  try {
    const body = await request.json();
    const rawName = String(body.name == null ? '' : body.name).trim();
    if (!rawName) {
      return jsonResponse(error('职位名称不能为空', 'MISSING_FIELDS'), 400);
    }
    if (isReservedRole(rawName)) {
      return jsonResponse(error('系统预置职位不能改为自定义职位', 'RESERVED_ROLE'), 400);
    }
    const named = assertCustomRoleName(rawName);
    if (!named.ok) {
      return jsonResponse(error(named.message, named.code), 400);
    }
    const permissions = Array.isArray(body.permissions) ? body.permissions.filter(Boolean) : [];

    const roleModel = new RoleModel(env.DB);
    await roleModel.upsert(named.name, JSON.stringify(sanitizePermissions(permissions)));

    return jsonResponse(success({ message: '职位已添加' }), 201);
  } catch (e) {
    console.error('添加自定义职位失败:', e);
    return jsonResponse(error('添加自定义职位失败，请稍后重试', 'CREATE_ROLE_FAILED'), 500);
  }
}

/**
 * 删除自定义职位（需 user:manage 权限）
 */
export async function handleDeleteRole(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('职位不存在', 'INVALID_ID'), 400);
    }

    const roleModel = new RoleModel(env.DB);
    await roleModel.deleteById(id);

    return jsonResponse(success({ message: '成员已删除' }));
  } catch (e) {
    console.error('删除自定义职位失败:', e);
    return jsonResponse(error('删除自定义职位失败，请稍后重试', 'DELETE_ROLE_FAILED'), 500);
  }
}

/* ===== 邮箱验证与忘记密码 =====
 *
 * 两条流程共用 utils/email.js（发信）与 models/emailCodeModel.js（码的生命周期）：
 *   绑定验证：send-code（登录）→ verify（登录）
 *   忘记密码：forgot/send（公开）→ forgot/reset（公开）
 *
 * 落库时机刻意定在「信确实发出去了之后」：先落库再发信的话，一旦发信失败或被 60 秒限发拦住，
 * 用户的邮箱就已经被改成新的、验证状态也被打回了，而他手上什么都没收到。
 */

/**
 * 发送绑定邮箱的验证码（需登录）
 * body: { email }
 *
 * 绑邮箱是两步（填 → 验码），中间态就是「已填未验证」，也就是 users.email_verified=0 ——
 * 这一列正是为它存在的。同一个已验证邮箱重复点「发送」不会把状态打回未验证，
 * 只有邮箱真的变了才重置（否则用户点一下就"掉验证"了）。
 */
export async function handleSendEmailCode(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const invalid = validateEmail(email);
    if (invalid) return jsonResponse(error(invalid, 'INVALID_EMAIL'), 400);

    const userModel = new UserModel(env.DB);
    const taken = await userModel.findByEmail(email);
    if (taken && Number(taken.id) !== Number(user.id)) {
      // 先查一次是为了别白花一封信；真正的闸门是数据库上的唯一索引
      return jsonResponse(error('该邮箱已被其他成员使用', 'EMAIL_TAKEN'), 409);
    }

    const codeModel = new EmailCodeModel(env.DB);
    const issued = await codeModel.issue(user.id, email, 'verify');
    if (!issued.ok) {
      return jsonResponse(error('验证码发送过于频繁，请稍后再试', 'EMAIL_CODE_TOO_SOON'), 429);
    }

    try {
      await sendEmail(env, {
        to: email,
        subject: '班级助理 · 邮箱验证码',
        html: renderVerifyEmail(issued.code)
      });
    } catch (e) {
      // 信没发出去就把刚写的码撤掉：留着的话，重发会被 60 秒限发拦住，
      // 用户要干等一分钟才能再试，而这一轮他根本没收到信
      await codeModel.clear(user.id, 'verify');
      return emailFailure(e);
    }

    // 信发出去了才落库。换邮箱时把验证状态重置为 0（新邮箱得重新验）。
    const changed = email !== normalizeEmail(user.email);
    if (changed) {
      await userModel.update(user.id, { email, email_verified: 0 });
    }

    return jsonResponse(success({ message: '验证码已发送', email }));
  } catch (e) {
    console.error('发送邮箱验证码失败:', e);
    return jsonResponse(error('发送验证码失败，请稍后重试', 'SEND_EMAIL_CODE_FAILED'), 500);
  }
}

/**
 * 校验验证码并完成邮箱绑定（需登录）
 * body: { email, code }
 */
export async function handleVerifyEmail(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const code = String(body.code == null ? '' : body.code).trim();

    const invalid = validateEmail(email);
    if (invalid) return jsonResponse(error(invalid, 'INVALID_EMAIL'), 400);
    if (!/^\d{6}$/.test(code)) return jsonResponse(error('请输入 6 位验证码', 'MISSING_CODE'), 400);

    const userModel = new UserModel(env.DB);
    const taken = await userModel.findByEmail(email);
    if (taken && Number(taken.id) !== Number(user.id)) {
      return jsonResponse(error('该邮箱已被其他成员使用', 'EMAIL_TAKEN'), 409);
    }

    const result = await new EmailCodeModel(env.DB).verify(user.id, {
      purpose: 'verify',
      email,
      code
    });
    if (!result.ok) return codeRejected(result.reason);

    try {
      await userModel.update(user.id, { email, email_verified: 1 });
    } catch (e) {
      // 唯一索引是最后一道闸：并发下两个账号同时验同一个邮箱，第二个会在这里被数据库拒掉。
      // 到这一步码已经消耗掉了，属可接受 —— 反正这个邮箱他也绑不上。
      console.error('写入邮箱失败（可能是唯一索引冲突）:', e);
      return jsonResponse(error('该邮箱已被其他成员使用', 'EMAIL_TAKEN'), 409);
    }

    const fresh = await userModel.findById(user.id);
    const permissions = await computePermissions(env, fresh.positions);
    return jsonResponse(success({
      message: '邮箱已验证',
      user: publicUser(fresh, permissions)
    }));
  } catch (e) {
    console.error('验证邮箱失败:', e);
    return jsonResponse(error('验证邮箱失败，请稍后重试', 'VERIFY_EMAIL_FAILED'), 500);
  }
}

/**
 * 解绑邮箱（需登录）
 *
 * 不需要验证码：解绑的风险是把「找回密码」这条路关掉，而这件事本来就要求用户已登录。
 * 顺手清掉未用的绑定码，免得用户在别处留着一条还能用的码。
 */
export async function handleUnbindEmail(request, env, user) {
  try {
    const userModel = new UserModel(env.DB);
    await userModel.update(user.id, { email: null, email_verified: 0 });
    await new EmailCodeModel(env.DB).clear(user.id, 'verify');
    // 解绑 = 邮箱没了，订阅失去承载体，一并清零（保留行，见模型注释）
    await new EmailSubscriptionModel(env.DB).resetToZero(user.id);

    const fresh = await userModel.findById(user.id);
    const permissions = await computePermissions(env, fresh.positions);
    return jsonResponse(success({
      message: '已解绑邮箱',
      user: publicUser(fresh, permissions)
    }));
  } catch (e) {
    console.error('解绑邮箱失败:', e);
    return jsonResponse(error('解绑邮箱失败，请稍后重试', 'UNBIND_EMAIL_FAILED'), 500);
  }
}

/**
 * 读取当前用户的订阅开关（需登录）
 * 未绑定 / 未验证也照常返回（全 0 或实际值），前端自己决定显不显示订阅区。
 */
export async function handleGetEmailSubscriptions(request, env, user) {
  try {
    const subs = await new EmailSubscriptionModel(env.DB).get(user.id);
    return jsonResponse(success({ subscriptions: subs }));
  } catch (e) {
    console.error('读取订阅设置失败:', e);
    return jsonResponse(error('读取订阅设置失败，请稍后重试', 'GET_SUBSCRIPTIONS_FAILED'), 500);
  }
}

/**
 * 保存订阅开关（需登录）
 * body: { activities, notices, forms }（布尔或 0/1）
 *
 * 只有「已绑且已验证」的邮箱才收得到订阅邮件，所以这里拦一道：
 * 前端订阅区只在已验证时显示，直接调接口的绕过前端也存不进去（409）。
 */
export async function handleSetEmailSubscriptions(request, env, user) {
  try {
    if (Number(user.email_verified) !== 1 || !user.email) {
      return jsonResponse(error('请先验证邮箱再设置订阅', 'EMAIL_NOT_VERIFIED'), 409);
    }
    const body = await request.json().catch(() => ({}));
    const toBool = (v) => v === true || v === 1 || v === '1';
    const subscriptions = {
      activities: toBool(body.activities),
      notices: toBool(body.notices),
      forms: toBool(body.forms)
    };
    await new EmailSubscriptionModel(env.DB).set(user.id, subscriptions);
    return jsonResponse(success({ subscriptions }));
  } catch (e) {
    console.error('保存订阅设置失败:', e);
    return jsonResponse(error('保存订阅设置失败，请稍后重试', 'SET_SUBSCRIPTIONS_FAILED'), 500);
  }
}

/**
 * 忘记密码 · 发送重置码（公开，无需登录）
 * body: { email }
 *
 * **只对已绑定且已验证的邮箱真发信**，其余情况一律回同一句成功文案，
 * 否则这个接口就成了「查这个邮箱有没有注册过班级助理」的枚举工具。
 *
 * 已知残余面（写在这里免得以后被当成 bug 查）：同一邮箱连发两次，第二次会撞 60 秒限发返回 429，
 * 而未注册的邮箱永远回 200 —— 试探者据此仍能区分出「这个邮箱注册过」。
 * 要彻底堵住得给不存在的邮箱也记一条限发记录（多一张表或一个哨兵 user_id），
 * 而它泄漏的只是「某人用没用班级助理」，与代价不成比例，本期不做。
 */
export async function handleForgotSend(request, env) {
  // 统一文案。先构造好，所有「不该发信」的分支都回它
  const generic = success({ message: '如果该邮箱已绑定并验证，我们已发送重置验证码' });
  try {
    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const invalid = validateEmail(email);
    // 格式错误可以如实报 —— 这暴露的是请求的毛病，不是账号的存在性
    if (invalid) return jsonResponse(error(invalid, 'INVALID_EMAIL'), 400);

    const userModel = new UserModel(env.DB);
    const target = await userModel.findByEmail(email);
    if (!target || Number(target.email_verified) !== 1) return jsonResponse(generic);

    const codeModel = new EmailCodeModel(env.DB);
    const issued = await codeModel.issue(target.id, email, 'reset');
    if (!issued.ok) {
      return jsonResponse(error('验证码发送过于频繁，请稍后再试', 'EMAIL_CODE_TOO_SOON'), 429);
    }

    try {
      await sendEmail(env, {
        to: email,
        subject: '班级助理 · 重置密码',
        html: renderResetEmail(issued.code)
      });
    } catch (e) {
      await codeModel.clear(target.id, 'reset');
      return emailFailure(e);
    }

    return jsonResponse(generic);
  } catch (e) {
    console.error('发送重置验证码失败:', e);
    return jsonResponse(error('发送验证码失败，请稍后重试', 'SEND_EMAIL_CODE_FAILED'), 500);
  }
}

/**
 * 忘记密码 · 重置并登录（公开，无需登录）
 * body: { email, code, new_password }
 *
 * 校验失败一律回「验证码错误或已过期」，不区分「这个邮箱没注册」——
 * 与 forgot/send 同一个理由。
 */
export async function handleForgotReset(request, env) {
  try {
    const body = await request.json().catch(() => ({}));
    const email = normalizeEmail(body.email);
    const code = String(body.code == null ? '' : body.code).trim();
    const newPassword = String(body.new_password == null ? '' : body.new_password);

    const invalid = validateEmail(email);
    if (invalid) return jsonResponse(error(invalid, 'INVALID_EMAIL'), 400);
    if (newPassword.length < PASSWORD_MIN || newPassword.length > PASSWORD_MAX) {
      return jsonResponse(error(`新密码长度须为 ${PASSWORD_MIN}–${PASSWORD_MAX} 位`, 'WEAK_PASSWORD'), 400);
    }
    if (!env.JWT_SECRET) {
      console.error('未配置 JWT_SECRET，无法签发登录态');
      return jsonResponse(error('服务端暂时不可用，请联系管理员', 'SERVER_MISCONFIGURED'), 500);
    }

    const rejected = () => jsonResponse(error('验证码错误或已过期', 'EMAIL_CODE_INVALID'), 400);

    const userModel = new UserModel(env.DB);
    const target = await userModel.findByEmail(email);
    if (!target || Number(target.email_verified) !== 1) return rejected();

    const result = await new EmailCodeModel(env.DB).verify(target.id, {
      purpose: 'reset',
      email,
      code
    });
    if (!result.ok) return rejected();

    const { hash, salt } = await hashPassword(newPassword);
    await userModel.update(target.id, {
      password_hash: `${salt}:${hash}`,
      // 重置即作废此前所有令牌；下面再签一枚新的给本人 —— 也正好把被盗的会话踢下线
      password_changed_at: passwordChangedAtNow()
    });

    const token = await sign(
      { id: target.id, student_id: target.student_id, name: target.name },
      env.JWT_SECRET,
      jwtExpiresIn(env)
    );
    const fresh = await userModel.findById(target.id);
    const permissions = await computePermissions(env, fresh.positions);

    return jsonResponse(success({
      token,
      user: publicUser(fresh, permissions)
    }));
  } catch (e) {
    console.error('重置密码失败:', e);
    return jsonResponse(error('重置密码失败，请稍后重试', 'RESET_PASSWORD_FAILED'), 500);
  }
}
