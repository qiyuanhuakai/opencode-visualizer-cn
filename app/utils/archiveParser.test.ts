import { gzipSync } from 'fflate';
import JSZip from 'jszip';
import { createTar } from 'nanotar';
import { beforeEach, describe, expect, it, vi } from 'vitest';

import { parseArchive } from './archiveParser';

const libarchiveMock = vi.hoisted(() => {
  const constructorBytes: Uint8Array[] = [];

  class MockArchiveReader {
    constructor(_libarchive: unknown, bytes: Int8Array) {
      constructorBytes.push(new Uint8Array(bytes));
    }

    *entries() {
      yield {
        getPathname: () => 'libarchive-entry.txt',
        getSize: () => 19,
      };
    }

    free() {}
  }

  return {
    ArchiveReader: MockArchiveReader,
    constructorBytes,
    libarchiveWasm: vi.fn(async () => ({})),
  };
});

vi.mock('libarchive-wasm', () => ({
  ArchiveReader: libarchiveMock.ArchiveReader,
  libarchiveWasm: libarchiveMock.libarchiveWasm,
}));

beforeEach(() => {
  libarchiveMock.constructorBytes.splice(0);
});

describe('parseArchive format detection and parsing', () => {
  it('detects the zip signature and routes to the zip parser', async () => {
    const result = await parseArchive(new Uint8Array([0x50, 0x4b, 0x03, 0x04]), 'dat');

    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('ZIP');
  });

  it.each([
    ['RAR', new Uint8Array([0x52, 0x61, 0x72, 0x21])],
    ['7z', new Uint8Array([0x37, 0x7a, 0xbc, 0xaf])],
    ['XZ', new Uint8Array([0xfd, 0x37, 0x7a, 0x58])],
    ['BZIP2', new Uint8Array([0x42, 0x5a, 0x68])],
  ])('routes the %s signature in a dat file through ArchiveReader with its original bytes', async (_kind, bytes) => {
    const result = await parseArchive(bytes, 'dat');

    expect(libarchiveMock.constructorBytes).toEqual([bytes]);
    expect(result).toEqual({
      entries: [{ name: 'libarchive-entry.txt', size: 19, isDirectory: false }],
    });
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
  it('parses valid zip content through the real JSZip library', async () => {
    const zip = new JSZip();
    zip.file('zip-entry.txt', 'zip payload');

    const result = await parseArchive(await zip.generateAsync({ type: 'uint8array' }), 'dat');

    expect(result.error).toBeUndefined();
    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('ZIP');
    expect(result.entries).toMatchObject([{ name: 'zip-entry.txt', isDirectory: false }]);
  });

  it('parses valid tar content through the real nanotar library', async () => {
    const result = await parseArchive(
      createTar([{ name: 'tar-entry.txt', data: 'tar payload' }], { attrs: { mtime: 0 } }),
      'dat',
    );

    expect(result.error).toBeUndefined();
    expect(result.unsupported).toBeUndefined();
    expect(result.format).toBe('TAR');
    expect(result.entries).toEqual([{ name: 'tar-entry.txt', size: 11, isDirectory: false }]);
  });

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
