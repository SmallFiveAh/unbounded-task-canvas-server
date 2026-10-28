import { describe, expect, it } from 'vitest';
import { AppError } from '../src/lib/errors.js';
import { matchesEtag, parseEntityTag, requireBaseRevision, revisionEtag } from '../src/lib/http.js';

describe('http etag helpers', () => {
  it('revisionEtag 使用强实体标签', () => {
    expect(revisionEtag(7)).toBe('"7"');
  });

  it('parseEntityTag 支持强标签与弱标签', () => {
    expect(parseEntityTag('"12"')).toBe('12');
    expect(parseEntityTag('W/"12"')).toBe('12');
    expect(parseEntityTag('12')).toBeNull();
  });

  it('matchesEtag 支持列表与弱比较', () => {
    expect(matchesEtag('"3"', 3)).toBe(true);
    expect(matchesEtag('"1", W/"3"', 3)).toBe(true);
    expect(matchesEtag('"3"', 4)).toBe(false);
    expect(matchesEtag(null, 4)).toBe(false);
  });

  it('requireBaseRevision：缺失 428、非法 400、正常返回数字', () => {
    expect(requireBaseRevision('"5"')).toBe(5);

    expect(() => requireBaseRevision(undefined)).toThrowError(AppError);
    try {
      requireBaseRevision(undefined);
    } catch (error) {
      expect(error.status).toBe(428);
      expect(error.code).toBe('IF_MATCH_REQUIRED');
    }

    try {
      requireBaseRevision('abc');
    } catch (error) {
      expect(error.status).toBe(400);
      expect(error.code).toBe('INVALID_IF_MATCH');
    }
  });
});
