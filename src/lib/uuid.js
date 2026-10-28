import { randomBytes } from './crypto.js';

/**
 * UUIDv7：前 48 位为毫秒时间戳，天然按时间有序，适合做 D1 主键。
 */
export function uuidv7(timestamp = Date.now()) {
  const bytes = randomBytes(16);
  let remaining = BigInt(timestamp);

  for (let i = 5; i >= 0; i -= 1) {
    bytes[i] = Number(remaining & 0xffn);
    remaining >>= 8n;
  }

  bytes[6] = (bytes[6] & 0x0f) | 0x70; // version 7
  bytes[8] = (bytes[8] & 0x3f) | 0x80; // variant RFC 4122

  const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
  return [
    hex.slice(0, 8),
    hex.slice(8, 12),
    hex.slice(12, 16),
    hex.slice(16, 20),
    hex.slice(20, 32),
  ].join('-');
}
