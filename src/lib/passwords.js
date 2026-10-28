import {
  PASSWORD_HASH_BYTES,
  PASSWORD_SALT_BYTES,
  COMMON_WEAK_PASSWORDS,
  PASSWORD_MAX_LENGTH,
  PASSWORD_MIN_LENGTH,
} from '../config/constants.js';
import { base64Decode, base64Encode, constantTimeEqual, randomBytes } from './crypto.js';
import { unprocessable } from './errors.js';

const ALGORITHM = 'pbkdf2-sha256';
const MIN_ITERATIONS = 100000;
const MAX_ITERATIONS = 1000000;

/**
 * 用于「邮箱不存在」时仍执行一次等价耗时的校验，避免时序侧信道（设计 §3.2）。
 */
export const DUMMY_PASSWORD_HASH =
  'pbkdf2-sha256$600000$AAAAAAAAAAAAAAAAAAAAAA==$AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=';

async function derive(password, salt, iterations) {
  const key = await crypto.subtle.importKey('raw', new TextEncoder().encode(password), 'PBKDF2', false, [
    'deriveBits',
  ]);
  const bits = await crypto.subtle.deriveBits(
    { name: 'PBKDF2', hash: 'SHA-256', salt, iterations },
    key,
    PASSWORD_HASH_BYTES * 8,
  );
  return new Uint8Array(bits);
}

function parsePhc(phc) {
  if (typeof phc !== 'string') return null;
  const parts = phc.split('$');
  if (parts.length !== 4) return null;

  const [algorithm, iterationsRaw, saltRaw, hashRaw] = parts;
  if (algorithm !== ALGORITHM) return null;

  const iterations = Number.parseInt(iterationsRaw, 10);
  if (!Number.isFinite(iterations) || iterations < MIN_ITERATIONS || iterations > MAX_ITERATIONS) {
    return null;
  }

  try {
    const salt = base64Decode(saltRaw);
    const hash = base64Decode(hashRaw);
    if (salt.length !== PASSWORD_SALT_BYTES || hash.length !== PASSWORD_HASH_BYTES) return null;
    return { iterations, salt, hash };
  } catch {
    return null;
  }
}

/**
 * 生成 PHC 格式密码哈希：pbkdf2-sha256$<iterations>$<salt_b64>$<hash_b64>
 */
export async function hashPassword(password, { iterations = 600000 } = {}) {
  const salt = randomBytes(PASSWORD_SALT_BYTES);
  const hash = await derive(password, salt, iterations);
  return `${ALGORITHM}$${iterations}$${base64Encode(salt)}$${base64Encode(hash)}`;
}

/**
 * 常量时间校验密码。
 */
export async function verifyPassword(password, phc) {
  const parsed = parsePhc(phc);
  if (!parsed) {
    // 结构非法时也走一次等价计算，保持耗时稳定
    await derive(password, randomBytes(PASSWORD_SALT_BYTES), 600000);
    return false;
  }
  const hash = await derive(password, parsed.salt, parsed.iterations);
  return constantTimeEqual(base64Encode(hash), base64Encode(parsed.hash));
}

/**
 * 密码强度校验：长度下限 + 常见弱口令黑名单。
 */
export function assertPasswordStrength(password) {
  if (typeof password !== 'string') {
    throw unprocessable('WEAK_PASSWORD', '密码不合法');
  }
  if (password.length < PASSWORD_MIN_LENGTH) {
    throw unprocessable('WEAK_PASSWORD', `密码长度至少 ${PASSWORD_MIN_LENGTH} 位`);
  }
  if (password.length > PASSWORD_MAX_LENGTH) {
    throw unprocessable('WEAK_PASSWORD', `密码长度不能超过 ${PASSWORD_MAX_LENGTH} 位`);
  }
  if (COMMON_WEAK_PASSWORDS.has(password.toLowerCase())) {
    throw unprocessable('WEAK_PASSWORD', '密码过于常见，请更换');
  }
}
