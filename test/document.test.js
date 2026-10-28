import { describe, expect, it } from 'vitest';
import {
  computeContentHash,
  emptyDocument,
  inferTitleFromDocument,
  normalizeDocument,
  normalizeView,
  serializeDocument,
} from '../src/lib/document.js';

describe('document', () => {
  it('normalizeDocument 对缺失字段做兜底', () => {
    const doc = normalizeDocument({});
    expect(doc.version).toBe(1);
    expect(doc.nodes).toEqual([]);
    expect(doc.tables).toEqual([]);
    expect(doc.view).toBeNull();
    expect(Number.isInteger(doc.updatedAt)).toBe(true);
  });

  it('视口 scale 被 clamp 到 [0.2, 5]', () => {
    expect(normalizeView({ x: 1, y: 2, scale: 0.01 })).toEqual({ x: 1, y: 2, scale: 0.2 });
    expect(normalizeView({ x: 1, y: 2, scale: 99 })).toEqual({ x: 1, y: 2, scale: 5 });
    expect(normalizeView({ x: 1, y: 2, scale: Number.NaN })).toBeNull();
    expect(normalizeView(null)).toBeNull();
  });

  it('内容哈希忽略 updatedAt', async () => {
    const a = normalizeDocument({ nodes: [{ id: 'n1', text: 'hi' }], updatedAt: 1000 });
    const b = normalizeDocument({ nodes: [{ id: 'n1', text: 'hi' }], updatedAt: 2000 });
    expect(await computeContentHash(a)).toBe(await computeContentHash(b));
  });

  it('键顺序不同但内容相同 → 哈希相同', async () => {
    const a = normalizeDocument({ nodes: [{ id: 'n1', text: 'hi', x: 1, y: 2 }] });
    const b = normalizeDocument({ nodes: [{ y: 2, x: 1, text: 'hi', id: 'n1' }] });
    expect(await computeContentHash(a)).toBe(await computeContentHash(b));
  });

  it('serializeDocument 输出四个 JSON 列与体积', () => {
    const serialized = serializeDocument(normalizeDocument({ nodes: [{ id: 'n1' }] }));
    expect(serialized.nodesJson).toBe('[{"id":"n1"}]');
    expect(serialized.viewJson).toBeNull();
    expect(serialized.sizeBytes).toBeGreaterThan(0);
  });

  it('空文档与标题兜底', () => {
    expect(emptyDocument().nodes).toEqual([]);
    expect(inferTitleFromDocument(null)).toBe('未命名任务');
    expect(inferTitleFromDocument({ nodes: [{ text: '  设计稿  ' }] })).toBe('设计稿');
  });
});
