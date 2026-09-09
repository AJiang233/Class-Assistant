import { ActivityModel } from '../models/activityModel.js';
import { success, error, jsonResponse } from '../utils/response.js';

/**
 * 发布活动（需登录）
 */
export async function handleCreateActivity(request, env, user) {
  try {
    const body = await request.json();
    const { title, content = '', location = '', start_time, end_time = '', remind_people = null } = body;

    if (!title || !start_time) {
      return jsonResponse(error('标题、开始时间为必填字段', 'MISSING_FIELDS'), 400);
    }

    const activityModel = new ActivityModel(env.DB);
    await activityModel.create({
      title,
      content,
      location,
      start_time,
      end_time,
      publisher: user.name,
      remind_people: remind_people ? JSON.stringify(remind_people) : null
    });

    return jsonResponse(success({ message: '活动发布成功' }), 201);
  } catch (e) {
    console.error('发布活动失败:', e);
    return jsonResponse(error('发布活动失败', 'CREATE_ACTIVITY_FAILED'), 500);
  }
}

/**
 * 获取活动列表（需登录）
 */
export async function handleListActivities(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;

    const activityModel = new ActivityModel(env.DB);
    const list = await activityModel.list(limit, offset);

    return jsonResponse(success({ list, total: list.length }));
  } catch (e) {
    console.error('获取活动列表失败:', e);
    return jsonResponse(error('获取活动列表失败', 'LIST_ACTIVITIES_FAILED'), 500);
  }
}

/**
 * 获取单条活动（需登录）
 */
export async function handleGetActivity(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的活动ID', 'INVALID_ID'), 400);
    }

    const activityModel = new ActivityModel(env.DB);
    const activity = await activityModel.findById(id);

    if (!activity) {
      return jsonResponse(error('活动不存在', 'ACTIVITY_NOT_FOUND'), 404);
    }

    return jsonResponse(success(activity));
  } catch (e) {
    console.error('获取活动失败:', e);
    return jsonResponse(error('获取活动失败', 'GET_ACTIVITY_FAILED'), 500);
  }
}

/**
 * 更新活动（需登录）
 */
export async function handleUpdateActivity(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的活动ID', 'INVALID_ID'), 400);
    }

    const body = await request.json();
    const activityModel = new ActivityModel(env.DB);

    const existing = await activityModel.findById(id);
    if (!existing) {
      return jsonResponse(error('活动不存在', 'ACTIVITY_NOT_FOUND'), 404);
    }

    // 提醒对象数组统一序列化为 JSON 字符串存储
    const payload = { ...body };
    if (payload.remind_people !== undefined && payload.remind_people !== null) {
      payload.remind_people = Array.isArray(payload.remind_people) ? JSON.stringify(payload.remind_people) : payload.remind_people;
    }

    await activityModel.update(id, payload);

    return jsonResponse(success({ message: '活动更新成功' }));
  } catch (e) {
    console.error('更新活动失败:', e);
    return jsonResponse(error('更新活动失败', 'UPDATE_ACTIVITY_FAILED'), 500);
  }
}

/**
 * 删除活动（需登录）
 */
export async function handleDeleteActivity(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的活动ID', 'INVALID_ID'), 400);
    }

    const activityModel = new ActivityModel(env.DB);

    const existing = await activityModel.findById(id);
    if (!existing) {
      return jsonResponse(error('活动不存在', 'ACTIVITY_NOT_FOUND'), 404);
    }

    await activityModel.delete(id);

    return jsonResponse(success({ message: '活动删除成功' }));
  } catch (e) {
    console.error('删除活动失败:', e);
    return jsonResponse(error('删除活动失败', 'DELETE_ACTIVITY_FAILED'), 500);
  }
}
