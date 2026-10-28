import { describe, expect, it } from 'vitest';
import { uuidv7 } from '../src/lib/uuid.js';

const UUID_V7 = /^[0-9a-f]{8}-[0-9a-f]{4}-7[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;

describe('uuidv7', () => {
  it('格式与版本位正确', () => {
    expect(uuidv7()).toMatch(UUID_V7);
  });

  it('同一毫秒内不重复', () => {
    const values = new Set(Array.from({ length: 200 }, () => uuidv7(1700000000000)));
    expect(values.size).toBe(200);
  });

  it('时间戳靠前的 UUID 字典序更小（索引友好）', () => {
    expect(uuidv7(1000) < uuidv7(2000)).toBe(true);
  });
});
