import {
  LOCAL_DOC_KEY_PREFIX,
  TASK_STATUS_LABELS,
  TASK_STATUSES,
} from '../../config/constants.js';
import {
  computeContentHash,
  emptyDocument,
  inferTitleFromDocument,
  normalizeDocument,
  serializeDocument,
} from '../../lib/document.js';
import { payloadTooLarge, unprocessable } from '../../lib/errors.js';
import { parseTimestamp } from '../../lib/time.js';
import { uuidv7 } from '../../lib/uuid.js';

export const IMPORTED_OUTCOMES = new Set([
  'created',
  'created_seed',
  'updated',
  'conflict_kept_both',
]);

export function mapStatus(value) {
  if (typeof value !== 'string') return 'todo';
  const trimmed = value.trim();
  if (TASK_STATUSES.includes(trimmed)) return trimmed;
  return TASK_STATUS_LABELS[trimmed] ?? 'todo';
}

function clampProgress(value) {
  if (!Number.isFinite(value)) return 0;
  return Math.min(100, Math.max(0, Math.trunc(value)));
}

function isSupportedKey(localKey) {
  return localKey.startsWith(LOCAL_DOC_KEY_PREFIX);
}

export function extractLocalTaskId(localKey) {
  return localKey.startsWith(LOCAL_DOC_KEY_PREFIX) ? localKey.slice(LOCAL_DOC_KEY_PREFIX.length) : null;
}

async function buildPayload(ctx, doc) {
  const serialized = serializeDocument(doc);
  if (serialized.sizeBytes > ctx.config.limits.maxDocumentBytes) {
    throw payloadTooLarge('DOCUMENT_TOO_LARGE', '本地存档超过 1.5 MB 上限，无法导入', {
      sizeBytes: serialized.sizeBytes,
    });
  }
  return { serialized, hash: await computeContentHash(doc) };
}

function prepareDocument(item, now) {
  if (!item.document) return null;
  const fallbackUpdatedAt = parseTimestamp(item.task?.updatedAt, now);
  return normalizeDocument({
    version: item.document.version,
    nodes: item.document.nodes,
    edges: item.document.edges,
    tables: item.document.tables,
    view: item.document.view,
    updatedAt: parseTimestamp(item.document.updatedAt, fallbackUpdatedAt),
  });
}

function buildTaskFields(item, doc, now) {
  return {
    title: item.task?.title?.trim() || inferTitleFromDocument(doc),
    category: item.task?.category ?? 'work',
    status: mapStatus(item.task?.status),
    progress: clampProgress(item.task?.progress),
    updatedAt: parseTimestamp(item.task?.updatedAt, doc?.updatedAt ?? now),
  };
}

function documentStatement(ctx, { taskId, doc, payload, revision, createdAt, updatedAt, device }) {
  return ctx.repos.documents.insertStatement({
    task_id: taskId,
    owner_id: ctx.userId,
    schema_version: doc.version,
    revision,
    content_hash: payload.hash,
    nodes_json: payload.serialized.nodesJson,
    edges_json: payload.serialized.edgesJson,
    tables_json: payload.serialized.tablesJson,
    view_json: payload.serialized.viewJson,
    size_bytes: payload.serialized.sizeBytes,
    created_at: createdAt,
    updated_at: updatedAt,
    updated_by_device: device,
  });
}

function revisionStatementFromDoc(ctx, { taskId, payload, revision, reason, createdAt }) {
  return ctx.repos.revisions.upsertStatement({
    task_id: taskId,
    revision,
    nodes_json: payload.serialized.nodesJson,
    edges_json: payload.serialized.edgesJson,
    tables_json: payload.serialized.tablesJson,
    view_json: payload.serialized.viewJson,
    reason,
    created_at: createdAt,
  });
}

function revisionStatementFromCloud(ctx, { taskId, cloud, revision, reason, createdAt }) {
  return ctx.repos.revisions.upsertStatement({
    task_id: taskId,
    revision,
    nodes_json: cloud.nodes_json,
    edges_json: cloud.edges_json,
    tables_json: cloud.tables_json,
    view_json: cloud.view_json,
    reason,
    created_at: createdAt,
  });
}

function itemStatement(ctx, { batchId, localKey, taskId, localUpdatedAt, outcome, note }) {
  return ctx.repos.imports.insertItemStatement({
    batch_id: batchId,
    local_key: localKey,
    task_id: taskId,
    local_updated_at: localUpdatedAt,
    outcome,
    note: note ?? null,
  });
}

function linkStatement(ctx, { localKey, taskId, hash, revision, now }) {
  return ctx.repos.imports.insertLinkStatement({
    user_id: ctx.userId,
    local_key: localKey,
    task_id: taskId,
    last_content_hash: hash,
    imported_revision: revision,
    imported_at: now,
  });
}

/**
 * 云端已有该任务/文档：按「时间新的赢，输的一方留档」处理（设计 §6.5）。
 */
async function applyToExistingTask(ctx, { batchId, item, task, localDoc, doc, payload, fields, now }) {
  const cloud = await ctx.repos.documents.findByTaskId(task.id, ctx.userId);
  const localUpdatedAt = fields.updatedAt;
  const device = `migration:${item.localKey}`;

  if (!cloud) {
    const seeded = !localDoc;
    const statements = [
      documentStatement(ctx, {
        taskId: task.id,
        doc,
        payload,
        revision: 1,
        createdAt: now,
        updatedAt: localUpdatedAt,
        device,
      }),
      linkStatement(ctx, {
        localKey: item.localKey,
        taskId: task.id,
        hash: payload.hash,
        revision: 1,
        now,
      }),
      itemStatement(ctx, {
        batchId,
        localKey: item.localKey,
        taskId: task.id,
        localUpdatedAt,
        outcome: seeded ? 'created_seed' : 'created',
        note: '任务已存在但缺少文档',
      }),
    ];
    return { statements, taskId: task.id, outcome: seeded ? 'created_seed' : 'created' };
  }

  // 本地无存档、云端有：只建绑定让后续幂等，不写 import_items（设计 §6.5 pulled）
  if (!localDoc) {
    return {
      statements: [
        linkStatement(ctx, {
          localKey: item.localKey,
          taskId: task.id,
          hash: cloud.content_hash,
          revision: cloud.revision,
          now,
        }),
      ],
      taskId: task.id,
      outcome: 'pulled',
    };
  }

  if (cloud.content_hash === payload.hash) {
    return {
      statements: [
        itemStatement(ctx, {
          batchId,
          localKey: item.localKey,
          taskId: task.id,
          localUpdatedAt,
          outcome: 'skipped_equal',
        }),
        linkStatement(ctx, {
          localKey: item.localKey,
          taskId: task.id,
          hash: payload.hash,
          revision: cloud.revision,
          now,
        }),
      ],
      taskId: task.id,
      outcome: 'skipped_equal',
    };
  }

  if (localUpdatedAt > cloud.updated_at) {
    const statements = [
      // 先把云端旧版留档，再覆盖（迁移不可重来，绝不静默丢弃）
      revisionStatementFromCloud(ctx, {
        taskId: task.id,
        cloud,
        revision: cloud.revision,
        reason: 'migration',
        createdAt: now,
      }),
      ctx.repos.documents.overwrite({
        task_id: task.id,
        owner_id: ctx.userId,
        schema_version: doc.version,
        nodes_json: payload.serialized.nodesJson,
        edges_json: payload.serialized.edgesJson,
        tables_json: payload.serialized.tablesJson,
        view_json: payload.serialized.viewJson,
        content_hash: payload.hash,
        size_bytes: payload.serialized.sizeBytes,
        updated_at: localUpdatedAt,
        updated_by_device: device,
      }),
      linkStatement(ctx, {
        localKey: item.localKey,
        taskId: task.id,
        hash: payload.hash,
        revision: cloud.revision + 1,
        now,
      }),
      itemStatement(ctx, {
        batchId,
        localKey: item.localKey,
        taskId: task.id,
        localUpdatedAt,
        outcome: 'updated',
      }),
    ];
    return { statements, taskId: task.id, outcome: 'updated' };
  }

  if (localUpdatedAt < cloud.updated_at) {
    return {
      statements: [
        itemStatement(ctx, {
          batchId,
          localKey: item.localKey,
          taskId: task.id,
          localUpdatedAt,
          outcome: 'skipped_older',
          note: '本地版本更旧',
        }),
        linkStatement(ctx, {
          localKey: item.localKey,
          taskId: task.id,
          hash: cloud.content_hash,
          revision: cloud.revision,
          now,
        }),
      ],
      taskId: task.id,
      outcome: 'skipped_older',
    };
  }

  // 时间相同但内容不同：云端为主，本地版进历史版本
  const statements = [
    revisionStatementFromDoc(ctx, {
      taskId: task.id,
      payload,
      revision: cloud.revision + 1,
      reason: 'conflict',
      createdAt: now,
    }),
    linkStatement(ctx, {
      localKey: item.localKey,
      taskId: task.id,
      hash: cloud.content_hash,
      revision: cloud.revision,
      now,
    }),
    itemStatement(ctx, {
      batchId,
      localKey: item.localKey,
      taskId: task.id,
      localUpdatedAt,
      outcome: 'conflict_kept_both',
      note: '同一时间戳但内容不同，本地版已留档',
    }),
  ];
  return { statements, taskId: task.id, outcome: 'conflict_kept_both' };
}

function createTaskStatements(ctx, { batchId, item, doc, hasDocument, payload, fields, legacyId, now }) {
  const taskId = uuidv7(now);
  const outcome = hasDocument ? 'created' : 'created_seed';
  const device = `migration:${item.localKey}`;

  const taskRow = {
    id: taskId,
    owner_id: ctx.userId,
    legacy_id: legacyId,
    title: fields.title,
    category: fields.category,
    status: fields.status,
    progress: fields.progress,
    created_at: now,
    updated_at: fields.updatedAt,
  };

  const statements = [
    ctx.repos.tasks.insertStatement(taskRow),
    documentStatement(ctx, {
      taskId,
      doc,
      payload,
      revision: 1,
      createdAt: now,
      updatedAt: fields.updatedAt,
      device,
    }),
    linkStatement(ctx, {
      localKey: item.localKey,
      taskId,
      hash: payload.hash,
      revision: 1,
      now,
    }),
    itemStatement(ctx, {
      batchId,
      localKey: item.localKey,
      taskId,
      localUpdatedAt: fields.updatedAt,
      outcome,
    }),
  ];

  return { statements, taskId, outcome };
}

/**
 * 导入单条本地存档。返回结果并保证所有写入在一个 D1 batch 内完成。
 */
export async function importItem(ctx, { batchId, item, now }) {
  if (!isSupportedKey(item.localKey)) {
    throw unprocessable(
      'INVALID_LOCAL_KEY',
      '只能导入 unbounded-canvas:doc: 命名空间下的存档',
      { localKey: item.localKey },
    );
  }

  const localDoc = prepareDocument(item, now);
  const doc = localDoc ?? emptyDocument();
  const hasDocument = localDoc != null;
  const payload = await buildPayload(ctx, doc);
  const fields = buildTaskFields(item, localDoc, now);
  const legacyId = extractLocalTaskId(item.localKey);

  const link = await ctx.repos.imports.findLink(ctx.userId, item.localKey);
  if (link) {
    const task = await ctx.repos.tasks.findByOwnerAndId(ctx.userId, link.task_id);
    if (task) {
      const applied = await applyToExistingTask(ctx, {
        batchId,
        item,
        task,
        localDoc,
        doc,
        payload,
        fields,
        now,
      });
      await ctx.db.batch(applied.statements);
      return { localKey: item.localKey, taskId: applied.taskId, outcome: applied.outcome };
    }
  }

  const existingTask = !link && legacyId
    ? await ctx.repos.tasks.findByOwnerAndLegacyId(ctx.userId, legacyId)
    : null;

  if (existingTask) {
    const applied = await applyToExistingTask(ctx, {
      batchId,
      item,
      task: existingTask,
      localDoc,
      doc,
      payload,
      fields,
      now,
    });
    await ctx.db.batch(applied.statements);
    return { localKey: item.localKey, taskId: applied.taskId, outcome: applied.outcome };
  }

  const created = createTaskStatements(ctx, {
    batchId,
    item,
    doc,
    hasDocument,
    payload,
    fields,
    legacyId,
    now,
  });
  await ctx.db.batch(created.statements);

  return { localKey: item.localKey, taskId: created.taskId, outcome: created.outcome };
}
