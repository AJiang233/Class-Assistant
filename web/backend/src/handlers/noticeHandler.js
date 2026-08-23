import { NoticeModel } from '../models/noticeModel.js';
import { success, error, jsonResponse } from '../utils/response.js';

/**
 * 发布通知（需登录）
 */
export async function handleCreateNotice(request, env, user) {
  try {
    const body = await request.json();
    const { title, content, publish_time, remind_people = null } = body;

    if (!title || !content || !publish_time) {
      return jsonResponse(error('标题、内容、发布时间为必填字段', 'MISSING_FIELDS'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);
    await noticeModel.create({
      title,
      content,
      publish_time,
      publisher: user.name,  // 使用当前登录用户名
      remind_people: remind_people ? JSON.stringify(remind_people) : null,
      source: 'manual'
    });

    return jsonResponse(success({ message: '通知发布成功' }), 201);
  } catch (e) {
    console.error('发布通知失败:', e);
    return jsonResponse(error('发布通知失败', 'CREATE_NOTICE_FAILED'), 500);
  }
}

/**
 * 获取通知列表（需登录）
 */
export async function handleListNotices(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = parseInt(url.searchParams.get('limit')) || 50;
    const offset = parseInt(url.searchParams.get('offset')) || 0;

    const noticeModel = new NoticeModel(env.DB);
    const list = await noticeModel.list(limit, offset);

    return jsonResponse(success({ list, total: list.length }));
  } catch (e) {
    console.error('获取通知列表失败:', e);
    return jsonResponse(error('获取通知列表失败', 'LIST_NOTICES_FAILED'), 500);
  }
}

/**
 * 获取单条通知（需登录）
 */
export async function handleGetNotice(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的通知ID', 'INVALID_ID'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);
    const notice = await noticeModel.findById(id);

    if (!notice) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    return jsonResponse(success(notice));
  } catch (e) {
    console.error('获取通知失败:', e);
    return jsonResponse(error('获取通知失败', 'GET_NOTICE_FAILED'), 500);
  }
}

/**
 * 更新通知（需登录）
 */
export async function handleUpdateNotice(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的通知ID', 'INVALID_ID'), 400);
    }

    const body = await request.json();
    const noticeModel = new NoticeModel(env.DB);

    // 检查通知是否存在
    const existing = await noticeModel.findById(id);
    if (!existing) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    await noticeModel.update(id, body);

    return jsonResponse(success({ message: '通知更新成功' }));
  } catch (e) {
    console.error('更新通知失败:', e);
    return jsonResponse(error('更新通知失败', 'UPDATE_NOTICE_FAILED'), 500);
  }
}

/**
 * 删除通知（需登录）
 */
export async function handleDeleteNotice(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('无效的通知ID', 'INVALID_ID'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);

    // 检查通知是否存在
    const existing = await noticeModel.findById(id);
    if (!existing) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    await noticeModel.delete(id);

    return jsonResponse(success({ message: '通知删除成功' }));
  } catch (e) {
    console.error('删除通知失败:', e);
    return jsonResponse(error('删除通知失败', 'DELETE_NOTICE_FAILED'), 500);
  }
}
