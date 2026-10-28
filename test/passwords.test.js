import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { assertPasswordStrength, hashPassword, verifyPassword } from '../src/lib/passwords.js';

const ITERATIONS = 100000;

describe('passwords', () => {
  it('生成 PHC 格式并可通过校验', async () => {
    const phc = await hashPassword('correct horse battery', { iterations: ITERATIONS });
    expect(phc).toMatch(/^pbkdf2-sha256\$100000\$[\w+/=]+\$[\w+/=]+$/);
    await expect(verifyPassword('correct horse battery', phc)).resolves.toBe(true);
  });

  it('错误密码校验失败', async () => {
    const phc = await hashPassword('correct horse battery', { iterations: ITERATIONS });
    await expect(verifyPassword('wrong horse battery', phc)).resolves.toBe(false);
  });

  it('非法 PHC 返回 false 而不是抛错', async () => {
    await expect(verifyPassword('whatever', 'not-a-phc')).resolves.toBe(false);
    await expect(verifyPassword('whatever', null)).resolves.toBe(false);
  });

  it('弱口令被拒绝', () => {
    expect(() => assertPasswordStrength('short')).toThrowError(AppError);
    expect(() => assertPasswordStrength('password123')).toThrowError(/过于常见/);
    expect(() => assertPasswordStrength('a-very-long-password')).not.toThrow();
  });
});
