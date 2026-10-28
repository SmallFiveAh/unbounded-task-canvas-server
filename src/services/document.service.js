import { AppError, notFound, payloadTooLarge } from '../lib/errors.js';
import {
  computeContentHash,
  emptyDocument,
  normalizeDocument,
  serializeDocument,
} from '../lib/document.js';
import { toDocumentDto } from '../lib/serializers.js';

async function ensureDocument(ctx, taskId) {
  let row = await ctx.repos.documents.findByTaskId(taskId, ctx.userId);
  if (row) return row;

  const now = Date.now();
  const doc = emptyDocument();
  const serialized = serializeDocument(doc);

  await ctx.repos.documents.insertStatement({
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
  }).run();

  row = await ctx.repos.documents.findByTaskId(taskId, ctx.userId);
  if (!row) {
    throw notFound('DOCUMENT_NOT_FOUND', '画布文档不存在');
  }
  return row;
}

async function assertTaskOwned(ctx, taskId) {
  const task = await ctx.repos.tasks.findByOwnerAndId(ctx.userId, taskId);
  if (!task) {
    // 越权访问统一返回 404，不泄漏他人任务是否存在（设计 §3.5）
    throw notFound('TASK_NOT_FOUND', '任务不存在');
  }
  return task;
}

export async function getDocument(ctx, taskId) {
  await assertTaskOwned(ctx, taskId);
  const row = await ensureDocument(ctx, taskId);
  return { document: toDocumentDto(row), revision: row.revision };
}

/**
 * 保存画布：If-Match 乐观锁（设计 §5.3）。
 * 冲突时把服务端当前版本写入 revisions(reason='conflict') 并返回 409 + 最新文档。
 */
export async function putDocument(ctx, taskId, baseRevision, input) {
  await assertTaskOwned(ctx, taskId);
  const current = await ensureDocument(ctx, taskId);

  const now = Date.now();
  const doc = normalizeDocument({ ...input, updatedAt: now });
  const serialized = serializeDocument(doc);

  if (serialized.sizeBytes > ctx.config.limits.maxDocumentBytes) {
    throw payloadTooLarge('DOCUMENT_TOO_LARGE', '画布体积超过 1.5 MB 上限，请精简后再保存', {
      sizeBytes: serialized.sizeBytes,
      limitBytes: ctx.config.limits.maxDocumentBytes,
    });
  }

  const contentHash = await computeContentHash(doc);
  const deviceId = input.deviceId ?? null;

  // 内容没变（重复提交 / 重放）→ 幂等成功，不产生新版本、也不判定冲突
  if (current.content_hash === contentHash) {
    return {
      ok: true,
      skipped: true,
      revision: current.revision,
      updatedAt: current.updated_at,
      contentHash,
    };
  }

  const { meta } = await ctx.repos.documents.casUpdate({
    task_id: taskId,
    owner_id: ctx.userId,
    schema_version: doc.version,
    nodes_json: serialized.nodesJson,
    edges_json: serialized.edgesJson,
    tables_json: serialized.tablesJson,
    view_json: serialized.viewJson,
    content_hash: contentHash,
    size_bytes: serialized.sizeBytes,
    updated_at: now,
    updated_by_device: deviceId,
    revision: baseRevision,
  });

  if (meta?.changes === 1) {
    return {
      ok: true,
      skipped: false,
      revision: baseRevision + 1,
      updatedAt: now,
      contentHash,
    };
  }

  const latest = (await ctx.repos.documents.findByTaskId(taskId, ctx.userId)) ?? current;

  await ctx.repos.revisions.upsertStatement({
    task_id: taskId,
    revision: latest.revision,
    nodes_json: latest.nodes_json,
    edges_json: latest.edges_json,
    tables_json: latest.tables_json,
    view_json: latest.view_json,
    reason: 'conflict',
    created_at: now,
    created_by_device: deviceId,
  }).run();

  throw new AppError({
    status: 409,
    code: 'REVISION_CONFLICT',
    message: '画布已在其它位置被修改，请先合并',
    details: {
      baseRevision,
      serverRevision: latest.revision,
      document: toDocumentDto(latest),
    },
  });
}
