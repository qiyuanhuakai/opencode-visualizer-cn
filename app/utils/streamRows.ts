/**
 * Pure token batch → row HTML converter for streaming code highlight.
 *
 * Converts StreamTokenBatch (flat ThemedToken[] arrays from @shikijs/stream)
 * into the StreamBatch shape expected by streamPatch.applyBatch():
 *   { stableRows: string[], unstableRow: string | null }
 *
 * Token batch shape (empirically pinned from @shikijs/stream source):
 * - Tokens are flat ThemedToken[] arrays
 * - Line boundaries are tokens with content === '\n'
 * - stable tokens include completed lines WITH their trailing '\n' tokens
 * - unstable tokens are the trailing incomplete line (no trailing '\n')
 *
 * This module delegates per-line token → HTML serialization to buildLineTokens
 * and per-row wrapping to buildRows from tokenRows.ts, ensuring byte-identical
 * output to the single-shot render pipeline.
 */
import type { ThemedToken } from 'shiki/core';
import type { StreamTokenBatch } from '../workers/streamHandler';
import { buildRows } from './tokenRows';
import type { StreamBatch } from './streamPatch';

type GutterMode = 'none' | 'single' | 'double';

/**
 * Splits a flat token array on '\n' content tokens into per-line token arrays.
 * Each '\n' token marks the end of a line; the '\n' token itself is NOT included
 * in the line's token array (matching shiki's codeToTokens structure where each
 * line is a separate array).
 */
function splitTokensOnNewlines(tokens: readonly ThemedToken[]): ThemedToken[][] {
  const lines: ThemedToken[][] = [];
  let currentLine: ThemedToken[] = [];

  for (const token of tokens) {
    if (token.content === '\n') {
      lines.push(currentLine);
      currentLine = [];
    } else {
      currentLine.push(token);
    }
  }

  // If there are remaining tokens after the last '\n', they form an incomplete line
  if (currentLine.length > 0) {
    lines.push(currentLine);
  }

  return lines;
}

/**
 * Converts a StreamTokenBatch into the StreamBatch shape for streamPatch.
 *
 * @param batch - Token batch from the streaming worker
 * @param mode - Gutter mode ('none' | 'single' | 'double')
 * @param gutterLines - Optional custom gutter labels, indexed by ABSOLUTE line
 *   number (matching the single-shot buildRows semantics)
 * @param lineOffset - Absolute line index of this batch's first stable line
 *   (cumulative count of stable rows emitted by prior batches in the stream)
 * @returns StreamBatch with stableRows (complete lines) and unstableRow (trailing incomplete line or null)
 */
export function batchToRows(
  batch: StreamTokenBatch,
  mode: GutterMode,
  gutterLines?: string[],
  lineOffset = 0,
): StreamBatch {
  // Split stable tokens into per-line arrays
  const stableLines = splitTokensOnNewlines(batch.stable);

  // Absolute gutter labels for this batch's stable lines. Labels are resolved
  // explicitly (rather than slicing gutterLines) so buildRows' fallback
  // numbering String(index + 1) stays absolute, identical to single-shot.
  const stableGutterLines = mode === 'none'
    ? undefined
    : stableLines.map((_, index) => {
        const absolute = lineOffset + index;
        return gutterLines?.[absolute] ?? String(absolute + 1);
      });

  // Build stable row HTML strings
  const stableRows = stableLines.length > 0
    ? buildRows(stableLines, mode, stableGutterLines).split('\n')
    : [];

  // Build unstable row HTML (if any unstable tokens exist)
  let unstableRow: string | null = null;
  if (batch.unstable.length > 0) {
    const unstableLines = [batch.unstable];
    // The unstable line's absolute gutter index follows this batch's stable lines
    const unstableGutterIndex = lineOffset + stableLines.length;
    const unstableGutterLines = [gutterLines?.[unstableGutterIndex] ?? String(unstableGutterIndex + 1)];
    unstableRow = buildRows(unstableLines, mode, unstableGutterLines);
  }

  return { stableRows, unstableRow };
}
