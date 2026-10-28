const COLUMNS = `id, user_id, provider, provider_user_id, provider_email, provider_username,
  password_hash, password_updated_at, scopes, linked_at, last_used_at`;

export function identitiesRepo(db) {
  return {
    async findByProviderUserId(provider, providerUserId) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM auth_identities WHERE provider = ? AND provider_user_id = ? LIMIT 1`)
        .bind(provider, providerUserId)
        .first();
    },

    async findById(id) {
      return db.prepare(`SELECT ${COLUMNS} FROM auth_identities WHERE id = ? LIMIT 1`).bind(id).first();
    },

    async listByUser(userId) {
      const { results } = await db
        .prepare(`SELECT ${COLUMNS} FROM auth_identities WHERE user_id = ? ORDER BY linked_at ASC`)
        .bind(userId)
        .all();
      return results ?? [];
    },

    async countByUser(userId) {
      const row = await db
        .prepare('SELECT COUNT(*) AS total FROM auth_identities WHERE user_id = ?')
        .bind(userId)
        .first();
      return row?.total ?? 0;
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO auth_identities
             (id, user_id, provider, provider_user_id, provider_email, provider_username,
              password_hash, password_updated_at, scopes, linked_at, last_used_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.user_id,
          row.provider,
          row.provider_user_id,
          row.provider_email ?? null,
          row.provider_username ?? null,
          row.password_hash ?? null,
          row.password_updated_at ?? null,
          row.scopes ?? null,
          row.linked_at,
          row.last_used_at ?? null,
        );
    },

    async touchLastUsed(id, at) {
      return db.prepare('UPDATE auth_identities SET last_used_at = ? WHERE id = ?').bind(at, id).run();
    },

    async updatePassword(id, passwordHash, at) {
      return db
        .prepare(
          'UPDATE auth_identities SET password_hash = ?, password_updated_at = ? WHERE id = ? AND provider = ?',
        )
        .bind(passwordHash, at, id, 'email')
        .run();
    },

    async deleteByIdForUser(id, userId) {
      return db
        .prepare('DELETE FROM auth_identities WHERE id = ? AND user_id = ?')
        .bind(id, userId)
        .run();
    },
  };
}
