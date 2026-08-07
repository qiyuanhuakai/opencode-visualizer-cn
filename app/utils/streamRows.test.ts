/**
 * RED tests for streamRows.ts — token batch → row HTML conversion.
 *
 * Token batch shape (empirically pinned from @shikijs/stream source):
 * - Tokens are flat ThemedToken[] arrays
 * - Line boundaries are tokens with content === '\n'
 * - stable tokens include completed lines WITH their trailing '\n' tokens
 * - unstable tokens are the trailing incomplete line (no trailing '\n')
 * - recall = count of previous unstable tokens being replaced
 */
import { describe, expect, it } from 'vitest';
import type { ThemedToken } from 'shiki/core';
import type { StreamTokenBatch } from '../workers/streamHandler';
import { batchToRows } from './streamRows';
import { buildRows } from './tokenRows';

function token(content: string, color = '#E1E4E8'): ThemedToken {
  return { content, offset: 0, color };
}

function newlineToken(): ThemedToken {
  return { content: '\n', offset: 0 };
}

/** Stable token array for the given complete lines (each with trailing '\n'). */
function stableOf(...texts: string[]): ThemedToken[] {
  return texts.flatMap((text) => [token(text), newlineToken()]);
}

/** Per-line token arrays (single-shot buildRows input shape) for the given lines. */
function linesOf(...texts: string[]): ThemedToken[][] {
  return texts.map((text) => [token(text)]);
}

function gutterOf(row: string): string {
  const match = row.match(/<span class="code-gutter[^"]*">([^<]*)<\/span>/);
  if (!match?.[1]) throw new Error(`no gutter in row: ${row}`);
  return match[1];
}

describe('batchToRows', () => {
  describe('stable tokens → stableRows', () => {
    it('converts a single complete line (with trailing \\n) to one stable row', () => {
      // Given: stable tokens for "const x = 1;\n"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [token('const'), token(' '), token('x'), token(' = '), token('1'), token(';'), newlineToken()],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: one stable row, no unstable row
      expect(result.stableRows).toHaveLength(1);
      expect(result.stableRows[0]).toContain('<div class="code-row">');
      expect(result.stableRows[0]).toContain('<span class="line">');
      expect(result.unstableRow).toBeNull();
    });

    it('converts multiple complete lines to multiple stable rows', () => {
      // Given: stable tokens for "line1\nline2\nline3\n"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [
          token('line1'), newlineToken(),
          token('line2'), newlineToken(),
          token('line3'), newlineToken(),
        ],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: three stable rows
      expect(result.stableRows).toHaveLength(3);
      expect(result.stableRows[0]).toContain('line1');
      expect(result.stableRows[1]).toContain('line2');
      expect(result.stableRows[2]).toContain('line3');
      expect(result.unstableRow).toBeNull();
    });

    it('handles empty lines (consecutive \\n tokens)', () => {
      // Given: "line1\n\nline2\n" (empty line in middle)
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [
          token('line1'), newlineToken(),
          newlineToken(), // empty line
          token('line2'), newlineToken(),
        ],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: three rows (line1, empty, line2)
      expect(result.stableRows).toHaveLength(3);
      expect(result.stableRows[1]).toBe('<div class="code-row"><span class="line"></span></div>');
    });
  });

  describe('unstable tokens → unstableRow', () => {
    it('converts unstable tokens (no trailing \\n) to an unstable row', () => {
      // Given: stable for "line1\n", unstable for "partial"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [token('line1'), newlineToken()],
        unstable: [token('par'), token('tial')],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: one stable row, one unstable row
      expect(result.stableRows).toHaveLength(1);
      expect(result.unstableRow).not.toBeNull();
      expect(result.unstableRow).toContain('par');
      expect(result.unstableRow).toContain('tial');
      expect(result.unstableRow).toContain('<div class="code-row">');
    });

    it('handles empty stable + unstable-only batch (first chunk mid-line)', () => {
      // Given: no complete lines yet, just "partial"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [],
        unstable: [token('par'), token('tial')],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: no stable rows, one unstable row
      expect(result.stableRows).toHaveLength(0);
      expect(result.unstableRow).not.toBeNull();
      expect(result.unstableRow).toContain('par');
      expect(result.unstableRow).toContain('tial');
    });

    it('returns null unstableRow when unstable is empty', () => {
      // Given: stable with trailing \n, empty unstable
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [token('line1'), newlineToken()],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then
      expect(result.unstableRow).toBeNull();
    });
  });

  describe('mixed stable + unstable', () => {
    it('handles stable completing a line + new unstable starting', () => {
      // Given: previous unstable "partial" is now completed: "partial\n", new unstable "new"
      // recall=1 means 1 previous unstable token is being replaced
      const batch: StreamTokenBatch = {
        recall: 1,
        stable: [token('partial'), newlineToken()],
        unstable: [token('new')],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: one stable row (from completed "partial"), one unstable row ("new")
      expect(result.stableRows).toHaveLength(1);
      expect(result.stableRows[0]).toContain('partial');
      expect(result.unstableRow).not.toBeNull();
      expect(result.unstableRow).toContain('new');
    });

    it('handles multiple lines completing + new unstable', () => {
      // Given: "line1\nline2\n" stable, "partial" unstable
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [
          token('line1'), newlineToken(),
          token('line2'), newlineToken(),
        ],
        unstable: [token('par')],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: two stable rows, one unstable row
      expect(result.stableRows).toHaveLength(2);
      expect(result.unstableRow).not.toBeNull();
    });
  });

  describe('gutter mode passthrough', () => {
    it('applies single gutter mode to stable rows', () => {
      // Given: stable tokens for "line1\nline2\n"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [
          token('line1'), newlineToken(),
          token('line2'), newlineToken(),
        ],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'single');

      // Then: rows have gutter spans
      expect(result.stableRows[0]).toContain('<span class="code-gutter span-2">1</span>');
      expect(result.stableRows[1]).toContain('<span class="code-gutter span-2">2</span>');
    });

    it('applies custom gutterLines to stable rows', () => {
      // Given: stable tokens for "line1\nline2\n"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [
          token('line1'), newlineToken(),
          token('line2'), newlineToken(),
        ],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'single', ['10', '20']);

      // Then: rows use custom gutter labels
      expect(result.stableRows[0]).toContain('<span class="code-gutter span-2">10</span>');
      expect(result.stableRows[1]).toContain('<span class="code-gutter span-2">20</span>');
    });

    it('applies gutter mode to unstable row as well', () => {
      // Given: stable "line1\n", unstable "partial"
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [token('line1'), newlineToken()],
        unstable: [token('partial')],
      };

      // When
      const result = batchToRows(batch, 'single');

      // Then: unstable row also has gutter
      expect(result.unstableRow).toContain('<span class="code-gutter span-2">2</span>');
    });
  });

  describe('cumulative gutter numbering across batches', () => {
    it('continues default single-mode numbering across two batches, matching single-shot', () => {
      // Given: full code "aaa\nbbb\nccc\nddd\n" streamed as two batches
      // (batch 2 completes the line batch 1 left unstable)
      const batch1: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('aaa', 'bbb'),
        unstable: [token('cc')],
      };
      const batch2: StreamTokenBatch = {
        recall: 1,
        stable: stableOf('ccc', 'ddd'),
        unstable: [],
      };

      // When: converting with the composable's cumulative-offset pattern
      let lineOffset = 0;
      const rows1 = batchToRows(batch1, 'single', undefined, lineOffset);
      lineOffset += rows1.stableRows.length;
      const rows2 = batchToRows(batch2, 'single', undefined, lineOffset);

      // Then: gutter numbers are absolute and continuous (no restart at batch 2)
      expect(rows1.stableRows.map(gutterOf)).toEqual(['1', '2']);
      expect(gutterOf(rows1.unstableRow ?? '')).toBe('3');
      expect(rows2.stableRows.map(gutterOf)).toEqual(['3', '4']);

      // And: the accumulated stable rows equal the single-shot reference
      const singleShot = buildRows(linesOf('aaa', 'bbb', 'ccc', 'ddd'), 'single');
      expect([...rows1.stableRows, ...rows2.stableRows].join('\n')).toBe(singleShot);
    });

    it('continues custom gutterLines across three batches, matching single-shot', () => {
      // Given: five lines with custom absolute gutter labels, streamed as
      // three batches completing 2, 1, then 2 lines
      const gutterLines = ['10', '20', '30', '40', '50'];
      const batches: StreamTokenBatch[] = [
        { recall: 0, stable: stableOf('l1', 'l2'), unstable: [token('l')] },
        { recall: 1, stable: stableOf('l3'), unstable: [token('l4')] },
        { recall: 1, stable: stableOf('l4', 'l5'), unstable: [] },
      ];

      // When
      let lineOffset = 0;
      const allRows: string[] = [];
      for (const batch of batches) {
        const result = batchToRows(batch, 'single', gutterLines, lineOffset);
        lineOffset += result.stableRows.length;
        allRows.push(...result.stableRows);
      }

      // Then: each batch's rows carry the absolute custom labels
      expect(allRows.map(gutterOf)).toEqual(['10', '20', '30', '40', '50']);

      // And: the accumulated rows equal the single-shot reference
      const singleShot = buildRows(linesOf('l1', 'l2', 'l3', 'l4', 'l5'), 'single', gutterLines);
      expect(allRows.join('\n')).toBe(singleShot);
    });

    it('continues double-mode numbering across two batches, matching single-shot', () => {
      // Given: full code "aa\nbb\ncc\n" streamed as two batches
      const batch1: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('aa'),
        unstable: [token('b')],
      };
      const batch2: StreamTokenBatch = {
        recall: 1,
        stable: stableOf('bb', 'cc'),
        unstable: [],
      };

      // When
      let lineOffset = 0;
      const rows1 = batchToRows(batch1, 'double', undefined, lineOffset);
      lineOffset += rows1.stableRows.length;
      const rows2 = batchToRows(batch2, 'double', undefined, lineOffset);

      // Then: left gutter continues across the batch boundary
      expect(rows1.stableRows.map(gutterOf)).toEqual(['1']);
      expect(rows2.stableRows.map(gutterOf)).toEqual(['2', '3']);

      // And: the accumulated rows equal the single-shot reference
      const singleShot = buildRows(linesOf('aa', 'bb', 'cc'), 'double');
      expect([...rows1.stableRows, ...rows2.stableRows].join('\n')).toBe(singleShot);
    });

    it('numbers the unstable row by absolute line index across batches', () => {
      // Given: batch 1 completes two lines; batch 2 completes one more and
      // leaves a new unstable line
      const batch1: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('aaa', 'bbb'),
        unstable: [token('cc')],
      };
      const batch2: StreamTokenBatch = {
        recall: 1,
        stable: stableOf('ccc'),
        unstable: [token('dd')],
      };

      // When
      let lineOffset = 0;
      const rows1 = batchToRows(batch1, 'single', undefined, lineOffset);
      lineOffset += rows1.stableRows.length;
      const rows2 = batchToRows(batch2, 'single', undefined, lineOffset);

      // Then: the batch-2 unstable row is line 4, not batch-local line 2
      expect(gutterOf(rows2.unstableRow ?? '')).toBe('4');
      expect(lineOffset + rows2.stableRows.length).toBe(3);
    });

    it('labels the unstable row from absolute custom gutterLines across batches', () => {
      // Given: custom labels and a batch boundary before the unstable line
      const gutterLines = ['10', '20', '30', '40'];
      const batch1: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('aaa', 'bbb'),
        unstable: [],
      };
      const batch2: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('ccc'),
        unstable: [token('dd')],
      };

      // When
      let lineOffset = 0;
      const rows1 = batchToRows(batch1, 'single', gutterLines, lineOffset);
      lineOffset += rows1.stableRows.length;
      const rows2 = batchToRows(batch2, 'single', gutterLines, lineOffset);

      // Then: rows use the absolute custom labels
      expect(rows2.stableRows.map(gutterOf)).toEqual(['30']);
      expect(gutterOf(rows2.unstableRow ?? '')).toBe('40');
    });

    it('defaults to a zero offset so single-batch calls keep prior behavior', () => {
      // Given: a single batch converted without an offset argument
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: stableOf('line1', 'line2'),
        unstable: [token('par')],
      };

      // When
      const result = batchToRows(batch, 'single');

      // Then: numbering starts at 1
      expect(result.stableRows.map(gutterOf)).toEqual(['1', '2']);
      expect(gutterOf(result.unstableRow ?? '')).toBe('3');
    });
  });

  describe('edge cases', () => {
    it('handles completely empty batch (no tokens at all)', () => {
      // Given: empty batch
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: no rows
      expect(result.stableRows).toHaveLength(0);
      expect(result.unstableRow).toBeNull();
    });

    it('handles tokens with special characters (escaping)', () => {
      // Given: tokens with < and &
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [token('a < b'), token(' && '), token('c > d'), newlineToken()],
        unstable: [],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: special chars are escaped
      expect(result.stableRows[0]).toContain('&#x3C;'); // <
      expect(result.stableRows[0]).toContain('&#x26;'); // &
      expect(result.stableRows[0]).toContain(' > '); // > not escaped
    });

    it('handles a batch ending mid-line (no \\n in stable, unstable has content)', () => {
      // Given: "const x" with no newline yet
      const batch: StreamTokenBatch = {
        recall: 0,
        stable: [],
        unstable: [token('const'), token(' '), token('x')],
      };

      // When
      const result = batchToRows(batch, 'none');

      // Then: no stable rows, one unstable row
      expect(result.stableRows).toHaveLength(0);
      expect(result.unstableRow).not.toBeNull();
      expect(result.unstableRow).toContain('const');
      expect(result.unstableRow).toContain('x');
    });
  });
});
