import { describe, expect, it } from 'vitest';

import { isBatchSessionAction, normalizeBatchSessionTargets } from './batchSessionTargets';

describe('batchSessionTargets', () => {
  it('normalizes, trims, and dedupes only identical batch targets', () => {
    const targets = normalizeBatchSessionTargets([
      null,
      { sessionId: ' s1 ', projectId: ' p1 ', directory: ' /repo ' },
      { sessionId: 's1', projectId: 'p1', directory: '/repo' },
      { sessionId: 's1', projectId: 'p2', directory: '/other' },
      { sessionId: 's2', projectId: '', directory: ' /repo ' },
      { sessionId: '  ', projectId: 'p3', directory: '/repo' },
      { sessionId: 's3', projectId: 'p3', directory: '   ' },
    ]);

    expect(targets).toEqual([
      { sessionId: 's1', projectId: 'p1', directory: '/repo' },
      { sessionId: 's1', projectId: 'p2', directory: '/other' },
      { sessionId: 's2', projectId: undefined, directory: '/repo' },
    ]);
  });

  it('accepts only supported runtime batch actions', () => {
    expect(isBatchSessionAction('pin')).toBe(true);
    expect(isBatchSessionAction('delete')).toBe(true);
    expect(isBatchSessionAction('archive-all')).toBe(false);
    expect(isBatchSessionAction('')).toBe(false);
    expect(isBatchSessionAction(null)).toBe(false);
  });
});
