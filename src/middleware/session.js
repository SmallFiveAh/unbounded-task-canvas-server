import { appendCookie, parseCookieHeader } from '../lib/cookies.js';
import { unauthorized } from '../lib/errors.js';
import { clearSessionCookie, resolveSession } from '../services/session.service.js';

/**
 * 解析会话 cookie，注入 ctx.auth / ctx.userId。
 * 未登录不报错，由 requireAuth 决定哪些路由必须登录。
 */
export function sessionMiddleware() {
  return async (c, next) => {
    const ctx = c.get('ctx');
    const cookies = parseCookieHeader(c.req.header('Cookie'));
    const token = cookies[ctx.config.cookie.name];

    if (token && ctx.repos) {
      const auth = await resolveSession(ctx, token);
      if (auth) {
        ctx.auth = auth;
        ctx.userId = auth.userId;
      } else {
        appendCookie(c, clearSessionCookie(ctx.config));
      }
    }

    await next();
  };
}

export function requireAuth() {
  return async (c, next) => {
    const ctx = c.get('ctx');
    if (!ctx.auth) {
      throw unauthorized('UNAUTHENTICATED', '请先登录');
    }
    await next();
  };
}
