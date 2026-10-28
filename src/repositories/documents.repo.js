const COLUMNS = `task_id, owner_id, schema_version, revision, content_hash,
  nodes_json, edges_json, tables_json, view_json, node_count, table_count,
  size_bytes, created_at, updated_at, updated_by_device`;

export function documentsRepo(db) {
  return {
    async findByTaskId(taskId, ownerId) {
      return db
        .prepare(`SELECT ${COLUMNS} FROM canvas_documents WHERE task_id = ? AND owner_id = ? LIMIT 1`)
        .bind(taskId, ownerId)
        .first();
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO canvas_documents
             (task_id, owner_id, schema_version, revision, content_hash,
              nodes_json, edges_json, tables_json, view_json,
              size_bytes, created_at, updated_at, updated_by_device)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
        )
        .bind(
          row.task_id,
          row.owner_id,
          row.schema_version,
          row.revision,
          row.content_hash,
          row.nodes_json,
          row.edges_json,
          row.tables_json,
          row.view_json ?? null,
          row.size_bytes ?? 0,
          row.created_at,
          row.updated_at,
          row.updated_by_device ?? null,
        );
    },

    /**
     * 乐观锁 CAS：revision 不匹配则 changes === 0（设计 §5.3）。
     */
    async casUpdate(row) {
      return db
        .prepare(
          `UPDATE canvas_documents
              SET schema_version = ?, nodes_json = ?, edges_json = ?, tables_json = ?,
                  view_json = ?, content_hash = ?, size_bytes = ?,
                  revision = revision + 1, updated_at = ?, updated_by_device = ?
            WHERE task_id = ? AND owner_id = ? AND revision = ?`,
        )
        .bind(
          row.schema_version,
          row.nodes_json,
          row.edges_json,
          row.tables_json,
          row.view_json ?? null,
          row.content_hash,
          row.size_bytes ?? 0,
          row.updated_at,
          row.updated_by_device ?? null,
          row.task_id,
          row.owner_id,
          row.revision,
        )
        .run();
    },

    /**
     * 迁移 / 回滚专用：无版本守卫（调用方已确认任务独占），revision 自增。
     */
    async overwrite(row) {
      return db
        .prepare(
          `UPDATE canvas_documents
              SET schema_version = ?, nodes_json = ?, edges_json = ?, tables_json = ?,
                  view_json = ?, content_hash = ?, size_bytes = ?,
                  revision = revision + 1, updated_at = ?, updated_by_device = ?
            WHERE task_id = ? AND owner_id = ?`,
        )
        .bind(
          row.schema_version,
          row.nodes_json,
          row.edges_json,
          row.tables_json,
          row.view_json ?? null,
          row.content_hash,
          row.size_bytes ?? 0,
          row.updated_at,
          row.updated_by_device ?? null,
          row.task_id,
          row.owner_id,
        )
        .run();
    },
  };
}
