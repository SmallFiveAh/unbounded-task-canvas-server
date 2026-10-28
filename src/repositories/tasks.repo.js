const COLUMNS = `t.id, t.owner_id, t.legacy_id, t.title, t.category, t.status, t.progress,
  t.created_at, t.updated_at, t.deleted_at`;

const WITH_DOC_COUNTS = `${COLUMNS}, d.node_count, d.table_count, d.revision`;

const UPDATABLE_COLUMNS = {
  title: 'title',
  category: 'category',
  status: 'status',
  progress: 'progress',
};

export function tasksRepo(db) {
  return {
    async findByOwnerAndId(ownerId, id) {
      return db
        .prepare(
          `SELECT ${WITH_DOC_COUNTS}
             FROM tasks t
             LEFT JOIN canvas_documents d
                    ON d.task_id = t.id AND d.owner_id = t.owner_id
            WHERE t.owner_id = ? AND t.id = ? AND t.deleted_at IS NULL
            LIMIT 1`,
        )
        .bind(ownerId, id)
        .first();
    },

    async findByOwnerAndLegacyId(ownerId, legacyId) {
      return db
        .prepare(
          `SELECT ${WITH_DOC_COUNTS}
             FROM tasks t
             LEFT JOIN canvas_documents d
                    ON d.task_id = t.id AND d.owner_id = t.owner_id
            WHERE t.owner_id = ? AND t.legacy_id = ? AND t.deleted_at IS NULL
            LIMIT 1`,
        )
        .bind(ownerId, legacyId)
        .first();
    },

    /**
     * 列表主查询：命中 ix_tasks_owner_updated，keyset 分页避免 OFFSET。
     * 标题搜索用 instr()，避开 D1 LIKE 模式串 50 字节上限（设计 §4.4 备注）。
     */
    async listByOwner({ ownerId, category, status, query, limit, cursor }) {
      const where = ['t.owner_id = ?', 't.deleted_at IS NULL'];
      const params = [ownerId];

      if (category) {
        where.push('t.category = ?');
        params.push(category);
      }
      if (status) {
        where.push('t.status = ?');
        params.push(status);
      }
      if (query) {
        where.push('instr(t.title, ?) > 0');
        params.push(query);
      }
      if (cursor) {
        where.push('(t.updated_at < ? OR (t.updated_at = ? AND t.id < ?))');
        params.push(cursor.updatedAt, cursor.updatedAt, cursor.id);
      }

      const sql = `SELECT ${WITH_DOC_COUNTS}
                     FROM tasks t
                     LEFT JOIN canvas_documents d
                            ON d.task_id = t.id AND d.owner_id = t.owner_id
                    WHERE ${where.join(' AND ')}
                    ORDER BY t.updated_at DESC, t.id DESC
                    LIMIT ?`;
      params.push(limit);

      const { results } = await db
        .prepare(sql)
        .bind(...params)
        .all();
      return results ?? [];
    },

    insertStatement(row) {
      return db
        .prepare(
          `INSERT INTO tasks
             (id, owner_id, legacy_id, title, category, status, progress,
              created_at, updated_at, deleted_at)
           VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, NULL)`,
        )
        .bind(
          row.id,
          row.owner_id,
          row.legacy_id ?? null,
          row.title ?? '',
          row.category ?? 'work',
          row.status ?? 'todo',
          row.progress ?? 0,
          row.created_at,
          row.updated_at,
        );
    },

    async updateFields(ownerId, id, patch, at) {
      const columns = Object.keys(patch).filter((key) => UPDATABLE_COLUMNS[key]);
      if (columns.length === 0) return { success: true, meta: { changes: 0 } };

      const assignments = columns.map((key) => `${UPDATABLE_COLUMNS[key]} = ?`);
      assignments.push('updated_at = ?');

      const params = columns.map((key) => patch[key]);
      params.push(at, ownerId, id);

      return db
        .prepare(
          `UPDATE tasks
              SET ${assignments.join(', ')}
            WHERE owner_id = ? AND id = ? AND deleted_at IS NULL`,
        )
        .bind(...params)
        .run();
    },

    async softDelete(ownerId, id, at) {
      return db
        .prepare('UPDATE tasks SET deleted_at = ?, updated_at = ? WHERE owner_id = ? AND id = ? AND deleted_at IS NULL')
        .bind(at, at, ownerId, id)
        .run();
    },

    /** 硬删（迁移回滚用）：RETURNING 让调用方能确认真的删掉了 */
    async deleteById(ownerId, id) {
      const { results } = await db
        .prepare('DELETE FROM tasks WHERE owner_id = ? AND id = ? RETURNING id')
        .bind(ownerId, id)
        .all();
      return results?.length ?? 0;
    },
  };
}
