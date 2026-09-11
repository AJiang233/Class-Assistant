/**
 * 统一响应格式
 */

export function success(data) {
  return {
    success: true,
    data
  };
}

export function error(message, code = 'UNKNOWN_ERROR', status = 400) {
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
