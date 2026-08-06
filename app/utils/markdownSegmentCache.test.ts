import { beforeEach, describe, expect, it } from 'vitest';

import {
  clearMarkdownSegmentCache,
  getMarkdownSegmentHtml,
  MARKDOWN_SEGMENT_CACHE_LIMIT,
  setMarkdownSegmentHtml,
} from './markdownSegmentCache';

describe('markdown segment cache', () => {
  beforeEach(() => {
    clearMarkdownSegmentCache();
  });

  it('keys entries by theme and evicts the least recently used entry', () => {
    setMarkdownSegmentHtml('light', '', 'same', 'light-html');
    setMarkdownSegmentHtml('dark', '', 'same', 'dark-html');

    expect(getMarkdownSegmentHtml('light', '', 'same')).toBe('light-html');
    expect(getMarkdownSegmentHtml('dark', '', 'same')).toBe('dark-html');

    for (let index = 0; index < MARKDOWN_SEGMENT_CACHE_LIMIT - 1; index += 1) {
      setMarkdownSegmentHtml('light', '', `block-${index}`, `html-${index}`);
    }

    expect(getMarkdownSegmentHtml('dark', '', 'same')).toBe('dark-html');
    expect(getMarkdownSegmentHtml('light', '', 'same')).toBeUndefined();
  });

  it('keys entries by render context so label or file changes never reuse stale HTML', () => {
    setMarkdownSegmentHtml('light', 'ctx-a', 'same', 'html-a');
    setMarkdownSegmentHtml('light', 'ctx-b', 'same', 'html-b');

    expect(getMarkdownSegmentHtml('light', 'ctx-a', 'same')).toBe('html-a');
    expect(getMarkdownSegmentHtml('light', 'ctx-b', 'same')).toBe('html-b');
    expect(getMarkdownSegmentHtml('light', 'ctx-c', 'same')).toBeUndefined();
  });
});
