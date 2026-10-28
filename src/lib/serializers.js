/**
 * DTO 序列化：数据库 snake_case → 前端 camelCase。
 * 所有出站结构都在这里收口，避免 SQL 行结构泄漏到 API。
 */

function parseJson(text, fallback) {
  if (typeof text !== 'string' || text.length === 0) return fallback;
  try {
    return JSON.parse(text);
  } catch {
    return fallback;
  }
}

export function toUserDto(row) {
  return {
    id: row.id,
    email: row.email,
    emailVerified: row.email_verified_at != null,
    displayName: row.display_name ?? '',
    avatarUrl: row.avatar_url ?? null,
    locale: row.locale ?? 'zh-CN',
    status: row.status,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    lastLoginAt: row.last_login_at ?? null,
  };
}

export function toIdentityDto(row) {
  return {
    id: row.id,
    provider: row.provider,
    providerEmail: row.provider_email ?? null,
    providerUsername: row.provider_username ?? null,
    linkedAt: row.linked_at,
    lastUsedAt: row.last_used_at ?? null,
  };
}

export function toTaskDto(row) {
  return {
    id: row.id,
    legacyId: row.legacy_id ?? null,
    title: row.title ?? '',
    category: row.category,
    status: row.status,
    progress: row.progress ?? 0,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
    nodeCount: row.node_count ?? 0,
    tableCount: row.table_count ?? 0,
    revision: row.revision ?? null,
  };
}

export function toDocumentDto(row) {
  return {
    version: row.schema_version,
    revision: row.revision,
    nodes: parseJson(row.nodes_json, []),
    edges: parseJson(row.edges_json, []),
    tables: parseJson(row.tables_json, []),
    view: parseJson(row.view_json, null),
    updatedAt: row.updated_at,
  };
}

export function toSessionDto(auth) {
  return {
    expiresAt: auth.expiresAt,
    idleExpiresAt: auth.idleExpiresAt,
  };
}
