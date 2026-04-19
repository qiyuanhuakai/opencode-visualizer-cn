import { describe, expect, it } from 'vitest';

import type { MessageDiffEntry } from '../types/message';
import { hasCompleteBeforeAfter, reconstructSourcesFromDiff, toMessageDiffViewerEntry } from './messageDiff';

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

  it('reconstructs split content and falls back to local diff generation when before/after pair is incomplete', () => {
    const diff: MessageDiffEntry = {
      file: 'app/App.vue',
      diff: '@@ -0,0 +1,3 @@\n+new line',
      after: 'new line',
    };

    expect(hasCompleteBeforeAfter(diff)).toBe(false);
    expect(toMessageDiffViewerEntry(diff)).toEqual({
      file: 'app/App.vue',
      before: '',
      after: 'new line',
      patch: undefined,
    });
  });

  it('reconstructs both sides from patch-only diffs for split view tabs', () => {
    const diff: MessageDiffEntry = {
      file: 'scripts/electron-start.mjs',
      diff:
        '@@ -1,2 +1,3 @@\n import { spawn } from \'node:child_process\';\n import http from \'node:http\';\n+import net from \'node:net\';',
    };

    expect(toMessageDiffViewerEntry(diff)).toEqual({
      file: 'scripts/electron-start.mjs',
      before: "import { spawn } from 'node:child_process';\nimport http from 'node:http';",
      after:
        "import { spawn } from 'node:child_process';\nimport http from 'node:http';\nimport net from 'node:net';",
      patch: undefined,
    });
  });

  it('reconstructSourcesFromDiff preserves line positions for mixed hunks', () => {
    expect(
      reconstructSourcesFromDiff(
        '@@ -2,3 +2,4 @@\n keep\n-old\n+new\n stay\n+tail',
      ),
    ).toEqual({
      before: '\nkeep\nold\nstay',
      after: '\nkeep\nnew\nstay\ntail',
    });
  });

  it('reconstructSourcesFromDiff ignores diff metadata headers', () => {
    expect(
      reconstructSourcesFromDiff(
        [
          'Index: scripts/electron-start.mjs',
          '============================================================',
          '--- scripts/electron-start.mjs',
          '+++ scripts/electron-start.mjs',
          '@@ -1,2 +1,3 @@',
          " import { spawn } from 'node:child_process';",
          " import http from 'node:http';",
          "+import net from 'node:net';",
        ].join('\n'),
      ),
    ).toEqual({
      before: "import { spawn } from 'node:child_process';\nimport http from 'node:http';",
      after:
        "import { spawn } from 'node:child_process';\nimport http from 'node:http';\nimport net from 'node:net';",
    });
  });
});
