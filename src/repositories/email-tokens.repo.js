const COLUMNS = `id, user_id, email, purpose, token_hash, expires_at, consumed_at,
  attempts, created_at, requested_ip_hash`;

export function emailTokensRepo(db) {
  return {
    async findByHash(tokenHash) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM email_tokens WHERE token_hash = ? LIMIT 1`)
        .bind(tokenHash)
        .first();
    },

    async findLatest(email, purpose) {
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM email_tokens
            WHERE email = ? AND purpose = ?
            ORDER BY created_at DESC
            LIMIT 1`,
        )
        .bind(email, purpose)
        .first();
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO email_tokens
             (id, user_id, email, purpose, token_hash, expires_at, consumed_at,
              attempts, created_at, requested_ip_hash)
           VALUES (?, ?, ?, ?, ?, ?, NULL, 0, ?, ?)`,
        )
        .bind(
          row.id,
          row.user_id ?? null,
          row.email,
          row.purpose,
          row.token_hash,
          row.expires_at,
          row.created_at,
          row.requested_ip_hash ?? null,
        );
    },

    async consume(id, at) {
      return db
        .prepare('UPDATE email_tokens SET consumed_at = ? WHERE id = ? AND consumed_at IS NULL')
        .bind(at, id)
        .run();
    },

    async invalidateOutstanding(email, purpose, at) {
      return db
        .prepare(
          'UPDATE email_tokens SET consumed_at = ? WHERE email = ? AND purpose = ? AND consumed_at IS NULL',
        )
        .bind(at, email, purpose)
        .run();
    },
  };
}
