export const healthController = {
  async check(c) {
    let database = 'unavailable';

    if (c.env?.DB) {
      try {
        await c.env.DB.prepare('SELECT 1 AS ok').first();
        database = 'ok';
      } catch {
        database = 'error';
      }
    }

    return c.json({
      ok: true,
      database,
      time: new Date().toISOString(),
    });
  },
};
