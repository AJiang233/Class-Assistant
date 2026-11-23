import { SettingModel } from '../models/settingModel.js';
import { recordAudit } from '../utils/audit.js';
import { success, error, jsonResponse } from '../utils/response.js';

/**
 * 读取全局功能开关（需 user:manage 权限）。
 *
 * `chaoxing_available: false` 不是说学习通功能坏了，而是门户目前还没有 /api/chaoxing/*
 * 路由（那部分在私有 Worker，尚未接入）；开关先可配，等路由接上即生效。前端据此把学习通
 * 那个开关标成「待接入」，而不是给一个看起来能用、实际什么都不关的按钮。
 */
export async function handleGetSettings(request, env, user) {
  try {
    const settings = await new SettingModel(env.DB).all();
    return jsonResponse(success({
      academic: settings.academic,
      chaoxing: settings.chaoxing,
      chaoxing_available: false
    }));
  } catch (e) {
    console.error('读取功能开关失败:', e);
    return jsonResponse(error('读取功能开关失败', 'GET_SETTINGS_FAILED'), 500);
  }
}

/**
 * 修改全局功能开关（需 user:manage 权限）。
 *
 * body: { academic?: boolean, chaoxing?: boolean }，至少给一个。
 * 只接受真正的布尔值：把 "false" 这种字符串当成 false 会让前端一次拼错就把功能关掉，
 * 而管理员以为自己只是没改。
 */
export async function handleUpdateSettings(request, env, user) {
  try {
    const body = await request.json().catch(() => ({}));
    const changes = {};
    for (const feature of ['academic', 'chaoxing']) {
      if (body[feature] === undefined) continue;
      if (typeof body[feature] !== 'boolean') {
        return jsonResponse(error('开关值必须是布尔值', 'INVALID_SETTINGS'), 400);
      }
      changes[feature] = body[feature];
    }
    if (Object.keys(changes).length === 0) {
      return jsonResponse(error('没有需要保存的修改', 'MISSING_FIELDS'), 400);
    }

    const model = new SettingModel(env.DB);
    for (const [feature, enabled] of Object.entries(changes)) {
      await model.set(feature, enabled);
    }

    // 改开关是能影响全班的功能级操作，必须留痕（动作码 settings_updated 在 0005 就预留了）。
    // detail 里只放「改了哪几项、改成什么」，不含任何用户数据。
    await recordAudit(env, request, user, 'settings_updated', 'settings', null, { changed: changes });

    const settings = await model.all();
    return jsonResponse(success({ message: '已保存', settings }));
  } catch (e) {
    console.error('修改功能开关失败:', e);
    return jsonResponse(error('修改功能开关失败', 'UPDATE_SETTINGS_FAILED'), 500);
  }
}
