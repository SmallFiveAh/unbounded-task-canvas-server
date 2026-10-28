import { describe, expect, it } from 'vitest';
import { mapStatus } from '../src/services/migration/item.service.js';
import { sanitizeRedirect } from '../src/services/github.service.js';

describe('migration helpers', () => {
  it('本地中文状态映射到枚举', () => {
    expect(mapStatus('待办')).toBe('todo');
    expect(mapStatus('进行中')).toBe('doing');
    expect(mapStatus('已完成')).toBe('done');
    expect(mapStatus('todo')).toBe('todo');
    expect(mapStatus('unknown')).toBe('todo');
    expect(mapStatus(undefined)).toBe('todo');
  });
});

describe('github redirect 校验', () => {
  it('只接受站内相对路径', () => {
    expect(sanitizeRedirect('/tasks')).toBe('/tasks');
    expect(sanitizeRedirect('/tasks?tab=all')).toBe('/tasks?tab=all');
    expect(sanitizeRedirect('https://evil.example.com')).toBe('/');
    expect(sanitizeRedirect('//evil.example.com')).toBe('/');
    expect(sanitizeRedirect('/\\evil')).toBe('/');
    expect(sanitizeRedirect('javascript:alert(1)')).toBe('/');
    expect(sanitizeRedirect(undefined)).toBe('/');
  });
});
