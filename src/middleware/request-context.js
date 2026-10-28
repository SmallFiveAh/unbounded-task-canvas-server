import { loadConfig } from '../config/env.js';
import { createLogger } from '../lib/logger.js';

/**
 * 为每个请求建立上下文：配置、日志、请求 id。
 * D1 仓库在 database 中间件里按需创建（/api/health 不需要数据库）。
 */
export function requestContext() {
  return async (c, next) => {
    const env = c.env ?? {};
    const requestId = c.req.header('CF-Ray') ?? crypto.randomUUID();
    const config = loadConfig(env);
    const logger = createLogger({ requestId, environment: config.environment });

    const ctx = {
      env,
      config,
      logger,
      requestId,
      db: env.DB ?? null,
      repos: null,
      auth: null,
      userId: null,
      startedAt: Date.now(),
    };

    c.set('ctx', ctx);
    c.header('X-Request-Id', requestId);

    await next();

    logger.info('request.completed', {
      method: c.req.method,
      path: new URL(c.req.url).pathname,
      status: c.res?.status ?? 0,
      durationMs: Date.now() - ctx.startedAt,
      userId: ctx.userId ?? undefined,
    });
  };
}
