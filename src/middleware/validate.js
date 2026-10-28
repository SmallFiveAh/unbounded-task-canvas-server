import { badRequest, unprocessable } from '../lib/errors.js';
import { formatZodIssues } from '../lib/validation.js';

function parseQuery(c) {
  const url = new URL(c.req.url);
  const query = {};
  for (const [key, value] of url.searchParams) {
    if (value === '') continue;
    query[key] = value;
  }
  return query;
}

export function validateJson(schema) {
  return async (c, next) => {
    let payload;
    try {
      payload = await c.req.json();
    } catch {
      throw badRequest('INVALID_JSON', '请求体必须是合法 JSON');
    }

    const result = schema.safeParse(payload);
    if (!result.success) {
      throw unprocessable('VALIDATION_FAILED', '请求参数不合法', formatZodIssues(result.error));
    }

    c.set('body', result.data);
    await next();
  };
}

export function validateQuery(schema) {
  return async (c, next) => {
    const result = schema.safeParse(parseQuery(c));
    if (!result.success) {
      throw unprocessable('VALIDATION_FAILED', '查询参数不合法', formatZodIssues(result.error));
    }

    c.set('query', result.data);
    await next();
  };
}
