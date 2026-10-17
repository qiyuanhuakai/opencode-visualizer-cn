import { createHash, randomUUID } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { CollaborationError } from '../../../shared/runtime/collaboration.js';

/**
 * The artifact store (task 40): durable, immutable, content-addressed artifact objects, the frozen
 * 32 MiB ceiling, and a STREAMING hash.
 *
 * Three properties are enforced here, and each one is a number the caller can observe rather than
 * a prose claim:
 *
 *   1. The 32 MiB ceiling is `ARTIFACT_LIMITS.maxArtifactBytes`, one frozen number. It is checked
 *      DURING the hash pass, chunk by chunk, so an over-ceiling source is refused at the chunk that
 *      crosses the line — the remainder is never read and never written. `state().writes` stays 0
 *      and no object and no temp file is left behind.
 *
 *   2. The hash is STREAMING. `hashSource` keeps a live gauge of the bytes it is holding and
 *      reports the peak as `peakBufferedBytes`; the loop holds exactly one chunk at a time, so the
 *      peak is one chunk, never the content. `chunks` is the observed read count. A caller that
 *      buffered the whole content would report `peakBufferedBytes === bytes`; this module cannot.
 *
 *   3. An object is IMMUTABLE. The durable path IS the content hash, so storing the same bytes
 *      twice is the same object. If a different byte sequence ever lands on an existing path, the
 *      store REFUSES (`artifact_immutable`) rather than overwrite — a stored artifact is never
 *      silently replaced.
 *
 * A missing object is an explicit miss (`artifact_missing`), never a fabricated empty one.
 */

/**
 * The frozen artifact budgets. One object, shared by every enforcing call site:
 *
 *   maxArtifactBytes — the ceiling on one serialized artifact, 32 MiB
 *   chunkBytes       — the streaming read size; also the largest buffer the hasher ever holds
 *   maxPathEntries   — the path-manifest ceiling
 *   maxPathChars     — the longest one manifest path
 */
export const ARTIFACT_LIMITS = Object.freeze({
  maxArtifactBytes: 32 * 1024 * 1024,
  chunkBytes: 64 * 1024,
  maxPathEntries: 4096,
  maxPathChars: 1024,
});

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const OBJECTS_DIR = 'objects';
const TMP_DIR = 'tmp';

function requireHash(value) {
  if (typeof value !== 'string' || !HASH_PATTERN.test(value)) {
    throw new CollaborationError('invalid_request', 'artifact_hash');
  }
  return value;
}

/* ------------------------------------------------------------------ sources */

/**
 * A re-openable byte source. `open` may be called more than once: the store hashes in one pass and
 * copies in a second, and a source that could only be read once could not serve both.
 */
export function createBufferSource(buffer) {
  if (!Buffer.isBuffer(buffer)) {
    throw new CollaborationError('invalid_request', 'artifact_source');
  }
  return {
    async open() {
      let offset = 0;
      return {
        async read(maxBytes) {
          if (offset >= buffer.length) return null;
          const end = Math.min(offset + maxBytes, buffer.length);
          const chunk = buffer.subarray(offset, end);
          offset = end;
          return chunk;
        },
        async close() {},
      };
    },
  };
}

/** A file source, read in bounded chunks. */
export function createFileSource(filePath, fsLike = fs) {
  if (typeof filePath !== 'string' || filePath.length === 0) {
    throw new CollaborationError('invalid_request', 'artifact_source');
  }
  return {
    async open() {
      const handle = await fsLike.open(filePath, 'r');
      let done = false;
      return {
        async read(maxBytes) {
          if (done) return null;
          const buffer = Buffer.allocUnsafe(maxBytes);
          const { bytesRead } = await handle.read(buffer, 0, maxBytes, null);
          if (bytesRead === 0) {
            done = true;
            return null;
          }
          return buffer.subarray(0, bytesRead);
        },
        async close() {
          await handle.close();
        },
      };
    },
  };
}

/* ------------------------------------------------------------------ the hasher */

/**
 * Stream one source through sha256, counting bytes, chunks and the PEAK number of bytes held at
 * once. The gauge is incremented when a chunk is acquired and decremented once it has been folded
 * into the hash, so `peakBufferedBytes` is the product's own measurement of how much of the
 * content was ever in memory at one time.
 *
 * The ceiling is enforced here, mid-stream: the chunk that crosses `maxArtifactBytes` is refused
 * and nothing after it is read.
 */
export async function hashSource(source, limits = ARTIFACT_LIMITS) {
  if (source === null || typeof source !== 'object' || typeof source.open !== 'function') {
    throw new CollaborationError('invalid_request', 'artifact_source');
  }
  const maxBytes = limits.maxArtifactBytes;
  const chunkBytes = limits.chunkBytes;
  const hash = createHash('sha256');
  const reader = await source.open();
  let bytes = 0;
  let chunks = 0;
  let held = 0;
  let peakBufferedBytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(chunkBytes);
      if (chunk === null || chunk === undefined) break;
      if (!Buffer.isBuffer(chunk)) {
        throw new CollaborationError('invalid_request', 'artifact_source');
      }
      bytes += chunk.length;
      chunks += 1;
      held += chunk.length;
      if (held > peakBufferedBytes) peakBufferedBytes = held;
      if (bytes > maxBytes) {
        throw new CollaborationError('conflict', 'artifact_oversize', {
          limit: maxBytes,
          observed: bytes,
          chunkBytes,
        });
      }
      hash.update(chunk);
      held -= chunk.length;
    }
  } finally {
    await reader.close();
  }
  return Object.freeze({
    artifactHash: hash.digest('hex'),
    bytes,
    chunks,
    peakBufferedBytes,
  });
}

/* ------------------------------------------------------------------ the store */

export function createArtifactStore(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'artifact_store_options');
  }
  if (typeof options.root !== 'string' || options.root.length === 0) {
    throw new CollaborationError('invalid_request', 'artifact_store_root');
  }
  const root = options.root;
  const fsLike = options.fs ?? fs;
  const limits = options.limits ?? ARTIFACT_LIMITS;
  const hashImpl = options.hashImpl ?? hashSource;
  const newTempName = typeof options.newTempName === 'function' ? options.newTempName : randomUUID;
  const objectsRoot = path.join(root, OBJECTS_DIR);
  const tmpRoot = path.join(root, TMP_DIR);
  const stats = { writes: 0, oversizeRejections: 0, immutableRefusals: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'artifact_store_closed');
  }

  function objectPath(artifactHash) {
    return path.join(objectsRoot, artifactHash.slice(0, 2), artifactHash.slice(2));
  }

  async function pathExists(target) {
    try {
      await fsLike.stat(target);
      return true;
    } catch {
      return false;
    }
  }

  /**
   * Copy one source into a temp file, HASHING AND COUNTING as it goes and enforcing the ceiling
   * mid-stream. The second pass is not trusted: it must produce exactly the bytes the first pass
   * hashed, or a source that changed between the two opens (a mutable file, a source whose second
   * open differs) is refused instead of being stored under a stale hash. A short write is a
   * refusal, never a silently truncated object.
   */
  async function copySource(source, target, expected) {
    const reader = await source.open();
    // 'wx' is O_WRONLY|O_CREAT|O_EXCL: a temp file is created exactly once and never reopened for
    // writing, so an existing path can never be silently overwritten.
    const handle = await fsLike.open(target, 'wx', 0o444);
    const hash = createHash('sha256');
    let bytes = 0;
    try {
      for (;;) {
        const chunk = await reader.read(limits.chunkBytes);
        if (chunk === null || chunk === undefined) break;
        bytes += chunk.length;
        if (bytes > limits.maxArtifactBytes) {
          throw new CollaborationError('conflict', 'artifact_oversize', {
            limit: limits.maxArtifactBytes,
            observed: bytes,
          });
        }
        hash.update(chunk);
        let written = 0;
        while (written < chunk.length) {
          const result = await handle.write(chunk, written, chunk.length - written);
          if (result.bytesWritten <= 0) {
            throw new CollaborationError('source_unavailable', 'artifact_short_write', { path: target });
          }
          written += result.bytesWritten;
        }
      }
    } finally {
      await handle.close();
      await reader.close();
    }
    // The bytes that landed must be EXACTLY the bytes the first pass hashed.
    if (bytes !== expected.bytes || hash.digest('hex') !== expected.artifactHash) {
      throw new CollaborationError('conflict', 'artifact_changed', {
        expected: expected.artifactHash,
        observedBytes: bytes,
        expectedBytes: expected.bytes,
      });
    }
  }

  /** An existing object must hash to its own name, or the store refuses rather than overwrite. */
  async function assertImmutable(target, artifactHash) {
    const existing = await hashImpl(createFileSource(target, fsLike), limits);
    if (existing.artifactHash !== artifactHash) {
      stats.immutableRefusals += 1;
      throw new CollaborationError('conflict', 'artifact_immutable', {
        artifactHash,
        observed: existing.artifactHash,
      });
    }
  }

  /**
   * Store one artifact. Pass one hashes the source and enforces the ceiling; pass two copies it
   * into the content-addressed object, re-hashing and re-counting what actually lands and
   * publishing with a hard link so an existing object can never be overwritten.
   */
  async function write(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object' || input.source === null
      || typeof input.source !== 'object') {
      throw new CollaborationError('invalid_request', 'artifact_write');
    }
    let digest;
    try {
      digest = await hashImpl(input.source, limits);
    } catch (error) {
      if (error instanceof CollaborationError && error.field === 'artifact_oversize') {
        stats.oversizeRejections += 1;
      }
      throw error;
    }
    const target = objectPath(digest.artifactHash);
    let existed = false;
    if (await pathExists(target)) {
      await assertImmutable(target, digest.artifactHash);
      existed = true;
    } else {
      await fsLike.mkdir(path.dirname(target), { recursive: true });
      await fsLike.mkdir(tmpRoot, { recursive: true });
      const temp = path.join(tmpRoot, newTempName());
      try {
        await copySource(input.source, temp, digest);
        try {
          // Publish WITHOUT overwriting: link() is atomic and REFUSES an existing object, so a
          // concurrent writer can never replace a stored artifact.
          await fsLike.link(temp, target);
        } catch (error) {
          if (error?.code !== 'EEXIST') throw error;
          await assertImmutable(target, digest.artifactHash);
          existed = true;
        }
      } finally {
        await fsLike.rm(temp, { force: true }).catch(() => undefined);
      }
    }
    stats.writes += 1;
    return Object.freeze({ ...digest, path: target, existed });
  }

  /** Read one artifact back. A hash that was never stored is an explicit miss. */
  async function read(artifactHash) {
    assertOpen();
    const hash = requireHash(artifactHash);
    const target = objectPath(hash);
    if (!(await pathExists(target))) {
      throw new CollaborationError('invalid_request', 'artifact_missing', { artifactHash: hash });
    }
    return fsLike.readFile(target);
  }

  async function open(artifactHash) {
    assertOpen();
    const hash = requireHash(artifactHash);
    const target = objectPath(hash);
    if (!(await pathExists(target))) {
      throw new CollaborationError('invalid_request', 'artifact_missing', { artifactHash: hash });
    }
    return createFileSource(target, fsLike).open();
  }

  async function has(artifactHash) {
    assertOpen();
    return pathExists(objectPath(requireHash(artifactHash)));
  }

  /** Re-hash a stored object and report whether it still matches its own name. */
  async function verify(artifactHash) {
    assertOpen();
    const hash = requireHash(artifactHash);
    const target = objectPath(hash);
    if (!(await pathExists(target))) {
      throw new CollaborationError('invalid_request', 'artifact_missing', { artifactHash: hash });
    }
    const digest = await hashImpl(createFileSource(target, fsLike), limits);
    return Object.freeze({ ...digest, ok: digest.artifactHash === hash });
  }

  function state() {
    return Object.freeze({ ...stats, closed });
  }

  function close() {
    closed = true;
  }

  return {
    ARTIFACT_LIMITS,
    write,
    read,
    open,
    has,
    verify,
    state,
    close,
  };
}
