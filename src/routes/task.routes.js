import { Hono } from 'hono';
import { documentController } from '../controllers/document.controller.js';
import { taskController } from '../controllers/task.controller.js';
import {
  documentSchema,
  taskCreateSchema,
  taskListQuerySchema,
  taskUpdateSchema,
} from '../lib/validation.js';
import { requireAuth } from '../middleware/session.js';
import { validateJson, validateQuery } from '../middleware/validate.js';

export function taskRoutes() {
  const router = new Hono();

  // 所有任务接口都要求登录，且 SQL 一律带 owner_id（设计 §3.5）
  router.use('*', requireAuth());

  router.get('/', validateQuery(taskListQuerySchema), taskController.list);
  router.post('/', validateJson(taskCreateSchema), taskController.create);
  router.patch('/:id', validateJson(taskUpdateSchema), taskController.update);
  router.delete('/:id', taskController.remove);

  router.get('/:id/document', documentController.get);
  router.put('/:id/document', validateJson(documentSchema), documentController.put);

  return router;
}
