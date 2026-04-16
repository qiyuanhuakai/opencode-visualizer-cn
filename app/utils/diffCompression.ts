type ParsedHunk = {
  oldStart: number;
  newStart: number;
  lines: string[];
};

export function compactUnifiedDiffPatch(patch: string, contextLines = 3) {
  const source = patch.trim();
  if (!source) return '';

  const output: string[] = [];
  const lines = source.split('\n').filter((line) => !isDiffMetadataLine(line));
  let index = 0;

  while (index < lines.length) {
    const line = lines[index]!;
    if (!line.startsWith('@@')) {
      output.push(line);
      index += 1;
      continue;
    }

    const parsed = parseHunk(lines, index);
    if (!parsed) {
      output.push(line);
      index += 1;
      continue;
    }

    output.push(...compactHunk(parsed.hunk, contextLines));
    index = parsed.nextIndex;
  }

  return output.join('\n');
}

function parseHunk(lines: string[], startIndex: number): { hunk: ParsedHunk; nextIndex: number } | null {
  const header = lines[startIndex]!;
  const match = /@@\s+-(\d+)(?:,(\d+))?\s+\+(\d+)(?:,(\d+))?\s+@@/.exec(header);
  if (!match) return null;

  const hunkLines: string[] = [];
  let index = startIndex + 1;
  while (index < lines.length) {
    const line = lines[index]!;
    if (line.startsWith('@@') || isDiffMetadataLine(line)) break;
    hunkLines.push(line);
    index += 1;
  }

  return {
    hunk: {
      oldStart: Number(match[1]),
      newStart: Number(match[3]),
      lines: hunkLines,
    },
    nextIndex: index,
  };
}

function compactHunk(hunk: ParsedHunk, contextLines: number) {
  const changeIndices = hunk.lines
    .map((line, index) => (isChangeLine(line) ? index : -1))
    .filter((index) => index >= 0);

  if (changeIndices.length === 0) {
    return [formatHunkHeader(hunk.oldStart, hunk.lines, hunk.newStart, hunk.lines), ...hunk.lines];
  }

  const groups: Array<[number, number]> = [];
  let groupStart = changeIndices[0]!;
  let groupEnd = changeIndices[0]!;

  for (let index = 1; index < changeIndices.length; index += 1) {
    const nextChange = changeIndices[index]!;
    if (nextChange - groupEnd <= contextLines * 2 + 1) {
      groupEnd = nextChange;
    } else {
      groups.push([groupStart, groupEnd]);
      groupStart = nextChange;
      groupEnd = nextChange;
    }
  }
  groups.push([groupStart, groupEnd]);

  const output: string[] = [];
  for (const [start, end] of groups) {
    let sliceStart = Math.max(0, start - contextLines);
    let sliceEnd = Math.min(hunk.lines.length - 1, end + contextLines);

    while (sliceStart > 0 && isNoNewlineMarker(hunk.lines[sliceStart]!)) sliceStart -= 1;
    while (sliceEnd + 1 < hunk.lines.length && isNoNewlineMarker(hunk.lines[sliceEnd + 1]!)) {
      sliceEnd += 1;
    }

    const beforeSlice = hunk.lines.slice(0, sliceStart);
    const slice = hunk.lines.slice(sliceStart, sliceEnd + 1);

    const oldStart = hunk.oldStart + countOldLines(beforeSlice);
    const newStart = hunk.newStart + countNewLines(beforeSlice);

    output.push(formatHunkHeader(oldStart, slice, newStart, slice));
    output.push(...slice);
  }

  return output;
}

function formatHunkHeader(oldStart: number, oldLines: string[], newStart: number, newLines: string[]) {
  return `@@ -${oldStart},${countOldLines(oldLines)} +${newStart},${countNewLines(newLines)} @@`;
}

function countOldLines(lines: string[]) {
  return lines.reduce((count, line) => count + (consumesOldLine(line) ? 1 : 0), 0);
}

function countNewLines(lines: string[]) {
  return lines.reduce((count, line) => count + (consumesNewLine(line) ? 1 : 0), 0);
}

function isChangeLine(line: string) {
  return (line.startsWith('+') && !line.startsWith('+++')) || (line.startsWith('-') && !line.startsWith('---'));
}

function consumesOldLine(line: string) {
  return line.startsWith(' ') || (line.startsWith('-') && !line.startsWith('---'));
}

function consumesNewLine(line: string) {
  return line.startsWith(' ') || (line.startsWith('+') && !line.startsWith('+++'));
}

function isNoNewlineMarker(line: string) {
  return line.startsWith('\\');
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
