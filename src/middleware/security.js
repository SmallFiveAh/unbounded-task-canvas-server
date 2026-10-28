import { forbidden } from '../lib/errors.js';

function originFromReferer(referer) {
  if (!referer) return null;
  try {
    return new URL(referer).origin;
  } catch {
    return null;
  }
}

const SAFE_METHODS = new Set(['GET', 'HEAD', 'OPTIONS']);

/**
 * CSRF 第二道防线：SameSite=Lax 为主，非 GET 请求再校验 Origin/Referer 同源
 * （设计 §3.5）。没有 Origin/Referer 的请求视为非浏览器客户端（curl / cron）。
 */
export function enforceSameOrigin() {
  return async (c, next) => {
    if (SAFE_METHODS.has(c.req.method)) {
      await next();
      return;
    }

    const ctx = c.get('ctx');
    const origin = c.req.header('Origin') ?? originFromReferer(c.req.header('Referer'));

    if (origin && !ctx.config.allowedOrigins.has(origin)) {
      throw forbidden('ORIGIN_NOT_ALLOWED', '请求来源不被允许');
    }

    await next();
  };
}

/** 基础安全响应头 */
export function securityHeaders() {
  return async (c, next) => {
    const ctx = c.get('ctx');
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('X-Frame-Options', 'DENY');
    c.header('Cache-Control', 'no-store');
    if (ctx.config.isProduction) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
    await next();
  };
}
