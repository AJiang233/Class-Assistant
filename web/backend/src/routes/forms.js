import {
  handleCreateForm,
  handleListForms,
  handleListMyForms,
  handleGetForm,
  handleUpdateForm,
  handleDeleteForm,
  handleSubmitForm,
  handleListSubmissions,
  handleFormProgress,
  handleExportForm
} from '../handlers/formHandler.js';
import { withAuth, withPermission } from '../middleware/auth.js';

/**
 * 表单路由
 * 填写、看自己的提交：登录即可。
 * 建 / 改 / 删 / 提交明细 / 导出 / 未交名单：需 content:write，
 * 且 handler 内会再校验**能不能管这条表单** —— 创建者本人，或持 user:manage 的班委，
 * 与通知 / 活动同一口径（utils/audience.js 的 canManageItem）。只有 content:write 的
 * 学习委员因此碰不到别人的表单，也拿不到别人的全班学号名单。
 *
 * 管理面板的列表（GET /api/forms）照常列出全部表单，好让班委看清班里发过什么、收了多少份，
 * 但每一行按同一判据裁剪 —— 管得了的那几行带 can_manage: true 并保留 remind_people，
 * 其余行前端据此藏掉四个按钮（见 formHandler 的 formForViewer）。
 */
export async function formRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 建表单（同时可选下发通知）
  if (path === '/api/forms' && method === 'POST') {
    return withPermission('content:write')(handleCreateForm)(request, env, ctx);
  }

  // 表单列表（班委管理面板）
  if (path === '/api/forms' && method === 'GET') {
    return withPermission('content:write')(handleListForms)(request, env, ctx);
  }

  // 我的表单：待填 + 已填可修改
  if (path === '/api/forms/mine' && method === 'GET') {
    return withAuth(handleListMyForms)(request, env, ctx);
  }

  const exportMatch = path.match(/^\/api\/forms\/(\d+)\/export$/);
  if (exportMatch && method === 'GET') {
    const params = { id: exportMatch[1] };
    return withPermission('content:write')((req, env, user) =>
      handleExportForm(req, env, user, params)
    )(request, env, ctx);
  }

  const submissionsMatch = path.match(/^\/api\/forms\/(\d+)\/submissions$/);
  if (submissionsMatch && method === 'GET') {
    const params = { id: submissionsMatch[1] };
    return withPermission('content:write')((req, env, user) =>
      handleListSubmissions(req, env, user, params)
    )(request, env, ctx);
  }

  const progressMatch = path.match(/^\/api\/forms\/(\d+)\/progress$/);
  if (progressMatch && method === 'GET') {
    const params = { id: progressMatch[1] };
    return withPermission('content:write')((req, env, user) =>
      handleFormProgress(req, env, user, params)
    )(request, env, ctx);
  }

  const submitMatch = path.match(/^\/api\/forms\/(\d+)\/submit$/);
  if (submitMatch && method === 'POST') {
    const params = { id: submitMatch[1] };
    return withAuth((req, env, user) =>
      handleSubmitForm(req, env, user, params)
    )(request, env, ctx);
  }

  // 表单详情 / 更新 / 删除
  const match = path.match(/^\/api\/forms\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };

    if (method === 'GET') {
      return withAuth((req, env, user) =>
        handleGetForm(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'PUT') {
      return withPermission('content:write')((req, env, user) =>
        handleUpdateForm(req, env, user, params)
      )(request, env, ctx);
    }

    if (method === 'DELETE') {
      return withPermission('content:write')((req, env, user) =>
        handleDeleteForm(req, env, user, params)
      )(request, env, ctx);
    }
  }

  return null;
}
