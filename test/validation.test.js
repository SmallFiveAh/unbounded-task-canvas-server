import { describe, expect, it } from 'vitest';
import {
  documentSchema,
  emailSchema,
  migrateImportSchema,
  registerSchema,
  taskCreateSchema,
  taskUpdateSchema,
} from '../src/lib/validation.js';

describe('validation schemas', () => {
  it('email 统一小写并校验格式', () => {
    expect(emailSchema.parse('  User@Example.COM ')).toBe('user@example.com');
    expect(emailSchema.safeParse('not-an-email').success).toBe(false);
  });

  it('register 要求密码长度 ≥ 10', () => {
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'short' }).success).toBe(false);
    expect(registerSchema.safeParse({ email: 'a@b.co', password: 'long-enough-pass' }).success).toBe(
      true,
    );
    // 未声明字段被拒绝，避免越权修改 status / emailVerifiedAt
    expect(
      registerSchema.safeParse({ email: 'a@b.co', password: 'long-enough-pass', status: 'admin' })
        .success,
    ).toBe(false);
  });

  it('taskCreate 提供默认值', () => {
    const parsed = taskCreateSchema.parse({ title: '写周报' });
    expect(parsed).toMatchObject({ title: '写周报', category: 'work', status: 'todo', progress: 0 });
  });

  it('taskUpdate 至少一个字段', () => {
    expect(taskUpdateSchema.safeParse({}).success).toBe(false);
    expect(taskUpdateSchema.safeParse({ status: 'done' }).success).toBe(true);
    expect(taskUpdateSchema.safeParse({ progress: 101 }).success).toBe(false);
  });

  it('document 必需 nodes/edges/tables 数组', () => {
    expect(documentSchema.safeParse({ nodes: [], edges: [], tables: [] }).success).toBe(true);
    expect(documentSchema.safeParse({ nodes: [] }).success).toBe(false);
  });

  it('migrate 单批最多 20 条', () => {
    const item = { localKey: 'unbounded-canvas:doc:t1', document: { nodes: [], edges: [], tables: [] } };
    expect(
      migrateImportSchema.safeParse({ clientId: 'c1', items: Array(20).fill(item) }).success,
    ).toBe(true);
    expect(
      migrateImportSchema.safeParse({ clientId: 'c1', items: Array(21).fill(item) }).success,
    ).toBe(false);
  });
});
