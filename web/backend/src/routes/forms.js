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
 * 且 handler 内会再校验调用者是创建者（避免拿到别人的全班学号名单）。
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
