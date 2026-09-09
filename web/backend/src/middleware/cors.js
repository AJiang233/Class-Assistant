/**
 * CORS 中间件
 */
const allowedOrigins = [
  'http://localhost:5173',      // 本地开发前端 (Vite)
  'http://localhost:3000',
  'http://localhost:8080',      // 本地开发前端（静态服务器）
  'http://localhost:8787',      // wrangler dev 本地调试
  'https://class.qxwkstudio.top' // 生产前端域名（不带尾部斜杠，否则 Origin 比对失败）
];

export function handleCors(request) {
  const origin = request.headers.get('Origin');
  const isAllowed = allowedOrigins.includes(origin);

  return {
    'Access-Control-Allow-Origin': isAllowed ? origin : allowedOrigins[0],
    'Access-Control-Allow-Methods': 'GET, POST, PUT, DELETE, OPTIONS',
    'Access-Control-Allow-Headers': 'Content-Type, Authorization',
    'Access-Control-Max-Age': '86400'
  };
}

export function corsResponse(request) {
  const headers = handleCors(request);
  return new Response(null, {
    status: 204,
    headers
  });
}
