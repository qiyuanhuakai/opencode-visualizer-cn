/**
 * Shared unified-diff parsing primitives used by both the main thread
 * (messageDiff) and the render worker. Centralizes the metadata-line
 * classification, hunk-header parsing, and full-source reconstruction so
 * the main/worker implementations cannot drift apart.
 *
 * The metadata prefix set is the union of every prefix the historical
 * implementations handled:
 *  - messageDiff.ts: `diff --git`, `index `, `---`, `+++`, `new file mode`,
 *    `deleted file mode`, `similarity index`, `rename from `, `rename to `,
 *    `Binary files `, `GIT binary patch`, `\`
 *  - render-worker.ts / diffCompression.ts: `diff `, `index `, `Index: `,
 *    `===`, `---`, `+++`, `***`
 *
 * The `\` no-newline marker is intentionally NOT part of the classifier:
 * diffCompression treats it as a hunk-local marker that must survive
 * compaction. Consumers that want it to end a hunk check it explicitly.
 */
const DIFF_METADATA_PREFIXES = [
  'diff ',
  'index ',
  'Index: ',
  '===',
  '---',
  '+++',
  '***',
  'new file mode',
  'deleted file mode',
  'similarity index',
  'rename from ',
  'rename to ',
  'Binary files ',
  'GIT binary patch',
] as const;

export function isDiffMetadataLine(line: string): boolean {
  return DIFF_METADATA_PREFIXES.some((prefix) => line.startsWith(prefix));
}

export type ParsedHunkHeader = {
  oldStart: number;
  oldCount?: number;
  newStart: number;
  newCount?: number;
};

const HUNK_HEADER_RE = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/;

export function parseHunkHeader(line: string): ParsedHunkHeader | null {
  const match = HUNK_HEADER_RE.exec(line);
  if (!match) return null;
  return {
    oldStart: Number(match[1]),
    oldCount: match[2] === undefined ? undefined : Number(match[2]),
    newStart: Number(match[3]),
    newCount: match[4] === undefined ? undefined : Number(match[4]),
  };
}

export type DiffLineKind =
  | 'hunk'
  | 'metadata'
  | 'outside'
  | 'added'
  | 'removed'
  | 'context'
  | 'other';

export type DiffLineEvent = {
  kind: DiffLineKind;
  line: string;
  text: string;
  oldLine: number;
  newLine: number;
};

function contentLineKind(line: string): 'added' | 'removed' | 'context' | 'other' {
  if (line.startsWith('+') && !line.startsWith('+++')) return 'added';
  if (line.startsWith('-') && !line.startsWith('---')) return 'removed';
  if (line.startsWith(' ')) return 'context';
  return 'other';
}

function contentText(line: string, kind: 'added' | 'removed' | 'context' | 'other') {
  return kind === 'other' ? line : line.slice(1);
}

function nextCounters(kind: DiffLineKind, oldLine: number, newLine: number) {
  if (kind === 'added') return { oldLine, newLine: newLine + 1 };
  if (kind === 'removed') return { oldLine: oldLine + 1, newLine };
  if (kind === 'context') return { oldLine: oldLine + 1, newLine: newLine + 1 };
  return { oldLine, newLine };
}

/**
 * Walk a unified diff line by line, classifying each line and tracking the
 * old/new line counters. Consumers receive one event per line with the
 * counters as they were before the line was consumed, so they can index
 * reconstructed sources or build gutters without re-implementing the
 * hunk/metadata state machine.
 */
export function walkDiffLines(diff: string, onLine: (event: DiffLineEvent) => void): void {
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;

  for (const line of diff.split('\n')) {
    if (line.startsWith('@@')) {
      const header = parseHunkHeader(line);
      oldLine = header?.oldStart ?? oldLine;
      newLine = header?.newStart ?? newLine;
      inHunk = true;
      onLine({ kind: 'hunk', line, text: line, oldLine, newLine });
      continue;
    }

    if (isDiffMetadataLine(line) || line.startsWith('\\')) {
      inHunk = false;
      onLine({ kind: 'metadata', line, text: line, oldLine, newLine });
      continue;
    }

    if (!inHunk) {
      onLine({ kind: 'outside', line, text: line, oldLine, newLine });
      continue;
    }

    const kind = contentLineKind(line);
    onLine({ kind, line, text: contentText(line, kind), oldLine, newLine });
    const next = nextCounters(kind, oldLine, newLine);
    oldLine = next.oldLine;
    newLine = next.newLine;
  }
}

function buildPadded(entries: Array<[number, string]>) {
  if (entries.length === 0) return '';
  const maxLine = entries.reduce((currentMax, [lineNumber]) => Math.max(currentMax, lineNumber), 0);
  const lines = Array.from<string>({ length: maxLine }).fill('');
  entries.forEach(([lineNumber, text]) => {
    lines[lineNumber - 1] = text;
  });
  return lines.join('\n');
}

export function reconstructSourcesFromDiff(diff: string): { before: string; after: string } {
  const beforeLines: Array<[number, string]> = [];
  const afterLines: Array<[number, string]> = [];

  walkDiffLines(diff, ({ kind, text, oldLine, newLine }) => {
    if (kind === 'added') {
      afterLines.push([newLine, text]);
    } else if (kind === 'removed') {
      beforeLines.push([oldLine, text]);
    } else if (kind === 'context') {
      beforeLines.push([oldLine, text]);
      afterLines.push([newLine, text]);
    }
  });

  return {
    before: buildPadded(beforeLines),
    after: buildPadded(afterLines),
  };
}
