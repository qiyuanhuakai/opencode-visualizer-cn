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

function token(content: string, color = '#E1E4E8'): ThemedToken {
  return { content, offset: 0, color };
}

function newlineToken(): ThemedToken {
  return { content: '\n', offset: 0 };
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
