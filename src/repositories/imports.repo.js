export function importsRepo(db) {
  return {
    insertBatchStatement(row) {
      return db
        .prepare(
          `INSERT INTO import_batches
             (id, user_id, source, client_id, status, item_total,
              item_imported, item_skipped, started_at, finished_at)
           VALUES (?, ?, ?, ?, ?, ?, 0, 0, ?, NULL)`,
        )
        .bind(
          row.id,
          row.user_id,
          row.source ?? 'localStorage-v1',
          row.client_id,
          row.status ?? 'pending',
          row.item_total ?? 0,
          row.started_at,
        );
    },

    async findBatch(userId, batchId) {
      return db
        .prepare('SELECT * FROM import_batches WHERE id = ? AND user_id = ? LIMIT 1')
        .bind(batchId, userId)
        .first();
    },

    async finishBatch(batchId, { status, imported, skipped, finishedAt }) {
      return db
        .prepare(
          `UPDATE import_batches
              SET status = ?, item_imported = ?, item_skipped = ?, finished_at = ?
            WHERE id = ?`,
        )
        .bind(status, imported, skipped, finishedAt, batchId)
        .run();
    },

    insertItemStatement(row) {
      return db
        .prepare(
          `INSERT INTO import_items
             (batch_id, local_key, task_id, local_updated_at, outcome, note)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (batch_id, local_key) DO UPDATE SET
             task_id = excluded.task_id,
             local_updated_at = excluded.local_updated_at,
             outcome = excluded.outcome,
             note = excluded.note`,
        )
        .bind(
          row.batch_id,
          row.local_key,
          row.task_id ?? null,
          row.local_updated_at ?? 0,
          row.outcome,
          row.note ?? null,
        );
    },

    async listItems(batchId) {
      const { results } = await db
        .prepare('SELECT * FROM import_items WHERE batch_id = ? ORDER BY local_key ASC')
        .bind(batchId)
        .all();
      return results ?? [];
    },

    async findLink(userId, localKey) {
      return db
        .prepare('SELECT * FROM local_doc_links WHERE user_id = ? AND local_key = ? LIMIT 1')
        .bind(userId, localKey)
        .first();
    },

    insertLinkStatement(row) {
      return db
        .prepare(
          `INSERT INTO local_doc_links
             (user_id, local_key, task_id, last_content_hash, imported_revision, imported_at)
           VALUES (?, ?, ?, ?, ?, ?)
           ON CONFLICT (user_id, local_key) DO UPDATE SET
             task_id = excluded.task_id,
             last_content_hash = excluded.last_content_hash,
             imported_revision = excluded.imported_revision,
             imported_at = excluded.imported_at`,
        )
        .bind(
          row.user_id,
          row.local_key,
          row.task_id,
          row.last_content_hash,
          row.imported_revision ?? 1,
          row.imported_at,
        );
    },

    async updateLinkHash(userId, localKey, contentHash, revision, at) {
      return db
        .prepare(
          `UPDATE local_doc_links
              SET last_content_hash = ?, imported_revision = ?, imported_at = ?
            WHERE user_id = ? AND local_key = ?`,
        )
        .bind(contentHash, revision, at, userId, localKey)
        .run();
    },
  };
}
