/**
 * Web Push 订阅接口（iOS / 安卓 PWA 通用）。
 *
 * 前端只有在能力判定通过、且用户在点击手势里授权之后才会调 subscribe，
 * 所以这里不做「替用户开启」之类的兜底 —— 收不到就如实告诉用户为什么。
 */
import { PushSubscriptionModel } from '../models/pushSubscriptionModel.js';
import { success, error, jsonResponse } from '../utils/response.js';
import { vapidConfig } from '../utils/push.js';
import { sendWebPush, isAllowedPushEndpoint, hostOfEndpoint } from '../utils/webpush.js';

const MAX_ENDPOINT_LEN = 1000;
const MAX_KEY_LEN = 200;
const MAX_UA_LEN = 200;

/**
 * 校验订阅对象：endpoint 必须是 https 且落在已知推送服务白名单内，两个密钥必须是非空字符串。
 *
 * 白名单存在的理由见 utils/webpush.js 的 PUSH_HOST_SUFFIXES（issue #21）：endpoint 由客户端提供，
 * 只校验 https 的话，一个指向私网的地址也能存进库，之后由服务端去 POST。
 */
function validSubscription(body) {
  const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
  if (!endpoint || endpoint.length > MAX_ENDPOINT_LEN) return { ok: false, message: '这台设备的订阅信息不完整，请重新开启通知' };
  if (!isAllowedPushEndpoint(endpoint)) {
    // 只记主机名（endpoint 路径里的 token 是发送凭据，不进日志），好定位「白名单少写了谁」
    console.warn('拒绝不在白名单内的推送端点:', hostOfEndpoint(endpoint));
    return { ok: false, message: '这台设备的推送地址不受支持，暂时无法开启通知' };
  }

  const keys = (body && body.keys) || {};
  const p256dh = typeof keys.p256dh === 'string' ? keys.p256dh.trim() : '';
  const auth = typeof keys.auth === 'string' ? keys.auth.trim() : '';
  if (!p256dh || p256dh.length > MAX_KEY_LEN) return { ok: false, message: '这台设备的订阅信息不完整，请重新开启通知' };
  if (!auth || auth.length > MAX_KEY_LEN) return { ok: false, message: '这台设备的订阅信息不完整，请重新开启通知' };

  return { ok: true, endpoint, p256dh, auth };
}

/**
 * 取推送配置：公钥 + 服务端是否启用 + 本机是否已订阅。
 * 未配置 VAPID 时 enabled=false，前端据此直接说明「服务端未开启推送」，不给死按钮。
 */
export async function handlePushConfig(request, env, user) {
  try {
    const vapid = vapidConfig(env);
    const count = await new PushSubscriptionModel(env.DB).countByUser(user.id);
    return jsonResponse(success({
      enabled: !!vapid,
      public_key: vapid ? vapid.publicKey : null,
      subscribed: count > 0
    }));
  } catch (e) {
    console.error('获取推送配置失败:', e);
    return jsonResponse(error('获取推送配置失败，请稍后重试', 'PUSH_CONFIG_FAILED'), 500);
  }
}

/** 落库 / 改绑（同一 endpoint 换账号登录时改绑到新账号，见 PushSubscriptionModel.upsert） */
export async function handlePushSubscribe(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const parsed = validSubscription(body);
    if (!parsed.ok) return jsonResponse(error(parsed.message, 'INVALID_SUBSCRIPTION'), 400);

    const ua = String(request.headers.get('User-Agent') || '').slice(0, MAX_UA_LEN);
    const model = new PushSubscriptionModel(env.DB);
    const existed = await model.existsByEndpoint(parsed.endpoint);
    await model.upsert({
      userId: user.id,
      endpoint: parsed.endpoint,
      p256dh: parsed.p256dh,
      auth: parsed.auth,
      ua
    });

    // upsert 同时承担新建与改绑，只有确实是新订阅才回 201
    return jsonResponse(success({ message: '已开启通知' }), existed ? 200 : 201);
  } catch (e) {
    console.error('保存推送订阅失败:', e);
    return jsonResponse(error('保存推送订阅失败', 'PUSH_SUBSCRIBE_FAILED'), 500);
  }
}

/** 退订：只删自己那一条 */
export async function handlePushUnsubscribe(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const endpoint = body && typeof body.endpoint === 'string' ? body.endpoint.trim() : '';
    if (!endpoint) return jsonResponse(error('这台设备的订阅信息不完整，请重新开启通知', 'MISSING_ENDPOINT'), 400);

    await new PushSubscriptionModel(env.DB).removeOwn(user.id, endpoint);
    return jsonResponse(success({ message: '已关闭通知' }));
  } catch (e) {
    console.error('退订失败:', e);
    return jsonResponse(error('关闭通知失败，请稍后重试', 'PUSH_UNSUBSCRIBE_FAILED'), 500);
  }
}

/**
 * 给「自己」发一条测试推送（只发本机订阅），用于在手机上确认能不能收到。
 * 不是给全班发 —— 那是发布通知/活动的事。
 */
export async function handlePushTest(request, env, user) {
  try {
    const vapid = vapidConfig(env);
    if (!vapid) {
      console.error('未配置 VAPID 密钥，推送已禁用（见 web/README 的推送一节）');
      return jsonResponse(error('推送功能暂时不可用，请稍后重试', 'PUSH_DISABLED'), 503);
    }

    const model = new PushSubscriptionModel(env.DB);
    const subs = await model.listByUsers([user.id]);
    if (!subs.length) return jsonResponse(error('这台设备还没开启通知', 'NO_SUBSCRIPTION'), 400);

    const message = {
      title: '测试通知',
      body: '如果你看到这条通知，说明这台设备可以收到班级助理的推送。',
      url: '/?view=notices'
    };

    const dead = [];
    const results = [];
    for (const sub of subs) {
      try {
        const res = await sendWebPush(sub, message, vapid);
        results.push(res.status);
        if (res.status === 404 || res.status === 410) dead.push(sub.endpoint);
      } catch (e) {
        console.error('测试推送失败:', e);
        results.push(0);
      }
    }
    if (dead.length) await model.removeByEndpoints(dead);

    if (!results.some((s) => s >= 200 && s < 300)) {
      return jsonResponse(error('推送服务端拒绝了这次请求，请稍后重试', 'PUSH_REJECTED'), 502);
    }
    return jsonResponse(success({ message: '已发送，请查看通知栏', sent: results.length }));
  } catch (e) {
    console.error('测试推送失败:', e);
    return jsonResponse(error('测试推送失败', 'PUSH_TEST_FAILED'), 500);
  }
}
