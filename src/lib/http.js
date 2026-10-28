import { badRequest, preconditionRequired } from './errors.js';

export function revisionEtag(revision) {
  return `"${revision}"`;
}

/** 解析 If-Match / If-None-Match 中的单个实体标签值 */
export function parseEntityTag(header) {
  if (!header) return null;
  const trimmed = header.trim();
  const match = /^(?:W\/)?"([^"]*)"$/.exec(trimmed);
  return match ? match[1] : null;
}

export function matchesEtag(header, revision) {
  if (!header) return false;
  return header
    .split(',')
    .map((part) => parseEntityTag(part))
    .some((value) => value === String(revision));
}

/**
 * PUT 文档必须带 If-Match，且必须是可解析的 revision。
 * 缺失返回 428，格式非法返回 400（设计 §3.6 / §5.3）。
 */
export function requireBaseRevision(header) {
  if (!header) {
    throw preconditionRequired('IF_MATCH_REQUIRED', '保存画布必须携带 If-Match 版本号');
  }

  const tag = parseEntityTag(header);
  const revision = tag == null ? Number.NaN : Number.parseInt(tag, 10);
  if (!Number.isInteger(revision) || revision < 1) {
    throw badRequest('INVALID_IF_MATCH', 'If-Match 必须是形如 "<revision>" 的文档版本号');
  }

  return revision;
}

function requestIp(c) {
  return (
    c.req.header('CF-Connecting-IP') ||
    (c.req.header('X-Forwarded-For') ?? '').split(',')[0].trim() ||
    'unknown'
  );
}

export function requestMeta(c) {
  return {
    ip: requestIp(c),
    userAgent: c.req.header('User-Agent') ?? null,
  };
}
