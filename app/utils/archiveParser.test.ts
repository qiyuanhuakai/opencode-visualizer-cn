import { gzipSync } from 'fflate';
import { describe, expect, it } from 'vitest';

import { parseArchive } from './archiveParser';

describe('parseArchive signature detection', () => {
  it('detects the zip signature and routes to the zip parser', async () => {
    const result = await parseArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'dat');

    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('ZIP');
  });

  it('detects the rar signature', async () => {
    const result = await parseArchive(new Uint8Array([0x52, 0x61, 0x72, 0x21]), 'dat');

    expect(result.unsupported).toBeUndefined();
  });

  it('detects the 7z signature', async () => {
    const result = await parseArchive(new Uint8Array([0x37, 0x7a, 0xbc, 0xaf]), 'dat');

    expect(result.unsupported).toBeUndefined();
  });

  it('detects the xz signature', async () => {
    const result = await parseArchive(new Uint8Array([0xfd, 0x37, 0x7a, 0x58]), 'dat');

    expect(result.unsupported).toBeUndefined();
  });

  it('detects the bzip2 signature', async () => {
    const result = await parseArchive(new Uint8Array([0x42, 0x5a, 0x68]), 'dat');

    expect(result.unsupported).toBeUndefined();
  });

  it('detects the gzip signature and routes to the gzip parser', async () => {
    const result = await parseArchive(new Uint8Array([0x1f, 0x8b]), 'dat');

    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('GZIP');
  });

  it('detects the tar signature from the ustar marker at offset 257', async () => {
    const bytes = new Uint8Array(265);
    bytes.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
    const result = await parseArchive(bytes, 'dat');

    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('TAR');
  });

  it('returns unsupported for an empty buffer', async () => {
    const result = await parseArchive(new Uint8Array(0), 'dat');

    expect(result.unsupported).toBe(true);
  });

  it('returns unsupported when no signature matches', async () => {
    const result = await parseArchive(new Uint8Array([0x00, 0x00, 0x00, 0x00]), 'dat');

    expect(result.unsupported).toBe(true);
  });

  it('does not match a signature when a later byte differs', async () => {
    const result = await parseArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x05]), 'dat');

    expect(result.unsupported).toBe(true);
  });

  it('does not detect tar when the buffer is shorter than 265 bytes', async () => {
    const bytes = new Uint8Array(264);
    bytes.set([0x75, 0x73, 0x74, 0x61, 0x72], 257);
    const result = await parseArchive(bytes, 'dat');

    expect(result.unsupported).toBe(true);
  });
});

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
