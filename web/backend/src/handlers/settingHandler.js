import { SettingModel } from '../models/settingModel.js';
import { recordAudit } from '../utils/audit.js';
import { success, error, jsonResponse } from '../utils/response.js';

/**
 * 读取全局功能开关（需 user:manage 权限）。
 *
 * `chaoxing_available: true` 表示门户已经接上 /api/chaoxing/* 转发层（实现仍在私有
 * Worker）。管理页据此启用学习通开关；把它改成 false 会让那个开关变成「待接入」灰态。
 */
export async function handleGetSettings(request, env, user) {
  try {
    const settings = await new SettingModel(env.DB).all();
    return jsonResponse(success({
      academic: settings.academic,
      chaoxing: settings.chaoxing,
      mooc: settings.mooc,
      chaoxing_available: true,
      mooc_available: true
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
    for (const feature of ['academic', 'chaoxing', 'mooc']) {
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
