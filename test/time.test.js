import { describe, expect, it } from 'vitest';
import { parseTimestamp, secondsUntilWindowEnd, windowStart } from '../src/lib/time.js';

describe('time', () => {
  it("'YYYY-MM-DD' 按 Asia/Shanghai 00:00 解释", () => {
    expect(parseTimestamp('2026-10-16')).toBe(Date.UTC(2026, 9, 16) - 8 * 3600 * 1000);
  });

  it('数字时间戳原样返回', () => {
    expect(parseTimestamp(1793194995123)).toBe(1793194995123);
  });

  it('可解析的 ISO 字符串', () => {
    expect(parseTimestamp('2026-10-16T00:00:00.000Z')).toBe(Date.UTC(2026, 9, 16));
  });

  it('无法解析时使用 fallback', () => {
    expect(parseTimestamp('not-a-date', 42)).toBe(42);
    expect(parseTimestamp(null, 42)).toBe(42);
  });

  it('限流窗口对齐', () => {
    const windowMs = 15 * 60 * 1000;
    const start = windowStart(1793194995123, windowMs);
    expect(start % windowMs).toBe(0);
    expect(secondsUntilWindowEnd(start + 1, windowMs)).toBe(15 * 60);
  });
});
