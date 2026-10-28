export function sessionsRepo(db) {
  return {
    /**
     * 解析会话时一次join 出用户，避免两次查询。
     * 用户软删 / 状态异常 / 过期由应用层判定。
     */
    async findActiveWithUser(sessionId) {
      return db
        .prepare(
          `SELECT s.id              AS session_id,
                  s.user_id         AS user_id,
                  s.identity_id     AS identity_id,
                  s.created_at      AS session_created_at,
                  s.last_seen_at    AS last_seen_at,
                  s.expires_at      AS expires_at,
                  s.idle_expires_at AS idle_expires_at,
                  s.revoked_at      AS revoked_at,
                  u.id              AS id,
                  u.email           AS email,
                  u.email_verified_at AS email_verified_at,
                  u.display_name    AS display_name,
                  u.avatar_url      AS avatar_url,
                  u.locale          AS locale,
                  u.status          AS status,
                  u.created_at      AS created_at,
                  u.updated_at      AS updated_at,
                  u.last_login_at   AS last_login_at,
                  u.deleted_at      AS deleted_at
             FROM sessions s
             JOIN users u ON u.id = s.user_id
            WHERE s.id = ?
            LIMIT 1`,
        )
        .bind(sessionId)
        .first();
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO sessions
             (id, user_id, identity_id, created_at, last_seen_at,
              expires_at, idle_expires_at, user_agent, ip_hash, revoked_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          row.id,
          row.user_id,
          row.identity_id ?? null,
          row.created_at,
          row.last_seen_at,
          row.expires_at,
          row.idle_expires_at,
          row.user_agent ?? null,
          row.ip_hash ?? null,
        );
    },

    async touch(id, lastSeenAt, idleExpiresAt) {
      return db
        .prepare('UPDATE sessions SET last_seen_at = ?, idle_expires_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(lastSeenAt, idleExpiresAt, id)
        .run();
    },

    async revoke(id, at) {
      return db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE id = ? AND revoked_at IS NULL')
        .bind(at, id)
        .run();
    },

    async revokeAllForUser(userId, at, exceptSessionId = null) {
      if (exceptSessionId) {
        return db
          .prepare(
            'UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND id <> ? AND revoked_at IS NULL',
          )
          .bind(at, userId, exceptSessionId)
          .run();
      }
      return db
        .prepare('UPDATE sessions SET revoked_at = ? WHERE user_id = ? AND revoked_at IS NULL')
        .bind(at, userId)
        .run();
    },
  };
}
