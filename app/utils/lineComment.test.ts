import { describe, expect, it } from 'vitest';

import {
  formatCommentNote,
  buildLineCommentFileUrl,
} from '../utils/lineComment';

describe('formatCommentNote', () => {
  it('formats a single line', () => {
    expect(formatCommentNote('/foo/bar.txt', 10, 10, 'Nice code!'))
      .toBe('The user made the following comment regarding line 10 of bar.txt: Nice code!');
  });

  it('formats a line range', () => {
    expect(formatCommentNote('/a/b/c/d/file.ts', 2, 5, 'Check this range'))
      .toBe('The user made the following comment regarding lines 2-5 of file.ts: Check this range');
  });

  it('extracts basename from multi-segment path', () => {
    expect(formatCommentNote('/a/b/c/d/file.ts', 42, 42, 'Check this'))
      .toBe('The user made the following comment regarding line 42 of file.ts: Check this');
  });

  it('handles path with dots in filename', () => {
    expect(formatCommentNote('/home/user/.config/file.js', 5, 5, 'test'))
      .toBe('The user made the following comment regarding line 5 of file.js: test');
  });

  it('handles Windows-style path with backslashes', () => {
    expect(formatCommentNote('C:\\\\Users\\\\dev\\\\project\\\\main.py', 1, 3, 'first to third line'))
      .toBe('The user made the following comment regarding lines 1-3 of main.py: first to third line');
  });

  it('handles empty text', () => {
    expect(formatCommentNote('/path/to/file.txt', 100, 100, ''))
      .toBe('The user made the following comment regarding line 100 of file.txt: ');
  });

  it('handles special characters in text', () => {
    expect(formatCommentNote('/foo/bar.md', 3, 3, 'Line with "quotes" & <tags>!'))
      .toBe('The user made the following comment regarding line 3 of bar.md: Line with "quotes" & <tags>!');
  });

  it('handles line 0', () => {
    expect(formatCommentNote('/src/index.js', 0, 0, 'start'))
      .toBe('The user made the following comment regarding line 0 of index.js: start');
  });
});

describe('buildLineCommentFileUrl', () => {
  it('builds URL with absolute Unix path and single line', () => {
    expect(buildLineCommentFileUrl('/home/user/project/file.ts', 15, 15))
      .toBe('file:///home/user/project/file.ts?start=15&end=15');
  });

  it('builds URL with line range', () => {
    expect(buildLineCommentFileUrl('/home/user/project/file.ts', 10, 20))
      .toBe('file:///home/user/project/file.ts?start=10&end=20');
  });

  it('builds URL with absolute Windows path', () => {
    expect(buildLineCommentFileUrl('C:\\Projects\\app.js', 99, 101))
      .toBe('file:///C%3A/Projects/app.js?start=99&end=101');
  });

  it('builds URL with multi-segment path', () => {
    expect(buildLineCommentFileUrl('/a/b/c/file.txt', 1, 1))
      .toBe('file:///a/b/c/file.txt?start=1&end=1');
  });

  it('handles line 0', () => {
    expect(buildLineCommentFileUrl('/root/file', 0, 0))
      .toBe('file:///root/file?start=0&end=0');
  });

  it('encodes spaces in path', () => {
    expect(buildLineCommentFileUrl('/path/with spaces/file.md', 5, 8))
      .toBe('file:///path/with%20spaces/file.md?start=5&end=8');
  });
});
