import { describe, expect, it } from 'vitest';
import { hostEvidencePage } from './hostEvidenceViews';

describe('Bridge evidence page decoding', () => {
  const page = { available: true, hash: 'a'.repeat(64), target: { repoKey: 'repository', revision: 'base' }, offset: 0, length: 4, totalBytes: 8, nextOffset: 4, encoding: 'base64', data: 'cGFnZQ==' };
  it('decodes one bounded page and preserves unavailable evidence as unavailable', () => {
    const result = hostEvidencePage(page);
    expect(result.available && new TextDecoder().decode(result.bytes)).toBe('page');
    expect(hostEvidencePage({ available: false, unavailableReason: 'source_unavailable' })).toEqual({ available: false, unavailableReason: 'source_unavailable' });
  });
  it('refuses inconsistent offsets, payload lengths and oversized byte pages', () => {
    expect(() => hostEvidencePage({ ...page, length: 5 })).toThrow();
    expect(() => hostEvidencePage({ ...page, nextOffset: 7 })).toThrow();
    expect(() => hostEvidencePage({ ...page, offset: 8 })).toThrow();
    expect(() => hostEvidencePage({ ...page, data: 'a'.repeat(87385) })).toThrow();
  });
});
