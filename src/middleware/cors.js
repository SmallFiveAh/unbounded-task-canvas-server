/**
 * 跨域支持：前端 Dashboard 可能与 Worker 不同源（如 Vite dev server）。
 * 只允许白名单 Origin，并允许携带 Cookie。
 */
export function corsMiddleware() {
  return async (c, next) => {
    const ctx = c.get('ctx');
    const origin = c.req.header('Origin');
    const allowed = origin && ctx.config.allowedOrigins.has(origin);

    if (allowed) {
      c.header('Access-Control-Allow-Origin', origin);
      c.header('Access-Control-Allow-Credentials', 'true');
      c.header('Access-Control-Expose-Headers', 'ETag, X-Request-Id');
      c.header('Vary', 'Origin');
    }

    if (c.req.method === 'OPTIONS') {
      if (allowed) {
        c.header('Access-Control-Allow-Methods', 'GET, POST, PUT, PATCH, DELETE, OPTIONS');
        c.header(
          'Access-Control-Allow-Headers',
          'Content-Type, If-Match, If-None-Match, X-Requested-With',
        );
        c.header('Access-Control-Max-Age', '600');
      }
      return c.body(null, 204);
    }

    await next();
  };
}
