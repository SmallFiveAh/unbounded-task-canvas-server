import { Hono } from 'hono';
import { meController } from '../controllers/me.controller.js';
import { requireAuth } from '../middleware/session.js';

export function meRoutes() {
  const router = new Hono();
  router.use('*', requireAuth());
  router.get('/', meController.get);
  return router;
}
