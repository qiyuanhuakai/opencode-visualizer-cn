import { describe, expect, it } from 'vitest';

import type { MessageDiffEntry } from '../types/message';
import { hasCompleteBeforeAfter, toMessageDiffViewerEntry } from './messageDiff';

describe('messageDiff viewer mapping', () => {
  it('prefers local before/after diff generation when both sides exist', () => {
    const diff: MessageDiffEntry = {
      file: 'app/composables/useMessages.ts',
      diff: '@@ -1,20 +1,21 @@\n context line\n another context line',
      before: 'before content',
      after: 'after content',
    };

    expect(hasCompleteBeforeAfter(diff)).toBe(true);
    expect(toMessageDiffViewerEntry(diff)).toEqual({
      file: 'app/composables/useMessages.ts',
      before: 'before content',
      after: 'after content',
      patch: undefined,
    });
  });

  it('keeps server patch when before/after pair is incomplete', () => {
    const diff: MessageDiffEntry = {
      file: 'app/App.vue',
      diff: '@@ -0,0 +1,3 @@\n+new line',
      after: 'new line',
    };

    expect(hasCompleteBeforeAfter(diff)).toBe(false);
    expect(toMessageDiffViewerEntry(diff)).toEqual({
      file: 'app/App.vue',
      before: undefined,
      after: 'new line',
      patch: '@@ -0,0 +1,3 @@\n+new line',
    });
  });
});
