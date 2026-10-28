import { createRepositories } from '../repositories/index.js';

/**
 * 业务路由需要 D1；/api/health 不挂这个中间件，方便确认「服务活着但库没配」。
 * 必须在 sessionMiddleware 之前执行，因为解析会话要读 sessions 表。
 */
export function ensureDatabaseContext() {
  return async (c, next) => {
    const ctx = c.get('ctx');
    if (!ctx.repos) {
      ctx.repos = createRepositories(ctx.env?.DB);
    }
    await next();
  };
}
