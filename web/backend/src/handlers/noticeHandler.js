import { normalizeRecipients } from '../utils/recipients.js';
import { NoticeModel } from '../models/noticeModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { normalizeTimeRange } from '../utils/datetime.js';
import { pageLimit, pageOffset } from '../utils/query.js';
import { isSafeLink } from '../utils/link.js';
import {
  canManageItem,
  canViewItem,
  itemForViewer,
  loadViewer,
  listByAudience
} from '../utils/audience.js';

/**
 * 发布通知（需登录）
 */
export async function handleCreateNotice(request, env, user, ctx) {
  try {
    const body = await request.json();
    const { title, content, publish_time, remind_people = null, expire_time = null, link = null } = body;

    if (!title || !content || !publish_time) {
      return jsonResponse(error('请填写标题、内容和发布时间', 'MISSING_FIELDS'), 400);
    }
    if (!isSafeLink(link)) {
      return jsonResponse(error('跳转地址只能是本站页面', 'INVALID_LINK'), 400);
    }
    const times = normalizeTimeRange(publish_time, expire_time);
    if (!times) {
      return jsonResponse(error('通知时间不正确，过期时间不能早于发布时间', 'INVALID_TIME'), 400);
    }

    const remind = await normalizeRecipients(env.DB, remind_people);
    if (remind === false) return jsonResponse(error('提醒对象必须是有效的用户 ID 数组', 'INVALID_REMIND'), 400);
    const noticeModel = new NoticeModel(env.DB);
    const noticeId = await noticeModel.create({
      title,
      content,
      publish_time: times.start,
      // 署名与归属都由服务端从登录态写，请求体里传什么都不作数
      publisher: user.name,
      created_by: user.id,
      remind_people: remind,
      source: 'manual',
      expire_time: times.end,
      link: link ? String(link).trim() : null
    });

    // 数据库触发器与业务写入一起登记持久投递事件，由定时消费者处理。

    return jsonResponse(success({ message: '通知发布成功' }), 201);
  } catch (e) {
    console.error('发布通知失败:', e);
    return jsonResponse(error('发布通知失败，请稍后重试', 'CREATE_NOTICE_FAILED'), 500);
  }
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
    const mine = url.searchParams.get('audience') === 'mine';
    const list = mine ? await noticeModel.listPersonal(viewer, limit + 1, offset, date, scope) : await listByAudience(viewer,
      (l, o) => (scope === 'all' ? noticeModel.listAll(l, o) : noticeModel.list(l, o, date)),
      limit, offset);

    const page = mine ? list.slice(0, limit) : list;
    return jsonResponse(success({ list: page, total: page.length,
      nextOffset: mine && list.length > limit ? offset + limit : null }));
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
      return jsonResponse(error('通知不存在', 'INVALID_ID'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);
    const notice = await noticeModel.findById(id);

    // 看不到的条目与不存在的条目回同一个 404：既挡住「不计入班级管理」的人按 id 取全班内容，
    // 也不从状态码上泄露「这条内容确实存在」。文案同理 —— 只能写「没找到 + 两种可能」，
    // 不能写死「不存在」：被定向名单挡在外面的人会以为是自己点错了链接。
    const viewer = await loadViewer(env, user);
    if (!notice || !canViewItem(notice.remind_people, viewer)) {
      return jsonResponse(error('没有找到这条通知 —— 可能已被删除，也可能你不在提醒对象里', 'NOTICE_NOT_FOUND'), 404);
    }

    // 定向名单只回给能发文的人（编辑表单要拿它预填）；canManage 供前端决定显不显示改/删按钮
    return jsonResponse(success(itemForViewer(notice, viewer)));
  } catch (e) {
    console.error('获取通知失败:', e);
    return jsonResponse(error('获取通知失败', 'GET_NOTICE_FAILED'), 500);
  }
}

/**
 * 更新通知（需登录 + content:write + 是自己发布的）
 */
export async function handleUpdateNotice(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('通知不存在', 'INVALID_ID'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);

    // 检查通知是否存在
    const existing = await noticeModel.findById(id);
    if (!existing) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    // 归属校验：content:write 只说明「能发内容」，不等于「能改别人发的内容」
    const viewer = await loadViewer(env, user);
    if (!canManageItem(existing, viewer)) {
      return jsonResponse(error('只能编辑自己发布的通知', 'FORBIDDEN'), 403);
    }

    const body = await request.json().catch(() => ({}));

    // 逐字段取，不整包透传：此前 ...rest 会把 publisher 一并写进库，
    // 于是「改通知」顺带能把署名伪造成别人（见 issue #17）
    const payload = {};
    if (body.title !== undefined) payload.title = body.title;
    if (body.content !== undefined) payload.content = body.content;
    if (body.publish_time !== undefined || body.expire_time !== undefined) {
      const times = normalizeTimeRange(
        body.publish_time !== undefined ? body.publish_time : existing.publish_time,
        body.expire_time !== undefined ? body.expire_time : existing.expire_time
      );
      if (!times) {
        return jsonResponse(error('通知时间不正确，过期时间不能早于发布时间', 'INVALID_TIME'), 400);
      }
      if (body.publish_time !== undefined) payload.publish_time = times.start;
      if (body.expire_time !== undefined) payload.expire_time = times.end;
    }
    if (body.remind_people !== undefined) {
      payload.remind_people = await normalizeRecipients(env.DB, body.remind_people);
      if (payload.remind_people === false) return jsonResponse(error('提醒对象必须是有效的用户 ID 数组', 'INVALID_REMIND'), 400);
    }
    if (body.link !== undefined) {
      if (!isSafeLink(body.link)) {
        return jsonResponse(error('跳转地址只能是本站页面', 'INVALID_LINK'), 400);
      }
      payload.link = body.link ? String(body.link).trim() : null;
    }

    await noticeModel.update(id, payload);

    return jsonResponse(success({ message: '通知已保存' }));
  } catch (e) {
    console.error('更新通知失败:', e);
    return jsonResponse(error('保存通知失败，请稍后重试', 'UPDATE_NOTICE_FAILED'), 500);
  }
}

/**
 * 删除通知（需登录 + content:write + 是自己发布的）
 */
export async function handleDeleteNotice(request, env, user, params) {
  try {
    const id = parseInt(params.id);
    if (!id) {
      return jsonResponse(error('通知不存在', 'INVALID_ID'), 400);
    }

    const noticeModel = new NoticeModel(env.DB);

    // 检查通知是否存在
    const existing = await noticeModel.findById(id);
    if (!existing) {
      return jsonResponse(error('通知不存在', 'NOTICE_NOT_FOUND'), 404);
    }

    const viewer = await loadViewer(env, user);
    if (!canManageItem(existing, viewer)) {
      return jsonResponse(error('只能删除自己发布的通知', 'FORBIDDEN'), 403);
    }

    await noticeModel.delete(id);

    return jsonResponse(success({ message: '通知删除成功' }));
  } catch (e) {
    console.error('删除通知失败:', e);
    return jsonResponse(error('删除通知失败', 'DELETE_NOTICE_FAILED'), 500);
  }
}
