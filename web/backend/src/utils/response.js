/**
 * 统一响应格式
 */

export function success(data) {
  return {
    success: true,
    data
  };
}

/**
 * 构造失败结果体。
 * HTTP 状态码由 jsonResponse(data, status) 决定，这里不接收状态码 ——
 * 曾经多一个从不生效的 status 形参，容易让人误以为写了就会生效。
 */
export function error(message, code = 'UNKNOWN_ERROR') {
  return {
    success: false,
    error: message,
    code
  };
}

/**
 * 统一 JSON 响应。
 *
 * headers 是可选的附加响应头（限流响应要下发 Retry-After）。调用方传的头只能
 * *补充* 不能覆盖 Content-Type：漏写 Content-Type 的 JSON 响应会被浏览器按文本处理，
 * 前端 res.json() 直接失败。
 */
export function jsonResponse(data, status = 200, headers = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      ...headers,
      'Content-Type': 'application/json'
    }
  });
}
