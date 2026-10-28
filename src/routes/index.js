import { Hono } from 'hono';
import { authRoutes } from './auth.routes.js';
import { healthRoutes } from './health.routes.js';
import { meRoutes } from './me.routes.js';
import { migrateRoutes } from './migrate.routes.js';
import { taskRoutes } from './task.routes.js';

export function apiRoutes() {
  const api = new Hono();

  api.route('/health', healthRoutes());
  api.route('/auth', authRoutes());
  api.route('/me', meRoutes());
  api.route('/tasks', taskRoutes());
  api.route('/migrate', migrateRoutes());

  return api;
}
