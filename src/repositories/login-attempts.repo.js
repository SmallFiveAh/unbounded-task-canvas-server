export function loginAttemptsRepo(db) {
  return {
    async count(bucket, windowStart) {
      const row = await db
        .prepare('SELECT attempts FROM login_attempts WHERE bucket = ? AND window_start = ?')
        .bind(bucket, windowStart)
        .first();
      return row?.attempts ?? 0;
    },

    async increment(bucket, windowStart) {
      return db
        .prepare(
          `INSERT INTO login_attempts (bucket, window_start, attempts)
           VALUES (?, ?, 1)
           ON CONFLICT (bucket, window_start) DO UPDATE SET attempts = attempts + 1`,
        )
        .bind(bucket, windowStart)
        .run();
    },

    async clear(bucket) {
      return db.prepare('DELETE FROM login_attempts WHERE bucket = ?').bind(bucket).run();
    },
  };
}
