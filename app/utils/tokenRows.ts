/**
 * Pure ThemedToken[] -> row-HTML builder.
 *
 * Produces HTML structurally IDENTICAL to app/workers/render-worker.ts's standalone
 * code pipeline: codeToHtml(code, { lang, theme }) -> extractShikiLines -> buildCodeRows.
 *
 * Span serialization replicates shiki 4.4.2 exactly (see app/utils/tokenRows.test.ts oracle):
 *   - every token becomes `<span>`; the style attribute is present only when non-empty
 *   - style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token))
 *     (falsy check, matching shiki's `token.htmlStyle || getTokenStyleObject(token)`)
 *   - text escaping is stringify-entities with subset ['<','&']:
 *     '&' -> '&#x26;', '<' -> '&#x3C;' ('>' and quotes stay raw)
 *   - whitespace-only tokens are merged into the following token (shiki's
 *     mergeWhitespaceTokens, which codeToHtml applies with mergeWhitespaces=true),
 *     except tokens carrying the Underline/Strikethrough fontStyle bits
 *
 * Row templates and gutter escaping replicate render-worker.ts's buildCodeRows/escapeHtml
 * verbatim (gutter labels use the worker's escapeHtml: & < > " ' — unlike token text).
 */
import { getTokenStyleObject, stringifyTokenStyle, type ThemedToken } from 'shiki/core';

// FontStyle bit values from @shikijs/vscode-textmate (NotSet=-1, None=0,
// Italic=1, Bold=2, Underline=4, Strikethrough=8).
const FONT_STYLE_UNDERLINE = 4;
const FONT_STYLE_STRIKETHROUGH = 8;
const FONT_STYLE_DECORATED = FONT_STYLE_UNDERLINE | FONT_STYLE_STRIKETHROUGH;

const RE_WHITESPACE_ONLY = /^\s+$/;

/** shiki text-node escaping: stringify-entities subset ['<','&'], hex references. */
function escapeTokenText(value: string): string {
  return value.replace(/&/g, '&#x26;').replace(/</g, '&#x3C;');
}

/** render-worker.ts escapeHtml, verbatim — used for gutter labels only. */
function escapeHtml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function isDecorated(token: ThemedToken): boolean {
  return Boolean(token.fontStyle && token.fontStyle & FONT_STYLE_DECORATED);
}

/**
 * shiki 4.4.2 mergeWhitespaceTokens (single line), replicated:
 * a whitespace-only token with a following sibling is folded into that sibling's
 * content (adopting the sibling's style), unless either side is decorated.
 */
function mergeWhitespaceLine(line: ThemedToken[]): ThemedToken[] {
  const newLine: ThemedToken[] = [];
  let carryOnContent = '';
  let firstOffset: number | undefined;
  line.forEach((token, index) => {
    const couldMerge = !isDecorated(token);
    if (couldMerge && RE_WHITESPACE_ONLY.test(token.content) && line[index + 1]) {
      if (firstOffset === undefined) firstOffset = token.offset;
      carryOnContent += token.content;
    } else if (carryOnContent) {
      if (couldMerge) {
        newLine.push({
          ...token,
          offset: firstOffset ?? token.offset,
          content: carryOnContent + token.content,
        });
      } else {
        newLine.push({ content: carryOnContent, offset: firstOffset ?? token.offset }, token);
      }
      firstOffset = undefined;
      carryOnContent = '';
    } else {
      newLine.push(token);
    }
  });
  return newLine;
}

/** shiki 4.4.2 tokensToHast span serialization for a single token. */
function buildTokenSpan(token: ThemedToken): string {
  const style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token));
  const content = escapeTokenText(token.content);
  return style ? `<span style="${style}">${content}</span>` : `<span>${content}</span>`;
}

/** One line of tokens -> the `<span class="line">...</span>` HTML shiki would emit. */
export function buildLineTokens(tokens: ThemedToken[]): string {
  return `<span class="line">${mergeWhitespaceLine(tokens).map(buildTokenSpan).join('')}</span>`;
}

/**
 * Lines of tokens -> the exact rows render-worker.ts's buildCodeRows produces
 * for standalone code blocks (rows joined with a single '\n').
 */
export function buildRows(
  lines: ThemedToken[][],
  mode: 'none' | 'single' | 'double',
  gutterLines?: string[],
): string {
  return lines
    .map((tokens, index) => {
      const line = buildLineTokens(tokens);
      if (mode === 'none') {
        return `<div class="code-row">${line}</div>`;
      }
      if (mode === 'double') {
        const pair = gutterLines?.[index]?.split('\t') ?? [];
        const left = pair[0] ?? String(index + 1);
        const right = pair[1] ?? '';
        return `<div class="code-row"><span class="code-gutter">${escapeHtml(left)}</span><span class="code-gutter">${escapeHtml(right)}</span>${line}</div>`;
      }
      const gutter = gutterLines?.[index] ?? String(index + 1);
      return `<div class="code-row file-row"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${line}</div>`;
    })
    .join('\n');
}
