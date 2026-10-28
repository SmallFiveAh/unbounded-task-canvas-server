import { badRequest } from './errors.js';
import { base64UrlDecode, base64UrlEncode } from './crypto.js';

/**
 * 任务列表使用 keyset 分页（updated_at DESC, id DESC），
 * 游标里只有「最后一条的位置」，避免 OFFSET 在大表上退化。
 */
export function encodeCursor({ updatedAt, id }) {
  const payload = JSON.stringify({ u: updatedAt, i: id });
  return base64UrlEncode(new TextEncoder().encode(payload));
}

export function decodeCursor(cursor) {
  if (!cursor) return null;

  try {
    const raw = new TextDecoder().decode(base64UrlDecode(cursor));
    const parsed = JSON.parse(raw);

    if (!Number.isInteger(parsed.u) || typeof parsed.i !== 'string' || !parsed.i) {
      throw new Error('invalid cursor payload');
    }

    return { updatedAt: parsed.u, id: parsed.i };
  } catch {
    throw badRequest('INVALID_CURSOR', '分页游标不合法');
  }
}
