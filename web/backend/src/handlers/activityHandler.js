import { ActivityModel } from '../models/activityModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { toLocalDateTime } from '../utils/datetime.js';
import { pageLimit, pageOffset } from '../utils/query.js';
import { canManageItem, canViewItem, itemForViewer, loadViewer, listByAudience } from '../utils/audience.js';
import { pushToRemindAudience } from '../utils/push.js';

/**
 * 发布活动（需登录）
 */
export async function handleCreateActivity(request, env, user, ctx) {
  try {
    const body = await request.json();
    const { title, content = '', location = '', start_time, end_time = '', remind_people = null } = body;

    if (!title || !start_time) {
      return jsonResponse(error('标题、开始时间为必填字段', 'MISSING_FIELDS'), 400);
    }

    const remind = remind_people ? JSON.stringify(remind_people) : null;
    const activityModel = new ActivityModel(env.DB);
    const activityId = await activityModel.create({
      title,
      content,
      location,
      start_time: toLocalDateTime(start_time),
      end_time: toLocalDateTime(end_time),
      // 署名与归属都由服务端从登录态写，请求体里传什么都不作数
      publisher: user.name,
      created_by: user.id,
      remind_people: remind
    });

    // 推送：收件人与活动列表同一判定（utils/audience.js），发送在 waitUntil 里不拖慢响应
    await pushToRemindAudience(env, ctx, remind, {
      title: String(title),
      body: activityBody(content, location, start_time),
      url: activityId ? '/?view=activities&id=' + activityId : '/?view=activities',
      tag: activityId ? 'activity-' + activityId : undefined,
      excludeUserId: user.id
    });

    return jsonResponse(success({ message: '活动发布成功' }), 201);
  } catch (e) {
    console.error('发布活动失败:', e);
    return jsonResponse(error('发布活动失败', 'CREATE_ACTIVITY_FAILED'), 500);
  }
}

/** 锁屏上给一行「时间 + 地点」，比正文更实用 */
function activityBody(content, location, startTime) {
  const time = String(startTime == null ? '' : startTime).replace('T', ' ').slice(0, 16);
  const parts = [time, location ? String(location).trim() : ''].filter(Boolean);
  const head = parts.join(' · ');
  const text = head || String(content || '').replace(/\s+/g, ' ').trim();
  return text.length > 80 ? text.slice(0, 80) + '…' : text;
}

/**
 * 获取活动列表（需登录）
 */
export async function handleListActivities(request, env, user) {
  try {
    const url = new URL(request.url);
    const limit = pageLimit(url);
    const offset = pageOffset(url);
    // scope=all 返回全部活动（含已结束/未开始的），用于按「进行中/即将开始/已结束」分类
    const scope = url.searchParams.get('scope') || 'active';
    // date（YYYY-MM-DD）可选：只返回时间窗口覆盖该日的活动，用于主页按日历选中日期展示
    const date = url.searchParams.get('date') || null;

    const activityModel = new ActivityModel(env.DB);
    // 提醒对象为空的条目对「不计入班级管理」的人不可见（安卓推送读的也是这个接口）
    const viewer = await loadViewer(env, user);
    const list = await listByAudience(viewer,
      (l, o) => (scope === 'all' ? activityModel.listAll(l, o) : activityModel.list(l, o, date)),
      limit, offset);

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

    // 看不到的条目与不存在的条目回同一个 404（同通知单条读取）
    const viewer = await loadViewer(env, user);
    if (!activity || !canViewItem(activity.remind_people, viewer)) {
      return jsonResponse(error('活动不存在', 'ACTIVITY_NOT_FOUND'), 404);
    }

    // 定向名单只回给能发文的人（编辑表单要拿它预填）；canManage 供前端决定显不显示改/删按钮
    return jsonResponse(success(itemForViewer(activity, viewer)));
  } catch (e) {
    console.error('获取活动失败:', e);
    return jsonResponse(error('获取活动失败', 'GET_ACTIVITY_FAILED'), 500);
  }
}

/**
 * 更新活动（需登录 + content:write + 是自己发布的）
 */
export async function handleUpdateActivity(request, env, user, params) {
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

    // 归属校验：content:write 只说明「能发内容」，不等于「能改别人发的内容」
    const viewer = await loadViewer(env, user);
    if (!canManageItem(existing, viewer)) {
      return jsonResponse(error('只能修改自己发布的活动', 'FORBIDDEN'), 403);
    }

    const body = await request.json().catch(() => ({}));

    // 逐字段取，不整包透传：此前 ...rest 会把 publisher 一并写进库（见 issue #17）
    const payload = {};
    if (body.title !== undefined) payload.title = body.title;
    if (body.content !== undefined) payload.content = body.content;
    if (body.location !== undefined) payload.location = body.location;
    if (body.start_time !== undefined) payload.start_time = toLocalDateTime(body.start_time);
    if (body.end_time !== undefined) payload.end_time = toLocalDateTime(body.end_time);
    if (body.remind_people !== undefined) {
      payload.remind_people = Array.isArray(body.remind_people)
        ? JSON.stringify(body.remind_people)
        : body.remind_people;
    }

    await activityModel.update(id, payload);

    return jsonResponse(success({ message: '活动更新成功' }));
  } catch (e) {
    console.error('更新活动失败:', e);
    return jsonResponse(error('更新活动失败', 'UPDATE_ACTIVITY_FAILED'), 500);
  }
}

/**
 * 删除活动（需登录 + content:write + 是自己发布的）
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

    const viewer = await loadViewer(env, user);
    if (!canManageItem(existing, viewer)) {
      return jsonResponse(error('只能删除自己发布的活动', 'FORBIDDEN'), 403);
    }

    await activityModel.delete(id);

    return jsonResponse(success({ message: '活动删除成功' }));
  } catch (e) {
    console.error('删除活动失败:', e);
    return jsonResponse(error('删除活动失败', 'DELETE_ACTIVITY_FAILED'), 500);
  }
}
