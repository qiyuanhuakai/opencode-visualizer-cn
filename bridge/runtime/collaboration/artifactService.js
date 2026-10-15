import { createHash } from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import {
  ARTIFACT_LIMITS,
  createBufferSource,
  createFileSource,
  hashSource,
} from './artifactStore.js';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { createGitRunner } from './writerLeases.js';

/**
 * The change artifact (task 40): one immutable, hash-identified record of everything a writer
 * changed in its leased worktree, and a lossless way to reproduce it.
 *
 * The artifact carries, for every changed path, its kind (`file`, `symlink` or `delete`), its mode,
 * its raw bytes (for a file) or its raw link target (for a symlink), whether git tracked it, and a
 * sha256 over its payload. The path manifest is the artifact HEADER, so the recorded hash binds the
 * manifest as well as the bytes: a manifest that claims a path the object does not carry, or vice
 * versa, is detectable.
 *
 * LOSSLESS is proven by the shape of the record, not by a promise: every byte of a file, the exact
 * mode, the exact link target and the fact of a deletion are all stored, so applying the artifact
 * onto the base it was captured from reproduces the writer's tree byte-for-byte. There is no
 * "best effort" path and no patch synthesis: a capture with nothing to record refuses
 * (`artifact_empty`), and a missing object is an explicit miss rather than a fabricated one.
 *
 * The serialization is STREAMED: the header is written first, then each record as
 * `u32be(contentLength) + content + u32be(jsonLength) + json`, so a file's bytes are folded into
 * the artifact one chunk at a time and never held whole. The 32 MiB ceiling is enforced by the
 * store during that same pass.
 */

/** The artifact schema version. Bumped only by a deliberate format change. */
export const ARTIFACT_SCHEMA_VERSION = 1;

/** The three entry kinds. `delete` records a removal; it carries no payload. */
export const CHANGE_KINDS = Object.freeze(['file', 'symlink', 'delete']);

const HASH_PATTERN = /^[a-f0-9]{64}$/;
const COMMIT_PATTERN = /^[0-9a-f]{40,64}$/;
const WINDOWS_DRIVE_PATTERN = /^[a-zA-Z]:/;

function isWithin(targetPath, rootPath) {
  const relative = path.relative(rootPath, targetPath);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

/**
 * Validate one manifest path. Absolute paths, Windows drive letters, backslashes, NUL bytes, `.`
 * and `..` segments, over-long paths and anything that resolves outside the apply root are each an
 * explicit refusal — a crafted artifact cannot name a path outside its target.
 */
function validateArtifactPath(candidate, root) {
  if (typeof candidate !== 'string' || candidate.length === 0
    || candidate.length > ARTIFACT_LIMITS.maxPathChars || candidate.includes('\0')) {
    throw new CollaborationError('invalid_request', 'artifact_path');
  }
  if (candidate.includes('\\') || WINDOWS_DRIVE_PATTERN.test(candidate)
    || candidate.startsWith('/')) {
    throw new CollaborationError('invalid_request', 'artifact_path');
  }
  const segments = candidate.split('/');
  if (segments.some((segment) => segment === '' || segment === '.' || segment === '..')) {
    throw new CollaborationError('invalid_request', 'artifact_path');
  }
  const resolved = path.resolve(root, candidate);
  if (!isWithin(resolved, root)) {
    throw new CollaborationError('invalid_request', 'artifact_path');
  }
  return resolved;
}

function comparePaths(left, right) {
  return Buffer.compare(Buffer.from(left, 'utf8'), Buffer.from(right, 'utf8'));
}

function sha256Of(payload) {
  return createHash('sha256').update(payload).digest('hex');
}

/* ------------------------------------------------------------------ the wire format */

function headerLine(changeSet) {
  return Buffer.from(
    `${JSON.stringify({
      schemaVersion: ARTIFACT_SCHEMA_VERSION,
      baseCommit: changeSet.baseCommit,
      entryCount: changeSet.entries.length,
      paths: changeSet.entries.map((entry) => entry.path),
    })}\n`,
    'utf8',
  );
}

function lengthPrefix(length) {
  const head = Buffer.alloc(4);
  head.writeUInt32BE(length, 0);
  return head;
}

/** Open a caller-supplied content payload as a re-openable source. */
function openPayload(content) {
  if (content === null || content === undefined) {
    return createBufferSource(Buffer.alloc(0));
  }
  if (Buffer.isBuffer(content)) {
    return createBufferSource(content);
  }
  if (typeof content === 'object' && typeof content.open === 'function') {
    return content;
  }
  throw new CollaborationError('invalid_request', 'artifact_content');
}

async function payloadLength(content) {
  if (Buffer.isBuffer(content)) return content.length;
  if (content === null || content === undefined) return 0;
  if (typeof content === 'object' && typeof content.open === 'function') {
    const reader = await content.open();
    let total = 0;
    try {
      for (;;) {
        const chunk = await reader.read(ARTIFACT_LIMITS.chunkBytes);
        if (chunk === null || chunk === undefined) break;
        total += chunk.length;
      }
    } finally {
      await reader.close();
    }
    return total;
  }
  throw new CollaborationError('invalid_request', 'artifact_content');
}

/**
 * Turn one change set into a re-openable byte source. The change set is validated EAGERLY, so a
 * malicious path is refused before a single byte is produced; the content is then streamed, and
 * every entry's declared `contentBytes` and `sha256` are verified against what actually streams.
 */
export function serialize(changeSet) {
  if (changeSet === null || typeof changeSet !== 'object') {
    throw new CollaborationError('invalid_request', 'artifact_change_set');
  }
  if (typeof changeSet.baseCommit !== 'string' || !COMMIT_PATTERN.test(changeSet.baseCommit)) {
    throw new CollaborationError('invalid_request', 'artifact_base_commit');
  }
  if (!Array.isArray(changeSet.entries)) {
    throw new CollaborationError('invalid_request', 'artifact_entries');
  }
  if (changeSet.entries.length > ARTIFACT_LIMITS.maxPathEntries) {
    throw new CollaborationError('conflict', 'artifact_paths', {
      limit: ARTIFACT_LIMITS.maxPathEntries,
      observed: changeSet.entries.length,
    });
  }
  const entries = [...changeSet.entries].sort((left, right) => comparePaths(left.path, right.path));
  const seen = new Set();
  for (const entry of entries) {
    if (entry === null || typeof entry !== 'object') {
      throw new CollaborationError('invalid_request', 'artifact_entry');
    }
    if (!CHANGE_KINDS.includes(entry.kind)) {
      throw new CollaborationError('invalid_request', 'artifact_kind');
    }
    if (typeof entry.mode !== 'number' || !Number.isSafeInteger(entry.mode)
      || entry.mode < 0 || entry.mode > 0o7777) {
      throw new CollaborationError('invalid_request', 'artifact_mode');
    }
    if (typeof entry.tracked !== 'boolean') {
      throw new CollaborationError('invalid_request', 'artifact_tracked');
    }
    // The path is validated against a synthetic root: serialization is root-independent, so the
    // traversal / absolute / drive-letter class is refused here and again at apply time.
    validateArtifactPath(entry.path, path.parse(process.cwd()).root);
    if (seen.has(entry.path)) {
      throw new CollaborationError('conflict', 'artifact_entry_duplicate', { path: entry.path });
    }
    seen.add(entry.path);
    if (entry.kind === 'symlink') {
      if (typeof entry.target !== 'string' || entry.target.length === 0
        || entry.target.length > ARTIFACT_LIMITS.maxPathChars || entry.target.includes('\0')) {
        throw new CollaborationError('invalid_request', 'artifact_target');
      }
    } else if (entry.target !== null && entry.target !== undefined) {
      throw new CollaborationError('invalid_request', 'artifact_target');
    }
  }

  async function* stream() {
    yield headerLine({ baseCommit: changeSet.baseCommit, entries });
    for (const entry of entries) {
      if (entry.kind === 'file') {
        const source = openPayload(entry.content);
        const declared = await payloadLength(source);
        if (typeof entry.contentBytes !== 'number' || entry.contentBytes !== declared) {
          throw new CollaborationError('conflict', 'artifact_content_bytes', {
            path: entry.path,
            declared: entry.contentBytes ?? null,
            observed: declared,
          });
        }
        yield lengthPrefix(declared);
        const hash = createHash('sha256');
        let seen = 0;
        const reader = await source.open();
        try {
          for (;;) {
            const chunk = await reader.read(ARTIFACT_LIMITS.chunkBytes);
            if (chunk === null || chunk === undefined) break;
            seen += chunk.length;
            if (seen > declared) {
              throw new CollaborationError('conflict', 'artifact_changed', { path: entry.path });
            }
            hash.update(chunk);
            yield chunk;
          }
        } finally {
          await reader.close();
        }
        if (seen !== declared) {
          throw new CollaborationError('conflict', 'artifact_changed', { path: entry.path });
        }
        if (entry.sha256 !== hash.digest('hex')) {
          throw new CollaborationError('conflict', 'artifact_checksum', { path: entry.path });
        }
      } else {
        yield lengthPrefix(0);
        const payload = entry.kind === 'symlink'
          ? Buffer.from(entry.target, 'utf8')
          : Buffer.alloc(0);
        if (entry.sha256 !== sha256Of(payload)) {
          throw new CollaborationError('conflict', 'artifact_checksum', { path: entry.path });
        }
      }
      yield lengthPrefix(Buffer.byteLength(JSON.stringify({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        target: entry.kind === 'symlink' ? entry.target : null,
        contentBytes: entry.kind === 'file' ? entry.contentBytes : 0,
        sha256: entry.sha256,
        tracked: entry.tracked,
      }), 'utf8'));
      yield Buffer.from(JSON.stringify({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        target: entry.kind === 'symlink' ? entry.target : null,
        contentBytes: entry.kind === 'file' ? entry.contentBytes : 0,
        sha256: entry.sha256,
        tracked: entry.tracked,
      }), 'utf8');
    }
  }

  return {
    async open() {
      const iterator = stream()[Symbol.asyncIterator]();
      let pending = Buffer.alloc(0);
      return {
        async read(maxBytes) {
          let out = pending.length > 0 ? pending : Buffer.alloc(0);
          pending = Buffer.alloc(0);
          while (out.length < maxBytes) {
            const next = await iterator.next();
            if (next.done === true) break;
            out = out.length === 0 ? next.value : Buffer.concat([out, next.value]);
          }
          if (out.length === 0) return null;
          if (out.length <= maxBytes) return out;
          pending = out.subarray(maxBytes);
          return out.subarray(0, maxBytes);
        },
        async close() {
          await iterator.return?.();
        },
      };
    },
  };
}

/** Parse an artifact back into its header and its entries WITH their payloads. */
function parseArtifact(bytes) {
  if (!Buffer.isBuffer(bytes)) {
    throw new CollaborationError('invalid_request', 'artifact_bytes');
  }
  if (bytes.length > ARTIFACT_LIMITS.maxArtifactBytes) {
    throw new CollaborationError('conflict', 'artifact_oversize', {
      limit: ARTIFACT_LIMITS.maxArtifactBytes,
      observed: bytes.length,
    });
  }
  const newline = bytes.indexOf(0x0a);
  if (newline <= 0) {
    throw new CollaborationError('invalid_request', 'artifact_header');
  }
  let header;
  try {
    header = JSON.parse(bytes.subarray(0, newline).toString('utf8'));
  } catch {
    throw new CollaborationError('invalid_request', 'artifact_header');
  }
  if (header === null || typeof header !== 'object' || Array.isArray(header)
    || header.schemaVersion !== ARTIFACT_SCHEMA_VERSION
    || typeof header.baseCommit !== 'string' || !COMMIT_PATTERN.test(header.baseCommit)
    || !Number.isSafeInteger(header.entryCount) || header.entryCount < 0
    || header.entryCount > ARTIFACT_LIMITS.maxPathEntries
    || !Array.isArray(header.paths) || header.paths.length !== header.entryCount) {
    throw new CollaborationError('invalid_request', 'artifact_header');
  }
  let offset = newline + 1;
  const entries = [];
  const paths = [];
  for (let index = 0; index < header.entryCount; index += 1) {
    if (offset + 4 > bytes.length) {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    const contentBytes = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + contentBytes > bytes.length) {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    const content = bytes.subarray(offset, offset + contentBytes);
    offset += contentBytes;
    if (offset + 4 > bytes.length) {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    const jsonLength = bytes.readUInt32BE(offset);
    offset += 4;
    if (offset + jsonLength > bytes.length) {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    let record;
    try {
      record = JSON.parse(bytes.subarray(offset, offset + jsonLength).toString('utf8'));
    } catch {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    offset += jsonLength;
    if (record === null || typeof record !== 'object' || Array.isArray(record)
      || !CHANGE_KINDS.includes(record.kind) || typeof record.path !== 'string'
      || typeof record.mode !== 'number' || !Number.isSafeInteger(record.mode)
      || record.mode < 0 || record.mode > 0o7777 || typeof record.tracked !== 'boolean'
      || typeof record.contentBytes !== 'number' || record.contentBytes !== contentBytes
      || typeof record.sha256 !== 'string' || !HASH_PATTERN.test(record.sha256)) {
      throw new CollaborationError('invalid_request', 'artifact_structure');
    }
    if (record.kind === 'symlink') {
      if (typeof record.target !== 'string' || record.target.length === 0
        || record.target.length > ARTIFACT_LIMITS.maxPathChars
        || record.target.includes('\0') || sha256Of(Buffer.from(record.target, 'utf8')) !== record.sha256) {
        throw new CollaborationError('invalid_request', 'artifact_structure');
      }
    } else {
      if (record.target !== null || sha256Of(content) !== record.sha256) {
        throw new CollaborationError('invalid_request', 'artifact_structure');
      }
    }
    entries.push(Object.freeze({
      path: record.path,
      kind: record.kind,
      mode: record.mode,
      target: record.kind === 'symlink' ? record.target : null,
      contentBytes,
      sha256: record.sha256,
      tracked: record.tracked,
      content: Buffer.from(content),
    }));
    paths.push(record.path);
  }
  if (offset !== bytes.length) {
    throw new CollaborationError('invalid_request', 'artifact_structure');
  }
  // The manifest in the header must be exactly the sorted, unique set of paths the records carry.
  if (paths.length !== header.paths.length) {
    throw new CollaborationError('invalid_request', 'artifact_manifest');
  }
  for (let index = 0; index < paths.length; index += 1) {
    if (paths[index] !== header.paths[index]) {
      throw new CollaborationError('invalid_request', 'artifact_manifest');
    }
  }
  return Object.freeze({ header: Object.freeze(header), entries: Object.freeze(entries) });
}

/* ------------------------------------------------------------------ git plumbing */

/** Enumerate the writer's change set from the leased worktree, using git in that worktree. */
async function readChangeSet(runGit, cwd, baseCommit) {
  const head = await runGit({ cwd, args: ['rev-parse', '--verify', 'HEAD'] });
  if (head.exitCode !== 0) {
    throw new CollaborationError('source_unavailable', 'writer_head', {
      cwd,
      stderr: head.stderr.slice(0, 512),
    });
  }
  if (head.stdout.trim() !== baseCommit) {
    throw new CollaborationError('conflict', 'artifact_base_moved', {
      expected: baseCommit,
      observed: head.stdout.trim(),
    });
  }
  const tracked = await runGit({ cwd, args: ['ls-files', '-z'] });
  if (tracked.exitCode !== 0) {
    throw new CollaborationError('source_unavailable', 'writer_tracked', {
      cwd,
      stderr: tracked.stderr.slice(0, 512),
    });
  }
  const trackedSet = new Set(tracked.stdout.split('\0').filter((entry) => entry.length > 0));
  const status = await runGit({
    cwd,
    args: ['status', '--porcelain=v1', '-z', '--untracked-files=all'],
  });
  if (status.exitCode !== 0) {
    throw new CollaborationError('source_unavailable', 'writer_status', {
      cwd,
      stderr: status.stderr.slice(0, 512),
    });
  }

  const fields = status.stdout.split('\0');
  const pending = new Map();
  let index = 0;
  while (index < fields.length) {
    const field = fields[index];
    index += 1;
    if (field.length < 4) continue;
    const xy = field.slice(0, 2);
    const entryPath = field.slice(3);
    if (entryPath.length === 0) continue;
    let original = null;
    if (xy.includes('R') || xy.includes('C')) {
      original = fields[index];
      index += 1;
      if (typeof original !== 'string' || original.length === 0) {
        throw new CollaborationError('source_unavailable', 'writer_status');
      }
      pending.set(original, { path: original, kind: 'delete' });
    }
    pending.set(entryPath, { path: entryPath });
  }

  const entries = [];
  for (const wanted of [...pending.keys()].sort(comparePaths)) {
    const absolute = path.join(cwd, wanted);
    let info;
    try {
      info = await fs.lstat(absolute);
    } catch (error) {
      if (error?.code !== 'ENOENT') {
        throw new CollaborationError('source_unavailable', 'writer_entry', { path: wanted });
      }
      entries.push(Object.freeze({
        path: wanted,
        kind: 'delete',
        mode: 0,
        target: null,
        contentBytes: 0,
        sha256: sha256Of(Buffer.alloc(0)),
        tracked: trackedSet.has(wanted),
        content: null,
      }));
      continue;
    }
    if (info.isDirectory()) continue;
    if (info.isSymbolicLink()) {
      const target = await fs.readlink(absolute);
      entries.push(Object.freeze({
        path: wanted,
        kind: 'symlink',
        mode: info.mode & 0o7777,
        target,
        contentBytes: 0,
        sha256: sha256Of(Buffer.from(target, 'utf8')),
        tracked: trackedSet.has(wanted),
        content: null,
      }));
      continue;
    }
    if (!info.isFile()) continue;
    const digest = await digestFile(absolute);
    entries.push(Object.freeze({
      path: wanted,
      kind: 'file',
      mode: info.mode & 0o7777,
      target: null,
      contentBytes: digest.bytes,
      sha256: digest.sha256,
      tracked: trackedSet.has(wanted),
      content: createFileSource(absolute),
    }));
  }
  return Object.freeze(entries);
}

/** A streaming per-file digest. Holds one chunk at a time; enforces no ceiling of its own. */
async function digestFile(absolute) {
  const reader = await createFileSource(absolute).open();
  const hash = createHash('sha256');
  let bytes = 0;
  try {
    for (;;) {
      const chunk = await reader.read(ARTIFACT_LIMITS.chunkBytes);
      if (chunk === null || chunk === undefined) break;
      bytes += chunk.length;
      hash.update(chunk);
    }
  } finally {
    await reader.close();
  }
  return Object.freeze({ sha256: hash.digest('hex'), bytes });
}

/* ------------------------------------------------------------------ the service */

export function createArtifactService(options = {}) {
  if (options === null || typeof options !== 'object') {
    throw new CollaborationError('invalid_request', 'artifact_service_options');
  }
  if (options.store === null || typeof options.store !== 'object') {
    throw new CollaborationError('invalid_request', 'artifact_store');
  }
  const store = options.store;
  const root = typeof options.root === 'string' && options.root.length > 0
    ? options.root
    : (() => {
      throw new CollaborationError('invalid_request', 'artifact_service_root');
    })();
  const fsLike = options.fs ?? fs;
  const runGit = options.runGit ?? createGitRunner(options);
  const stats = { captures: 0, applies: 0, emptyRefusals: 0 };
  let closed = false;

  function assertOpen() {
    if (closed) throw new CollaborationError('cancelled', 'artifact_service_closed');
  }

  function requireLease(lease) {
    if (lease === null || typeof lease !== 'object' || typeof lease.leaseId !== 'string'
      || typeof lease.nativeCwd !== 'string' || typeof lease.baseCommit !== 'string'
      || typeof lease.worktree !== 'string'
      || lease.policy === null || typeof lease.policy !== 'object') {
      throw new CollaborationError('invalid_request', 'writer_lease');
    }
    if (!COMMIT_PATTERN.test(lease.baseCommit)) {
      throw new CollaborationError('invalid_request', 'artifact_base_commit');
    }
    return lease;
  }

  /**
   * Capture the writer's complete change set into one immutable artifact. The manifest reported
   * back is read OUT of the stored object, so the hash, the manifest and the bytes are the same
   * thing by construction rather than by assertion.
   */
  async function capture(input = {}) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'artifact_capture');
    }
    const lease = requireLease(input.lease);
    if (lease.policy.worktreeAccess === 'read-only') {
      throw new CollaborationError('unsupported', 'writer_lease_read_only', {
        leaseId: lease.leaseId,
      });
    }
    const at = parseAt(input.at);
    const entries = await readChangeSet(runGit, lease.nativeCwd, lease.baseCommit);
    if (entries.length === 0) {
      // Nothing to record is NOT an empty artifact: a patch is never fabricated.
      stats.emptyRefusals += 1;
      throw new CollaborationError('conflict', 'artifact_empty', {
        leaseId: lease.leaseId,
        baseCommit: lease.baseCommit,
      });
    }
    const stored = await store.write({
      source: serialize({ baseCommit: lease.baseCommit, entries }),
    });
    // Read the manifest back out of the durable object, so what is reported is what is stored.
    const parsed = parseArtifact(await store.read(stored.artifactHash));
    stats.captures += 1;
    const manifest = parsed.entries.map((entry) => Object.freeze({
      path: entry.path,
      kind: entry.kind,
      mode: entry.mode,
      target: entry.target,
      contentBytes: entry.contentBytes,
      sha256: entry.sha256,
      tracked: entry.tracked,
    }));
    return Object.freeze({
      artifactHash: stored.artifactHash,
      baseCommit: lease.baseCommit,
      leaseId: lease.leaseId,
      worktree: lease.worktree,
      nativeCwd: lease.nativeCwd,
      bytes: stored.bytes,
      chunks: stored.chunks,
      peakBufferedBytes: stored.peakBufferedBytes,
      entryCount: manifest.length,
      pathCount: manifest.length,
      paths: Object.freeze(manifest.map((entry) => entry.path)),
      manifest: Object.freeze(manifest),
      capturedAt: at,
    });
  }

  /**
   * Reproduce an artifact inside a target directory. Every path is re-validated against the target
   * as it is read off the wire, so a crafted object cannot reach outside it. Creates and overwrites
   * run first, deletions last, so a path is never removed before its replacement is written.
   */
  async function apply(input, target, options_) {
    assertOpen();
    if (input === null || typeof input !== 'object') {
      throw new CollaborationError('invalid_request', 'artifact_apply');
    }
    const dryRun = options_?.dryRun === true;
    let bytes;
    let artifactHash;
    if (typeof input.artifactHash === 'string') {
      bytes = await store.read(input.artifactHash);
      artifactHash = input.artifactHash;
    } else if (Buffer.isBuffer(input.artifact)) {
      bytes = input.artifact;
      artifactHash = (await hashSource(createBufferSource(bytes))).artifactHash;
    } else {
      throw new CollaborationError('invalid_request', 'artifact_apply');
    }
    const parsed = parseArtifact(bytes);
    if (typeof target !== 'string' || target.trim().length === 0) {
      throw new CollaborationError('invalid_request', 'artifact_target');
    }
    const applyRoot = path.resolve(root, target.trim());
    const info = await fsLike.lstat(applyRoot);
    if (!info.isDirectory()) {
      throw new CollaborationError('invalid_request', 'artifact_target');
    }
    // Validate EVERY path before touching the disk, so a refusal leaves the target untouched.
    const plan = parsed.entries.map((entry) =>
      Object.freeze({ entry, resolved: validateArtifactPath(entry.path, applyRoot) }));
    if (dryRun) {
      stats.applies += 1;
      return Object.freeze({
        artifactHash,
        baseCommit: parsed.header.baseCommit,
        applied: 0,
        paths: Object.freeze(parsed.entries.map((entry) => entry.path)),
        wouldCreate: Object.freeze(plan
          .filter((step) => step.entry.kind !== 'delete')
          .map((step) => step.entry.path)),
        wouldDelete: Object.freeze(plan
          .filter((step) => step.entry.kind === 'delete')
          .map((step) => step.entry.path)),
      });
    }
    for (const step of plan) {
      if (step.entry.kind === 'delete') continue;
      if (step.entry.kind === 'symlink') {
        await fsLike.rm(step.resolved, { force: true, recursive: true });
        await fsLike.symlink(step.entry.target, step.resolved);
        continue;
      }
      await fsLike.mkdir(path.dirname(step.resolved), { recursive: true });
      await fsLike.rm(step.resolved, { force: true, recursive: true });
      await fsLike.writeFile(step.resolved, step.entry.content);
      await fsLike.chmod(step.resolved, step.entry.mode);
    }
    for (const step of plan) {
      if (step.entry.kind !== 'delete') continue;
      await fsLike.rm(step.resolved, { force: true, recursive: true });
    }
    stats.applies += 1;
    return Object.freeze({
      artifactHash,
      baseCommit: parsed.header.baseCommit,
      applied: plan.length,
      paths: Object.freeze(parsed.entries.map((entry) => entry.path)),
    });
  }

  /** Read an artifact back as a frozen change set (no payloads). */
  function deserialize(bytes) {
    const parsed = parseArtifact(bytes);
    return Object.freeze({
      schemaVersion: parsed.header.schemaVersion,
      baseCommit: parsed.header.baseCommit,
      entryCount: parsed.header.entryCount,
      contentBytes: parsed.entries.reduce((total, entry) => total + entry.contentBytes, 0),
      paths: Object.freeze(parsed.entries.map((entry) => entry.path)),
      entries: Object.freeze(parsed.entries.map((entry) => Object.freeze({
        path: entry.path,
        kind: entry.kind,
        mode: entry.mode,
        target: entry.target,
        contentBytes: entry.contentBytes,
        sha256: entry.sha256,
        tracked: entry.tracked,
      }))),
    });
  }

  function state() {
    return Object.freeze({ ...stats, closed });
  }

  function close() {
    closed = true;
  }

  return {
    ARTIFACT_SCHEMA_VERSION,
    CHANGE_KINDS,
    capture,
    apply,
    serialize,
    deserialize,
    state,
    close,
  };
}
