import { createHighlighter } from 'shiki/bundle/web';

type RenderRequest = {
  id: string;
  code: string;
  patch?: string;
  after?: string;
  lang: string;
  theme: string;
};

type RenderResponse =
  | { id: string; ok: true; html: string }
  | { id: string; ok: false; error: string };

let highlighterPromise: Promise<Awaited<ReturnType<typeof createHighlighter>>> | null = null;
let cachedTheme = '';

function getHighlighter(theme: string) {
  if (!highlighterPromise || cachedTheme !== theme) {
    cachedTheme = theme;
    highlighterPromise = createHighlighter({ themes: [theme], langs: ['text'] });
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
  for (const candidate of languageCandidates(lang)) {
    if (loaded.includes(candidate)) return candidate;
    if (typeof highlighter.loadLanguage === 'function') {
      try {
        await highlighter.loadLanguage(candidate as never);
        return candidate;
      } catch {
        continue;
      }
    }
  }
  return 'text';
}

function escapeHtml(value: string) {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
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
    let oldLine = Number(match[1]);
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

function buildDiffGutterLines(source: string) {
  const lines = source.split('\n');
  let oldLine = 0;
  let newLine = 0;
  const oldValues: Array<string> = [];
  const newValues: Array<string> = [];

  lines.forEach((line) => {
    if (line.startsWith('@@')) {
      const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      oldValues.push('');
      newValues.push('');
      return;
    }
    if (
      line.startsWith('diff ') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('***')
    ) {
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
    if (oldLine === 0 && newLine === 0) {
      oldValues.push('');
      newValues.push('');
      return;
    }
    oldValues.push(String(oldLine));
    newValues.push(String(newLine));
    oldLine += 1;
    newLine += 1;
  });

  return { oldValues, newValues };
}

type DiffRow = {
  html: string;
  rowClass?: string;
};

function wrapDiffRows(lines: DiffRow[], oldValues: string[], newValues: string[]) {
  return lines
    .map((row, index) => {
      const oldValue = oldValues[index] ?? '';
      const newValue = newValues[index] ?? '';
      const rowClass = row.rowClass ? ` code-row ${row.rowClass}` : ' code-row';
      return `<span class="${rowClass.trim()}"><span class="code-gutter">${escapeHtml(oldValue)}</span><span class="code-gutter">${escapeHtml(newValue)}</span>${row.html}</span>`;
    })
    .join('\n');
}

function buildDiffHtmlFromCode(before: string, after: string, diff: string, lang: string, theme: string) {
  return getHighlighter(theme).then(async (highlighter) => {
    const resolvedLang = await resolveLanguage(highlighter, lang);
    const beforeHtml = highlighter.codeToHtml(before, { lang: resolvedLang, theme });
    const afterHtml = highlighter.codeToHtml(after, { lang: resolvedLang, theme });
    const beforeLines = extractShikiLines(beforeHtml);
    const afterLines = extractShikiLines(afterHtml);
    const diffLines = diff.split('\n');
    let oldLine = 0;
    let newLine = 0;
    const output: DiffRow[] = [];
    diffLines.forEach((line) => {
      if (line.startsWith('@@')) {
        const match = /@@\s+-(\d+)(?:,\d+)?\s+\+(\d+)(?:,\d+)?\s+@@/.exec(line);
        if (match) {
          oldLine = Number(match[1]);
          newLine = Number(match[2]);
        }
        output.push({ html: `<span class="line">${escapeHtml(line)}</span>`, rowClass: 'line-hunk' });
        return;
      }
      if (
        line.startsWith('diff ') ||
        line.startsWith('index ') ||
        line.startsWith('---') ||
        line.startsWith('+++') ||
        line.startsWith('***')
      ) {
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
      const htmlLine = beforeLines[oldLine - 1] ?? `<span class="line">${escapeHtml(line.replace(/^ /, ''))}</span>`;
      output.push({ html: htmlLine });
      oldLine += 1;
      newLine += 1;
    });
    const { oldValues, newValues } = buildDiffGutterLines(diff);
    const rows = wrapDiffRows(output, oldValues, newValues);
    return `<div class="code-host"><pre class="shiki"><code>${rows}</code></pre></div>`;
  });
}

function renderRequest(request: RenderRequest): Promise<string> {
  if (!request.patch) {
    return getHighlighter(request.theme).then(async (highlighter) => {
      const resolvedLang = await resolveLanguage(highlighter, request.lang);
      const html = highlighter.codeToHtml(request.code, { lang: resolvedLang, theme: request.theme });
      const lines = extractShikiLines(html);
      const rows = lines
        .map((line, index) => {
          const lineNumber = String(index + 1);
          return `<span class="code-row file-row"><span class="code-gutter span-2">${escapeHtml(lineNumber)}</span>${line}</span>`;
        })
        .join('\n');
      return `<div class="code-host"><pre class="shiki"><code>${rows}</code></pre></div>`;
    });
  }
  const after = request.after ?? applyPatchToCode(request.code, request.patch);
  return buildDiffHtmlFromCode(request.code, after, request.patch, request.lang, request.theme);
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
