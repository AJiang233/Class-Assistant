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

export function jsonResponse(data, status = 200, extraHeaders = {}) {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      'Content-Type': 'application/json',
      ...extraHeaders
    }
  });
}

export function tooManyRequests(retryAfterMs = 0) {
  const seconds = Math.max(1, Math.ceil(retryAfterMs / 1000));
  return jsonResponse(
    error('尝试过于频繁，请稍后再试', 'RATE_LIMITED'),
    429,
    { 'Retry-After': String(seconds) }
  );
}
