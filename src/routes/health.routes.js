import { Hono } from 'hono';
import { healthController } from '../controllers/health.controller.js';

export function healthRoutes() {
  const router = new Hono();
  router.get('/', healthController.check);
  return router;
}
