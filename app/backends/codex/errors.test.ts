import { describe, expect, it } from 'vitest';
import { isUnmaterializedThreadError } from './errors';

describe('CodexAdapter', () => {
  it.each([
    'thread is not materialized',
    'includeTurns is unavailable for this thread',
    'no rollout found for thread id thr_1',
  ])('recognizes recoverable unmaterialized-thread error: %s', (message) => {
    expect(isUnmaterializedThreadError(new Error(message))).toBe(true);
  });

  it('does not classify unrelated or non-error values as unmaterialized-thread failures', () => {
    expect(isUnmaterializedThreadError('network unavailable')).toBe(false);
    expect(isUnmaterializedThreadError({ message: 'no rollout found' })).toBe(false);
  });
});
