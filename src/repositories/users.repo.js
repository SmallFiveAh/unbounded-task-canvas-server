const COLUMNS = `id, email, email_verified_at, display_name, avatar_url, locale,
  status, created_at, updated_at, last_login_at, deleted_at`;

export function usersRepo(db) {
  return {
    async findLiveByEmail(email) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM users WHERE email = ? AND deleted_at IS NULL LIMIT 1`)
        .bind(email)
        .first();
    },

    async findById(id) {
      return db.prepare(`SELECT ${COLUMNS} FROM users WHERE id = ? LIMIT 1`).bind(id).first();
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO users
             (id, email, email_verified_at, display_name, avatar_url, locale,
              status, created_at, updated_at, last_login_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.id,
          row.email,
          row.email_verified_at ?? null,
          row.display_name ?? '',
          row.avatar_url ?? null,
          row.locale ?? 'zh-CN',
          row.status ?? 'active',
          row.created_at,
          row.updated_at,
          row.last_login_at ?? null,
          row.deleted_at ?? null,
        );
    },

    async touchLastLogin(id, at) {
      return db
        .prepare('UPDATE users SET last_login_at = ?, updated_at = ? WHERE id = ?')
        .bind(at, at, id)
        .run();
    },

    async markEmailVerified(id, at) {
      return db
        .prepare(
          `UPDATE users
              SET email_verified_at = COALESCE(email_verified_at, ?),
                  updated_at = ?
            WHERE id = ? AND deleted_at IS NULL`,
        )
        .bind(at, at, id)
        .run();
    },

    async touchUpdatedAt(id, at = Date.now()) {
      return db.prepare('UPDATE users SET updated_at = ? WHERE id = ?').bind(at, id).run();
    },
  };
}
