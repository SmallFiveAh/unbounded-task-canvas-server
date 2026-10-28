const COLUMNS = `task_id, revision, nodes_json, edges_json, tables_json, view_json,
  reason, created_at, created_by_device`;

export function revisionsRepo(db) {
  return {
    /**
     * 历史版本是「后悔药」，同一 (task_id, revision) 只保留最后一次快照。
     */
    upsertStatement(row) {
      return db
        .prepare(
          `INSERT OR REPLACE INTO canvas_document_revisions
             (task_id, revision, nodes_json, edges_json, tables_json, view_json,
              reason, created_at, created_by_device)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.task_id,
          row.revision,
          row.nodes_json,
          row.edges_json,
          row.tables_json,
          row.view_json ?? null,
          row.reason,
          row.created_at,
          row.created_by_device ?? null,
        );
    },

    async findLatestByReason(taskId, reason) {
      return db
        .prepare(
          `SELECT ${COLUMNS} FROM canvas_document_revisions
            WHERE task_id = ? AND reason = ?
            ORDER BY created_at DESC, revision DESC
            LIMIT 1`,
        )
        .bind(taskId, reason)
        .first();
    },
  };
}
