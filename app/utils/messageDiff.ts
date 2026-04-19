import type { MessageDiffEntry } from '../types/message';

export type MessageDiffViewerEntry = {
  file: string;
  before?: string;
  after?: string;
  patch?: string;
};

export function hasCompleteBeforeAfter(diff: MessageDiffEntry): boolean {
  return typeof diff.before === 'string' && typeof diff.after === 'string';
}

export function reconstructSourcesFromDiff(diff: string): { before: string; after: string } {
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

    if (
      line.startsWith('diff --git') ||
      line.startsWith('index ') ||
      line.startsWith('---') ||
      line.startsWith('+++') ||
      line.startsWith('new file mode') ||
      line.startsWith('deleted file mode') ||
      line.startsWith('similarity index') ||
      line.startsWith('rename from ') ||
      line.startsWith('rename to ') ||
      line.startsWith('Binary files ') ||
      line.startsWith('GIT binary patch') ||
      line.startsWith('\\')
    ) {
      inHunk = false;
      continue;
    }

    if (!inHunk) continue;

    if (line.startsWith('+') && !line.startsWith('+++')) {
      afterLines.push([newLine, line.slice(1)]);
      newLine += 1;
      continue;
    }

    if (line.startsWith('-') && !line.startsWith('---')) {
      beforeLines.push([oldLine, line.slice(1)]);
      oldLine += 1;
      continue;
    }

    if (line.startsWith(' ')) {
      const text = line.slice(1);
      beforeLines.push([oldLine, text]);
      afterLines.push([newLine, text]);
      oldLine += 1;
      newLine += 1;
    }
  }

  const buildPadded = (entries: Array<[number, string]>) => {
    if (entries.length === 0) return '';
    const maxLine = entries.reduce((currentMax, [lineNumber]) => Math.max(currentMax, lineNumber), 0);
    const lines = Array.from<string>({ length: maxLine }).fill('');
    entries.forEach(([lineNumber, text]) => {
      lines[lineNumber - 1] = text;
    });
    return lines.join('\n');
  };

  return {
    before: buildPadded(beforeLines),
    after: buildPadded(afterLines),
  };
}

export function toMessageDiffViewerEntry(diff: MessageDiffEntry): MessageDiffViewerEntry {
  if (!hasCompleteBeforeAfter(diff) && diff.diff.trim()) {
    const reconstructed = reconstructSourcesFromDiff(diff.diff);
    return {
      file: diff.file,
      before: reconstructed.before,
      after: reconstructed.after,
      patch: undefined,
    };
  }

  return {
    file: diff.file,
    before: diff.before,
    after: diff.after,
    patch: hasCompleteBeforeAfter(diff) ? undefined : diff.diff || undefined,
  };
}
