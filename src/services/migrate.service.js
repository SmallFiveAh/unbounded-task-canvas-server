import { ROLLBACK_WINDOW_MS } from '../config/constants.js';
import {
  computeContentHash,
  normalizeDocument,
  serializeDocument,
} from '../lib/document.js';
import { AppError, conflict, notFound } from '../lib/errors.js';
import { formatZodIssues, migrateItemSchema } from '../lib/validation.js';
import { uuidv7 } from '../lib/uuid.js';
import { IMPORTED_OUTCOMES, importItem } from './migration/item.service.js';

function parseJson(text, fallback) {
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

/**
 * 处理单条存档：损坏 / 非法条目只返回 skipped_invalid，不阻断整批（设计 §6.7）；
 * 5xx 等系统级错误向上抛出，让批次保持 pending 以便整批重试。
 */
async function processItem(ctx, { batchId, rawItem, now }) {
  const parsed = migrateItemSchema.safeParse(rawItem);

  if (!parsed.success) {
    return {
      localKey: typeof rawItem?.localKey === 'string' ? rawItem.localKey : null,
      outcome: 'skipped_invalid',
      issues: formatZodIssues(parsed.error),
    };
  }

  const item = parsed.data;
  try {
    return await importItem(ctx, { batchId, item, now });
  } catch (error) {
    if (error instanceof AppError && error.status < 500) {
      return { localKey: item.localKey, outcome: 'skipped_invalid', reason: error.message };
    }
    throw error;
  }
}

/**
 * 批量导入本地存档（设计 §6.1 / §6.6）。
 * 每一批建立一条 import_batches，每个任务一个 D1 batch，保证幂等与可回滚。
 */
export async function importLocal(ctx, input) {
  const now = Date.now();
  const batchId = uuidv7(now);

  await ctx.repos.imports
    .insertBatchStatement({
      id: batchId,
      user_id: ctx.userId,
      source: input.source ?? 'localStorage-v1',
      client_id: input.clientId,
      status: 'pending',
      item_total: input.items.length,
      started_at: now,
    })
    .run();

  const results = [];
  let imported = 0;
  let skipped = 0;

  try {
    for (const rawItem of input.items) {
      const result = await processItem(ctx, { batchId, rawItem, now });
      results.push(result);
      if (IMPORTED_OUTCOMES.has(result.outcome)) {
        imported += 1;
      } else {
        skipped += 1;
      }
    }
  } catch (error) {
    ctx.logger.error('migration.interrupted', {
      batchId,
      error: error?.message ?? 'unknown',
    });
    throw new AppError({
      status: error instanceof AppError ? error.status : 500,
      code: error instanceof AppError ? error.code : 'MIGRATION_INTERRUPTED',
      message: error instanceof AppError ? error.message : '导入中断，已成功的条目不会重复',
      details: { batchId, results, ...(error?.details ? { cause: error.details } : {}) },
    });
  }

  await ctx.repos.imports.finishBatch(batchId, {
    status: 'committed',
    imported,
    skipped,
    finishedAt: Date.now(),
  });

  return {
    batchId,
    status: 'committed',
    itemTotal: input.items.length,
    itemImported: imported,
    itemSkipped: skipped,
    results,
  };
}

function documentFromRevision(revisionRow, schemaVersion, updatedAt) {
  return normalizeDocument({
    version: schemaVersion,
    nodes: parseJson(revisionRow.nodes_json, []),
    edges: parseJson(revisionRow.edges_json, []),
    tables: parseJson(revisionRow.tables_json, []),
    view: parseJson(revisionRow.view_json, null),
    updatedAt,
  });
}

async function restoreUpdatedTask(ctx, item, now) {
  const revision = await ctx.repos.revisions.findLatestByReason(item.task_id, 'migration');
  if (!revision) return false;

  const current = await ctx.repos.documents.findByTaskId(item.task_id, ctx.userId);
  if (!current) return false;

  const doc = documentFromRevision(revision, current.schema_version, now);
  const serialized = serializeDocument(doc);
  const hash = await computeContentHash(doc);

  await ctx.repos.documents.overwrite({
    task_id: item.task_id,
    owner_id: ctx.userId,
    schema_version: doc.version,
    nodes_json: serialized.nodesJson,
    edges_json: serialized.edgesJson,
    tables_json: serialized.tablesJson,
    view_json: serialized.viewJson,
    content_hash: hash,
    size_bytes: serialized.sizeBytes,
    updated_at: now,
    updated_by_device: 'migration:rollback',
  });

  await ctx.repos.imports.updateLinkHash(
    ctx.userId,
    item.local_key,
    hash,
    current.revision + 1,
    now,
  );

  return true;
}

/**
 * 回滚某个导入批次（设计 §6.6）：
 *   · created / created_seed → 删除任务（级联清文档与绑定）
 *   · updated → 用 revisions(reason='migration') 还原文档
 *   · 其余不动
 */
export async function rollbackBatch(ctx, batchId) {
  const batch = await ctx.repos.imports.findBatch(ctx.userId, batchId);
  if (!batch) {
    throw notFound('BATCH_NOT_FOUND', '迁移批次不存在');
  }
  if (batch.status === 'rolled_back') {
    throw conflict('BATCH_ALREADY_ROLLED_BACK', '该批次已经回滚过');
  }

  const now = Date.now();
  if (batch.started_at < now - ROLLBACK_WINDOW_MS) {
    throw conflict('ROLLBACK_WINDOW_EXPIRED', '超出 7 天回滚窗口');
  }

  const items = await ctx.repos.imports.listItems(batchId);
  let deleted = 0;
  let restored = 0;

  for (const item of items) {
    if (!item.task_id) {
      continue;
    }

    if (item.outcome === 'created' || item.outcome === 'created_seed') {
      const deletedCount = await ctx.repos.tasks.deleteById(ctx.userId, item.task_id);
      if (deletedCount === 1) deleted += 1;
      continue;
    }

    if (item.outcome === 'updated') {
      const ok = await restoreUpdatedTask(ctx, item, now);
      if (ok) restored += 1;
    }
  }

  await ctx.repos.imports.finishBatch(batchId, {
    status: 'rolled_back',
    imported: batch.item_imported,
    skipped: batch.item_skipped,
    finishedAt: now,
  });

  return {
    batchId,
    status: 'rolled_back',
    deleted,
    restored,
    untouched: Math.max(0, items.length - deleted - restored),
  };
}
