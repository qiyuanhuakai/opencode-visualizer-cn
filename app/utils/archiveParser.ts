import JSZip from 'jszip';
import { parseTar } from 'nanotar';
import { gunzipSync } from 'fflate';
import { ArchiveReader, libarchiveWasm } from 'libarchive-wasm';

type ArchiveKind = 'zip' | 'gzip' | 'bzip2' | 'xz' | '7z' | 'rar' | 'tar' | 'unknown';
type ArchiveParser = (bytes: Uint8Array) => Promise<ArchiveParseResult> | ArchiveParseResult;

export interface ArchiveEntry {
  name: string;
  size: number;
  compressedSize?: number;
  date?: Date;
  isDirectory: boolean;
}

export interface ArchiveParseResult {
  entries: ArchiveEntry[];
  error?: string;
  unsupported?: boolean;
  format?: string;
}

let libarchiveInstance: Awaited<ReturnType<typeof libarchiveWasm>> | null = null;

function detectArchiveKind(bytes: Uint8Array): ArchiveKind {
  if (bytes.length >= 4) {
    if (bytes[0] === 0x50 && bytes[1] === 0x4b && bytes[2] === 0x03 && bytes[3] === 0x04) {
      return 'zip';
    }
    if (bytes[0] === 0x52 && bytes[1] === 0x61 && bytes[2] === 0x72 && bytes[3] === 0x21) {
      return 'rar';
    }
    if (bytes[0] === 0x37 && bytes[1] === 0x7a && bytes[2] === 0xbc && bytes[3] === 0xaf) {
      return '7z';
    }
    if (bytes[0] === 0xfd && bytes[1] === 0x37 && bytes[2] === 0x7a && bytes[3] === 0x58) {
      return 'xz';
    }
  }

  if (bytes.length >= 3 && bytes[0] === 0x42 && bytes[1] === 0x5a && bytes[2] === 0x68) {
    return 'bzip2';
  }

  if (bytes.length >= 2 && bytes[0] === 0x1f && bytes[1] === 0x8b) {
    return 'gzip';
  }

  if (bytes.length >= 265) {
    const ustar = new TextDecoder('ascii').decode(bytes.slice(257, 262));
    if (ustar === 'ustar') return 'tar';
  }

  return 'unknown';
}

function extensionExpectedKinds(extension: string): ArchiveKind[] {
  switch (extension.toLowerCase()) {
    case 'zip':
      return ['zip'];
    case 'gz':
    case 'gzip':
    case 'tar.gz':
    case 'tgz':
      return ['gzip'];
    case 'tar':
      return ['tar', 'unknown'];
    case 'bz2':
    case 'tar.bz2':
    case 'tbz':
    case 'tbz2':
      return ['bzip2'];
    case 'xz':
    case 'tar.xz':
    case 'txz':
      return ['xz'];
    case '7z':
      return ['7z'];
    case 'rar':
      return ['rar'];
    default:
      return ['unknown'];
  }
}

function isSuccessfulParse(result: ArchiveParseResult) {
  return !result.error && !result.unsupported;
}

function parserForKind(kind: ArchiveKind, extension: string): ArchiveParser | null {
  switch (kind) {
    case 'zip':
      return parseZip;
    case 'tar':
      return parseTarArchive;
    case 'gzip':
      return extension === 'tar.gz' || extension === 'tgz' ? parseTarGz : parseGzip;
    case 'bzip2':
    case 'xz':
    case '7z':
    case 'rar':
      return parseLibarchiveFormats;
    default:
      return null;
  }
}

function parsersForExtension(extension: string): ArchiveParser[] {
  switch (extension.toLowerCase()) {
    case 'zip':
      return [parseZip];
    case 'tar':
      return [parseTarArchive, parseLibarchiveFormats];
    case 'gz':
    case 'gzip':
      return [parseGzip, parseTarGz];
    case 'tar.gz':
    case 'tgz':
      return [parseTarGz, parseGzip];
    case 'bz2':
    case 'tar.bz2':
    case 'tbz':
    case 'tbz2':
    case 'xz':
    case 'tar.xz':
    case 'txz':
    case '7z':
    case 'rar':
      return [parseLibarchiveFormats];
    default:
      return [];
  }
}

async function tryParsers(bytes: Uint8Array, parsers: ArchiveParser[]) {
  let lastResult: ArchiveParseResult | null = null;
  for (const parser of parsers) {
    const result = await parser(bytes);
    if (isSuccessfulParse(result)) return result;
    lastResult = result;
  }

  return lastResult;
}

async function getLibarchiveInstance(): Promise<Awaited<ReturnType<typeof libarchiveWasm>>> {
  if (!libarchiveInstance) {
    libarchiveInstance = await libarchiveWasm();
  }
  return libarchiveInstance;
}

export async function parseZip(bytes: Uint8Array): Promise<ArchiveParseResult> {
  try {
    const zip = await JSZip.loadAsync(bytes);
    const entries: ArchiveEntry[] = [];

    zip.forEach((relativePath, file) => {
      entries.push({
        name: relativePath,
        size: 0,
        date: file.date,
        isDirectory: file.dir,
      });
    });

    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries, format: 'ZIP' };
  } catch (err) {
    return {
      entries: [],
      format: 'ZIP',
      error: err instanceof Error ? err.message : 'Failed to parse ZIP archive',
    };
  }
}

export function parseTarArchive(bytes: Uint8Array): ArchiveParseResult {
  try {
    const entries = parseTar(bytes);
    const archiveEntries: ArchiveEntry[] = entries.map((entry) => ({
      name: entry.name,
      size: entry.size,
      isDirectory: entry.type === 'directory' || entry.name.endsWith('/'),
    }));

    archiveEntries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries: archiveEntries, format: 'TAR' };
  } catch (err) {
    return {
      entries: [],
      format: 'TAR',
      error: err instanceof Error ? err.message : 'Failed to parse TAR archive',
    };
  }
}

export async function parseGzip(bytes: Uint8Array): Promise<ArchiveParseResult> {
  try {
    const decompressed = gunzipSync(bytes);
    return {
      entries: [{
        name: 'decompressed',
        size: decompressed.length,
        isDirectory: false,
      }],
      format: 'GZIP',
    };
  } catch (err) {
    return {
      entries: [],
      format: 'GZIP',
      error: err instanceof Error ? err.message : 'Failed to decompress GZIP',
    };
  }
}

export async function parseLibarchiveFormats(bytes: Uint8Array): Promise<ArchiveParseResult> {
  try {
    const libarchive = await getLibarchiveInstance();
    const reader = new ArchiveReader(libarchive, new Int8Array(bytes));
    const entries: ArchiveEntry[] = [];

    for (const entry of reader.entries()) {
      const pathname = entry.getPathname();
      const size = entry.getSize();
      entries.push({
        name: pathname,
        size: size,
        isDirectory: pathname.endsWith('/'),
      });
    }

    reader.free();
    entries.sort((a, b) => a.name.localeCompare(b.name));
    return { entries };
  } catch (err) {
    return {
      entries: [],
      error: err instanceof Error ? err.message : 'Failed to parse archive',
    };
  }
}

export async function parseTarGz(bytes: Uint8Array): Promise<ArchiveParseResult> {
  try {
    const decompressed = gunzipSync(bytes);
    const result = parseTarArchive(decompressed);
    return { ...result, format: 'TAR.GZ' };
  } catch (err) {
    return {
      entries: [],
      format: 'TAR.GZ',
      error: err instanceof Error ? err.message : 'Failed to parse TAR.GZ archive',
    };
  }
}

export async function parseArchive(
  bytes: Uint8Array,
  extension: string,
): Promise<ArchiveParseResult> {
  const ext = extension.toLowerCase();
  const detectedKind = detectArchiveKind(bytes);
  const expectedKinds = extensionExpectedKinds(ext).filter((kind) => kind !== 'unknown');
  const parserChain: ArchiveParser[] = [];
  const seen = new Set<ArchiveParser>();

  const pushParser = (parser: ArchiveParser | null) => {
    if (!parser || seen.has(parser)) return;
    seen.add(parser);
    parserChain.push(parser);
  };

  if (detectedKind !== 'unknown') {
    if (expectedKinds.length === 0 || expectedKinds.includes(detectedKind)) {
      pushParser(parserForKind(detectedKind, ext));
    } else {
      for (const expectedKind of expectedKinds) {
        pushParser(parserForKind(expectedKind, ext));
      }
      pushParser(parserForKind(detectedKind, ext));
    }
  }

  for (const parser of parsersForExtension(ext)) {
    pushParser(parser);
  }

  const result = await tryParsers(bytes, parserChain);
  if (result) return result;

  return {
    entries: [],
    unsupported: true,
  };
}
