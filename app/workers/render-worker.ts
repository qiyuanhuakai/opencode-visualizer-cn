import MarkdownIt from 'markdown-it';
import { fromHighlighter, type MarkdownItShikiSetupOptions } from '@shikijs/markdown-it/core';
import { bundledLanguages, createHighlighter } from 'shiki/bundle/web';
import { bundledLanguages as allBundledLanguages } from 'shiki/langs';
import { transformerNotationDiff } from '@shikijs/transformers';
import { compactUnifiedDiffPatch } from '../utils/diffCompression';

type RenderRequest = {
  id: string;
  code: string;
  patch?: string;
  after?: string;
  lang: string;
  theme: string;
  gutterMode?: 'none' | 'single' | 'double';
  gutterLines?: string[];
  grepPattern?: string;
  lineOffset?: number;
  lineLimit?: number;
  files?: string[];
  // Localization strings for copy buttons
  copyButtonLabel?: string;
  copiedLabel?: string;
  copyCodeAriaLabel?: string;
  copyMarkdownAriaLabel?: string;
};

type RenderResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

type DiffRow = {
  html: string;
  rowClass?: string;
};

type Highlighter = Awaited<ReturnType<typeof createHighlighter>>;
type MarkdownShikiOptions = MarkdownItShikiSetupOptions & { langAlias?: Record<string, string> };
type MarkdownRenderEnv = {
  fileSet?: Set<string>;
};

type ParsedInlineFileRef = {
  path: string;
  lines?: string;
};

const HEX_COLOR_REF_RE = /^#(?:[0-9a-f]{3}|[0-9a-f]{4}|[0-9a-f]{6}|[0-9a-f]{8})$/i;
const FUNC_COLOR_REF_RE = /^(?:rgb|rgba|hsl|hsla)\(\s*[\d.]+%?\s*(?:[,/]\s*[\d.]+%?\s*)*\)$/i;

function isInlineColorRef(value: string) {
  return HEX_COLOR_REF_RE.test(value) || FUNC_COLOR_REF_RE.test(value);
}

function parseInlineFileRef(rawRef: string, fileSet: Set<string>): ParsedInlineFileRef | null {
  const ref = rawRef.trim();
  if (!ref) return null;
  if (fileSet.has(ref)) return { path: ref };
  const match = /^(.+?):(\d+(?:-\d+)?(?:,\d+(?:-\d+)?)*)$/.exec(ref);
  if (!match) return null;
  const path = match[1];
  if (!path || !fileSet.has(path)) return null;
  const lines = (match[2] ?? '').trim();
  if (!lines) return null;

  return { path, lines };
}

let highlighterPromise: Promise<Awaited<ReturnType<typeof createHighlighter>>> | null = null;
let cachedTheme = '';
let loadedLanguageCache = new Set<string>(['text']);
let failedLanguageCache = new Set<string>();

const HIGHLIGHT_CACHE_MAX = 512;
let codeHtmlCache = new Map<string, string>();
let mdHighlightCache = new Map<string, string>();

function pruneHighlightCache(cache: Map<string, string>) {
  if (cache.size <= HIGHLIGHT_CACHE_MAX) return;
  const target = Math.floor(HIGHLIGHT_CACHE_MAX / 2);
  for (const key of cache.keys()) {
    if (cache.size <= target) break;
    cache.delete(key);
  }
}

function getHighlighter(theme: string) {
  if (!highlighterPromise || cachedTheme !== theme) {
    cachedTheme = theme;
    highlighterPromise = createHighlighter({ themes: [theme], langs: ['text'] });
    loadedLanguageCache = new Set(['text']);
    failedLanguageCache = new Set();
    codeHtmlCache = new Map();
    mdHighlightCache = new Map();
  }
  return highlighterPromise;
}

function languageCandidates(lang: string) {
  const trimmed = (lang || '').trim().toLowerCase();
  if (!trimmed) return ['text'];
  if (trimmed === 'shellscript') return ['bash', 'shellscript', 'sh', 'text'];
  if (trimmed === 'tsx') return ['tsx', 'typescript', 'text'];
  if (trimmed === 'jsx') return ['jsx', 'javascript', 'text'];
  if (trimmed === 'md') return ['markdown', 'text'];
  if (trimmed === 'yml') return ['yaml', 'text'];
  return [trimmed, 'text'];
}

async function resolveLanguage(highlighter: Highlighter, lang: string) {
  const loaded =
    typeof highlighter.getLoadedLanguages === 'function' ? highlighter.getLoadedLanguages() : [];
  for (const item of loaded) loadedLanguageCache.add(item);
  for (const candidate of languageCandidates(lang)) {
    if (loadedLanguageCache.has(candidate)) return candidate;
    if (candidate === 'text') return 'text';
    const loadedCandidate = await tryLoadLanguage(highlighter, candidate);
    if (loadedCandidate) return candidate;
  }
  return 'text';
}

type LanguageLoader = () => Promise<{ default: unknown }>;

async function tryLoadLanguage(highlighter: Highlighter, candidate: string) {
  if (failedLanguageCache.has(candidate)) return false;
  if (typeof highlighter.loadLanguage !== 'function') return false;

  const loader =
    (bundledLanguages as Record<string, unknown>)[candidate] ??
    (allBundledLanguages as Record<string, unknown>)[candidate];
  try {
    if (typeof loader === 'function') {
      const module = await (loader as LanguageLoader)();
      const language = module?.default;
      await highlighter.loadLanguage(language as never);
    } else {
      await highlighter.loadLanguage(candidate as never);
    }
    loadedLanguageCache.add(candidate);
    failedLanguageCache.delete(candidate);
    return true;
  } catch (error) {
    if (!failedLanguageCache.has(candidate)) {
      console.warn('[render-worker] language load failed', candidate, error);
    }
    failedLanguageCache.add(candidate);
    return false;
  }
}

function safeCodeToHtml(
  highlighter: Highlighter,
  code: string,
  lang: string,
  theme: string,
): string {
  const cacheKey = `${lang}\0${code}`;
  const cached = codeHtmlCache.get(cacheKey);
  if (cached !== undefined) return cached;
  let result: string;
  try {
    result = highlighter.codeToHtml(code, { lang, theme });
  } catch {
    result = highlighter.codeToHtml(code, { lang: 'text', theme });
  }
  codeHtmlCache.set(cacheKey, result);
  pruneHighlightCache(codeHtmlCache);
  return result;
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function buildHtmlFromRows(rows: string) {
  return `<div class="code-host"><pre class="shiki"><code>${rows}</code></pre></div>`;
}

function buildCodeRows(
  lines: string[],
  mode: 'none' | 'single' | 'double',
  gutterLines?: string[],
) {
  return lines
    .map((line, index) => {
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

/**
 * Generate a unified diff from two strings using a simple LCS-based algorithm.
 * Produces output compatible with the existing buildDiffHtmlFromCode parser.
 */
function generateUnifiedDiff(before: string, after: string, contextLines = 3): string {
  const a = before.split('\n');
  const b = after.split('\n');

  // LCS via Hunt-McIlroy / simple DP for line-level diff
  // Build edit script: array of {type, line} where type is ' ', '+', '-'
  const n = a.length;
  const m = b.length;

  // Myers diff (linear space, O(ND) time)
  const max = n + m;
  const vSize = 2 * max + 1;
  const v = new Int32Array(vSize);
  v.fill(-1);
  const offset = max;
  v[offset + 1] = 0;

  const trace: Array<Int32Array> = [];

  outer: for (let d = 0; d <= max; d++) {
    const snap = new Int32Array(vSize);
    snap.set(v);
    trace.push(snap);
    for (let k = -d; k <= d; k += 2) {
      let x: number;
      if (k === -d || (k !== d && v[offset + k - 1] < v[offset + k + 1])) {
        x = v[offset + k + 1];
      } else {
        x = v[offset + k - 1] + 1;
      }
      let y = x - k;
      while (x < n && y < m && a[x] === b[y]) {
        x++;
        y++;
      }
      v[offset + k] = x;
      if (x >= n && y >= m) break outer;
    }
  }

  // Backtrack to get the edit path
  interface Edit {
    type: ' ' | '+' | '-';
    text: string;
  }
  const edits: Edit[] = [];
  let cx = n;
  let cy = m;
  for (let d = trace.length - 1; d >= 0; d--) {
    const snap = trace[d];
    const k = cx - cy;
    let prevK: number;
    if (k === -d || (k !== d && snap[offset + k - 1] < snap[offset + k + 1])) {
      prevK = k + 1;
    } else {
      prevK = k - 1;
    }
    const prevX = snap[offset + prevK];
    const prevY = prevX - prevK;

    // Diagonal (equal lines)
    while (cx > prevX && cy > prevY) {
      cx--;
      cy--;
      edits.push({ type: ' ', text: a[cx] });
    }

    if (d > 0) {
      if (cx === prevX) {
        // Insertion
        cy--;
        edits.push({ type: '+', text: b[cy] });
      } else {
        // Deletion
        cx--;
        edits.push({ type: '-', text: a[cx] });
      }
    }
  }
  edits.reverse();

  if (edits.length === 0) return '';

  // Group into hunks with context
  type Hunk = {
    oldStart: number;
    oldCount: number;
    newStart: number;
    newCount: number;
    lines: string[];
  };
  const hunks: Hunk[] = [];
  // Find change regions
  const changeIndices: number[] = [];
  edits.forEach((e, i) => {
    if (e.type !== ' ') changeIndices.push(i);
  });

  if (changeIndices.length === 0) return '';

  // Merge nearby changes into hunks
  const groups: Array<[number, number]> = [];
  let groupStart = changeIndices[0];
  let groupEnd = changeIndices[0];

  for (let i = 1; i < changeIndices.length; i++) {
    if (changeIndices[i] - groupEnd <= contextLines * 2 + 1) {
      groupEnd = changeIndices[i];
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = changeIndices[i];
      groupEnd = changeIndices[i];
    }
  }
  groups.push([groupStart, groupEnd]);

  for (const [gStart, gEnd] of groups) {
    const ctxStart = Math.max(0, gStart - contextLines);
    const ctxEnd = Math.min(edits.length - 1, gEnd + contextLines);

    let oLine = 1;
    let nLine = 1;
    for (let i = 0; i < ctxStart; i++) {
      if (edits[i].type === ' ' || edits[i].type === '-') oLine++;
      if (edits[i].type === ' ' || edits[i].type === '+') nLine++;
    }

    const hunkLines: string[] = [];
    let oldCount = 0;
    let newCount = 0;
    for (let i = ctxStart; i <= ctxEnd; i++) {
      const e = edits[i];
      hunkLines.push(`${e.type}${e.text}`);
      if (e.type === ' ' || e.type === '-') oldCount++;
      if (e.type === ' ' || e.type === '+') newCount++;
    }

    hunks.push({
      oldStart: oLine,
      oldCount,
      newStart: nLine,
      newCount,
      lines: hunkLines,
    });
  }

  const result: string[] = [];
  for (const hunk of hunks) {
    result.push(`@@ -${hunk.oldStart},${hunk.oldCount} +${hunk.newStart},${hunk.newCount} @@`);
    result.push(...hunk.lines);
  }
  return result.join('\n');
}

function applyPatchToCode(code: string, patch: string) {
  const lines = code.split('\n');
  let offset = 0;
  const patchLines = patch.split('\n');
  let index = 0;
  while (index < patchLines.length) {
    const line = patchLines[index];
    if (!line.startsWith('@@')) {
      index += 1;
      continue;
    }
    const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
    if (!match) {
      index += 1;
      continue;
    }
    const oldLine = Number(match[1]);
    let pointer = oldLine - 1 + offset;
    index += 1;
    while (index < patchLines.length && !patchLines[index].startsWith('@@')) {
      const patchLine = patchLines[index];
      if (patchLine.startsWith('+') && !patchLine.startsWith('+++')) {
        lines.splice(pointer, 0, patchLine.slice(1));
        pointer += 1;
        offset += 1;
      } else if (patchLine.startsWith('-') && !patchLine.startsWith('---')) {
        lines.splice(pointer, 1);
        offset -= 1;
      } else if (patchLine.startsWith(' ')) {
        pointer += 1;
      }
      index += 1;
    }
  }
  return lines.join('\n');
}

function extractShikiLines(html: string) {
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

function isDiffMetadataLine(line: string) {
  return (
    line.startsWith('diff ') ||
    line.startsWith('index ') ||
    line.startsWith('Index: ') ||
    line.startsWith('===') ||
    line.startsWith('---') ||
    line.startsWith('+++') ||
    line.startsWith('***')
  );
}

function buildDiffGutterLines(source: string) {
  const lines = source.split('\n');
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  const oldValues: Array<string> = [];
  const newValues: Array<string> = [];

  lines.forEach((line) => {
    if (line.startsWith('@@')) {
      const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      inHunk = true;
      oldValues.push('');
      newValues.push('');
      return;
    }
    if (isDiffMetadataLine(line) || line.startsWith('\\')) {
      inHunk = false;
      oldValues.push('');
      newValues.push('');
      return;
    }
    if (!inHunk) {
      oldValues.push('');
      newValues.push('');
      return;
    }
    if (line.startsWith('+') && !line.startsWith('+++')) {
      oldValues.push('');
      newValues.push(String(newLine));
      newLine += 1;
      return;
    }
    if (line.startsWith('-') && !line.startsWith('---')) {
      oldValues.push(String(oldLine));
      newValues.push('');
      oldLine += 1;
      return;
    }
    if (line.startsWith(' ')) {
      oldValues.push(String(oldLine));
      newValues.push(String(newLine));
      oldLine += 1;
      newLine += 1;
      return;
    }
    if (oldLine === 0 && newLine === 0) {
      oldValues.push('');
      newValues.push('');
      return;
    }
    oldValues.push('');
    newValues.push('');
  });

  return { oldValues, newValues };
}

function wrapDiffRows(
  lines: DiffRow[],
  oldValues: string[],
  newValues: string[],
  mode: 'none' | 'single' | 'double',
) {
  return lines
    .map((row, index) => {
      const rowClass = row.rowClass ? ` code-row ${row.rowClass}` : ' code-row';
      if (mode === 'none') return `<div class="${rowClass.trim()}">${row.html}</div>`;
      if (mode === 'single') {
        const left = oldValues[index] ?? '';
        const right = newValues[index] ?? '';
        const gutter = right || left;
        return `<div class="${rowClass.trim()}"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${row.html}</div>`;
      }
      const oldValue = oldValues[index] ?? '';
      const newValue = newValues[index] ?? '';
      return `<div class="${rowClass.trim()}"><span class="code-gutter">${escapeHtml(oldValue)}</span><span class="code-gutter">${escapeHtml(newValue)}</span>${row.html}</div>`;
    })
    .join('\n');
}

function buildGrepMatcher(pattern?: string) {
  if (!pattern?.trim()) return null;
  try {
    return new RegExp(pattern, 'g');
  } catch {
    return null;
  }
}

function highlightGrepMatches(line: string, matcher: RegExp | null) {
  if (!matcher) return escapeHtml(line);
  matcher.lastIndex = 0;
  let html = '';
  let cursor = 0;
  while (cursor <= line.length) {
    const match = matcher.exec(line);
    if (!match) break;
    const index = match.index;
    const value = match[0] ?? '';
    if (index > cursor) {
      html += escapeHtml(line.slice(cursor, index));
    }
    if (!value) {
      if (index >= line.length) break;
      html += escapeHtml(line[index] ?? '');
      cursor = index + 1;
      matcher.lastIndex = cursor;
      continue;
    }
    html += `<span class="grep-match"><strong>${escapeHtml(value)}</strong></span>`;
    cursor = index + value.length;
    if (!matcher.global) break;
    if (matcher.lastIndex <= index) matcher.lastIndex = index + value.length;
  }
  if (cursor < line.length) html += escapeHtml(line.slice(cursor));
  return html;
}

function renderGrepRows(
  code: string,
  mode: 'none' | 'single' | 'double',
  gutterLines?: string[],
  pattern?: string,
) {
  const lines = code.split('\n');
  const matcher = buildGrepMatcher(pattern);
  return lines
    .map((line, index) => {
      const content = `<span class="line">${highlightGrepMatches(line, matcher)}</span>`;
      if (mode === 'none') return `<div class="code-row">${content}</div>`;
      if (mode === 'double') {
        const pair = gutterLines?.[index]?.split('\t') ?? [];
        const left = pair[0] ?? '';
        const right = pair[1] ?? '';
        return `<div class="code-row"><span class="code-gutter">${escapeHtml(left)}</span><span class="code-gutter">${escapeHtml(right)}</span>${content}</div>`;
      }
      const gutter = gutterLines?.[index] ?? String(index + 1);
      return `<div class="code-row"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${content}</div>`;
    })
    .join('\n');
}

function diffMaxLines(diff: string): { maxOld: number; maxNew: number } {
  let maxOld = 0;
  let maxNew = 0;
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[3]);
      }
      inHunk = true;
      continue;
    }
    if (isDiffMetadataLine(line) || line.startsWith('\\')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      maxNew = Math.max(maxNew, newLine);
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      maxOld = Math.max(maxOld, oldLine);
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      maxOld = Math.max(maxOld, oldLine);
      maxNew = Math.max(maxNew, newLine);
      oldLine += 1;
      newLine += 1;
    }
  }
  return { maxOld, maxNew };
}

function reconstructSourcesFromDiff(diff: string): { before: string; after: string } {
  const beforeLines: Array<[number, string]> = [];
  const afterLines: Array<[number, string]> = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      inHunk = true;
      continue;
    }
    if (isDiffMetadataLine(line) || line.startsWith('\\')) {
      inHunk = false;
      continue;
    }
    if (!inHunk) continue;
    if (line.startsWith('+') && !line.startsWith('+++')) {
      afterLines.push([newLine, line.slice(1)]);
      newLine += 1;
    } else if (line.startsWith('-') && !line.startsWith('---')) {
      beforeLines.push([oldLine, line.slice(1)]);
      oldLine += 1;
    } else if (line.startsWith(' ')) {
      const text = line.slice(1);
      beforeLines.push([oldLine, text]);
      afterLines.push([newLine, text]);
      oldLine += 1;
      newLine += 1;
    }
  }

  const buildPadded = (entries: Array<[number, string]>) => {
    if (entries.length === 0) return '';
    const maxLine = entries.reduce((m, [n]) => Math.max(m, n), 0);
    const arr = Array.from<string>({ length: maxLine }).fill('');
    entries.forEach(([n, text]) => {
      arr[n - 1] = text;
    });
    return arr.join('\n');
  };

  return { before: buildPadded(beforeLines), after: buildPadded(afterLines) };
}

function buildDiffHtmlFromCode(
  before: string,
  after: string,
  diff: string,
  lang: string,
  theme: string,
  mode: 'none' | 'single' | 'double',
) {
  return getHighlighter(theme).then(async (highlighter) => {
    const resolvedLang = await resolveLanguage(highlighter, lang);

    let effectiveBefore = before;
    let effectiveAfter = after;
    if (!before.trim() && diff.trim()) {
      const reconstructed = reconstructSourcesFromDiff(diff);
      effectiveBefore = reconstructed.before;
      effectiveAfter = reconstructed.after;
    }

    const { maxOld, maxNew } = diffMaxLines(diff);
    const trimmedBefore =
      maxOld > 0 ? effectiveBefore.split('\n').slice(0, maxOld).join('\n') : effectiveBefore;
    const trimmedAfter =
      maxNew > 0 ? effectiveAfter.split('\n').slice(0, maxNew).join('\n') : effectiveAfter;

    const beforeHtml = safeCodeToHtml(highlighter, trimmedBefore, resolvedLang, theme);
    const afterHtml = safeCodeToHtml(highlighter, trimmedAfter, resolvedLang, theme);
    const beforeLines = extractShikiLines(beforeHtml);
    const afterLines = extractShikiLines(afterHtml);
    const diffLines = diff.split('\n');
    let oldLine = 0;
    let newLine = 0;
    let inHunk = false;
    const output: DiffRow[] = [];
    diffLines.forEach((line) => {
      if (line.startsWith('@@')) {
        const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
        if (match) {
          oldLine = Number(match[1]);
          newLine = Number(match[2]);
        }
        inHunk = true;
        output.push({
          html: `<span class="line">${escapeHtml(line)}</span>`,
          rowClass: 'line-hunk',
        });
        return;
      }
      if (isDiffMetadataLine(line) || line.startsWith('\\')) {
        inHunk = false;
        output.push({
          html: `<span class="line">${escapeHtml(line)}</span>`,
          rowClass: 'line-header',
        });
        return;
      }
      if (!inHunk) {
        output.push({
          html: `<span class="line">${escapeHtml(line)}</span>`,
          rowClass: 'line-header',
        });
        return;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const htmlLine =
          afterLines[newLine - 1] ?? `<span class="line">${escapeHtml(line.slice(1))}</span>`;
        output.push({ html: htmlLine, rowClass: 'line-added' });
        newLine += 1;
        return;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        const htmlLine =
          beforeLines[oldLine - 1] ?? `<span class="line">${escapeHtml(line.slice(1))}</span>`;
        output.push({ html: htmlLine, rowClass: 'line-removed' });
        oldLine += 1;
        return;
      }
      if (!line.startsWith(' ')) {
        output.push({
          html: `<span class="line">${escapeHtml(line)}</span>`,
          rowClass: 'line-header',
        });
        return;
      }
      const htmlLine =
        beforeLines[oldLine - 1] ??
        `<span class="line">${escapeHtml(line.replace(/^ /, ''))}</span>`;
      output.push({ html: htmlLine });
      oldLine += 1;
      newLine += 1;
    });
    const { oldValues, newValues } = buildDiffGutterLines(diff);
    const rows = wrapDiffRows(output, oldValues, newValues, mode);
    return buildHtmlFromRows(rows);
  });
}

async function renderCodeHtml(request: RenderRequest) {
  const highlighter = await getHighlighter(request.theme);
  const resolvedLang = await resolveLanguage(highlighter, request.lang);
  const html = safeCodeToHtml(highlighter, request.code, resolvedLang, request.theme);
  let lines = extractShikiLines(html);
  const mode = request.gutterMode ?? 'single';
  let gutterLines = request.gutterLines;

  const hasRange =
    (typeof request.lineOffset === 'number' && request.lineOffset > 0) ||
    typeof request.lineLimit === 'number';
  if (hasRange) {
    const offset = typeof request.lineOffset === 'number' ? Math.max(0, request.lineOffset) : 0;
    const limit =
      typeof request.lineLimit === 'number' && request.lineLimit > 0
        ? request.lineLimit
        : lines.length;
    lines = lines.slice(offset, offset + limit);
    if (gutterLines) gutterLines = gutterLines.slice(offset, offset + limit);

    if (!gutterLines) {
      const generatedGutter = lines.map((_, i) => String(offset + i + 1));
      return buildHtmlFromRows(buildCodeRows(lines, mode, generatedGutter));
    }
  }

  return buildHtmlFromRows(buildCodeRows(lines, mode, gutterLines));
}

let cachedMd: MarkdownIt | null = null;
let cachedMdTheme = '';
let cachedMdHighlighter: Highlighter | null = null;
let cachedMdShikiOptions: MarkdownShikiOptions | null = null;

function parseFenceLanguage(info: string) {
  const raw = info.trim().split(/\s+/, 1)[0] ?? '';
  if (!raw || raw.startsWith('{')) return null;

  let normalized = raw;
  if (normalized.startsWith('.')) normalized = normalized.slice(1);
  if (normalized.startsWith('language-')) normalized = normalized.slice('language-'.length);
  if (!normalized) return null;

  return { raw, normalized };
}

function collectMarkdownFenceLanguages(markdown: string) {
  const langs = new Map<string, string>();
  let fenceChar = '';
  let fenceLength = 0;

  for (const line of markdown.split('\n')) {
    const match = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
    if (!match) continue;
    const marker = match[1];
    const info = match[2] ?? '';

    if (!fenceChar) {
      fenceChar = marker[0] ?? '';
      fenceLength = marker.length;
      const parsed = parseFenceLanguage(info);
      if (parsed) langs.set(parsed.raw, parsed.normalized);
      continue;
    }

    const isClosing = marker[0] === fenceChar && marker.length >= fenceLength && !info.trim();
    if (isClosing) {
      fenceChar = '';
      fenceLength = 0;
    }
  }

  return langs;
}

async function resolveMarkdownLangAliases(highlighter: Highlighter, markdown: string) {
  const aliases: Record<string, string> = {};
  const langs = collectMarkdownFenceLanguages(markdown);

  for (const [raw, normalized] of langs.entries()) {
    const resolved = await resolveLanguage(highlighter, normalized);
    aliases[raw] = resolved;
    aliases[normalized] = resolved;
    aliases[normalized.toLowerCase()] = resolved;
  }

  return aliases;
}

/**
 * Tiny markdown-it plugin that replaces task list markers ([ ] / [x]) with emoji.
 */
function taskListEmojiPlugin(md: MarkdownIt) {
  md.core.ruler.after('inline', 'task-list-emoji', (state) => {
    const tokens = state.tokens;
    for (let i = 2; i < tokens.length; i++) {
      const tok = tokens[i];
      if (
        tok.type !== 'inline' ||
        tokens[i - 1].type !== 'paragraph_open' ||
        tokens[i - 2].type !== 'list_item_open'
      )
        continue;

      let emoji: string | null = null;
      if (tok.content.startsWith('[ ] ')) emoji = '\u2B1C ';
      else if (tok.content.startsWith('[x] ') || tok.content.startsWith('[X] ')) emoji = '\u2705 ';
      if (!emoji) continue;

      tok.content = emoji + tok.content.slice(4);
      const first = tok.children?.[0];
      if (first) first.content = emoji + first.content.slice(4);
    }
  });
}


function getMarkdownIt(highlighter: Highlighter, theme: string) {
  if (
    !cachedMd ||
    !cachedMdShikiOptions ||
    cachedMdTheme !== theme ||
    cachedMdHighlighter !== highlighter
  ) {
    cachedMdTheme = theme;
    cachedMdHighlighter = highlighter;
    const shikiOptions: MarkdownShikiOptions = {
      themes: {
        light: theme,
        dark: theme,
      },
      transformers: [transformerNotationDiff()],
      langAlias: {},
    };
    cachedMdShikiOptions = shikiOptions;
    cachedMd = new MarkdownIt({ html: false, linkify: false, breaks: true });
    cachedMd.use(fromHighlighter(highlighter, shikiOptions));
    cachedMd.use(taskListEmojiPlugin);
    const defaultLinkOpen =
      cachedMd.renderer.rules.link_open ??
      function (tokens, idx, options, _env, self) {
        return self.renderToken(tokens, idx, options);
      };

    cachedMd.renderer.rules.link_open = function (tokens, idx, options, _env, self) {
      tokens[idx].attrSet('target', '_blank');
      tokens[idx].attrSet('rel', 'noopener noreferrer');
      return defaultLinkOpen(tokens, idx, options, _env, self);
    };



    const defaultCodeInline =
      cachedMd.renderer.rules.code_inline ??
      function (tokens, idx, options, _env, self) {
        return self.renderToken(tokens, idx, options);
      };

    cachedMd.renderer.rules.code_inline = function (tokens, idx, options, env, self) {
      const fileSet = (env as MarkdownRenderEnv | undefined)?.fileSet;
      const token = tokens[idx];
      const ref = token.content?.trim() ?? '';
      const parsed = fileSet && ref ? parseInlineFileRef(ref, fileSet) : null;
      if (parsed) {
        token.attrSet('data-file-ref', parsed.path);
        if (parsed.lines) token.attrSet('data-file-lines', parsed.lines);
        token.attrJoin('class', 'file-ref');
      } else if (/^[0-9a-f]{7,40}$/i.test(ref)) {
        token.attrSet('data-commit-ref', ref);
        token.attrJoin('class', 'commit-ref');
      } else if (isInlineColorRef(ref)) {
        token.attrJoin('class', 'color-ref');
        const existingStyle = token.attrGet('style');
        token.attrSet(
          'style',
          existingStyle ? `${existingStyle}; --preview-color: ${ref}` : `--preview-color: ${ref}`,
        );
      }
      return defaultCodeInline(tokens, idx, options, env, self);
    };

    const shikiHighlight = cachedMd.options.highlight;
    cachedMd.options.highlight = function (code, lang, attrs) {
      const cacheKey = `${lang}\0${code}`;
      const cached = mdHighlightCache.get(cacheKey);
      if (cached !== undefined) return cached;
      let result: string;
      try {
        result = shikiHighlight?.call(this, code, lang, attrs) ?? '';
      } catch {
        result = safeCodeToHtml(highlighter, code, lang || 'text', theme);
      }
      mdHighlightCache.set(cacheKey, result);
      pruneHighlightCache(mdHighlightCache);
      return result;
    };
  }
  if (!cachedMd || !cachedMdShikiOptions) {
    throw new Error('failed to initialize markdown renderer');
  }
  return { md: cachedMd, shikiOptions: cachedMdShikiOptions };
}

async function renderMarkdownHtml(request: RenderRequest): Promise<string> {
  const highlighter = await getHighlighter(request.theme);
  const { md, shikiOptions } = getMarkdownIt(highlighter, request.theme);
  shikiOptions.langAlias = await resolveMarkdownLangAliases(highlighter, request.code);
  const env: MarkdownRenderEnv = {};
  if (request.files?.length) env.fileSet = new Set(request.files);
  const rendered = md.render(request.code, env);

  // Use localized strings or defaults
  const copyButtonLabel = request.copyButtonLabel ?? 'COPY';
  const copiedLabel = request.copiedLabel ?? '✓ Copied';
  const copyCodeAriaLabel = request.copyCodeAriaLabel ?? 'Copy code';
  const copyMarkdownAriaLabel = request.copyMarkdownAriaLabel ?? 'Copy markdown';

  // Wrap code blocks with copy buttons using localized strings
  const wrappedRendered = rendered.replace(
    /<pre class="shiki"/g,
    `<div class="md-code-block"><pre class="shiki"`,
  );
  const withCodeButtons = wrappedRendered.replace(
    /<\/pre>(?![\s\S]*<\/pre>)/g,
    `</pre><button class="md-copy-btn" type="button" aria-label="${escapeHtml(copyCodeAriaLabel)}">${escapeHtml(copyButtonLabel)}</button><div class="md-copied-indicator" aria-hidden="true">${escapeHtml(copiedLabel)}</div></div>`,
  );

  return `<div class="markdown-host"><template class="md-raw-source">${escapeHtml(request.code)}</template><button class="md-copy-btn md-copy-btn-host" type="button" aria-label="${escapeHtml(copyMarkdownAriaLabel)}">${escapeHtml(copyButtonLabel)}</button><div class="md-copied-indicator md-copied-indicator-host" aria-hidden="true">${escapeHtml(copiedLabel)}</div>${withCodeButtons}</div>`;
}

function renderRequest(request: RenderRequest): Promise<string> {
  if (request.patch) {
    const compactPatch = request.after === undefined ? compactUnifiedDiffPatch(request.patch) : request.patch;
    const after = request.after ?? applyPatchToCode(request.code, compactPatch);
    return buildDiffHtmlFromCode(
      request.code,
      after,
      compactPatch,
      request.lang,
      request.theme,
      request.gutterMode ?? 'double',
    );
  }

  // before/after without patch — generate unified diff from the two texts
  if (request.after !== undefined) {
    const patch = generateUnifiedDiff(request.code, request.after);
    if (patch) {
      return buildDiffHtmlFromCode(
        request.code,
        request.after,
        patch,
        request.lang,
        request.theme,
        request.gutterMode ?? 'double',
      );
    }
  }

  if (request.grepPattern !== undefined) {
    const mode = request.gutterMode ?? 'single';
    const rows = renderGrepRows(request.code, mode, request.gutterLines, request.grepPattern);
    return Promise.resolve(buildHtmlFromRows(rows));
  }

  // Markdown rendering for messages (gutterMode: 'none' only)
  const resolvedLang = languageCandidates(request.lang)[0] ?? 'text';
  if ((resolvedLang === 'markdown' || resolvedLang === 'md') && request.gutterMode === 'none') {
    return renderMarkdownHtml(request);
  }

  return renderCodeHtml(request);
}

self.onmessage = (event: MessageEvent<RenderRequest>) => {
  const request = event.data;
  renderRequest(request)
    .then((html) => {
      const response: RenderResponse = { id: request.id, ok: true, html };
      self.postMessage(response);
    })
    .catch((error) => {
      const response: RenderResponse = {
        id: request.id,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      };
      self.postMessage(response);
    });
};
