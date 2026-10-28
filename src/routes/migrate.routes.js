import { Hono } from 'hono';
import { migrateController } from '../controllers/migrate.controller.js';
import { migrateImportSchema } from '../lib/validation.js';
import { requireAuth } from '../middleware/session.js';
import { validateJson } from '../middleware/validate.js';

export function migrateRoutes() {
  const router = new Hono();

  router.use('*', requireAuth());
  router.post('/import', validateJson(migrateImportSchema), migrateController.import);
  router.post('/rollback/:batchId', migrateController.rollback);

  return router;
}
