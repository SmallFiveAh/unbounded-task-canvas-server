import { DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE } from '../config/constants.js';
import { computeContentHash, emptyDocument, serializeDocument } from '../lib/document.js';
import { conflict, notFound } from '../lib/errors.js';
import { decodeCursor, encodeCursor } from '../lib/pagination.js';
import { toTaskDto } from '../lib/serializers.js';
import { uuidv7 } from '../lib/uuid.js';

export async function listTasks(ctx, query) {
  const limit = Math.min(query.limit ?? DEFAULT_PAGE_SIZE, MAX_PAGE_SIZE);
  const cursor = query.cursor ? decodeCursor(query.cursor) : null;

  const rows = await ctx.repos.tasks.listByOwner({
    ownerId: ctx.userId,
    category: query.category,
    status: query.status,
    query: query.q,
    cursor,
    // 多取一条用于判断是否还有下一页
    limit: limit + 1,
  });

  const hasMore = rows.length > limit;
  const items = hasMore ? rows.slice(0, limit) : rows;
  const last = items[items.length - 1];

  return {
    items: items.map(toTaskDto),
    nextCursor: hasMore && last ? encodeCursor({ updatedAt: last.updated_at, id: last.id }) : null,
  };
}

export async function createTask(ctx, input) {
  const now = Date.now();
  const taskId = uuidv7(now);
  const doc = emptyDocument();
  const serialized = serializeDocument(doc);

  const taskRow = {
    id: taskId,
    owner_id: ctx.userId,
    legacy_id: input.legacyId ?? null,
    title: input.title,
    category: input.category,
    status: input.status,
    progress: input.progress,
    created_at: now,
    updated_at: now,
  };

  try {
    await ctx.db.batch([
      ctx.repos.tasks.insertStatement(taskRow),
      ctx.repos.documents.insertStatement({
        task_id: taskId,
        owner_id: ctx.userId,
        schema_version: doc.version,
        revision: 1,
        content_hash: await computeContentHash(doc),
        nodes_json: serialized.nodesJson,
        edges_json: serialized.edgesJson,
        tables_json: serialized.tablesJson,
        view_json: serialized.viewJson,
        size_bytes: serialized.sizeBytes,
        created_at: now,
        updated_at: now,
      }),
    ]);
  } catch (error) {
    // (owner_id, legacy_id) 唯一索引冲突 → 409，而不是 500
    if (input.legacyId && String(error?.message ?? '').includes('UNIQUE')) {
      throw conflict('LEGACY_ID_TAKEN', '本地任务 ID 已被占用');
    }
    throw error;
  }

  return toTaskDto({ ...taskRow, node_count: 0, table_count: 0, revision: 1 });
}

export async function updateTask(ctx, taskId, patch) {
  const now = Date.now();
  const { meta } = await ctx.repos.tasks.updateFields(ctx.userId, taskId, patch, now);

  if (meta?.changes !== 1) {
    throw notFound('TASK_NOT_FOUND', '任务不存在');
  }

  const row = await ctx.repos.tasks.findByOwnerAndId(ctx.userId, taskId);
  return toTaskDto(row);
}

export async function removeTask(ctx, taskId) {
  const { meta } = await ctx.repos.tasks.softDelete(ctx.userId, taskId, Date.now());
  if (meta?.changes !== 1) {
    throw notFound('TASK_NOT_FOUND', '任务不存在');
  }
}
