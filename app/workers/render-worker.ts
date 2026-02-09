import { bundledLanguages, createHighlighter } from 'shiki/bundle/web';

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
};

type RenderResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

type DiffRow = {
  html: string;
  rowClass?: string;
};

let highlighterPromise: Promise<Awaited<ReturnType<typeof createHighlighter>>> | null = null;
let cachedTheme = '';
let loadedLanguageCache = new Set<string>(['text']);
let failedLanguageCache = new Set<string>();

function getHighlighter(theme: string) {
  if (!highlighterPromise || cachedTheme !== theme) {
    cachedTheme = theme;
    highlighterPromise = createHighlighter({ themes: [theme], langs: ['text'] });
    loadedLanguageCache = new Set(['text']);
    failedLanguageCache = new Set();
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

async function resolveLanguage(highlighter: Awaited<ReturnType<typeof createHighlighter>>, lang: string) {
  const loaded =
    typeof highlighter.getLoadedLanguages === 'function' ? highlighter.getLoadedLanguages() : [];
  loaded.forEach((item) => loadedLanguageCache.add(item));
  for (const candidate of languageCandidates(lang)) {
    if (loadedLanguageCache.has(candidate)) return candidate;
    if (candidate === 'text') return 'text';
    const loadedCandidate = await tryLoadLanguage(highlighter, candidate);
    if (loadedCandidate) return candidate;
  }
  return 'text';
}

type LanguageLoader = () => Promise<{ default: unknown }>;

async function tryLoadLanguage(
  highlighter: Awaited<ReturnType<typeof createHighlighter>>,
  candidate: string,
) {
  if (failedLanguageCache.has(candidate)) return false;
  if (typeof highlighter.loadLanguage !== 'function') return false;

  const loader = (bundledLanguages as Record<string, unknown>)[candidate];
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

function buildCodeRows(lines: string[], mode: 'none' | 'single' | 'double', gutterLines?: string[]) {
  return lines
    .map((line, index) => {
      if (mode === 'none') {
        return `<span class="code-row">${line}</span>`;
      }
      if (mode === 'double') {
        const pair = gutterLines?.[index]?.split('\t') ?? [];
        const left = pair[0] ?? String(index + 1);
        const right = pair[1] ?? '';
        return `<span class="code-row"><span class="code-gutter">${escapeHtml(left)}</span><span class="code-gutter">${escapeHtml(right)}</span>${line}</span>`;
      }
      const gutter = gutterLines?.[index] ?? String(index + 1);
      return `<span class="code-row file-row"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${line}</span>`;
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

  type Snake = { prevK: number; prevD: number; x: number; y: number };
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
  interface Edit { type: ' ' | '+' | '-'; text: string }
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
  type Hunk = { oldStart: number; oldCount: number; newStart: number; newCount: number; lines: string[] };
  const hunks: Hunk[] = [];
  let oldLine = 1;
  let newLine = 1;

  // Find change regions
  const changeIndices: number[] = [];
  edits.forEach((e, i) => {
    if (e.type !== ' ') changeIndices.push(i);
  });

  if (changeIndices.length === 0) return '';

  // Merge nearby changes into hunks
  let hunkStart = 0;
  let hunkEnd = 0;
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
      if (mode === 'none') return `<span class="${rowClass.trim()}">${row.html}</span>`;
      if (mode === 'single') {
        const left = oldValues[index] ?? '';
        const right = newValues[index] ?? '';
        const gutter = right || left;
        return `<span class="${rowClass.trim()}"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${row.html}</span>`;
      }
      const oldValue = oldValues[index] ?? '';
      const newValue = newValues[index] ?? '';
      return `<span class="${rowClass.trim()}"><span class="code-gutter">${escapeHtml(oldValue)}</span><span class="code-gutter">${escapeHtml(newValue)}</span>${row.html}</span>`;
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
      if (mode === 'none') return `<span class="code-row">${content}</span>`;
      if (mode === 'double') {
        const pair = gutterLines?.[index]?.split('\t') ?? [];
        const left = pair[0] ?? '';
        const right = pair[1] ?? '';
        return `<span class="code-row"><span class="code-gutter">${escapeHtml(left)}</span><span class="code-gutter">${escapeHtml(right)}</span>${content}</span>`;
      }
      const gutter = gutterLines?.[index] ?? String(index + 1);
      return `<span class="code-row"><span class="code-gutter span-2">${escapeHtml(gutter)}</span>${content}</span>`;
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

    const { maxOld, maxNew } = diffMaxLines(diff);
    const trimmedBefore =
      maxOld > 0 ? before.split('\n').slice(0, maxOld).join('\n') : before;
    const trimmedAfter =
      maxNew > 0 ? after.split('\n').slice(0, maxNew).join('\n') : after;

    const beforeHtml = highlighter.codeToHtml(trimmedBefore, { lang: resolvedLang, theme });
    const afterHtml = highlighter.codeToHtml(trimmedAfter, { lang: resolvedLang, theme });
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
        output.push({ html: `<span class="line">${escapeHtml(line)}</span>`, rowClass: 'line-hunk' });
        return;
      }
      if (isDiffMetadataLine(line) || line.startsWith('\\')) {
        inHunk = false;
        output.push({ html: `<span class="line">${escapeHtml(line)}</span>`, rowClass: 'line-header' });
        return;
      }
      if (!inHunk) {
        output.push({ html: `<span class="line">${escapeHtml(line)}</span>`, rowClass: 'line-header' });
        return;
      }
      if (line.startsWith('+') && !line.startsWith('+++')) {
        const htmlLine = afterLines[newLine - 1] ?? `<span class="line">${escapeHtml(line.slice(1))}</span>`;
        output.push({ html: htmlLine, rowClass: 'line-added' });
        newLine += 1;
        return;
      }
      if (line.startsWith('-') && !line.startsWith('---')) {
        const htmlLine = beforeLines[oldLine - 1] ?? `<span class="line">${escapeHtml(line.slice(1))}</span>`;
        output.push({ html: htmlLine, rowClass: 'line-removed' });
        oldLine += 1;
        return;
      }
      if (!line.startsWith(' ')) {
        output.push({ html: `<span class="line">${escapeHtml(line)}</span>`, rowClass: 'line-header' });
        return;
      }
      const htmlLine = beforeLines[oldLine - 1] ?? `<span class="line">${escapeHtml(line.replace(/^ /, ''))}</span>`;
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
  const html = highlighter.codeToHtml(request.code, { lang: resolvedLang, theme: request.theme });
  const lines = extractShikiLines(html);
  const mode = request.gutterMode ?? 'single';
  return buildHtmlFromRows(buildCodeRows(lines, mode, request.gutterLines));
}

function renderRequest(request: RenderRequest): Promise<string> {
  if (request.patch) {
    const after = request.after ?? applyPatchToCode(request.code, request.patch);
    return buildDiffHtmlFromCode(
      request.code,
      after,
      request.patch,
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
