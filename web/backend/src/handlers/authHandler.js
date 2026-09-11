import { UserModel } from '../models/userModel.js';
import { RoleModel } from '../models/roleModel.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { sign } from '../utils/jwt.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { parsePositions, getPermissions, buildRoleMap } from '../utils/permissions.js';

/**
 * 计算某用户的权限集合（含自定义职位，来自 roles 表）
 */
async function computePermissions(env, positions) {
  try {
    const roleModel = new RoleModel(env.DB);
    const customMap = buildRoleMap(await roleModel.list());
    return Array.from(getPermissions(positions, customMap));
  } catch (e) {
    return Array.from(getPermissions(positions));
  }
}

/**
 * 用户注册
 */
export async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { student_id, name, password, positions = '学生', contact = '', role_permissions, role_name } = body;

    // 校验必填字段
    if (!student_id || !name || !password) {
      return jsonResponse(error('学号、姓名、密码为必填字段', 'MISSING_FIELDS'), 400);
    }

    // 若注册了自定义职位且指定了权限，则先把该职位写入 roles 表
    // role_name 指定该自定义职位的名称；兼容旧客户端：未传 role_name 时回退到字符串形式的 positions
    if (role_permissions && Array.isArray(role_permissions) && role_permissions.length) {
      const customName = role_name || (typeof positions === 'string' ? positions : '');
      if (customName) {
        const roleModel = new RoleModel(env.DB);
        await roleModel.upsert(customName, JSON.stringify(role_permissions));
      }
    }

    // positions 兼容数组（自动转 JSON 字符串）或字符串，D1 不接受 object 类型；空数组回退为「学生」
    const posArr = Array.isArray(positions) ? positions.filter(Boolean) : null;
    const positionsValue = posArr ? (posArr.length ? JSON.stringify(posArr) : '学生') : positions;

    const userModel = new UserModel(env.DB);

    // 检查学号是否已存在
    const existing = await userModel.findByStudentId(student_id);
    if (existing) {
      return jsonResponse(error('该学号已注册', 'STUDENT_ID_EXISTS'), 409);
    }

    // 哈希密码
    const { hash, salt } = await hashPassword(password);
    const passwordHash = `${salt}:${hash}`;  // 存储格式：盐值:哈希

    // 创建用户
    await userModel.create({
      student_id,
      name,
      password_hash: passwordHash,
      positions: positionsValue,
      contact
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
      return jsonResponse(error('学号和密码为必填字段', 'MISSING_FIELDS'), 400);
    }

    const userModel = new UserModel(env.DB);
    const user = await userModel.findByStudentId(student_id);

    if (!user) {
      return jsonResponse(error('学号或密码错误', 'INVALID_CREDENTIALS'), 401);
    }

    // 验证密码（格式：盐值:哈希）
    const [salt, hash] = user.password_hash.split(':');
    const isValid = await verifyPassword(password, hash, salt);

    if (!isValid) {
      return jsonResponse(error('学号或密码错误', 'INVALID_CREDENTIALS'), 401);
    }

    // 生成 JWT
    const token = await sign(
      { id: user.id, student_id: user.student_id, name: user.name },
      env.JWT_SECRET
    );

    const permissions = await computePermissions(env, user.positions);

    return jsonResponse(success({
      token,
      user: {
        id: user.id,
        student_id: user.student_id,
        name: user.name,
        positions: user.positions,
        contact: user.contact,
        permissions
      }
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
      return jsonResponse(error('用户不存在', 'USER_NOT_FOUND'), 404);
    }

    const permissions = await computePermissions(env, user.positions);

    return jsonResponse(success({ ...user, permissions }));
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
      return jsonResponse(error('没有可更新的字段', 'MISSING_FIELDS'), 400);
    }

    const value = String(contact).trim();
    if (value.length > 60) {
      return jsonResponse(error('联系方式最多 60 个字符', 'CONTACT_TOO_LONG'), 400);
    }

    const userModel = new UserModel(env.DB);
    await userModel.update(user.id, { contact: value });

    const fresh = await userModel.findById(user.id);
    return jsonResponse(success({
      message: '更新成功',
      contact: fresh ? fresh.contact : value,
      update_time: fresh ? fresh.update_time : null
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
      return jsonResponse(error('旧密码、新密码为必填字段', 'MISSING_FIELDS'), 400);
    }
    if (new_password.length < 6) {
      return jsonResponse(error('新密码长度至少 6 位', 'WEAK_PASSWORD'), 400);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findByStudentId(user.student_id);
    if (!existing) {
      return jsonResponse(error('用户不存在', 'USER_NOT_FOUND'), 404);
    }

    const [salt, hash] = existing.password_hash.split(':');
    const isValid = await verifyPassword(old_password, hash, salt);
    if (!isValid) {
      return jsonResponse(error('旧密码错误', 'INVALID_OLD_PASSWORD'), 400);
    }

    const { hash: newHash, salt: newSalt } = await hashPassword(new_password);
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
      return jsonResponse(error('无效的用户ID', 'INVALID_ID'), 400);
    }
    if (id === user.id) {
      return jsonResponse(error('不能删除当前登录账号', 'CANNOT_DELETE_SELF'), 400);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findById(id);
    if (!existing) {
      return jsonResponse(error('用户不存在', 'USER_NOT_FOUND'), 404);
    }

    await userModel.delete(id);
    return jsonResponse(success({ message: '删除成功' }));
  } catch (e) {
    console.error('删除成员失败:', e);
    return jsonResponse(error('删除成员失败', 'DELETE_USER_FAILED'), 500);
  }
}

/**
 * 更新班级成员资料（姓名/职务/联系方式，需 user:manage 权限）
 */
export async function handleUpdateUser(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的用户ID', 'INVALID_ID'), 400);
    }

    const body = await request.json();
    const { name, positions, contact } = body;
    if (name === undefined && positions === undefined && contact === undefined) {
      return jsonResponse(error('没有可更新的字段', 'MISSING_FIELDS'), 400);
    }

    const userModel = new UserModel(env.DB);
    const existing = await userModel.findById(id);
    if (!existing) {
      return jsonResponse(error('用户不存在', 'USER_NOT_FOUND'), 404);
    }

    const data = {};
    if (name !== undefined) data.name = name;
    if (positions !== undefined) data.positions = Array.isArray(positions) ? JSON.stringify(positions) : positions;
    if (contact !== undefined) data.contact = contact;

    await userModel.update(id, data);
    return jsonResponse(success({ message: '更新成功' }));
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
    const list = rows.map((r) => ({ name: r.name, permissions: r.permissions }));
    return jsonResponse(success({ list }));
  } catch (e) {
    console.error('获取自定义职位失败:', e);
    return jsonResponse(error('获取自定义职位失败', 'LIST_ROLES_FAILED'), 500);
  }
}
