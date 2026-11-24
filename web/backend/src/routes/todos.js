import {
  handleListTodos,
  handleCreateTodo,
  handleUpdateTodo,
  handleUpdateTodoStatus,
  handleDeleteTodo,
  handleDelegateTodos,
  handleAddTodoFromSource,
  handleGetTodoPrefs,
  handleUpdateTodoPrefs,
  handleSyncChaoxingTodos,
  handleHideTodo
} from '../handlers/todoHandler.js';
import { withAuth, withPermission } from '../middleware/auth.js';

/**
 * 待办路由（issue #99）
 * 个人待办全部需要登录；代加需要 content:write；通知/活动附带待办的一键加入走 from-source。
 */
export async function todoRoutes(request, env, ctx) {
  const url = new URL(request.url);
  const path = url.pathname;
  const method = request.method;

  // 阈值设置（注意放在 /api/todos/:id 的数字匹配之前，虽然后者只认数字、并不冲突）
  if (path === '/api/todos/prefs') {
    if (method === 'GET') return withAuth(handleGetTodoPrefs)(request, env, ctx);
    if (method === 'PUT' || method === 'POST') return withAuth(handleUpdateTodoPrefs)(request, env, ctx);
  }

  if (path === '/api/todos/delegate' && method === 'POST') {
    return withPermission('content:write')(handleDelegateTodos)(request, env, ctx);
  }

  if (path === '/api/todos/from-source' && method === 'POST') {
    return withAuth(handleAddTodoFromSource)(request, env, ctx);
  }

  // 学习通作业/考试同步（分批拉取，前端按 next_cursor 继续）。
  if (path === '/api/todos/sync-chaoxing' && method === 'POST') {
    return withAuth(handleSyncChaoxingTodos)(request, env, ctx);
  }

  if (path === '/api/todos') {
    if (method === 'GET') return withAuth(handleListTodos)(request, env, ctx);
    if (method === 'POST') return withAuth(handleCreateTodo)(request, env, ctx);
  }

  const statusMatch = path.match(/^\/api\/todos\/(\d+)\/status$/);
  if (statusMatch && method === 'POST') {
    const params = { id: statusMatch[1] };
    return withAuth((req, env, user) => handleUpdateTodoStatus(req, env, user, params))(request, env, ctx);
  }

  const hideMatch = path.match(/^\/api\/todos\/(\d+)\/hide$/);
  if (hideMatch && method === 'POST') {
    const params = { id: hideMatch[1] };
    return withAuth((req, env, user) => handleHideTodo(req, env, user, params))(request, env, ctx);
  }

  const match = path.match(/^\/api\/todos\/(\d+)$/);
  if (match) {
    const params = { id: match[1] };
    if (method === 'PUT') {
      return withAuth((req, env, user) => handleUpdateTodo(req, env, user, params))(request, env, ctx);
    }
    if (method === 'DELETE') {
      return withAuth((req, env, user) => handleDeleteTodo(req, env, user, params))(request, env, ctx);
    }
  }

  return null;
}
