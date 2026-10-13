import { createHash, randomUUID } from 'node:crypto';
import { statfsSync } from 'node:fs';
import { mkdir, open, readFile, readdir, rename } from 'node:fs/promises';
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
 *  3. **locking**   — a single owner holds the fence; a competing live writer gets
 *                     `conflict` (never a silent second writer), a reader opens read-only.
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

/**
 * Verifies that `root` sits on a disk the control store may trust. A known network or
 * cluster filesystem is refused with `unsupported`; an unrecognized type is accepted as a
 * best-effort local disk (the plan only forbids the *shared disk* as the local DB).
 */
export async function verifyLocalFilesystem(options = {}) {
  const root = path.resolve(textValue(options.root, 'store.root'));
  const platform = options.platform ?? process.platform;
  const statfs = options.statfs ?? defaultStatfs;
  let stats;
  try {
    stats = await statfs(root);
  } catch {
    stats = undefined;
  }
  const type = stats?.type;
  const klass = filesystemClass(type, platform);
  if (klass === 'network') throw new ProtocolError('unsupported', 'store.filesystem');
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

  let opened = false;
  let writable = false;
  let epoch = 0;
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

  async function openStore(mode = 'owner') {
    requireValue(mode === 'owner' || mode === 'readonly', 'store.mode');
    await verifyLocalFilesystem({ root, platform, statfs });
    await mkdir(root, { recursive: true, mode: 0o700 });
    await mkdir(intentsDirectory, { recursive: true, mode: 0o700 });
    await loadJournal();

    const existing = await readFence();
    epoch = existing?.epoch ?? 0;
    if (existing !== undefined && existing.released !== true) {
      const foreignLive = existing.ownerInstanceId !== ownerInstanceId && defaultAlive(existing.pid);
      if (foreignLive) {
        if (mode === 'owner') throw new ProtocolError('conflict', 'store.fence');
        opened = true;
        writable = false;
        return status();
      }
      epoch = existing.epoch;
    }
    if (mode === 'readonly') {
      opened = true;
      writable = false;
      return status();
    }
    writable = true;
    await writeFence(false);
    await appendJournal({ type: 'store.opened', ownerInstanceId, epoch });
    opened = true;
    return status();
  }

  async function close() {
    if (!opened) return status();
    if (writable) {
      await appendJournal({ type: 'store.closed', epoch });
      await writeFence(true);
    }
    opened = false;
    writable = false;
    return status();
  }

  async function bumpEpoch(input = {}) {
    requireWritable();
    epoch += 1;
    await writeFence(false);
    await appendJournal({ type: 'epoch.bumped', epoch, reason: input.reason ?? null });
    return epoch;
  }

  async function writeIntent(intent) {
    requireWritable();
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
    requireWritable();
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
