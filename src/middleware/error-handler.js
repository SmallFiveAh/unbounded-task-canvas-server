import { ZodError } from 'zod';
import { AppError } from '../lib/errors.js';
import { formatZodIssues } from '../lib/validation.js';

function errorBody(ctx, requestId, code, message, details) {
  return {
    error: {
      code,
      message,
      ...(details !== undefined ? { details } : {}),
    },
    requestId: requestId ?? ctx?.requestId ?? null,
  };
}

/**
 * 把任意异常归类为可渲染结构；无法识别时返回 null 交给兜底分支。
 */
function classify(err) {
  if (err instanceof AppError) {
    return {
      status: err.status,
      code: err.code,
      message: err.message,
      details: err.details,
      headers: err.headers ?? {},
    };
  }

  if (err instanceof ZodError) {
    return {
      status: 422,
      code: 'VALIDATION_FAILED',
      message: '请求参数不合法',
      details: formatZodIssues(err),
      headers: {},
    };
  }

  if (err instanceof SyntaxError) {
    return {
      status: 400,
      code: 'INVALID_JSON',
      message: '请求体必须是合法 JSON',
      details: undefined,
      headers: {},
    };
  }

  return null;
}

/**
 * 统一错误渲染：业务错误暴露信息，未知错误只返回泛化文案并记录堆栈。
 */
export function errorHandler(err, c) {
  const ctx = c.get('ctx');
  const logger = ctx?.logger;
  const known = classify(err);

  if (!known) {
    logger?.error('app.unhandled', { message: err?.message, stack: err?.stack });
    return c.json(errorBody(ctx, ctx?.requestId, 'INTERNAL_ERROR', '服务器内部错误'), 500);
  }

  if (known.status >= 500) {
    logger?.error('app.error', { code: known.code, message: known.message, stack: err?.stack });
  } else {
    logger?.warn('app.client_error', {
      code: known.code,
      status: known.status,
      message: known.message,
    });
  }

  return c.json(
    errorBody(ctx, ctx?.requestId, known.code, known.message, known.details),
    known.status,
    known.headers,
  );
}

export function notFoundHandler(c) {
  const ctx = c.get('ctx');
  return c.json(
    errorBody(
      ctx,
      ctx?.requestId,
      'NOT_FOUND',
      `接口不存在：${c.req.method} ${new URL(c.req.url).pathname}`,
    ),
    404,
  );
}
