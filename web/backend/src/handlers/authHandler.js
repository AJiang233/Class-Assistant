import { UserModel } from '../models/userModel.js';
import { RoleModel } from '../models/roleModel.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { sign } from '../utils/jwt.js';
import { success, error, jsonResponse } from '../utils/response.js';
import {
  parsePositions,
  getPermissions,
  buildRoleMap,
  isReservedRole,
  sanitizePermissions,
  assertCustomRoleName,
  positionsToStore,
  STUDENT_ROLE
} from '../utils/permissions.js';

const PASSWORD_MIN = 6;
const PASSWORD_MAX = 72;
const NAME_MAX = 40;
const CONTACT_MAX = 60;

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
    permissions
  };
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
    await userModel.update(existing.id, { password_hash: `${newSalt}:${newHash}` });

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
    const members = list.map(u => ({ ...u, positions: parsePositions(u.positions) }));
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
    return jsonResponse(success({ list }));
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
