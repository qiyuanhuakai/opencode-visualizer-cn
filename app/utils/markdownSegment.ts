export type SegmentResult = {
  readonly stable: string[];
  readonly tail: string;
  readonly disabled: boolean;
  readonly reset: boolean;
};

type Candidate = {
  readonly offset: number;
  readonly predecessor: string;
};

type Segmenter = {
  push: (text: string) => SegmentResult;
};

const REFERENCE_DEFINITION = /^ {0,3}\[[^\]\n]+\]:\s*\S/;
const LIST_ITEM = /^ {0,3}([-*+]|\d{1,9}[.)])\s/;
const HTML_BLOCK = /^ {0,3}</;
const TABLE_DELIMITER = /^[|:\-\s]+$/;

function lineContent(text: string, end: number): string {
  return text.slice(0, end).replace(/\r$/, '');
}

function firstNonBlankLine(text: string, offset: number): string | undefined {
  let start = offset;
  while (start < text.length) {
    const newline = text.indexOf('\n', start);
    const end = newline < 0 ? text.length : newline;
    const line = lineContent(text.slice(start), end - start);
    if (line.trim() !== '') return line;
    if (newline < 0) return undefined;
    start = newline + 1;
  }
  return undefined;
}

function candidateIsSafe(text: string, candidate: Candidate): boolean {
  if (LIST_ITEM.test(candidate.predecessor) || HTML_BLOCK.test(candidate.predecessor)) return false;
  const successor = firstNonBlankLine(text, candidate.offset);
  if (successor === undefined || /^\s/.test(successor) || LIST_ITEM.test(successor)) return false;
  return !(successor.includes('|') && successor.includes('-') && TABLE_DELIMITER.test(successor));
}

export function createMarkdownSegmenter(): Segmenter {
  let previousText = '';
  let stableEnd = 0;
  let scanOffset = 0;
  let fenceChar = '';
  let fenceLength = 0;
  let lastNonBlank = '';
  let disabled = false;
  let candidates: Candidate[] = [];

  function resetScan(): void {
    stableEnd = 0;
    scanOffset = 0;
    fenceChar = '';
    fenceLength = 0;
    lastNonBlank = '';
    disabled = false;
    candidates = [];
  }

  function scan(text: string): void {
    let start = scanOffset;
    while (start < text.length) {
      const newline = text.indexOf('\n', start);
      if (newline < 0) break;
      const line = lineContent(text.slice(start), newline - start);
      // `[key]: value` inside a fence is literal text, not a reference definition.
      if (fenceChar === '' && REFERENCE_DEFINITION.test(line)) disabled = true;
      const fence = /^(?: {0,3})(`{3,}|~{3,})(.*)$/.exec(line);
      if (fence) {
        const marker = fence[1] ?? '';
        const info = fence[2] ?? '';
        if (fenceChar === '') {
          fenceChar = marker[0] ?? '';
          fenceLength = marker.length;
        } else if (
          marker[0] === fenceChar &&
          marker.length >= fenceLength &&
          /^\s*$/.test(info)
        ) {
          fenceChar = '';
          fenceLength = 0;
        }
      } else if (line.trim() === '' && fenceChar === '') {
        candidates.push({ offset: newline + 1, predecessor: lastNonBlank });
      }
      if (line.trim() !== '') lastNonBlank = line;
      start = newline + 1;
    }
    scanOffset = start;
    if (fenceChar === '' && REFERENCE_DEFINITION.test(text.slice(scanOffset))) disabled = true;
  }

  function push(text: string): SegmentResult {
    const reset = !text.startsWith(previousText);
    if (reset) resetScan();
    previousText = text;

    if (disabled) {
      return { stable: [], tail: text, disabled: true, reset };
    }

    scan(text);
    if (disabled) return { stable: [], tail: text, disabled: true, reset };

    const safe = candidates.filter((candidate) => candidateIsSafe(text, candidate));
    const split = safe.at(-1)?.offset ?? stableEnd;
    if (split <= stableEnd) {
      const stable = stableEnd > 0 ? [text.slice(0, stableEnd)] : [];
      return { stable, tail: text.slice(stableEnd), disabled: false, reset };
    }

    const stable = [text.slice(0, split)];
    stableEnd = split;
    candidates = candidates.filter((candidate) => candidate.offset > stableEnd);
    return { stable, tail: text.slice(stableEnd), disabled: false, reset };
  }

  return { push };
}
