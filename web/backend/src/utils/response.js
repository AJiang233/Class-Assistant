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

export function jsonResponse(data, status = 200) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json'
    }
  });
}
