import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseArchive } from './archiveParser';

describe('parseArchive', () => {
  it('falls back to detected archive type when extension is wrong', async () => {
    const gzipBytes = gzipSync(new TextEncoder().encode('hello world'));
    const result = await parseArchive(gzipBytes, 'zip');

    expect(result.error).toBeUndefined();
    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('GZIP');
  });

  it('still parses valid gzip files', async () => {
    const gzipBytes = gzipSync(new TextEncoder().encode('hello world'));
    const result = await parseArchive(gzipBytes, 'gz');

    expect(result.error).toBeUndefined();
    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('GZIP');
    expect(result.entries).toEqual([
      {
        name: 'decompressed',
        size: 11,
        isDirectory: false,
      },
    ]);
  });

  it('parses detected gzip content even without a known extension', async () => {
    const gzipBytes = gzipSync(new TextEncoder().encode('hello world'));
    const result = await parseArchive(gzipBytes, 'dat');

    expect(result.error).toBeUndefined();
    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('GZIP');
  });
});
