import { createHash, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename, rm, stat } from 'node:fs/promises';
import path from 'node:path';

import { ProtocolError, requireValue, textValue } from '../../../shared/runtime/capabilities.js';
import { parseEnvironmentId } from '../../../shared/runtime/identity.js';

/**
 * Durable Slurm control store, owned by the login-side `--role=control-store` bridge.
 *
 * The plan (Scope 12 / Metis closure) forbids putting the Runtime DB on an unverified
 * NFS/Lustre share: a shared disk is never silently treated as a local SQLite disk. This
 * module is the login-local persistence contract for the recoverable job journal, and it
 * enforces the four properties the acceptance criteria name:
 *
 *  1. **localFS**   — `verifyLocalFilesystem` classifies the mount and rejects a known
 *                     network/cluster filesystem before any byte is written.
 *  2. **permissions**— the root and intent files are created 0700/0600.
 *  3. **locking**   — a single owner holds the fence behind an atomic cross-instance /
 *                     cross-process lock; a competing live writer gets `conflict` (never a
 *                     silent second writer), a reader opens read-only, and every write and
 *                     the release re-verify this instance's owner/epoch.
 *  4. **integrity** — every mutation appends to a hash-chained journal that
 *                     `verifyIntegrity` recomputes, so tampering is detected, not trusted.
 *
 * The fencing epoch is monotonic per environment: a requeued compute node bumps the epoch
 * and the previous owner is fenced out (`bumpEpoch`). Only the control store writes here;
 * the compute Runtime reaches it through the login-owned relay (task 29), never directly.
 */
export const CONTROL_STORE_SCHEMA_VERSION = 1;

export const CONTROL_STORE_FILES = Object.freeze({
  journal: 'journal.jsonl',
  intents: 'intents',
  fence: 'fence.json',
});

/**
 * The owner lock is a directory created with `mkdir` (atomic `O_EXCL`-equivalent) — the only
 * primitive Node exposes that is exclusive across instances and processes. Its metadata names
 * the holder's pid, owner and epoch. A lock whose holder is gone is reclaimed by an atomic
 * `rename` guarded by a per-holder mutex, so no two reclaimers can ever steal a fresh lock.
 */
const LOCK_DIRECTORY_NAME = 'owner.lock';
const LOCK_METADATA_NAME = 'owner.json';
const LOCK_ACQUIRE_ATTEMPTS = 50;
const LOCK_RETRY_DELAY_MS = 20;
const STALE_LOCK_MS = 60_000;


/** Linux `statfs(2)` magic numbers for filesystems a shared/cluster mount would report. */
export const NETWORK_FILESYSTEM_MAGIC = Object.freeze({
  0x6969: 'nfs',
  0xfe534d42: 'smb2',
  0xff534d42: 'cifs',
  0x517b: 'smb',
  0x0bd00bd0: 'lustre',
  0x00c36400: 'ceph',
  0x01161970: 'glusterfs',
  0x01021997: '9p',
  0x65735546: 'fuse', // typically sshfs/rclone/network shims; not a verified local disk
  0x73757245: 'coda',
  0x564c: 'ncp',
  0x5346414f: 'afs',
});

/** Linux magic numbers for known local disk/volatile filesystems. */
export const LOCAL_FILESYSTEM_MAGIC = Object.freeze({
  0xef53: 'ext2/3/4',
  0x58465342: 'xfs',
  0x9123683e: 'btrfs',
  0x01021994: 'tmpfs',
  0x2fc12fc1: 'zfs',
  0xf2f52010: 'f2fs',
  0x794c7630: 'overlay',
  0x4244: 'hfs',
  0x1a1901: 'ntfs',
  0x4d44: 'msdos',
  0x2011bab0: 'exfat',
  0x27e0eb: 'cgroup',
  0x63677270: 'cgroup2',
  0x958458f6: 'hugetlbfs',
  0x1373: 'devfs',
  0x9fa0: 'proc',
  0x62656572: 'sysfs',
  0x62656570: 'configfs',
  0x73717368: 'squashfs',
  0x858458f6: 'ramfs',
});

const JOURNAL_GENESIS = 'genesis';

function sha256(input) {
  return createHash('sha256').update(input).digest('hex');
}

/** Classifies a `statfs` type number. `unknown` means "no network evidence", not "local". */
export function filesystemClass(type, platform = process.platform) {
  if (type === undefined || type === null || typeof type !== 'number') return 'unknown';
  if (platform !== 'linux') return 'unknown';
  if (Object.hasOwn(NETWORK_FILESYSTEM_MAGIC, type)) return 'network';
  if (Object.hasOwn(LOCAL_FILESYSTEM_MAGIC, type)) return 'local';
  return 'unknown';
}

export function filesystemName(type, platform = process.platform) {
  if (typeof type !== 'number') return null;
  if (platform !== 'linux') return null;
  return NETWORK_FILESYSTEM_MAGIC[type] ?? LOCAL_FILESYSTEM_MAGIC[type] ?? null;
}

export function isNetworkFilesystem(type, platform = process.platform) {
  return filesystemClass(type, platform) === 'network';
}

function defaultStatfs(target) {
  try {
    return statfsSync(target);
  } catch {
    return undefined;
  }
}

function* ancestorPaths(target) {
  let current = target;
  for (;;) {
    yield current;
    const parent = path.dirname(current);
    if (parent === current) return;
    current = parent;
  }
}

async function probeStatfs(statfs, target) {
  try {
    return await statfs(target);
  } catch {
    return undefined;
  }
}

/**
 * Verifies that `root` sits on a disk the control store may trust.
 *
 * The root may not exist yet, so the probe walks up to the nearest existing ancestor and
 * classifies that mount; a not-yet-created root must not slip past the network filesystem
 * rejection because statfs cannot read the target path. A known network/cluster filesystem is
 * refused with `unsupported`; a probe that classifies no ancestor at all is never accepted as
 * verified local storage (on linux it is refused outright). Callers re-run this after creating
 * the root so a mount that appears on creation is caught too.
 */
export async function verifyLocalFilesystem(options = {}) {
  const root = path.resolve(textValue(options.root, 'store.root'));
  const platform = options.platform ?? process.platform;
  const statfs = options.statfs ?? defaultStatfs;
  let probed = false;
  let type;
  for (const candidate of ancestorPaths(root)) {
    const stats = await probeStatfs(statfs, candidate);
    if (stats === undefined) continue;
    probed = true;
    type = stats.type;
    break;
  }
  const klass = filesystemClass(type, platform);
  if (klass === 'network') throw new ProtocolError('unsupported', 'store.filesystem');
  if (!probed && platform === 'linux') throw new ProtocolError('unsupported', 'store.filesystem');
  return Object.freeze({
    root,
    type: typeof type === 'number' ? type : null,
    name: filesystemName(type, platform),
    filesystemClass: klass,
  });
}

function isMissingFileError(error) {
  return error instanceof Error && 'code' in error && error.code === 'ENOENT';
}

function isAlreadyExistsError(error) {
  return error instanceof Error && 'code' in error && error.code === 'EEXIST';
}

function delay(ms) {
  return new Promise((resolve) => {
    setTimeout(resolve, ms);
  });
}

async function readJsonFile(file) {
  try {
    return JSON.parse(await readFile(file, 'utf8'));
  } catch (error) {
    if (isMissingFileError(error)) return undefined;
    throw error;
  }
}

async function writeJsonDurable(file, value) {
  const temporary = `${file}.tmp-${process.pid}-${randomUUID()}`;
  const handle = await open(temporary, 'wx', 0o600);
  try {
    await handle.writeFile(`${JSON.stringify(value)}\n`, 'utf8');
    await handle.sync();
  } finally {
    await handle.close();
  }
  await rename(temporary, file);
}

/**
 * Creates the durable control store. Injected `statfs`, `platform`, `isProcessAlive` and
 * `clock` are the only boundaries; tests drive real files under a temp root and fake only
 * the filesystem-type and process-liveness probes.
 */
export function createSlurmControlStore(options = {}) {
  const root = path.resolve(textValue(options.root, 'store.root'));
  const environmentId = parseEnvironmentId(options.environmentId);
  const ownerInstanceId = textValue(options.ownerInstanceId, 'store.ownerInstanceId');
  const platform = options.platform ?? process.platform;
  const statfs = options.statfs ?? defaultStatfs;
  const clock = options.clock ?? (() => Date.now());
  const defaultAlive =
    options.isProcessAlive ??
    ((pid) => {
      try {
        process.kill(pid, 0);
        return true;
      } catch {
        return false;
      }
    });

  const journalPath = path.join(root, CONTROL_STORE_FILES.journal);
  const intentsDirectory = path.join(root, CONTROL_STORE_FILES.intents);
  const fencePath = path.join(root, CONTROL_STORE_FILES.fence);
  const lockDirectoryPath = path.join(root, LOCK_DIRECTORY_NAME);
  const lockMetadataPath = path.join(lockDirectoryPath, LOCK_METADATA_NAME);

  let opened = false;
  let writable = false;
  let epoch = 0;
  let lockId = null;
  let journalSequence = 0;
  let lastJournalHash = JOURNAL_GENESIS;

  function status() {
    return Object.freeze({ opened, writable, epoch, environmentId, ownerInstanceId, root });
  }

  function requireWritable() {
    requireValue(opened, 'store.open', 'unauthorized');
    requireValue(writable, 'store.readonly', 'unauthorized');
  }

  function intentPath(intentId) {
    return path.join(intentsDirectory, `${textValue(intentId, 'store.intentId')}.json`);
  }

  async function loadJournal() {
    journalSequence = 0;
    lastJournalHash = JOURNAL_GENESIS;
    let text;
    try {
      text = await readFile(journalPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return;
      throw error;
    }
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      const record = JSON.parse(line);
      journalSequence = record.seq;
      lastJournalHash = record.hash;
    }
  }

  async function appendJournal(record) {
    journalSequence += 1;
    const base = { seq: journalSequence, at: new Date(clock()).toISOString(), ...record };
    const hash = sha256(`${lastJournalHash}\n${JSON.stringify(base)}`);
    const line = JSON.stringify({ ...base, prevHash: lastJournalHash, hash });
    lastJournalHash = hash;
    const handle = await open(journalPath, 'a', 0o600);
    try {
      await handle.writeFile(`${line}\n`, 'utf8');
      await handle.sync();
    } finally {
      await handle.close();
    }
  }

  async function readFence() {
    const fence = await readJsonFile(fencePath);
    if (fence === undefined) return undefined;
    requireValue(fence.schemaVersion === CONTROL_STORE_SCHEMA_VERSION, 'store.fence.version', 'conflict');
    requireValue(fence.environmentId === environmentId, 'store.environment', 'conflict');
    return fence;
  }

  async function writeFence(released) {
    await writeJsonDurable(fencePath, {
      schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
      environmentId,
      ownerInstanceId,
      pid: process.pid,
      epoch,
      released: released === true,
      openedAt: new Date(clock()).toISOString(),
    });
  }

  function lockRecord() {
    return {
      schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
      environmentId,
      ownerInstanceId,
      pid: process.pid,
      lockId,
      epoch,
      acquiredAt: new Date(clock()).toISOString(),
    };
  }

  async function readOwnershipLock() {
    let text;
    try {
      text = await readFile(lockMetadataPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return undefined;
      throw error;
    }
    try {
      return JSON.parse(text);
    } catch {
      // The creator is mid-write; callers treat an unparsable record as "not yet readable".
      return undefined;
    }
  }

  async function lockDirectoryIsStale() {
    try {
      const info = await stat(lockDirectoryPath);
      return Date.now() - info.mtimeMs > STALE_LOCK_MS;
    } catch (error) {
      return isMissingFileError(error);
    }
  }

  // A reclaim is an atomic rename guarded by a per-holder mutex, so two processes that both
  // see the same dead holder cannot both rename away a lock the other just re-created.
  async function reclaimLockDirectory(mutexKey) {
    const mutexPath = `${lockDirectoryPath}.reclaim-${mutexKey}`;
    try {
      await mkdir(mutexPath, { mode: 0o700 });
    } catch (error) {
      if (isAlreadyExistsError(error)) return false;
      throw error;
    }
    try {
      const holder = await readOwnershipLock();
      if (holder !== undefined && defaultAlive(holder.pid)) return false;
      const grave = `${lockDirectoryPath}.stale-${randomUUID()}`;
      try {
        await rename(lockDirectoryPath, grave);
      } catch (error) {
        if (isMissingFileError(error)) return true;
        throw error;
      }
      await rm(grave, { recursive: true, force: true });
      return true;
    } finally {
      await rm(mutexPath, { recursive: true, force: true });
    }
  }

  async function acquireOwnershipLock() {
    for (let attempt = 0; attempt < LOCK_ACQUIRE_ATTEMPTS; attempt += 1) {
      try {
        await mkdir(lockDirectoryPath, { mode: 0o700 });
        lockId = randomUUID();
        await writeJsonDurable(lockMetadataPath, lockRecord());
        return true;
      } catch (error) {
        if (!isAlreadyExistsError(error)) throw error;
      }
      const holder = await readOwnershipLock();
      if (holder === undefined) {
        if (await lockDirectoryIsStale()) await reclaimLockDirectory('orphan');
        else await delay(LOCK_RETRY_DELAY_MS);
        continue;
      }
      if (defaultAlive(holder.pid)) return false;
      if (!(await reclaimLockDirectory(holder.lockId))) await delay(LOCK_RETRY_DELAY_MS);
    }
    return false;
  }

  async function updateOwnershipLock() {
    const holder = await readOwnershipLock();
    requireValue(
      holder !== undefined && holder.ownerInstanceId === ownerInstanceId && holder.lockId === lockId,
      'store.lock',
      'conflict',
    );
    await writeJsonDurable(lockMetadataPath, lockRecord());
  }

  async function releaseOwnershipLock() {
    const holder = await readOwnershipLock();
    if (holder !== undefined && (holder.ownerInstanceId !== ownerInstanceId || holder.lockId !== lockId)) {
      throw new ProtocolError('conflict', 'store.lock');
    }
    await rm(lockDirectoryPath, { recursive: true, force: true });
    lockId = null;
  }

  async function assertOwnership() {
    requireWritable();
    const fence = await readFence();
    requireValue(
      fence !== undefined && fence.ownerInstanceId === ownerInstanceId && fence.epoch === epoch && fence.released !== true,
      'store.fence',
      'conflict',
    );
    const holder = await readOwnershipLock();
    requireValue(
      holder !== undefined && holder.ownerInstanceId === ownerInstanceId && holder.lockId === lockId && holder.epoch === epoch,
      'store.lock',
      'conflict',
    );
  }

  async function openStore(mode = 'owner') {
    requireValue(mode === 'owner' || mode === 'readonly', 'store.mode');
    // Probe the nearest existing ancestor, then re-confirm once the root exists.
    await verifyLocalFilesystem({ root, platform, statfs });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(intentsDirectory, { recursive: true, mode: 0o700 });
    await verifyLocalFilesystem({ root, platform, statfs });
    await loadJournal();

    const existing = await readFence();
    epoch = existing?.epoch ?? 0;
    const liveForeignFence = existing !== undefined
      && existing.released !== true
      && existing.ownerInstanceId !== ownerInstanceId
      && defaultAlive(existing.pid);

    if (mode === 'readonly') {
      opened = true;
      writable = false;
      return status();
    }
    if (liveForeignFence) throw new ProtocolError('conflict', 'store.fence');

    if (!(await acquireOwnershipLock())) throw new ProtocolError('conflict', 'store.fence');

    // Re-read the fence under the exclusive lock: another owner may have taken over between
    // the pre-lock read and acquiring the lock.
    const current = await readFence();
    if (current !== undefined
      && current.released !== true
      && current.ownerInstanceId !== ownerInstanceId
      && defaultAlive(current.pid)) {
      await releaseOwnershipLock();
      throw new ProtocolError('conflict', 'store.fence');
    }
    epoch = current?.epoch ?? epoch;
    await updateOwnershipLock();
    writable = true;
    await writeFence(false);
    await appendJournal({ type: 'store.opened', ownerInstanceId, epoch });
    opened = true;
    return status();
  }

  async function close() {
    if (!opened) return status();
    if (writable) {
      try {
        await assertOwnership();
      } catch (error) {
        opened = false;
        writable = false;
        lockId = null;
        throw error;
      }
      await appendJournal({ type: 'store.closed', epoch });
      await writeFence(true);
      await releaseOwnershipLock();
    }
    opened = false;
    writable = false;
    return status();
  }

  async function bumpEpoch(input = {}) {
    await assertOwnership();
    epoch += 1;
    await writeFence(false);
    await updateOwnershipLock();
    await appendJournal({ type: 'epoch.bumped', epoch, reason: input.reason ?? null });
    return epoch;
  }

  async function writeIntent(intent) {
    await assertOwnership();
    requireValue(intent !== null && typeof intent === 'object' && !Array.isArray(intent), 'store.intent');
    const intentId = textValue(intent.intentId, 'store.intentId');
    const record = Object.freeze({
      schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
      environmentId,
      ...intent,
      intentId,
    });
    await writeJsonDurable(intentPath(intentId), record);
    await appendJournal({ type: 'intent.written', intentId, state: record.state ?? null });
    return record;
  }

  async function updateIntent(intentId, patch) {
    await assertOwnership();
    const current = await readIntent(intentId);
    requireValue(current !== undefined, 'store.intent', 'source_unavailable');
    requireValue(patch !== null && typeof patch === 'object' && !Array.isArray(patch), 'store.patch');
    const next = Object.freeze({ ...current, ...patch, intentId: current.intentId, environmentId });
    await writeJsonDurable(intentPath(current.intentId), next);
    await appendJournal({ type: 'intent.updated', intentId: current.intentId, state: next.state ?? null });
    return next;
  }

  async function readIntent(intentId) {
    const record = await readJsonFile(intentPath(intentId));
    if (record === undefined) return undefined;
    requireValue(record.environmentId === environmentId, 'store.environment', 'conflict');
    return Object.freeze(record);
  }

  async function listIntents() {
    let entries;
    try {
      entries = await readdir(intentsDirectory);
    } catch (error) {
      if (isMissingFileError(error)) return Object.freeze([]);
      throw error;
    }
    const intents = [];
    for (const entry of entries.sort()) {
      if (!entry.endsWith('.json')) continue;
      const record = await readIntent(entry.slice(0, -'.json'.length));
      if (record !== undefined) intents.push(record);
    }
    return Object.freeze(intents);
  }

  async function verifyIntegrity() {
    let text;
    try {
      text = await readFile(journalPath, 'utf8');
    } catch (error) {
      if (isMissingFileError(error)) return Object.freeze({ ok: true, records: 0, lastHash: JOURNAL_GENESIS });
      throw error;
    }
    let previous = JOURNAL_GENESIS;
    let records = 0;
    for (const line of text.split('\n')) {
      if (line.trim() === '') continue;
      let record;
      try {
        record = JSON.parse(line);
      } catch {
        throw new ProtocolError('conflict', 'store.integrity');
      }
      const { prevHash, hash, ...base } = record;
      if (prevHash !== previous || hash !== sha256(`${previous}\n${JSON.stringify(base)}`)) {
        throw new ProtocolError('conflict', 'store.integrity');
      }
      previous = hash;
      records += 1;
    }
    return Object.freeze({ ok: true, records, lastHash: previous });
  }

  return {
    root,
    environmentId,
    ownerInstanceId,
    open: openStore,
    close,
    status,
    bumpEpoch,
    writeIntent,
    updateIntent,
    readIntent,
    listIntents,
    verifyIntegrity,
  };
}
