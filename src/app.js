import { Hono } from 'hono';
import { corsMiddleware } from './middleware/cors.js';
import { ensureDatabaseContext } from './middleware/database.js';
import { errorHandler, notFoundHandler } from './middleware/error-handler.js';
import { requestContext } from './middleware/request-context.js';
import { enforceSameOrigin, securityHeaders } from './middleware/security.js';
import { sessionMiddleware } from './middleware/session.js';
import { apiRoutes } from './routes/index.js';

/**
 * 组合根：中间件顺序即安全边界。
 *   上下文 → CORS → 安全头 → 同源校验 → D1 仓库 → 会话 → 业务路由
 */
export function createApp() {
  const app = new Hono();

  app.use('*', requestContext());
  app.use('/api/*', corsMiddleware());
  app.use('/api/*', securityHeaders());
  app.use('/api/*', enforceSameOrigin());

  app.use('/api/auth/*', ensureDatabaseContext());
  app.use('/api/me', ensureDatabaseContext());
  app.use('/api/me/*', ensureDatabaseContext());
  app.use('/api/tasks/*', ensureDatabaseContext());
  app.use('/api/migrate/*', ensureDatabaseContext());

  app.use('/api/*', sessionMiddleware());

  app.route('/api', apiRoutes());

  app.notFound(notFoundHandler);
  app.onError(errorHandler);

  return app;
}
