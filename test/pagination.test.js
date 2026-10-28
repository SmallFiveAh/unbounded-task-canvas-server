import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { decodeCursor, encodeCursor } from '../src/lib/pagination.js';

describe('pagination cursor', () => {
  it('编解码往返', () => {
    const cursor = { updatedAt: 1793194995000, id: '018f2b3c-0000-7000-8000-000000000000' };
    expect(decodeCursor(encodeCursor(cursor))).toEqual(cursor);
  });

  it('空游标返回 null', () => {
    expect(decodeCursor(undefined)).toBeNull();
    expect(decodeCursor('')).toBeNull();
  });

  it('非法游标抛出 AppError 400', () => {
    try {
      decodeCursor('not-base64-json');
      throw new Error('should have thrown');
    } catch (error) {
      expect(error).toBeInstanceOf(AppError);
      expect(error.status).toBe(400);
      expect(error.code).toBe('INVALID_CURSOR');
    }
  });
});
