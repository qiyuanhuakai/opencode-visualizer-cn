/**
 * ORACLE — the output contract of app/workers/render-worker.ts (READ-ONLY, shiki 4.4.2).
 * The reference helpers below quote the worker VERBATIM; tokenRows must match them byte-for-byte.
 *
 * function escapeHtml(value: string) {
 *   return value
 *     .replace(/&/g, '&amp;')
 *     .replace(/</g, '&lt;')
 *     .replace(/>/g, '&gt;')
 *     .replace(/"/g, '&quot;')
 *     .replace(/'/g, '&#39;');
 * }
 *
 * function buildHtmlFromRows(rows: string) {
 *   return `<div class="code-host"><pre class="shiki"><code>${rows}</code></pre></div>`;
 * }
 *
 * function buildCodeRows(
 *   lines: string[],
 *   mode: 'none' | 'single' | 'double',
 *   gutterLines?: string[],
 * ) {
 *   return lines
 *     .map((line, index) => {
 *       if (mode === 'none') {
 *         return `<div class="code-row">${line}</div>`;
 *       }
 *       if (mode === 'double') {
 *         const pair = gutterLines?.[index]?.split('\t') ?? [];
 *         const left = pair[0] ?? String(index + 1);
 *         const right = pair[1] ?? '';
 *         return `<div class="code-row"><span class="code-gutter">${escapeHtml(left)}</span><span class="code-gutter">${escapeHtml(right)}</span>${line}</div>`;
 *       }
 *       const gutter = gutterLines?.[index] ?? String(index + 1);
 *       return `<div class="code-row file-row"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${line}</div>`;
 *     })
 *     .join('\n');
 * }
 *
 * function extractShikiLines(html: string) {
 *   const lines = html.split('\n').filter((line) => line.includes('class="line"'));
 *   return lines.map((line, index) => {
 *     let next = line;
 *     if (index === 0) {
 *       next = next.replace(/^.*?(<span class="line">)/, '$1');
 *     }
 *     if (index === lines.length - 1) {
 *       next = next.replace(/<\/code><\/pre>\s*$/, '');
 *     }
 *     return next;
 *   });
 * }
 *
 * Worker pipeline for standalone code (renderCodeHtml):
 *   codeToHtml(code, { lang, theme }) -> extractShikiLines -> buildCodeRows(lines, mode, gutterLines)
 *
 * Shiki 4.4.2 span serialization (verified facts this suite pins):
 *   - every token becomes `<span>`; style attr present only when non-empty
 *   - style = stringifyTokenStyle(token.htmlStyle || getTokenStyleObject(token))
 *   - text escaping is stringify-entities subset ['<','&'] => '&' -> '&#x26;', '<' -> '&#x3C;'
 *     ('>' and quotes are NOT escaped inside token text)
 *   - codeToHtml merges whitespace-only tokens into the following token (mergeWhitespaces=true),
 *     except tokens with Underline/Strikethrough fontStyle bits
 */
import { createHighlighter, type BundledLanguage } from 'shiki/bundle/web';
import type { ThemedToken } from 'shiki/core';
import { beforeAll, describe, expect, it } from 'vitest';

import { buildLineTokens, buildRows } from './tokenRows';

type GutterMode = 'none' | 'single' | 'double';
type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;

// ---------------------------------------------------------------------------
// Reference helpers — VERBATIM copies of the render-worker.ts oracle quoted above.
// ---------------------------------------------------------------------------

function referenceEscapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function referenceBuildCodeRows(lines: string[], mode: GutterMode, gutterLines?: string[]) {
  return lines
    .map((line, index) => {
      if (mode === 'none') {
        return `<div class="code-row">${line}</div>`;
      }
      if (mode === 'double') {
        const pair = gutterLines?.[index]?.split('\t') ?? [];
        const left = pair[0] ?? String(index + 1);
        const right = pair[1] ?? '';
        return `<div class="code-row"><span class="code-gutter">${referenceEscapeHtml(left)}</span><span class="code-gutter">${referenceEscapeHtml(right)}</span>${line}</div>`;
      }
      const gutter = gutterLines?.[index] ?? String(index + 1);
      return `<div class="code-row file-row"><span class="code-gutter span-2">${referenceEscapeHtml(gutter)}</span>${line}</div>`;
    })
    .join('\n');
}

function referenceExtractShikiLines(html: string) {
  const lines = html.split('\n').filter((line) => line.includes('class="line"'));
  return lines.map((line, index) => {
    let next = line;
    if (index === 0) {
      next = next.replace(/^.*?(<span class="line">)/, '$1');
    }
    if (index === lines.length - 1) {
      next = next.replace(/<\/code><\/pre>\s*$/, '');
    }
    return next;
  });
}

// ---------------------------------------------------------------------------
// Real-shiki oracle: the worker's single-shot pipeline, run in-test.
// ---------------------------------------------------------------------------

const THEME = 'github-dark';

let highlighter: Highlighter;

beforeAll(async () => {
  highlighter = await createHighlighter({
    themes: [THEME],
    langs: ['typescript', 'python', 'bash', 'markdown'],
  });
});

function oracleLines(code: string, lang: BundledLanguage) {
  return referenceExtractShikiLines(highlighter.codeToHtml(code, { lang, theme: THEME }));
}

function oracleRows(code: string, lang: BundledLanguage, mode: GutterMode, gutterLines?: string[]) {
  return referenceBuildCodeRows(oracleLines(code, lang), mode, gutterLines);
}

function tokensOf(code: string, lang: BundledLanguage) {
  return highlighter.codeToTokens(code, { lang, theme: THEME }).tokens;
}

describe('buildLineTokens', () => {
  it.each<[BundledLanguage, string]>([
    [
      'typescript',
      [
        'interface User {',
        '  id: number;',
        '  name?: string;',
        '}',
        'const u: User = { id: 1, name: "ada" };',
      ].join('\n'),
    ],
    [
      'python',
      ['def greet(name: str) -> str:', '    """Return a greeting."""', '    return f"hi {name}"'].join(
        '\n',
      ),
    ],
    ['bash', ['#!/bin/bash', 'echo "hi $USER" | grep -o \'h.\' # trailing'].join('\n')],
  ])('matches oracle line HTML for %s', (lang, code) => {
    const lines = oracleLines(code, lang);
    const tokens = tokensOf(code, lang);
    expect(tokens).toHaveLength(lines.length);
    lines.forEach((lineHtml, index) => {
      expect(buildLineTokens(tokens[index])).toBe(lineHtml);
    });
  });

  it('matches the oracle on empty lines, whitespace-only lines and a trailing newline', () => {
    const code = 'def f(x):\n    pass\n\n   \n    return x\n';
    const lines = oracleLines(code, 'python');
    const tokens = tokensOf(code, 'python');
    expect(tokens).toHaveLength(lines.length);
    lines.forEach((lineHtml, index) => {
      expect(buildLineTokens(tokens[index])).toBe(lineHtml);
    });
    // explicit pins: empty line and whitespace-only line shapes
    expect(lines[2]).toBe('<span class="line"></span>');
    expect(buildLineTokens(tokens[2])).toBe('<span class="line"></span>');
    expect(lines[3]).toBe('<span class="line"><span style="color:#E1E4E8">   </span></span>');
    expect(buildLineTokens(tokens[3])).toBe(lines[3]);
  });

  it('matches the oracle for a completely empty source', () => {
    const lines = oracleLines('', 'typescript');
    const tokens = tokensOf('', 'typescript');
    expect(lines).toEqual(['<span class="line"></span>']);
    expect(tokens).toEqual([[]]);
    expect(buildLineTokens(tokens[0])).toBe(lines[0]);
  });

  it('escapes token text exactly like shiki: & -> &#x26;, < -> &#x3C;, > and quotes raw', () => {
    const code = 'const a = 1 > 2 && "x" < 3; // <b> & \'q\'';
    const lines = oracleLines(code, 'typescript');
    const tokens = tokensOf(code, 'typescript');
    expect(buildLineTokens(tokens[0])).toBe(lines[0]);
    expect(lines[0]).toContain('&#x26;&#x26;');
    expect(lines[0]).toContain('&#x3C;');
    expect(lines[0]).toContain(' >'); // '>' is NOT escaped by shiki
    expect(lines[0]).not.toContain('&gt;');
    expect(lines[0]).not.toContain('&quot;');
    expect(lines[0]).toContain('"x"');
  });

  it('serializes every fontStyle branch exactly like shiki (real markdown tokens)', () => {
    // Given: github-dark markdown emits Italic(1), Bold(2), Underline(4) and
    // Strikethrough(8) single-bit fontStyle tokens. Combined-bit ordering
    // (font-style then font-weight; underline then line-through) is produced by
    // shiki's own getTokenStyleObject/stringifyTokenStyle, which buildLineTokens
    // delegates to — so it is byte-correct by construction once each branch matches.
    const code = '*it* **bo** ~~st~~ [ln](http://x)';
    const [line] = oracleLines(code, 'markdown');
    const tokens = tokensOf(code, 'markdown');
    expect(buildLineTokens(tokens[0])).toBe(line);
    // explicit pins of shiki's CSS serialization (color first, then font-* / text-decoration)
    expect(line).toContain('<span style="color:#E1E4E8;font-style:italic">*it*</span>');
    // whitespace merged INTO the following bold token (adopts the bold style)
    expect(line).toContain('<span style="color:#E1E4E8;font-weight:bold"> **bo**</span>');
    // carried whitespace before a decorated token becomes a BARE span (color dropped by shiki)
    expect(line).toContain('<span> </span>');
    expect(line).toContain('<span style="color:#E1E4E8;text-decoration:line-through">~~st~~</span>');
    expect(line).toContain('<span style="color:#DBEDFF;text-decoration:underline">ln</span>');
  });

  it('does not merge whitespace into a following decorated (underline/strikethrough) token', () => {
    // Given: [whitespace-only token, underline token] — shiki's mergeWhitespaceTokens
    // treats decorated tokens as non-mergeable and emits the carried whitespace as a
    // BARE { content, offset } token (its original color is dropped by shiki's algorithm).
    const line: ThemedToken[] = [
      { content: '  ', offset: 0, color: '#E1E4E8', fontStyle: 0 },
      { content: 'x', offset: 2, color: '#F97583', fontStyle: 4 }, // Underline
    ];
    expect(buildLineTokens(line)).toBe(
      '<span class="line">' +
        '<span>  </span>' +
        '<span style="color:#F97583;text-decoration:underline">x</span>' +
        '</span>',
    );
  });

  it('never merges a whitespace-only decorated token into its neighbour', () => {
    // Given: a whitespace-only UNDERLINE token followed by a plain token —
    // shiki keeps the decorated whitespace token as its own span.
    const line: ThemedToken[] = [
      { content: 'a', offset: 0, color: '#79B8FF', fontStyle: 0 },
      { content: ' ', offset: 1, color: '#E1E4E8', fontStyle: 4 }, // Underline whitespace
      { content: 'b', offset: 2, color: '#79B8FF', fontStyle: 0 },
    ];
    expect(buildLineTokens(line)).toBe(
      '<span class="line">' +
        '<span style="color:#79B8FF">a</span>' +
        '<span style="color:#E1E4E8;text-decoration:underline"> </span>' +
        '<span style="color:#79B8FF">b</span>' +
        '</span>',
    );
  });

  it('honours a pre-computed htmlStyle record the same way shiki does', () => {
    const line: ThemedToken[] = [
      { content: 'x', offset: 0, htmlStyle: { color: '#123456', 'font-style': 'italic' } },
    ];
    expect(buildLineTokens(line)).toBe(
      '<span class="line"><span style="color:#123456;font-style:italic">x</span></span>',
    );
  });
});

describe('buildRows', () => {
  const tsCode = ['export function add(a: number, b: number) {', '  return a + b;', '}'].join('\n');

  it('equals the worker rows for gutterMode none', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    expect(buildRows(tokens, 'none')).toBe(oracleRows(tsCode, 'typescript', 'none'));
    expect(buildRows(tokens, 'none')).toContain('<div class="code-row"><span class="line">');
  });

  it('equals the worker rows for gutterMode single with explicit gutter labels', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    const gutterLines = ['10', '11', '12'];
    expect(buildRows(tokens, 'single', gutterLines)).toBe(
      oracleRows(tsCode, 'typescript', 'single', gutterLines),
    );
    expect(buildRows(tokens, 'single', gutterLines)).toContain(
      '<div class="code-row file-row"><span class="code-gutter span-2">10</span>',
    );
  });

  it('equals the worker rows for gutterMode single without gutterLines (index fallback)', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    expect(buildRows(tokens, 'single')).toBe(oracleRows(tsCode, 'typescript', 'single'));
  });

  it('equals the worker rows for gutterMode double with tab-separated gutter pairs', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    const gutterLines = ['1\t1', '2\t', '\t3'];
    expect(buildRows(tokens, 'double', gutterLines)).toBe(
      oracleRows(tsCode, 'typescript', 'double', gutterLines),
    );
    expect(buildRows(tokens, 'double', gutterLines)).toContain(
      '<div class="code-row"><span class="code-gutter">1</span><span class="code-gutter">1</span>',
    );
  });

  it('equals the worker rows for gutterMode double with missing gutter entries', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    expect(buildRows(tokens, 'double')).toBe(oracleRows(tsCode, 'typescript', 'double'));
  });

  it('escapes gutter labels with the worker escapeHtml (& < > " \'), unlike token text', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    const gutterLines = ['<&>', '"q"', "'x'"];
    const expected = oracleRows(tsCode, 'typescript', 'single', gutterLines);
    expect(buildRows(tokens, 'single', gutterLines)).toBe(expected);
    expect(buildRows(tokens, 'single', gutterLines)).toContain(
      '<span class="code-gutter span-2">&lt;&amp;&gt;</span>',
    );
    expect(buildRows(tokens, 'single', gutterLines)).toContain(
      '<span class="code-gutter span-2">&quot;q&quot;</span>',
    );
    expect(buildRows(tokens, 'single', gutterLines)).toContain(
      '<span class="code-gutter span-2">&#39;x&#39;</span>',
    );
  });

  it('joins rows with a single newline and nothing else', () => {
    const tokens = tokensOf(tsCode, 'typescript');
    const rows = buildRows(tokens, 'none');
    expect(rows.split('\n')).toHaveLength(3);
    expect(rows).toBe(oracleRows(tsCode, 'typescript', 'none'));
  });

  it.each(['python', 'bash'] as const)('equals the worker rows across modes for %s', (lang) => {
    const code =
      lang === 'python'
        ? 'import os\n\ndef main():\n    print(os.name)\n'
        : 'for f in *.log; do\n  echo "$f"\ndone';
    const tokens = tokensOf(code, lang);
    const gutterLines = tokens.map((_, i) => `${i + 1}\t${i + 10}`);
    for (const mode of ['none', 'single', 'double'] as const) {
      expect(buildRows(tokens, mode)).toBe(oracleRows(code, lang, mode));
      expect(buildRows(tokens, mode, gutterLines)).toBe(oracleRows(code, lang, mode, gutterLines));
    }
  });
});
