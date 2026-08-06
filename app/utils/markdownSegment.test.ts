import { describe, expect, it } from 'vitest';

import { createMarkdownSegmenter } from './markdownSegment';

type SegmentResult = ReturnType<ReturnType<typeof createMarkdownSegmenter>['push']>;

function appendChunks(chunks: readonly string[]): SegmentResult[] {
  const segmenter = createMarkdownSegmenter();
  return chunks.map((chunk) => segmenter.push(chunk));
}

function assertByteExact(text: string, result: SegmentResult): void {
  expect(`${result.stable.join('')}${result.tail}`).toBe(text);
}

function firstResult(chunks: readonly string[]): SegmentResult {
  const result = appendChunks(chunks)[0];
  if (!result) throw new Error('expected one segment result');
  return result;
}

describe('markdownSegmenter', () => {
  it('R1 splits only immediately after a blank line', () => {
    const [result] = appendChunks(['alpha\n\nbeta']);

    expect(result?.stable).toEqual(['alpha\n\n']);
    expect(result?.tail).toBe('beta');
  });

  it('R2 keeps content inside fences together and splits after a valid close', () => {
    const [result] = appendChunks(['before\n\n```ts\nvalue\n```\n\nafter']);

    expect(result?.stable).toEqual(['before\n\n```ts\nvalue\n```\n\n']);
    expect(result?.tail).toBe('after');
  });

  it('R3 rejects list and HTML predecessors', () => {
    const result = appendChunks(['- item\n\nnext', '<div>\n\nnext']);

    expect(result[0]?.stable).toEqual([]);
    expect(result[1]?.stable).toEqual([]);
  });

  it('R4 rejects indented, list, and GFM-table successors', () => {
    const results = appendChunks(['first\n\n next', 'first\n\n- next', 'first\n\n|---|---|']);

    expect(results.every((result) => result.stable.length === 0)).toBe(true);
  });

  it('R5 permanently disables segmentation for reference definitions', () => {
    const [first, second] = appendChunks(['[ref]: https://example.com\n\nbody', '[ref]: https://example.com\n\nbody\n\nmore']);

    expect(first?.disabled).toBe(true);
    expect(second?.disabled).toBe(true);
    expect(second?.stable).toEqual([]);
    expect(second?.tail).toBe('[ref]: https://example.com\n\nbody\n\nmore');
  });

  it('R6 resets and re-segments when the input shrinks or edits', () => {
    const segmenter = createMarkdownSegmenter();
    segmenter.push('old\n\ncontent');

    const result = segmenter.push('new\n\ntext');

    expect(result.reset).toBe(true);
    expect(`${result.stable.join('')}${result.tail}`).toBe('new\n\ntext');
  });

  it('R7 keeps stable output monotonic across prefix extensions', () => {
    const segmenter = createMarkdownSegmenter();
    let previousStableLength = 0;

    for (const text of ['a', 'a\n', 'a\n\nb', 'a\n\nb\n\nc']) {
      const result = segmenter.push(text);
      expect(result.stable.join('').length).toBeGreaterThanOrEqual(previousStableLength);
      previousStableLength = result.stable.join('').length;
    }
  });

  it('R8 chooses the last safe candidate and preserves bytes', () => {
    const result = firstResult(['one\n\ntwo\n\nthree']);

    expect(result?.stable).toEqual(['one\n\ntwo\n\n']);
    assertByteExact('one\n\ntwo\n\nthree', result);
  });

  it('handles CRLF, empty input, and a single line', () => {
    const [empty, single, crlf] = appendChunks(['', 'single', 'first\r\n\r\nsecond']);

    expect(empty).toEqual({ stable: [], tail: '', disabled: false, reset: false });
    expect(single?.tail).toBe('single');
    expect(crlf?.stable).toEqual(['first\r\n\r\n']);
  });

  it('treats repeated identical pushes as no-ops', () => {
    const segmenter = createMarkdownSegmenter();
    const first = segmenter.push('one\n\ntwo');
    const second = segmenter.push('one\n\ntwo');

    expect(second).toEqual(first);
  });

  it('never splits an unclosed fence at any delta', () => {
    const segmenter = createMarkdownSegmenter();
    let text = '```\n';
    let result = segmenter.push(text);

    for (const suffix of ['a\n\n', 'b\n\n', 'c']) {
      text += suffix;
      result = segmenter.push(text);
      expect(result.stable).toEqual([]);
    }
  });

  it('re-enables segmentation when a reset replaces a ref-def document', () => {
    const segmenter = createMarkdownSegmenter();
    const disabled = segmenter.push('[note]: value\n\ntext');
    expect(disabled.disabled).toBe(true);

    const result = segmenter.push('clean\n\ntext');

    expect(result.reset).toBe(true);
    expect(result.disabled).toBe(false);
    expect(result.stable).toEqual(['clean\n\n']);
    expect(result.tail).toBe('text');
  });

  it('does not disable segmentation for reference-definition lines inside fences', () => {
    const [result] = appendChunks(['```md\n[key]: value\n```\n\nafter']);

    expect(result?.disabled).toBe(false);
    expect(result?.stable).toEqual(['```md\n[key]: value\n```\n\n']);
    expect(result?.tail).toBe('after');
  });

  it('does not disable segmentation for a trailing partial ref-def line inside an open fence', () => {
    const [result] = appendChunks(['```md\n[key]: val']);

    expect(result?.disabled).toBe(false);
  });

  it('holds byte exactness over a fuzzed growing markdown fixture', () => {
    let seed = 0x12345678;
    const nextRandom = (): number => {
      seed = (seed * 1664525 + 1013904223) >>> 0;
      return seed / 0x100000000;
    };
    const fixture = Array.from({ length: 160 }, () => {
      const choices = ['word', ' ', '\n', '\n\n', '`', '|', '-', ':', '1. item'];
      return choices[Math.floor(nextRandom() * choices.length)] ?? '';
    }).join('');
    const segmenter = createMarkdownSegmenter();
    let text = '';
    let previousStableLength = 0;

    for (let offset = 0; offset < fixture.length; ) {
      const size = Math.max(1, Math.floor(nextRandom() * 8));
      text += fixture.slice(offset, offset + size);
      offset += size;
      const result = segmenter.push(text);
      assertByteExact(text, result);
      expect(result.stable.join('').length).toBeGreaterThanOrEqual(previousStableLength);
      previousStableLength = result.stable.join('').length;
    }
  });
});
