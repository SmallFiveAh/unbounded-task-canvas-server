/**
 * 统一的业务错误类型。
 * 路由层只抛这里定义的错误，HTTP 状态与错误码由 error-handler 统一渲染。
 */

export class AppError extends Error {
  /**
   * @param {object} options
   * @param {number} [options.status]
   * @param {string} [options.code]
   * @param {string} [options.message]
   * @param {unknown} [options.details]
   * @param {Record<string, string>} [options.headers]
   */
  constructor({ status = 500, code = 'INTERNAL_ERROR', message = '服务器内部错误', details, headers }) {
    super(message);
    this.name = 'AppError';
    this.status = status;
    this.code = code;
    this.details = details;
    this.headers = headers;
    this.expose = status < 500;
  }
}

export const badRequest = (code, message, details) =>
  new AppError({ status: 400, code, message, details });

export const unauthorized = (code, message, details) =>
  new AppError({ status: 401, code, message, details });

export const forbidden = (code, message, details) =>
  new AppError({ status: 403, code, message, details });

export const notFound = (code, message, details) =>
  new AppError({ status: 404, code, message, details });

export const conflict = (code, message, details) =>
  new AppError({ status: 409, code, message, details });

export const unprocessable = (code, message, details) =>
  new AppError({ status: 422, code, message, details });

export const payloadTooLarge = (code, message, details) =>
  new AppError({ status: 413, code, message, details });

export const preconditionRequired = (code, message, details) =>
  new AppError({ status: 428, code, message, details });

export const tooManyRequests = (code, message, details, headers) =>
  new AppError({ status: 429, code, message, details, headers });

export const badGateway = (code, message, details) =>
  new AppError({ status: 502, code, message, details });
