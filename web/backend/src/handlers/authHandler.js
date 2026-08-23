import { UserModel } from '../models/userModel.js';
import { hashPassword, verifyPassword } from '../utils/crypto.js';
import { sign } from '../utils/jwt.js';
import { success, error, jsonResponse } from '../utils/response.js';

/**
 * 用户注册
 */
export async function handleRegister(request, env) {
  try {
    const body = await request.json();
    const { student_id, name, password, positions = '学生', contact = '' } = body;

    // 校验必填字段
    if (!student_id || !name || !password) {
      return jsonResponse(error('学号、姓名、密码为必填字段', 'MISSING_FIELDS'), 400);
    }

    // positions 兼容数组（自动转 JSON 字符串）或字符串，D1 不接受 object 类型
    const positionsValue = Array.isArray(positions) ? JSON.stringify(positions) : positions;

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

    return jsonResponse(success({
      token,
      user: {
        id: user.id,
        student_id: user.student_id,
        name: user.name,
        positions: user.positions,
        contact: user.contact
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

    return jsonResponse(success(user));
  } catch (e) {
    console.error('获取用户信息失败:', e);
    return jsonResponse(error('获取用户信息失败', 'FETCH_USER_FAILED'), 500);
  }
}
