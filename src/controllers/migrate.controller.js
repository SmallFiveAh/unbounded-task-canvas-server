import { importLocal, rollbackBatch } from '../services/migrate.service.js';

export const migrateController = {
  async import(c) {
    const result = await importLocal(c.get('ctx'), c.get('body'));
    return c.json(result);
  },

  async rollback(c) {
    const result = await rollbackBatch(c.get('ctx'), c.req.param('batchId'));
    return c.json(result);
  },
};
