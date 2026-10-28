import {
  createTask,
  listTasks,
  removeTask,
  updateTask,
} from '../services/task.service.js';

export const taskController = {
  async list(c) {
    return c.json(await listTasks(c.get('ctx'), c.get('query')));
  },

  async create(c) {
    return c.json(await createTask(c.get('ctx'), c.get('body')), 201);
  },

  async update(c) {
    const ctx = c.get('ctx');
    return c.json(await updateTask(ctx, c.req.param('id'), c.get('body')));
  },

  async remove(c) {
    await removeTask(c.get('ctx'), c.req.param('id'));
    return c.body(null, 204);
  },
};
