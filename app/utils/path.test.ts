import { describe, expect, it } from 'vitest';

import {
  normalizeAbsolutePathNoParent,
  normalizeDirectory,
  normalizeRelativePathNoParent,
  splitFileContentDirectoryAndPath,
} from './path';

describe('normalizeRelativePathNoParent', () => {
  it('normalizes mixed separators and removes dot segments', () => {
    expect(normalizeRelativePathNoParent('a\\b/c')).toBe('a/b/c');
    expect(normalizeRelativePathNoParent('./foo/../bar/./baz')).toBe('foo/bar/baz');
  });

  it('returns empty string for empty or all-dot input', () => {
    expect(normalizeRelativePathNoParent('')).toBe('');
    expect(normalizeRelativePathNoParent('./../.')).toBe('');
  });
});

describe('normalizeAbsolutePathNoParent', () => {
  it('resolves dot segments and keeps leading slash', () => {
    expect(normalizeAbsolutePathNoParent('/foo/../bar')).toBe('/bar');
    expect(normalizeAbsolutePathNoParent('/a//b/./c')).toBe('/a/b/c');
  });

  it('returns slash for empty input', () => {
    expect(normalizeAbsolutePathNoParent('')).toBe('/');
  });
});

describe('normalizeDirectory', () => {
  it('removes trailing slashes', () => {
    expect(normalizeDirectory('/repo/')).toBe('/repo');
  });

  it('returns empty string for empty or whitespace input', () => {
    expect(normalizeDirectory('  ')).toBe('');
    expect(normalizeDirectory('')).toBe('');
    expect(normalizeDirectory(undefined)).toBe('');
  });

  it('returns slash for root-like input', () => {
    expect(normalizeDirectory('/')).toBe('/');
  });
});

describe('splitFileContentDirectoryAndPath', () => {
  it('handles empty targetPath inside sandbox', () => {
    expect(splitFileContentDirectoryAndPath('', '/sandbox')).toEqual({
      directory: '/sandbox',
      path: '.',
    });
  });

  it('normalizes relative targetPath inside sandbox', () => {
    expect(splitFileContentDirectoryAndPath('foo/../bar', '/sandbox')).toEqual({
      directory: '/sandbox',
      path: 'foo/bar',
    });
  });

  it('strips sandbox prefix from absolute paths', () => {
    expect(splitFileContentDirectoryAndPath('/sandbox/sub/file', '/sandbox')).toEqual({
      directory: '/sandbox',
      path: 'sub/file',
    });
  });

  it('falls back to root directory when sandbox is null', () => {
    expect(splitFileContentDirectoryAndPath('/other/path', null)).toEqual({
      directory: '/',
      path: 'other/path',
    });
    expect(splitFileContentDirectoryAndPath('relative', null)).toEqual({
      directory: '/',
      path: 'relative',
    });
  });

  it('treats sandbox itself as dot path', () => {
    expect(splitFileContentDirectoryAndPath('/sandbox', '/sandbox')).toEqual({
      directory: '/sandbox',
      path: '.',
    });
  });
});
