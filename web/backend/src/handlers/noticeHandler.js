import { NoticeModel } from '../models/noticeModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { toLocalDateTime } from '../utils/datetime.js';
import { pageLimit, pageOffset } from '../utils/query.js';
import { isSafeLink } from '../utils/link.js';
import { canViewItem, loadViewer, listByAudience, withoutRemindPeople } from '../utils/audience.js';
import { pushToRemindAudience } from '../utils/push.js';

/**
 * 发布通知（需登录）
 */
export async function handleCreateNotice(request, env, user, ctx) {
  try {
    const body = await request.json();
    const { title, content, publish_time, remind_people = null, expire_time = null, link = null } = body;

    if (!title || !content || !publish_time) {
      return jsonResponse(error('标题、内容、发布时间为必填字段', 'MISSING_FIELDS'), 400);
    }
    if (!isSafeLink(link)) {
      return jsonResponse(error('跳转地址只能是站内路径', 'INVALID_LINK'), 400);
    }

    const remind = remind_people ? JSON.stringify(remind_people) : null;
    const noticeModel = new NoticeModel(env.DB);
    const noticeId = await noticeModel.create({
      title,
      content,
      publish_time: toLocalDateTime(publish_time),
      publisher: user.name,
      remind_people: remind,
      source: 'manual',
      expire_time: toLocalDateTime(expire_time),
      link: link ? String(link).trim() : null
    });

    // 推送：收件人与通知列表同一判定（utils/audience.js），发送在 waitUntil 里不拖慢响应
    await pushToRemindAudience(env, ctx, remind, {
      title: String(title),
      body: excerpt(content),
      url: noticeId ? '/?view=notices&id=' + noticeId : '/?view=notices',
      tag: noticeId ? 'notice-' + noticeId : undefined,
      excludeUserId: user.id
    });

    return jsonResponse(success({ message: '通知发布成功' }), 201);
  } catch (e) {
    console.error('发布通知失败:', e);
    return jsonResponse(error('发布通知失败', 'CREATE_NOTICE_FAILED'), 500);
  }
}

/** 通知正文在锁屏上只显示一两行，截一段就够，避免整段长文塞进推送 */
function excerpt(text, max = 80) {
  const s = String(text == null ? '' : text).replace(/\s+/g, ' ').trim();
  return s.length > max ? s.slice(0, max) + '…' : s;
}

/**
 * 获取通知列表（需登录）
 */
export async function handleListNotices(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = pageLimit(url);
    const offset = pageOffset(url);
    // scope=all 返回全部通知（含已过期/未到发布时间的），用于按「进行中/即将开始/已结束」分类
    const scope = url.searchParams.get('scope') || 'active';
    // date（YYYY-MM-DD）可选：只返回生效窗口覆盖该日的通知，用于主页按日历选中日期展示
    const date = url.searchParams.get('date') || null;

    const noticeModel = new NoticeModel(env.DB);
    // 提醒对象为空的条目对「不计入班级管理」的人不可见（安卓推送读的也是这个接口）
    const viewer = await loadViewer(env, user);
    const list = await listByAudience(viewer,
      (l, o) => (scope === 'all' ? noticeModel.listAll(l, o) : noticeModel.list(l, o, date)),
      limit, offset);

    return jsonResponse(success({ list, total: list.length }));
  } catch (e) {
    console.error('获取通知列表失败:', e);
    return jsonResponse(error('获取通知列表失败', 'LIST_NOTICES_FAILED'), 500);
  }
}

/**
 * 获取归档通知列表（含已过期，需 content:write 权限，供管理员查看）
 */
export async function handleListArchivedNotices(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = pageLimit(url);
    const offset = pageOffset(url);

    const noticeModel = new NoticeModel(env.DB);
    const list = await noticeModel.listAll(limit, offset);

    return jsonResponse(success({ list, total: list.length }));
  } catch (e) {
    console.error('获取归档通知失败:', e);
    return jsonResponse(error('获取归档通知失败', 'LIST_NOTICES_FAILED'), 500);
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

    // 看不到的条目与不存在的条目回同一个 404：既挡住「不计入班级管理」的人按 id 取全班内容，
    // 也不从状态码上泄露「这条内容确实存在」
    const viewer = await loadViewer(env, user);
    if (!notice || !canViewItem(notice.remind_people, viewer)) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    // 定向名单只回给能发文的人（编辑表单要拿它预填）
    return jsonResponse(success(withoutRemindPeople(notice, viewer)));
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

    const { publish_time, expire_time, ...rest } = body;
    const payload = { ...rest };
    if (publish_time !== undefined) payload.publish_time = toLocalDateTime(publish_time);
    if (expire_time !== undefined) payload.expire_time = toLocalDateTime(expire_time);
    if (payload.link !== undefined) {
      if (!isSafeLink(payload.link)) {
        return jsonResponse(error('跳转地址只能是站内路径', 'INVALID_LINK'), 400);
      }
      payload.link = payload.link ? String(payload.link).trim() : null;
    }
    if (payload.remind_people !== undefined && payload.remind_people !== null) {
      payload.remind_people = Array.isArray(payload.remind_people) ? JSON.stringify(payload.remind_people) : payload.remind_people;
    }

    await noticeModel.update(id, payload);

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
