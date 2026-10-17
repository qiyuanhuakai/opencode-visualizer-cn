// @vitest-environment node
//
// Task 40 — writer leases and complete change artifacts.
//
// Product under test:
//   bridge/runtime/collaboration/writerLeases.js  (explicit worktree / base-commit / native-cwd
//                                                  allocation, read-only+snapshot policy, the
//                                                  reviewer posture, worktree retention)
//   bridge/runtime/collaboration/artifactStore.js (durable content-addressed artifact objects, the
//                                                  frozen 32 MiB ceiling, the STREAMING hash)
//   bridge/runtime/collaboration/artifactService.js (the immutable change artifact: tracked /
//                                                  untracked / binary / mode / symlink-deletion
//                                                  entries, the path manifest, lossless apply)
//   shared/runtime/collaboration.js               (the frozen contract: CollaborationError, parsers)
//
// The three bridge modules under test are loaded through createRequire rather than a static import:
// this task's grant is exactly four new paths and none of them is a declaration file. A static
// import of a .d.ts-less bridge module is TS7016 under the repo's strict vue-tsc gate — the same
// reason task 37's collaborationCoordinator.test.ts, task 38's fanout.test.ts and task 39's
// delegation.test.ts use the require boundary. The contracts below are therefore declared here, in
// the test, and the require boundary is the only untyped edge. shared/runtime/collaboration.js DOES
// ship a sibling declaration file and is imported statically, so its contract is checked by vue-tsc.
//
// ARTIFACT WIRE FORMAT (asserted directly by the adversarial test below, so it is a contract):
//
//   artifact   = headerLine record*
//   headerLine = utf8(JSON.stringify({
//                 schemaVersion, baseCommit, entryCount, paths
//               })) + 0x0A                      // `paths` is the sorted, unique path manifest
//   record     = u32be(contentLength) + content + u32be(jsonLength) + recordJson
//   recordJson = JSON.stringify({
//                 path, kind, mode, target, contentBytes, sha256, tracked
//               })                              // fixed key order, as written
//   content    = the raw entry bytes; `contentLength` of them for kind 'file', 0 otherwise
//   sha256     = sha256 over the payload (for 'symlink': over the utf8 target, 'delete': empty)
//
// Every git / spawn / exec call in this file names its cwd explicitly. No git operation is ever run
// in the QA worktree: every repository below is a private temporary repository under os.tmpdir().
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { EventEmitter } from 'node:events';
import {
  chmod,
  lstat,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  realpath,
  rm,
  stat,
  symlink,
  writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { CollaborationError } from '../../shared/runtime/collaboration.js';

/* ------------------------------------------------------------------ contracts */

type ChangeKind = 'file' | 'symlink' | 'delete';

interface WriterLimits {
  readonly maxWritersPerRepository: number;
  readonly maxActiveLeases: number;
  readonly maxLeaseTtlMs: number;
  readonly maxCwdChars: number;
  readonly maxOwnerChars: number;
  readonly maxRepositoryChars: number;
  readonly maxWorktreeNameChars: number;
}

interface ArtifactLimits {
  readonly maxArtifactBytes: number;
  readonly chunkBytes: number;
  readonly maxPathEntries: number;
  readonly maxPathChars: number;
}

interface LeaseView {
  readonly leaseId: string;
  readonly taskId: string;
  readonly repository: string;
  readonly ownerId: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly nativeCwd: string;
  readonly snapshot: Readonly<{ baseCommit: string; worktree: string; createdAt: number }>;
  readonly policy: Readonly<{ worktreeAccess: 'read-write' | 'read-only'; userRepository: 'read-only' }>;
  readonly state: 'active' | 'released' | 'removed';
  readonly createdAt: number;
  readonly expiresAt: number;
  readonly releasedAt: number | null;
  readonly removedAt: number | null;
}

interface PostureView {
  readonly isolation: 'lease-plus-worktree';
  readonly sandbox: false;
  readonly mechanism: string;
  readonly guarantees: readonly string[];
  readonly notProvided: readonly string[];
  readonly reviewerStatement: string;
}

interface ReleaseView {
  readonly leaseId: string;
  readonly state: 'released';
  readonly releasedAt: number;
  readonly worktree: Readonly<{ path: string; disposition: 'retained' }>;
  readonly userConfirmed: false;
}

interface RetentionView {
  readonly leaseId: string;
  readonly path: string;
  readonly userConfirmed: boolean;
  readonly confirmedAt: number | null;
  readonly removedAt: number | null;
  readonly exists: boolean;
}

interface RunResult {
  readonly exitCode: number;
  readonly signal: string | null;
  readonly stdout: string;
  readonly stderr: string;
}

interface ArtifactSource {
  open(): Promise<ArtifactReader>;
}
interface ArtifactReader {
  read(maxBytes: number): Promise<Buffer | null>;
  close(): Promise<void>;
}

interface DigestView {
  readonly artifactHash: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly peakBufferedBytes: number;
}

interface StoredArtifactView extends DigestView {
  readonly path: string;
  readonly existed: boolean;
}

interface CaptureView {
  readonly artifactHash: string;
  readonly baseCommit: string;
  readonly leaseId: string;
  readonly worktree: string;
  readonly nativeCwd: string;
  readonly bytes: number;
  readonly chunks: number;
  readonly peakBufferedBytes: number;
  readonly entryCount: number;
  readonly pathCount: number;
  readonly paths: readonly string[];
  readonly manifest: readonly ChangeEntry[];
  readonly capturedAt: number;
}

interface ChangeEntry {
  readonly path: string;
  readonly kind: ChangeKind;
  readonly mode: number;
  readonly target: string | null;
  readonly contentBytes: number;
  readonly sha256: string;
  readonly tracked: boolean;
}

interface ChangeEntryInput extends ChangeEntry {
  readonly content?: Buffer | ArtifactSource | null;
}

interface ChangeSetInput {
  readonly baseCommit: string;
  readonly entries: readonly ChangeEntryInput[];
}

interface ChangeSetView {
  readonly schemaVersion: number;
  readonly baseCommit: string;
  readonly entryCount: number;
  readonly contentBytes: number;
  readonly paths: readonly string[];
  readonly entries: readonly ChangeEntry[];
}

interface ApplyView {
  readonly artifactHash: string;
  readonly baseCommit: string;
  readonly applied: number;
  readonly paths: readonly string[];
}

interface WriterLeaseService {
  readonly WRITER_LIMITS: WriterLimits;
  allocate(input: {
    readonly repository: string;
    readonly taskId: string;
    readonly ownerId: string;
    readonly ttlMs?: number;
    readonly at?: number;
    readonly readOnly?: boolean;
  }): Promise<LeaseView>;
  lease(leaseId: string): LeaseView;
  leases(): readonly LeaseView[];
  leasesByRepository(repository: string): readonly LeaseView[];
  nativeCwd(leaseId: string): string;
  assertPathWithinLease(leaseId: string, candidate: string): string;
  posture(leaseId: string): PostureView;
  run(input: {
    readonly leaseId: string;
    readonly command: string;
    readonly args?: readonly string[];
    readonly timeoutMs?: number;
  }): Promise<RunResult>;
  release(input: { readonly leaseId: string; readonly at?: number }): ReleaseView;
  confirmWorktreeRemoval(input: { readonly leaseId: string; readonly at?: number }): RetentionView;
  removeWorktree(input: { readonly leaseId: string; readonly at?: number }): Promise<RetentionView>;
  retention(leaseId: string): Promise<RetentionView>;
  state(): Readonly<{
    active: number;
    released: number;
    removed: number;
    total: number;
    worktreesRetained: number;
    worktreesRemoved: number;
    closed: boolean;
  }>;
  close(): void;
}

interface ArtifactStore {
  readonly ARTIFACT_LIMITS: ArtifactLimits;
  write(input: { readonly source: ArtifactSource }): Promise<StoredArtifactView>;
  read(artifactHash: string): Promise<Buffer>;
  open(artifactHash: string): Promise<ArtifactReader>;
  has(artifactHash: string): Promise<boolean>;
  verify(artifactHash: string): Promise<DigestView & { readonly ok: boolean }>;
  state(): Readonly<{
    writes: number;
    oversizeRejections: number;
    immutableRefusals: number;
    closed: boolean;
  }>;
  close(): void;
}

interface ArtifactService {
  readonly ARTIFACT_SCHEMA_VERSION: number;
  readonly CHANGE_KINDS: readonly ChangeKind[];
  capture(input: { readonly lease: LeaseView; readonly at?: number }): Promise<CaptureView>;
  apply(
    input: { readonly artifactHash: string } | { readonly artifact: Buffer },
    target: string,
    options?: { readonly dryRun?: boolean },
  ): Promise<ApplyView>;
  serialize(changeSet: ChangeSetInput): ArtifactSource;
  deserialize(bytes: Buffer): ChangeSetView;
  state(): Readonly<{ captures: number; applies: number; emptyRefusals: number; closed: boolean }>;
  close(): void;
}

interface WriterLeasesModule {
  readonly WRITER_LIMITS: WriterLimits;
  readonly WRITER_ISOLATION: PostureView;
  readonly POSTURE_KEYS: readonly string[];
  createWriterLeaseService(options: Record<string, unknown>): WriterLeaseService;
  createGitRunner(options: Record<string, unknown>): (input: {
    readonly cwd: string;
    readonly args: readonly string[];
    readonly timeoutMs?: number;
  }) => Promise<{ exitCode: number; signal: string | null; stdout: string; stderr: string }>;
}

interface ArtifactStoreModule {
  readonly ARTIFACT_LIMITS: ArtifactLimits;
  createArtifactStore(options: Record<string, unknown>): ArtifactStore;
  createBufferSource(buffer: Buffer): ArtifactSource;
  createFileSource(filePath: string): ArtifactSource;
}

interface ArtifactServiceModule {
  readonly ARTIFACT_SCHEMA_VERSION: number;
  readonly CHANGE_KINDS: readonly ChangeKind[];
  createArtifactService(options: Record<string, unknown>): ArtifactService;
}

const require_ = createRequire(import.meta.url);

/* ------------------------------------------------------------------ helpers */

const CLEANUPS: (() => Promise<void>)[] = [];

afterAll(async () => {
  for (const cleanup of CLEANUPS.splice(0).reverse()) {
    await cleanup();
  }
});

/** Run one git command in a NAMED working directory. Never inherits an ambient cwd. */
function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

async function exists(filePath: string): Promise<boolean> {
  try {
    await stat(filePath);
    return true;
  } catch {
    return false;
  }
}

async function countFiles(root: string): Promise<number> {
  if (!(await exists(root))) return 0;
  const entries = await readdir(root, { withFileTypes: true });
  let total = 0;
  for (const entry of entries) {
    const child = path.join(root, entry.name);
    if (entry.isDirectory()) total += await countFiles(child);
    else total += 1;
  }
  return total;
}

/** A private temporary git repository with a single base commit. Never the QA worktree. */
async function createRepo(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `vis-writer-${name}-`));
  CLEANUPS.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), 'base readme\n', 'utf8');
  await writeFile(path.join(root, 'src', 'keep.txt'), 'keep\n', 'utf8');
  await writeFile(path.join(root, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
  await writeFile(path.join(root, 'script.sh'), 'echo hi\n', 'utf8');
  await symlink('src/keep.txt', path.join(root, 'link'));
  await symlink('README.md', path.join(root, 'link2'));
  await runGit(root, ['init', '-q', '-b', 'main']);
  await runGit(root, ['add', '-A']);
  await runGit(root, [
    '-c',
    'user.name=vis',
    '-c',
    'user.email=vis@example.invalid',
    'commit',
    '-q',
    '-m',
    'base',
  ]);
  return root;
}

/** A private scratch root, deliberately OUTSIDE every repository. */
async function scratch(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `vis-scratch-${name}-`));
  CLEANUPS.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

function taskIdFor(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

interface Rejection {
  readonly code: string;
  readonly field: string;
  readonly detail: unknown;
}

async function rejection(promise: Promise<unknown>): Promise<Rejection> {
  try {
    await promise;
  } catch (error) {
    if (error instanceof CollaborationError) {
      return { code: error.code, field: error.field, detail: error.detail };
    }
    const typed = error as { code?: unknown; field?: unknown; detail?: unknown };
    return { code: String(typed.code), field: String(typed.field), detail: typed.detail ?? null };
  }
  throw new Error('expected a rejection, but the call resolved');
}

/** Wrap a SYNCHRONOUS call so a synchronous throw is observed as a rejection. */
function deferred(run: () => unknown): Promise<unknown> {
  return Promise.resolve().then(run);
}

/** A rejection from a SYNCHRONOUS call (the serializer validates its change set eagerly). */
function syncRejection(run: () => unknown): Rejection {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationError) {
      return { code: error.code, field: error.field, detail: error.detail };
    }
    const typed = error as { code?: unknown; field?: unknown };
    return { code: String(typed.code), field: String(typed.field), detail: null };
  }
  throw new Error('expected a rejection, but the call resolved');
}

/** The on-disk shape of one path: kind, mode and either a content hash or a raw link target. */
interface ObservedEntry {
  readonly kind: 'file' | 'symlink';
  readonly mode: number;
  readonly sha256: string;
  readonly target: string | null;
}

async function observeTree(root: string): Promise<Map<string, ObservedEntry>> {
  const found = new Map<string, ObservedEntry>();
  async function walk(relative: string): Promise<void> {
    const absolute = relative === '' ? root : path.join(root, relative);
    const entries = await readdir(absolute, { withFileTypes: true });
    for (const entry of entries) {
      if (entry.name === '.git') continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(path.join(root, child));
      if (info.isDirectory()) {
        await walk(child);
        continue;
      }
      if (info.isSymbolicLink()) {
        const target = await readlink(path.join(root, child));
        found.set(
          child,
          Object.freeze({
            kind: 'symlink' as const,
            mode: info.mode & 0o7777,
            sha256: createHash('sha256').update(target).digest('hex'),
            target,
          }),
        );
        continue;
      }
      const content = await readFile(path.join(root, child));
      found.set(
        child,
        Object.freeze({
          kind: 'file' as const,
          mode: info.mode & 0o7777,
          sha256: createHash('sha256').update(content).digest('hex'),
          target: null,
        }),
      );
    }
  }
  await walk('');
  return found;
}

/** A counting source: records the largest single read the hasher ever asked for. */
function countingSource(
  buffer: Buffer,
  counters: { maxRequested: number; reads: number },
): ArtifactSource {
  let offset = 0;
  return {
    async open(): Promise<ArtifactReader> {
      offset = 0;
      return {
        async read(maxBytes: number): Promise<Buffer | null> {
          counters.maxRequested = Math.max(counters.maxRequested, maxBytes);
          counters.reads += 1;
          if (offset >= buffer.length) return null;
          const end = Math.min(offset + maxBytes, buffer.length);
          const chunk = buffer.subarray(offset, end);
          offset = end;
          return chunk;
        },
        async close(): Promise<void> {},
      };
    },
  };
}

async function collect(source: ArtifactSource): Promise<Buffer> {
  const reader = await source.open();
  const parts: Buffer[] = [];
  for (;;) {
    const chunk = await reader.read(64 * 1024);
    if (chunk === null) break;
    parts.push(Buffer.from(chunk));
  }
  await reader.close();
  return Buffer.concat(parts);
}

function badEntry(badPath: unknown): ChangeEntry {
  return {
    path: badPath as string,
    kind: 'file',
    mode: 0o644,
    target: null,
    contentBytes: 3,
    sha256: createHash('sha256').update('ok\n').digest('hex'),
    tracked: false,
  };
}

/* ------------------------------------------------------------------ the suite */

describe('task 40 — writer leases and change artifacts', () => {
  let leasesModule: WriterLeasesModule;
  let storeModule: ArtifactStoreModule;
  let serviceModule: ArtifactServiceModule;

  beforeAll(() => {
    // If either module is missing (the TDD RED state) this throws and every test is reported
    // failed, which is exactly the RED we capture before implementing.
    leasesModule = require_('../../bridge/runtime/collaboration/writerLeases.js') as WriterLeasesModule;
    storeModule = require_('../../bridge/runtime/collaboration/artifactStore.js') as ArtifactStoreModule;
    serviceModule = require_(
      '../../bridge/runtime/collaboration/artifactService.js',
    ) as ArtifactServiceModule;
  });

  /* ---------------------------------------------------------- frozen contract */

  it('freezes the shared writer and artifact limits once and hands out the very same objects', () => {
    const limits = leasesModule.WRITER_LIMITS;
    const artifactLimits = storeModule.ARTIFACT_LIMITS;

    expect(Object.isFrozen(limits)).toBe(true);
    expect(Object.isFrozen(artifactLimits)).toBe(true);

    // The 32 MiB artifact ceiling is a frozen number, not a per-call computation.
    expect(artifactLimits.maxArtifactBytes).toBe(32 * 1024 * 1024);
    expect(artifactLimits.chunkBytes).toBeGreaterThan(0);
    expect(artifactLimits.maxPathEntries).toBeGreaterThan(0);
    expect(artifactLimits.maxPathChars).toBeGreaterThan(0);

    // A reviewer must be told the posture keys up front, so it can never be surprised by a field.
    expect(Object.isFrozen(leasesModule.POSTURE_KEYS)).toBe(true);
    expect(Object.isFrozen(leasesModule.WRITER_ISOLATION)).toBe(true);
    expect(leasesModule.WRITER_ISOLATION.sandbox).toBe(false);

    const store = storeModule.createArtifactStore({ root: path.join(tmpdir(), 'vis-unused-store') });
    expect(store.ARTIFACT_LIMITS).toBe(artifactLimits);
    store.close();

    const service = serviceModule.createArtifactService({
      store,
      root: path.join(tmpdir(), 'vis-unused-service'),
    });
    expect(service.ARTIFACT_SCHEMA_VERSION).toBeGreaterThanOrEqual(1);
    expect(Object.isFrozen(service.CHANGE_KINDS)).toBe(true);
    expect(service.CHANGE_KINDS).toEqual(Object.freeze(['file', 'symlink', 'delete']));
    service.close();
  });

  /* ------------------------------- AC1: same repo, two writers, different cwd + lease */

  it('AC1: two writers on the SAME repository get distinct OBSERVED native cwds and distinct OBSERVED lease identities', async () => {
    const repository = await createRepo('two-writers');
    const writersRoot = await scratch('two-writers');
    const service = leasesModule.createWriterLeaseService({ writersRoot });

    const first = await service.allocate({
      repository,
      taskId: taskIdFor('two-writers-a'),
      ownerId: 'writer-a',
    });
    const second = await service.allocate({
      repository,
      taskId: taskIdFor('two-writers-b'),
      ownerId: 'writer-b',
    });

    // Both leases are on the same repository, pinned to the same base commit...
    expect(first.repository).toBe(second.repository);
    expect(first.baseCommit).toBe(second.baseCommit);

    // ...and they are still two different writers: distinct lease identities, distinct worktrees.
    expect(first.leaseId).not.toBe(second.leaseId);
    expect(first.taskId).not.toBe(second.taskId);
    expect(first.worktree).not.toBe(second.worktree);
    expect(first.nativeCwd).not.toBe(second.nativeCwd);
    expect(first.nativeCwd).not.toBe(await realpath(repository));
    expect(second.nativeCwd).not.toBe(await realpath(repository));

    // OBSERVED, not read back: a real child process reports the cwd it was actually launched in.
    const probe = ['-e', 'process.stdout.write(process.cwd())'];
    const observedFirst = await service.run({ leaseId: first.leaseId, command: process.execPath, args: probe });
    const observedSecond = await service.run({
      leaseId: second.leaseId,
      command: process.execPath,
      args: probe,
    });
    expect(observedFirst.exitCode).toBe(0);
    expect(observedSecond.exitCode).toBe(0);
    const cwdFirst = await realpath(observedFirst.stdout.trim());
    const cwdSecond = await realpath(observedSecond.stdout.trim());
    expect(cwdFirst).toBe(await realpath(first.nativeCwd));
    expect(cwdSecond).toBe(await realpath(second.nativeCwd));
    expect(cwdFirst).not.toBe(cwdSecond);

    // OBSERVED isolation: a marker written into writer A's worktree is visible to a real process
    // launched in A's cwd and invisible to one launched in B's cwd.
    await writeFile(path.join(first.nativeCwd, 'marker-a.txt'), 'A', 'utf8');
    const listing = [
      '-e',
      'process.stdout.write(require("node:fs").readdirSync(process.cwd()).sort().join(","))',
    ];
    const listedFirst = await service.run({ leaseId: first.leaseId, command: process.execPath, args: listing });
    const listedSecond = await service.run({
      leaseId: second.leaseId,
      command: process.execPath,
      args: listing,
    });
    expect(listedFirst.exitCode).toBe(0);
    expect(listedSecond.exitCode).toBe(0);
    expect(listedFirst.stdout).toContain('marker-a.txt');
    expect(listedSecond.stdout).not.toContain('marker-a.txt');

    // OBSERVED lease identity: the two native processes each report a different toplevel.
    const toplevel = ['rev-parse', '--show-toplevel'];
    const topFirst = await service.run({ leaseId: first.leaseId, command: 'git', args: toplevel });
    const topSecond = await service.run({ leaseId: second.leaseId, command: 'git', args: toplevel });
    expect(topFirst.exitCode).toBe(0);
    expect(topSecond.exitCode).toBe(0);
    expect(await realpath(topFirst.stdout.trim())).not.toBe(await realpath(topSecond.stdout.trim()));

    service.close();
  });

  /* ------------------------------------- AC: the native working directory is really correct */

  it('AC4: the native working directory is MEASURED by a real command in it, and is neither the repository nor another writer', async () => {
    const repository = await createRepo('measured-cwd');
    const writersRoot = await scratch('measured-cwd');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('measured-cwd'),
      ownerId: 'writer-measured',
    });

    const observed = await service.run({
      leaseId: lease.leaseId,
      command: process.execPath,
      args: ['-e', 'process.stdout.write(process.cwd())'],
    });
    expect(observed.exitCode).toBe(0);
    const measured = await realpath(observed.stdout.trim());
    expect(measured).toBe(await realpath(lease.nativeCwd));
    expect(measured).not.toBe(await realpath(repository));
    // The measured directory is a real, existing git worktree pinned at the assigned base commit.
    expect(await exists(measured)).toBe(true);
    expect(runGit(measured, ['rev-parse', 'HEAD']).trim()).toBe(lease.baseCommit);
    expect(await realpath(runGit(measured, ['rev-parse', '--show-toplevel']).trim())).toBe(measured);

    service.close();
  });

  /* ---------------------------------------- AC: a reviewer is never told about a sandbox */

  it('AC2: a reviewer is told the lease+worktree posture and is NEVER told a sandbox exists', () => {
    const service = leasesModule.createWriterLeaseService({
      writersRoot: path.join(tmpdir(), 'vis-posture-writers'),
    });
    const keys = leasesModule.POSTURE_KEYS;
    const posture = leasesModule.WRITER_ISOLATION;

    // The posture shape is frozen and closed: a reviewer cannot be handed an invented field.
    expect(Object.keys(posture).sort()).toEqual([...keys].sort());
    expect(Object.isFrozen(posture)).toBe(true);
    expect(Object.isFrozen(posture.guarantees)).toBe(true);
    expect(Object.isFrozen(posture.notProvided)).toBe(true);

    // The load-bearing claim, as a literal: the type of `sandbox` here is `false`.
    expect(posture.sandbox).toBe(false);
    expect(posture.isolation).toBe('lease-plus-worktree');
    expect(posture.mechanism).not.toMatch(/sandbox/i);

    // The posture must DENY a sandbox explicitly, not merely stay silent about one.
    expect(posture.notProvided.length).toBeGreaterThan(0);
    expect(posture.notProvided.some((entry) => /sandbox/i.test(entry))).toBe(true);
    expect(posture.reviewerStatement).toMatch(/no sandbox/i);
    expect(posture.reviewerStatement).toMatch(/lease/i);
    expect(posture.reviewerStatement).toMatch(/worktree/i);

    service.close();
  });

  it('AC2b: the posture a service hands a reviewer is the same frozen posture, with no sandbox claim', async () => {
    const repository = await createRepo('posture-lease');
    const writersRoot = await scratch('posture-lease');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('posture-lease'),
      ownerId: 'writer-posture',
    });
    const posture = service.posture(lease.leaseId);
    expect(posture).toBe(leasesModule.WRITER_ISOLATION);
    expect(posture.sandbox).toBe(false);
    expect(JSON.stringify(posture)).not.toMatch(/"sandbox":\s*true/);
    // Attempting to mutate the read model is a no-op at best, never a promotion to a sandbox.
    try {
      (posture as { sandbox: boolean }).sandbox = true;
    } catch {
      /* strict mode refuses a write to a frozen object; either way the value cannot change */
    }
    expect(posture.sandbox).toBe(false);
    service.close();
  });

  /* ------------------------------------------ AC3: the 32 MiB ceiling and the streaming hash */

  it('AC3a: an artifact EXCEEDING the 32 MiB ceiling is rejected with an OBSERVED oversize rejection and leaves nothing durable', async () => {
    const repository = await createRepo('oversize');
    const writersRoot = await scratch('oversize');
    const storeRoot = await scratch('oversize-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('oversize'),
      ownerId: 'writer-oversize',
    });

    // 32 MiB + 1 KiB of binary content, as a real file in a real worktree.
    await writeFile(path.join(lease.nativeCwd, 'huge.bin'), Buffer.alloc(32 * 1024 * 1024 + 1024, 0x5a));

    const observed = await rejection(artifacts.capture({ lease }));
    expect(observed.code).toBe('conflict');
    expect(observed.field).toBe('artifact_oversize');
    const detail = observed.detail as { limit: number; observed: number };
    expect(detail.limit).toBe(32 * 1024 * 1024);
    expect(detail.observed).toBeGreaterThan(detail.limit);

    // Nothing durable was fabricated: no object was written and nothing was left on disk.
    expect(store.state().writes).toBe(0);
    expect(store.state().oversizeRejections).toBe(1);
    expect(await countFiles(storeRoot)).toBe(0);

    artifacts.close();
    store.close();
    service.close();
  });

  it('AC3b: the artifact hash is STREAMING — OBSERVED peak-buffer and chunk-count prove the content was never buffered whole', async () => {
    const storeRoot = await scratch('streaming-store');
    const store = storeModule.createArtifactStore({ root: storeRoot });

    // 1 MiB of content: 16 chunks at the frozen 64 KiB chunk size.
    const content = Buffer.alloc(1024 * 1024);
    for (let index = 0; index < content.length; index += 1) content[index] = index % 251;
    const counters = { maxRequested: 0, reads: 0 };
    const stored = await store.write({ source: countingSource(content, counters) });

    const chunkBytes = store.ARTIFACT_LIMITS.chunkBytes;
    const expectedChunks = Math.ceil(content.length / chunkBytes);
    // The hasher never ASKED for more than one chunk...
    expect(counters.maxRequested).toBeLessThanOrEqual(chunkBytes);
    // ...and the number of reads stays a small bounded multiple of the chunk count (the store
    // re-opens the source for its copy pass). A whole-content read would be exactly ONE read of
    // `content.length` bytes, which is what `maxRequested` rules out.
    expect(counters.reads).toBeLessThanOrEqual(2 * expectedChunks + 2);
    expect(counters.reads).toBeGreaterThan(expectedChunks);
    // ...and it never HELD more than one chunk, which the product's own gauge reports.
    expect(stored.chunks).toBe(expectedChunks);
    expect(stored.peakBufferedBytes).toBeLessThanOrEqual(chunkBytes);
    expect(stored.peakBufferedBytes).toBeLessThan(stored.bytes);
    expect(stored.peakBufferedBytes * stored.chunks).toBe(stored.bytes);
    // A whole-content buffer would make peakBufferedBytes equal the byte count; it does not.
    expect(stored.peakBufferedBytes).not.toBe(stored.bytes);

    // The streamed hash is the same hash a one-shot digest would produce.
    expect(stored.artifactHash).toBe(createHash('sha256').update(content).digest('hex'));
    expect(stored.bytes).toBe(content.length);

    store.close();
  });

  /* ------------------------------------------------- AC5: the change is lossless */

  it('AC5: the artifact reproduces tracked, untracked, binary, mode and symlink-deletion changes byte-for-byte', async () => {
    const repository = await createRepo('lossless');
    const writersRoot = await scratch('lossless');
    const storeRoot = await scratch('lossless-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('lossless'),
      ownerId: 'writer-lossless',
    });
    const cwd = lease.nativeCwd;

    // --- every change class the plan names, made the way a real writer makes them ---
    // tracked text edit
    await writeFile(path.join(cwd, 'src', 'keep.txt'), 'keep changed\nsecond line\n', 'utf8');
    // tracked binary edit
    await writeFile(path.join(cwd, 'bin.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x10]));
    // tracked mode change only
    await chmod(path.join(cwd, 'script.sh'), 0o755);
    // tracked symlink retarget
    await rm(path.join(cwd, 'link'));
    await symlink('notes.md', path.join(cwd, 'link'));
    // tracked symlink deletion
    await rm(path.join(cwd, 'link2'));
    // tracked file deletion
    await rm(path.join(cwd, 'README.md'));
    // untracked text
    await writeFile(path.join(cwd, 'notes.md'), '# notes\n', 'utf8');
    // untracked binary — every byte value, so no encoding assumption can pass
    const binary = Buffer.alloc(512);
    for (let index = 0; index < binary.length; index += 1) binary[index] = index % 256;
    await writeFile(path.join(cwd, 'blob.dat'), binary);
    // untracked nested path
    await mkdir(path.join(cwd, 'newdir', 'deeper'), { recursive: true });
    await writeFile(path.join(cwd, 'newdir', 'deeper', 'deep.txt'), 'deep\n', 'utf8');

    const captured = await artifacts.capture({ lease });
    expect(captured.entryCount).toBe(9);
    expect(captured.pathCount).toBe(9);
    // The path manifest is sorted, unique and frozen.
    expect(captured.paths).toEqual([
      'README.md',
      'bin.bin',
      'blob.dat',
      'link',
      'link2',
      'newdir/deeper/deep.txt',
      'notes.md',
      'script.sh',
      'src/keep.txt',
    ]);
    expect(Object.isFrozen(captured.paths)).toBe(true);
    expect(Object.isFrozen(captured.manifest)).toBe(true);

    const byPath = new Map(captured.manifest.map((entry) => [entry.path, entry]));
    expect(byPath.get('src/keep.txt')?.kind).toBe('file');
    expect(byPath.get('src/keep.txt')?.tracked).toBe(true);
    expect(byPath.get('bin.bin')?.kind).toBe('file');
    expect(byPath.get('bin.bin')?.tracked).toBe(true);
    expect(byPath.get('bin.bin')?.contentBytes).toBe(6);
    expect(byPath.get('script.sh')?.mode).toBe(0o755);
    expect(byPath.get('script.sh')?.tracked).toBe(true);
    expect(byPath.get('link')?.kind).toBe('symlink');
    expect(byPath.get('link')?.target).toBe('notes.md');
    expect(byPath.get('link')?.tracked).toBe(true);
    expect(byPath.get('link2')?.kind).toBe('delete');
    expect(byPath.get('README.md')?.kind).toBe('delete');
    expect(byPath.get('notes.md')?.kind).toBe('file');
    expect(byPath.get('notes.md')?.tracked).toBe(false);
    expect(byPath.get('blob.dat')?.kind).toBe('file');
    expect(byPath.get('blob.dat')?.tracked).toBe(false);
    expect(byPath.get('blob.dat')?.contentBytes).toBe(512);
    expect(byPath.get('newdir/deeper/deep.txt')?.kind).toBe('file');
    expect(byPath.get('newdir/deeper/deep.txt')?.tracked).toBe(false);

    // The path manifest is inside the artifact, so the recorded hash binds it.
    const round = artifacts.deserialize(await store.read(captured.artifactHash));
    expect(round.baseCommit).toBe(lease.baseCommit);
    expect(round.paths).toEqual(captured.paths);
    expect(round.entryCount).toBe(9);

    // --- apply onto a pristine worktree of the SAME base commit, then compare byte-for-byte ---
    const pristineRoot = await scratch('lossless-pristine');
    const pristine = path.join(pristineRoot, 'pristine');
    runGit(repository, ['worktree', 'add', '--detach', '--', pristine, lease.baseCommit]);
    const applied = await artifacts.apply({ artifactHash: captured.artifactHash }, pristine);
    expect(applied.applied).toBe(9);
    expect(applied.baseCommit).toBe(lease.baseCommit);

    const before = await observeTree(cwd);
    const after = await observeTree(pristine);
    expect([...after.keys()].sort()).toEqual([...before.keys()].sort());
    for (const [entryPath, observed] of before) {
      const reproduced = after.get(entryPath);
      expect(reproduced, `missing ${entryPath}`).toBeDefined();
      expect(reproduced?.kind, `kind of ${entryPath}`).toBe(observed.kind);
      expect(reproduced?.mode, `mode of ${entryPath}`).toBe(observed.mode);
      expect(reproduced?.sha256, `content of ${entryPath}`).toBe(observed.sha256);
      expect(reproduced?.target, `target of ${entryPath}`).toBe(observed.target);
    }

    artifacts.close();
    store.close();
    service.close();
  });

  it('AC5b: a capture with NO change refuses to fabricate a patch', async () => {
    const repository = await createRepo('no-change');
    const writersRoot = await scratch('no-change');
    const storeRoot = await scratch('no-change-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('no-change'),
      ownerId: 'writer-no-change',
    });

    const observed = await rejection(artifacts.capture({ lease }));
    expect(observed.code).toBe('conflict');
    expect(observed.field).toBe('artifact_empty');
    expect(store.state().writes).toBe(0);

    artifacts.close();
    store.close();
    service.close();
  });

  /* ------------------------------------------------------------ failure classes */

  it('F1: a DIRTY base is refused before any worktree is allocated', async () => {
    const repository = await createRepo('dirty-base');
    const writersRoot = await scratch('dirty-base');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    await writeFile(path.join(repository, 'README.md'), 'uncommitted edit\n', 'utf8');

    const observed = await rejection(
      service.allocate({ repository, taskId: taskIdFor('dirty-base'), ownerId: 'writer-dirty' }),
    );
    expect(observed.code).toBe('conflict');
    expect(observed.field).toBe('writer_base_dirty');
    // No lease and no worktree were created for a refused allocation.
    expect(service.leases()).toEqual([]);
    expect(service.state().active).toBe(0);
    service.close();
  });

  it('F2: a duplicate task lease and a repository over its writer quota are explicit conflicts', async () => {
    const repository = await createRepo('lease-conflict');
    const writersRoot = await scratch('lease-conflict');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const taskId = taskIdFor('lease-conflict');
    await service.allocate({ repository, taskId, ownerId: 'writer-one' });

    const duplicate = await rejection(service.allocate({ repository, taskId, ownerId: 'writer-two' }));
    expect(duplicate.code).toBe('conflict');
    expect(duplicate.field).toBe('writer_lease_task');

    const quota = leasesModule.WRITER_LIMITS.maxWritersPerRepository;
    for (let index = 0; index < quota - 1; index += 1) {
      await service.allocate({
        repository,
        taskId: taskIdFor(`lease-conflict-${index}`),
        ownerId: `writer-quota-${index}`,
      });
    }
    const overflow = await rejection(
      service.allocate({ repository, taskId: taskIdFor('lease-conflict-over'), ownerId: 'writer-over' }),
    );
    expect(overflow.code).toBe('conflict');
    expect(overflow.field).toBe('writer_lease_repository');
    // The repository holds exactly the quota; the refused writer is the quota + 1'th.
    expect(service.leasesByRepository(repository)).toHaveLength(quota);
    service.close();
  });

  it('F3: a path outside the lease native cwd is refused — a worker cannot cross into another writer cwd', async () => {
    const repository = await createRepo('cross-cwd');
    const writersRoot = await scratch('cross-cwd');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const first = await service.allocate({
      repository,
      taskId: taskIdFor('cross-cwd-a'),
      ownerId: 'writer-a',
    });
    const second = await service.allocate({
      repository,
      taskId: taskIdFor('cross-cwd-b'),
      ownerId: 'writer-b',
    });

    // The user's own repository is read-only to every writer.
    const intoRepository = await rejection(
      deferred(() => service.assertPathWithinLease(first.leaseId, repository)),
    );
    expect(intoRepository.code).toBe('unauthorized');
    expect(intoRepository.field).toBe('writer_lease_cwd');

    // ...and so is the sibling writer's worktree.
    const intoSibling = await rejection(
      deferred(() => service.assertPathWithinLease(first.leaseId, second.nativeCwd)),
    );
    expect(intoSibling.code).toBe('unauthorized');
    expect(intoSibling.field).toBe('writer_lease_cwd');

    // Traversal out of the lease is refused too.
    const escaped = await rejection(
      deferred(() =>
        service.assertPathWithinLease(first.leaseId, path.join(first.nativeCwd, '..', '..')),
      ),
    );
    expect(escaped.code).toBe('unauthorized');
    expect(escaped.field).toBe('writer_lease_cwd');

    // A path inside the lease resolves, and the lease cwd is the ONLY cwd a lease exposes.
    expect(service.assertPathWithinLease(first.leaseId, 'src/keep.txt')).toBe(
      path.join(first.nativeCwd, 'src', 'keep.txt'),
    );
    expect(service.nativeCwd(first.leaseId)).toBe(first.nativeCwd);
    expect(service.nativeCwd(second.leaseId)).toBe(second.nativeCwd);
    service.close();
  });

  it('F4a: exiting releases the lease and RETAINS the user-unconfirmed worktree, and closing deletes nothing', async () => {
    const repository = await createRepo('retain');
    const writersRoot = await scratch('retain');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('retain'),
      ownerId: 'writer-retain',
    });

    const released = await service.release({ leaseId: lease.leaseId });
    expect(released.state).toBe('released');
    expect(released.userConfirmed).toBe(false);
    expect(released.worktree.disposition).toBe('retained');
    // The release read model has NO member that can delete anything.
    expect(Object.keys(released).sort()).toEqual(
      ['leaseId', 'releasedAt', 'state', 'userConfirmed', 'worktree'].sort(),
    );
    expect('delete' in released).toBe(false);
    expect('remove' in released).toBe(false);
    expect('removeWorktree' in released).toBe(false);

    // Removal without an explicit user confirmation is an explicit refusal, never a silent delete.
    const unconfirmed = await rejection(service.removeWorktree({ leaseId: lease.leaseId }));
    expect(unconfirmed.code).toBe('conflict');
    expect(unconfirmed.field).toBe('writer_worktree_unconfirmed');

    // OBSERVED: the worktree is still on disk, untouched, and the retention view says so.
    expect(await exists(lease.worktree)).toBe(true);
    const retention = await service.retention(lease.leaseId);
    expect(retention.userConfirmed).toBe(false);
    expect(retention.exists).toBe(true);
    expect(retention.removedAt).toBe(null);

    // Exiting — closing the whole service — deletes nothing either.
    service.close();
    expect(service.state().closed).toBe(true);
    expect(await exists(lease.worktree)).toBe(true);
  });

  it('F4b: a worktree is removed ONLY after an explicit user confirmation', async () => {
    const repository = await createRepo('confirm-remove');
    const writersRoot = await scratch('confirm-remove');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('confirm-remove'),
      ownerId: 'writer-confirm',
    });
    await service.release({ leaseId: lease.leaseId });

    // Confirming before release is a conflict: a live lease cannot be dismantled.
    const live = leasesModule.createWriterLeaseService({ writersRoot: await scratch('confirm-remove-2') });
    const other = await live.allocate({
      repository,
      taskId: taskIdFor('confirm-remove-live'),
      ownerId: 'writer-live',
    });
    const tooEarly = await rejection(
      deferred(() => live.confirmWorktreeRemoval({ leaseId: other.leaseId })),
    );
    expect(tooEarly.code).toBe('conflict');
    expect(tooEarly.field).toBe('writer_lease_state');
    live.close();

    const confirmed = await service.confirmWorktreeRemoval({ leaseId: lease.leaseId });
    expect(confirmed.userConfirmed).toBe(true);
    expect(confirmed.confirmedAt).not.toBe(null);
    expect(await exists(lease.worktree)).toBe(true);

    const removed = await service.removeWorktree({ leaseId: lease.leaseId });
    expect(removed.removedAt).not.toBe(null);
    expect(await exists(lease.worktree)).toBe(false);
    const retention = await service.retention(lease.leaseId);
    expect(retention.exists).toBe(false);
    expect(retention.userConfirmed).toBe(true);
    expect(service.state().worktreesRemoved).toBe(1);
    service.close();
  });

  it('F5: a durable artifact survives the job ending; a missing one is an explicit miss, never a fabricated patch', async () => {
    const repository = await createRepo('durable');
    const writersRoot = await scratch('durable');
    const storeRoot = await scratch('durable-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('durable'),
      ownerId: 'writer-durable',
    });
    await writeFile(path.join(lease.nativeCwd, 'change.txt'), 'durable change\n', 'utf8');
    const captured = await artifacts.capture({ lease });

    // The job ends: the artifact service, the store and the lease service all close.
    artifacts.close();
    store.close();
    await service.release({ leaseId: lease.leaseId });
    service.close();

    // OBSERVED on disk: the object is still there and still re-hashes to the recorded value.
    const reopenedStore = storeModule.createArtifactStore({ root: storeRoot });
    expect(await reopenedStore.has(captured.artifactHash)).toBe(true);
    const verified = await reopenedStore.verify(captured.artifactHash);
    expect(verified.ok).toBe(true);
    expect(verified.artifactHash).toBe(captured.artifactHash);
    expect(verified.bytes).toBe(captured.bytes);
    // The unconfirmed worktree also survived.
    expect(await exists(lease.worktree)).toBe(true);

    // A hash that was never stored is an explicit miss.
    const missing = await rejection(reopenedStore.read('f'.repeat(64)));
    expect(missing.code).toBe('invalid_request');
    expect(missing.field).toBe('artifact_missing');

    const reopenedService = serviceModule.createArtifactService({
      store: reopenedStore,
      root: storeRoot,
    });
    const applyTarget = path.join(storeRoot, 'apply-target');
    const missingApply = await rejection(
      reopenedService.apply({ artifactHash: 'e'.repeat(64) }, applyTarget),
    );
    expect(missingApply.code).toBe('invalid_request');
    expect(missingApply.field).toBe('artifact_missing');
    expect(await exists(applyTarget)).toBe(false);

    reopenedService.close();
    reopenedStore.close();
  });

  it('F6: a malicious artifact path is refused at serialization AND at apply', async () => {
    const storeRoot = await scratch('malicious-store');
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const service = serviceModule.createArtifactService({ store, root: storeRoot });
    const target = path.join(storeRoot, 'apply-target');
    await mkdir(target, { recursive: true });

    // The serializer validates its change set eagerly: a traversal path, an absolute path, a NUL
    // and an over-long path are each refused with an explicit field.
    const malicious: [string, unknown][] = [
      ['traversal', '../escaped.txt'],
      ['nested traversal', 'a/../../escaped.txt'],
      ['absolute', '/etc/vis-artifact.txt'],
      ['nul', 'bad\u0000path.txt'],
      ['over-long', `x${'y'.repeat(2000)}.txt`],
      ['windows drive', 'C:\\vis-artifact.txt'],
    ];
    for (const [label, badPath] of malicious) {
      const observed = syncRejection(() =>
        service.serialize({ baseCommit: 'a'.repeat(40), entries: [badEntry(badPath)] }),
      );
      expect(observed.code, label).toBe('invalid_request');
      expect(observed.field, label).toBe('artifact_path');
    }

    // A hand-built artifact with a traversal path is refused by APPLY as well: the deserializer
    // re-validates every path it reads off the wire, so a crafted object cannot escape the target.
    const crafted = Buffer.concat([
      Buffer.from(
        `${JSON.stringify({
          schemaVersion: service.ARTIFACT_SCHEMA_VERSION,
          baseCommit: 'a'.repeat(40),
          entryCount: 1,
          paths: ['../escaped.txt'],
        })}\n`,
        'utf8',
      ),
      (() => {
        const json = Buffer.from(
          JSON.stringify({
            path: '../escaped.txt',
            kind: 'file',
            mode: 0o644,
            target: null,
            contentBytes: 0,
            sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
            tracked: false,
          }),
          'utf8',
        );
        const head = Buffer.alloc(4);
        head.writeUInt32BE(json.length, 0);
        return Buffer.concat([Buffer.alloc(4), head, json]);
      })(),
    ]);
    const observed = await rejection(
      Promise.resolve(service.apply({ artifact: crafted }, target)),
    );
    expect(observed.code).toBe('invalid_request');
    expect(observed.field).toBe('artifact_path');
    expect(await exists(path.join(storeRoot, 'escaped.txt'))).toBe(false);
    expect(await exists(path.join(target, 'escaped.txt'))).toBe(false);

    // A truncated / structurally broken artifact is an explicit refusal, never a partial apply.
    const good = await store.write({
      source: storeModule.createBufferSource(Buffer.from('x'.repeat(64), 'utf8')),
    });
    const whole = await store.read(good.artifactHash);
    const truncated = await rejection(
      Promise.resolve(service.apply({ artifact: whole.subarray(0, whole.length - 8) }, target)),
    );
    expect(truncated.code).toBe('invalid_request');
    expect(['artifact_structure', 'artifact_header']).toContain(truncated.field);
    expect(await countFiles(target)).toBe(0);

    service.close();
    store.close();
  });

  it('F6b: the wire format is exactly the contract this test documents', async () => {
    const storeRoot = await scratch('wire-store');
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const service = serviceModule.createArtifactService({ store, root: storeRoot });
    const baseCommit = 'a'.repeat(40);
    const entries: ChangeEntryInput[] = [
      {
        path: 'a.txt',
        kind: 'file',
        mode: 0o644,
        target: null,
        contentBytes: 3,
        sha256: createHash('sha256').update('ok\n').digest('hex'),
        tracked: true,
        content: Buffer.from('ok\n', 'utf8'),
      },
      {
        path: 'b.link',
        kind: 'symlink',
        mode: 0o777,
        target: 'a.txt',
        contentBytes: 0,
        sha256: createHash('sha256').update('a.txt').digest('hex'),
        tracked: true,
        content: null,
      },
      {
        path: 'c.gone',
        kind: 'delete',
        mode: 0,
        target: null,
        contentBytes: 0,
        sha256: createHash('sha256').update(Buffer.alloc(0)).digest('hex'),
        tracked: true,
        content: null,
      },
    ];
    const bytes = await collect(service.serialize({ baseCommit, entries }));
    const newline = bytes.indexOf(0x0a);
    expect(newline).toBeGreaterThan(0);
    const header = JSON.parse(bytes.subarray(0, newline).toString('utf8')) as {
      schemaVersion: number;
      baseCommit: string;
      entryCount: number;
      paths: string[];
    };
    expect(header.schemaVersion).toBe(service.ARTIFACT_SCHEMA_VERSION);
    expect(header.baseCommit).toBe(baseCommit);
    expect(header.entryCount).toBe(3);
    expect(header.paths).toEqual(['a.txt', 'b.link', 'c.gone']);

    // The first record is: u32be(contentLength=3) + 'ok\n' + u32be(jsonLength) + recordJson.
    expect(bytes.readUInt32BE(newline + 1)).toBe(3);
    expect(bytes.subarray(newline + 5, newline + 8).toString('utf8')).toBe('ok\n');
    const firstJsonLength = bytes.readUInt32BE(newline + 8);
    const firstRecord = JSON.parse(
      bytes.subarray(newline + 12, newline + 12 + firstJsonLength).toString('utf8'),
    ) as Record<string, unknown>;
    expect(Object.keys(firstRecord)).toEqual([
      'path',
      'kind',
      'mode',
      'target',
      'contentBytes',
      'sha256',
      'tracked',
    ]);
    expect(firstRecord.contentBytes).toBe(3);

    // Round-trips to the same frozen change set, and the hash of the stream is reproducible.
    const stored = await store.write({ source: storeModule.createBufferSource(bytes) });
    expect(stored.artifactHash).toBe(createHash('sha256').update(bytes).digest('hex'));
    const round = service.deserialize(bytes);
    expect(round.entries).toEqual(entries.map(({ content: _content, ...entry }) => entry));
    expect(round.contentBytes).toBe(3);
    service.close();
    store.close();
  });

  it('F7: a read-only lease cannot be captured, and its posture still denies a sandbox', async () => {
    const repository = await createRepo('read-only');
    const writersRoot = await scratch('read-only');
    const storeRoot = await scratch('read-only-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('read-only'),
      ownerId: 'writer-readonly',
      readOnly: true,
    });
    expect(lease.policy.worktreeAccess).toBe('read-only');
    expect(lease.policy.userRepository).toBe('read-only');
    expect(Object.isFrozen(lease.snapshot)).toBe(true);
    expect(lease.snapshot.baseCommit).toBe(lease.baseCommit);
    expect(lease.snapshot.worktree).toBe(lease.worktree);

    await writeFile(path.join(lease.nativeCwd, 'notes.md'), 'read only\n', 'utf8');
    const observed = await rejection(artifacts.capture({ lease }));
    expect(observed.code).toBe('unsupported');
    expect(observed.field).toBe('writer_lease_read_only');
    expect(service.posture(lease.leaseId).sandbox).toBe(false);

    artifacts.close();
    store.close();
    service.close();
  });

  it('F8: every rejection carries an explicit code and field, never a bare throw', async () => {
    const service = leasesModule.createWriterLeaseService({
      writersRoot: path.join(tmpdir(), 'vis-rejections-writers'),
    });
    const cases: [string, Promise<unknown>, string, string][] = [
      [
        'unknown lease',
        deferred(() => service.lease('f'.repeat(8))),
        'invalid_request',
        'lease_id',
      ],
      [
        'bad task id',
        service.allocate({ repository: '/tmp', taskId: 'not-a-uuid', ownerId: 'w' }),
        'invalid_request',
        'task_id',
      ],
      [
        'empty owner',
        service.allocate({ repository: '/tmp', taskId: taskIdFor('reject'), ownerId: '' }),
        'invalid_request',
        'writer_owner',
      ],
      [
        'huge ttl',
        service.allocate({
          repository: '/tmp',
          taskId: taskIdFor('reject-ttl'),
          ownerId: 'w',
          ttlMs: leasesModule.WRITER_LIMITS.maxLeaseTtlMs + 1,
        }),
        'invalid_request',
        'writer_ttl',
      ],
      [
        'empty repository',
        service.allocate({ repository: '   ', taskId: taskIdFor('reject-repo'), ownerId: 'w' }),
        'invalid_request',
        'writer_repository',
      ],
    ];
    for (const [label, promise, code, field] of cases) {
      const observed = await rejection(promise);
      expect(observed.code, label).toBe(code);
      expect(observed.field, label).toBe(field);
      expect(typeof observed.field, label).toBe('string');
      expect(observed.field.length, label).toBeGreaterThan(0);
    }
    service.close();
  });
});

/* ------------------------------------------------------------------ PR #196 review findings */

describe('task 40 — the six PR #196 review findings', () => {
  let leasesModule: WriterLeasesModule;
  let storeModule: ArtifactStoreModule;
  let serviceModule: ArtifactServiceModule;

  beforeAll(() => {
    leasesModule = require_('../../bridge/runtime/collaboration/writerLeases.js') as WriterLeasesModule;
    storeModule = require_('../../bridge/runtime/collaboration/artifactStore.js') as ArtifactStoreModule;
    serviceModule = require_(
      '../../bridge/runtime/collaboration/artifactService.js',
    ) as ArtifactServiceModule;
  });

  it('P1: apply refuses a symlinked parent directory instead of writing outside the target', async () => {
    const storeRoot = await scratch('symlink-parent');
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const service = serviceModule.createArtifactService({ store, root: storeRoot });
    const target = path.join(storeRoot, 'apply-target');
    const outside = path.join(storeRoot, 'outside');
    await mkdir(target, { recursive: true });
    await mkdir(outside, { recursive: true });
    await writeFile(path.join(outside, 'victim'), 'original\n', 'utf8');
    // Inside the target, `link` names a directory OUTSIDE the target root.
    await symlink(outside, path.join(target, 'link'));

    const artifact = await collect(service.serialize({
      baseCommit: 'a'.repeat(40),
      entries: [{
        path: 'link/victim',
        kind: 'file',
        mode: 0o644,
        target: null,
        contentBytes: 12,
        sha256: createHash('sha256').update('overwritten\n').digest('hex'),
        tracked: false,
        content: Buffer.from('overwritten\n', 'utf8'),
      }],
    }));
    const observed = await rejection(Promise.resolve(service.apply({ artifact }, target)));
    expect(observed.code).toBe('invalid_request');
    expect(observed.field).toBe('artifact_path');
    // The file outside the target is byte-identical: nothing was written through the link.
    expect(await readFile(path.join(outside, 'victim'), 'utf8')).toBe('original\n');
    service.close();
    store.close();
  });

  it('P2: a file replaced by a directory is captured as a deletion and replays onto the base', async () => {
    const repository = await createRepo('file-to-dir');
    // The base commit carries a tracked FILE named `item`.
    await writeFile(path.join(repository, 'item'), 'a file\n', 'utf8');
    runGit(repository, ['add', '-A']);
    runGit(repository, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'add item']);

    const writersRoot = await scratch('file-to-dir');
    const storeRoot = await scratch('file-to-dir-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('file-to-dir'),
      ownerId: 'writer-f2d',
    });
    // The writer replaces the tracked FILE with a DIRECTORY of the same name.
    await rm(path.join(lease.nativeCwd, 'item'));
    await mkdir(path.join(lease.nativeCwd, 'item'));
    await writeFile(path.join(lease.nativeCwd, 'item', 'child'), 'nested\n', 'utf8');

    const captured = await artifacts.capture({ lease });
    expect(captured.paths).toContain('item');
    expect(captured.paths).toContain('item/child');
    // The tracked file's DELETION is recorded, not silently dropped.
    expect(captured.manifest.find((entry) => entry.path === 'item')?.kind).toBe('delete');

    // Replaying onto the pristine base reproduces the transition instead of failing EEXIST.
    const applyTarget = await scratch('file-to-dir-apply');
    await writeFile(path.join(applyTarget, 'item'), 'a file\n', 'utf8');
    const applied = await artifacts.apply({ artifactHash: captured.artifactHash }, applyTarget);
    expect(applied.applied).toBe(2);
    expect(await readFile(path.join(applyTarget, 'item', 'child'), 'utf8')).toBe('nested\n');
    service.close();
    store.close();
  });

  it('P2b: a directory replaced by a file is captured and replays onto the base', async () => {
    const repository = await createRepo('dir-to-file');
    // The base commit carries a tracked FILE inside a tracked directory.
    await mkdir(path.join(repository, 'bundle'), { recursive: true });
    await writeFile(path.join(repository, 'bundle', 'child'), 'nested\n', 'utf8');
    runGit(repository, ['add', '-A']);
    runGit(repository, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'add bundle']);

    const writersRoot = await scratch('dir-to-file');
    const storeRoot = await scratch('dir-to-file-store');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const artifacts = serviceModule.createArtifactService({ store, root: storeRoot });
    const lease = await service.allocate({
      repository,
      taskId: taskIdFor('dir-to-file'),
      ownerId: 'writer-d2f',
    });
    // The writer replaces the tracked DIRECTORY with a FILE of the same name.
    await rm(path.join(lease.nativeCwd, 'bundle'), { recursive: true });
    await writeFile(path.join(lease.nativeCwd, 'bundle'), 'a file\n', 'utf8');

    const captured = await artifacts.capture({ lease });
    expect(captured.paths).toContain('bundle');
    expect(captured.paths).toContain('bundle/child');
    expect(captured.manifest.find((entry) => entry.path === 'bundle')?.kind).toBe('file');
    expect(captured.manifest.find((entry) => entry.path === 'bundle/child')?.kind).toBe('delete');

    // Replaying onto the pristine base replaces the directory with the file.
    const applyTarget = await scratch('dir-to-file-apply');
    await mkdir(path.join(applyTarget, 'bundle'), { recursive: true });
    await writeFile(path.join(applyTarget, 'bundle', 'child'), 'nested\n', 'utf8');
    const applied = await artifacts.apply({ artifactHash: captured.artifactHash }, applyTarget);
    expect(applied.applied).toBe(2);
    const observed = await lstat(path.join(applyTarget, 'bundle'));
    expect(observed.isFile()).toBe(true);
    expect(await readFile(path.join(applyTarget, 'bundle'), 'utf8')).toBe('a file\n');
    service.close();
    store.close();
  });

  it('P3: a git timeout STOPS the child process instead of waiting for it to exit on its own', async () => {
    const stops: unknown[] = [];
    const spawned: EventEmitter[] = [];
    const runner = leasesModule.createGitRunner({
      spawnProcess: () => {
        const child = new EventEmitter();
        const stdout = new EventEmitter();
        const stderr = new EventEmitter();
        spawned.push(Object.assign(child, { stdout, stderr }));
        return Object.assign(child, { stdout, stderr });
      },
      stopChild: (child: unknown) => {
        stops.push(child);
        return Promise.resolve();
      },
      timeoutMs: 10,
    });
    const pending = runner({ cwd: tmpdir(), args: ['status'] });
    await new Promise((resolve) => setTimeout(resolve, 50));
    // The child was actually stopped, exactly once, and it is the child this run spawned.
    expect(stops).toHaveLength(1);
    expect(stops[0]).toBe(spawned[0]);
    // The promise is still pending: only the child's close settles it.
    let settled = false;
    void pending.then(() => { settled = true; }, () => { settled = true; });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(settled).toBe(false);
    // The close now settles the run, and the timeout failure is what it reports.
    (spawned[0] as EventEmitter).emit('close', 0, null);
    const observed = await rejection(pending);
    expect(observed.code).toBe('source_unavailable');
    expect(observed.field).toBe('writer_git_timeout');
  });

  it('P4: two concurrent allocations for ONE task mint exactly one lease', async () => {
    const repository = await createRepo('concurrent-allocate');
    const writersRoot = await scratch('concurrent-allocate');
    const service = leasesModule.createWriterLeaseService({ writersRoot });
    const taskId = taskIdFor('concurrent-allocate');
    const outcomes = await Promise.allSettled([
      service.allocate({ repository, taskId, ownerId: 'writer-a' }),
      service.allocate({ repository, taskId, ownerId: 'writer-b' }),
    ]);
    const fulfilled = outcomes.filter((entry) => entry.status === 'fulfilled');
    const rejected = outcomes.filter((entry) => entry.status === 'rejected');
    expect(fulfilled).toHaveLength(1);
    expect(rejected).toHaveLength(1);
    const reason = (rejected[0] as PromiseRejectedResult).reason as CollaborationError;
    expect(reason.code).toBe('conflict');
    expect(reason.field).toBe('writer_lease_task');
    // Exactly one live lease exists for the task, and the repository quota counts only it.
    expect(service.leases()).toHaveLength(1);
    expect(service.leasesByRepository(repository)).toHaveLength(1);
    service.close();
  });

  it('P5: a source that changes between the hash pass and the copy pass is refused, never stored', async () => {
    const storeRoot = await scratch('mutable-source');
    const store = storeModule.createArtifactStore({ root: storeRoot });
    let opens = 0;
    const mutable = {
      async open() {
        opens += 1;
        const payload = opens === 1 ? Buffer.from('first\n', 'utf8') : Buffer.from('other\n', 'utf8');
        let done = false;
        return {
          async read(maxBytes: number) {
            if (done) return null;
            done = true;
            return payload.subarray(0, Math.min(maxBytes, payload.length));
          },
          async close() {},
        };
      },
    };
    const observed = await rejection(store.write({ source: mutable }));
    expect(observed.code).toBe('conflict');
    expect(observed.field).toBe('artifact_changed');
    // Nothing was stored under the first pass's hash, and no write was counted.
    expect(await store.has(createHash('sha256').update('first\n').digest('hex'))).toBe(false);
    expect(store.state().writes).toBe(0);
    store.close();
  });

  it('P6: a symlink inside a NEW directory replays onto a clean target', async () => {
    const storeRoot = await scratch('newdir-symlink');
    const store = storeModule.createArtifactStore({ root: storeRoot });
    const service = serviceModule.createArtifactService({ store, root: storeRoot });
    const target = path.join(storeRoot, 'apply-target');
    await mkdir(target, { recursive: true });
    await writeFile(path.join(target, 'existing'), 'base\n', 'utf8');

    const artifact = await collect(service.serialize({
      baseCommit: 'a'.repeat(40),
      entries: [{
        path: 'newdir/link',
        kind: 'symlink',
        mode: 0o777,
        target: '../existing',
        contentBytes: 0,
        sha256: createHash('sha256').update('../existing').digest('hex'),
        tracked: false,
        content: null,
      }],
    }));
    const applied = await service.apply({ artifact }, target);
    expect(applied.applied).toBe(1);
    const observed = await lstat(path.join(target, 'newdir', 'link'));
    expect(observed.isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(target, 'newdir', 'link'))).toBe('../existing');
    service.close();
    store.close();
  });
});
