/**
 * 请求日志中间件
 */
export function logger(request, env) {
  const url = new URL(request.url);
  const timestamp = new Date().toISOString();

  console.log(`[${timestamp}] ${request.method} ${url.pathname}`);
}
