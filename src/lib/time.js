import { MINUTE_MS } from '../config/constants.js';

/** 上海无夏令时，固定 +08:00 */
const SHANGHAI_OFFSET_MS = 8 * 60 * MINUTE_MS;

export function nowMs() {
  return Date.now();
}

/**
 * 把迁移数据里的时间归一化为毫秒时间戳。
 * 支持：
 *   · 数字（已是 ms）—— 原样返回；
 *   · 'YYYY-MM-DD' —— 按 Asia/Shanghai 当日 00:00 解释（设计 §6.3，避免跨时区差一天）；
 *   · 其它可被 Date.parse 的字符串。
 * 无法解析时返回 fallback（默认当前时间）。
 */
export function parseTimestamp(value, fallback = Date.now()) {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Math.trunc(value);
  }

  if (typeof value === 'string') {
    const trimmed = value.trim();
    const dateOnly = /^(\d{4})-(\d{2})-(\d{2})$/.exec(trimmed);
    if (dateOnly) {
      const [, year, month, day] = dateOnly;
      return Date.UTC(Number(year), Number(month) - 1, Number(day)) - SHANGHAI_OFFSET_MS;
    }

    const parsed = Date.parse(trimmed);
    if (!Number.isNaN(parsed)) {
      return parsed;
    }
  }

  return fallback;
}

/** 固定窗口的起点（用于登录限流） */
export function windowStart(now, windowMs) {
  return Math.floor(now / windowMs) * windowMs;
}

/** 距离当前窗口结束还有多少秒（用于 Retry-After） */
export function secondsUntilWindowEnd(now, windowMs) {
  const start = windowStart(now, windowMs);
  return Math.max(1, Math.ceil((start + windowMs - now) / 1000));
}
