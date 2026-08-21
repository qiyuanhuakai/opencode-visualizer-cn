import { describe, expect, it } from 'vitest';

import {
  isDiffMetadataLine,
  parseHunkHeader,
  reconstructSourcesFromDiff,
  walkDiffLines,
} from './unifiedDiff';

describe('isDiffMetadataLine', () => {
  it('classifies every metadata prefix handled by the main-thread implementation', () => {
    for (const line of [
      'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
      'index 0000000..e69de29',
      '--- a/scripts/foo.mjs',
      '+++ b/scripts/foo.mjs',
      'new file mode 100644',
      'deleted file mode 100644',
      'similarity index 95%',
      'rename from a/old.ts',
      'rename to b/new.ts',
      'Binary files a/x and b/x differ',
      'GIT binary patch',
    ]) {
      expect(isDiffMetadataLine(line)).toBe(true);
    }
  });

  it('classifies every metadata prefix handled by the worker implementation', () => {
    for (const line of [
      'diff --cc a/x b/x',
      'index 1111111..2222222 100644',
      'Index: app/utils/messageDiff.ts',
      '===================================================================',
      '--- a/x',
      '+++ b/x',
      '*** 1,3 ****',
    ]) {
      expect(isDiffMetadataLine(line)).toBe(true);
    }
  });

  it('does not classify hunk content, hunk headers, or no-newline markers', () => {
    for (const line of [
      ' context line',
      '+added line',
      '-removed line',
      '@@ -1,2 +1,2 @@',
      '\\ No newline at end of file',
      'plain text',
    ]) {
      expect(isDiffMetadataLine(line)).toBe(false);
    }
  });
});

describe('parseHunkHeader', () => {
  it('parses headers with explicit counts', () => {
    expect(parseHunkHeader('@@ -1,2 +3,4 @@')).toEqual({
      oldStart: 1,
      oldCount: 2,
      newStart: 3,
      newCount: 4,
    });
  });

  it('parses headers without counts', () => {
    expect(parseHunkHeader('@@ -1 +1 @@')).toEqual({
      oldStart: 1,
      oldCount: undefined,
      newStart: 1,
      newCount: undefined,
    });
  });

  it('returns null for non-hunk lines', () => {
    expect(parseHunkHeader(' context')).toBeNull();
    expect(parseHunkHeader('diff --git a/x b/x')).toBeNull();
  });
});

describe('walkDiffLines', () => {
  it('emits classified events with pre-increment line counters', () => {
    const events: Array<{ kind: string; text: string; oldLine: number; newLine: number }> = [];
    walkDiffLines(
      [
        'diff --git a/x b/x',
        '--- a/x',
        '+++ b/x',
        '@@ -1,3 +1,3 @@',
        ' keep',
        '-old',
        '+new',
        ' stay',
      ].join('\n'),
      (event) => {
        events.push({
          kind: event.kind,
          text: event.text,
          oldLine: event.oldLine,
          newLine: event.newLine,
        });
      },
    );

    expect(events).toEqual([
      { kind: 'metadata', text: 'diff --git a/x b/x', oldLine: 0, newLine: 0 },
      { kind: 'metadata', text: '--- a/x', oldLine: 0, newLine: 0 },
      { kind: 'metadata', text: '+++ b/x', oldLine: 0, newLine: 0 },
      { kind: 'hunk', text: '@@ -1,3 +1,3 @@', oldLine: 1, newLine: 1 },
      { kind: 'context', text: 'keep', oldLine: 1, newLine: 1 },
      { kind: 'removed', text: 'old', oldLine: 2, newLine: 2 },
      // The added line fires after the deletion advanced the old cursor:
      // consumers read only their own side's counter (newLine for additions).
      { kind: 'added', text: 'new', oldLine: 3, newLine: 2 },
      { kind: 'context', text: 'stay', oldLine: 3, newLine: 3 },
    ]);
  });

  it('emits outside events before hunks and other for unclassified hunk lines', () => {
    const kinds: string[] = [];
    walkDiffLines('plain text\n@@ -1 +1 @@\n+added\nodd line', (event) => {
      kinds.push(event.kind);
    });
    expect(kinds).toEqual(['outside', 'hunk', 'added', 'other']);
  });
});

describe('reconstructSourcesFromDiff', () => {
  it('reconstructs both sides from a git-style patch (worker parity)', () => {
    const diff = [
      'diff --git a/scripts/foo.mjs b/scripts/foo.mjs',
      'new file mode 100644',
      'index 0000000..e69de29',
      '--- /dev/null',
      '+++ b/scripts/foo.mjs',
      '@@ -0,0 +1,2 @@',
      '+line one',
      '+line two',
    ].join('\n');

    expect(reconstructSourcesFromDiff(diff)).toEqual({
      before: '',
      after: 'line one\nline two',
    });
  });

  it('reconstructs both sides from an Index-style patch (main parity)', () => {
    const diff = [
      'Index: scripts/electron-start.mjs',
      '===================================================================',
      '--- scripts/electron-start.mjs',
      '+++ scripts/electron-start.mjs',
      '@@ -1,2 +1,3 @@',
      " import { spawn } from 'node:child_process';",
      " import http from 'node:http';",
      "+import net from 'node:net';",
    ].join('\n');

    expect(reconstructSourcesFromDiff(diff)).toEqual({
      before: "import { spawn } from 'node:child_process';\nimport http from 'node:http';",
      after:
        "import { spawn } from 'node:child_process';\nimport http from 'node:http';\nimport net from 'node:net';",
    });
  });

  it('ignores rename and similarity metadata between hunks', () => {
    const diff = [
      'diff --git a/old.ts b/new.ts',
      'similarity index 95%',
      'rename from a/old.ts',
      'rename to b/new.ts',
      'index 1111111..2222222 100644',
      '--- a/old.ts',
      '+++ b/new.ts',
      '@@ -1 +1 @@',
      '-old content',
      '+new content',
    ].join('\n');

    expect(reconstructSourcesFromDiff(diff)).toEqual({
      before: 'old content',
      after: 'new content',
    });
  });

  it('treats a no-newline marker as the end of a hunk', () => {
    const diff = [
      'diff --git a/file.ts b/file.ts',
      'index 1111111..2222222 100644',
      '--- a/file.ts',
      '+++ b/file.ts',
      '@@ -1,3 +1,3 @@',
      ' first',
      '-old',
      '+new',
      ' last',
      '\\ No newline at end of file',
    ].join('\n');

    expect(reconstructSourcesFromDiff(diff)).toEqual({
      before: 'first\nold\nlast',
      after: 'first\nnew\nlast',
    });
  });

  it('preserves line positions for mixed hunks', () => {
    expect(reconstructSourcesFromDiff('@@ -2,3 +2,4 @@\n keep\n-old\n+new\n stay\n+tail')).toEqual({
      before: '\nkeep\nold\nstay',
      after: '\nkeep\nnew\nstay\ntail',
    });
  });
});
