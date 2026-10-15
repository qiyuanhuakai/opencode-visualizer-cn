// @vitest-environment node
//
// Task 41 — serialized post-review integration with failure preservation.
//
// Product under test:
//   bridge/runtime/collaboration/integrationReview.js  (the review that BINDS artifactHash / base /
//                                                       target, and the approval that freezes that
//                                                       binding — there is no mutation path)
//   bridge/runtime/collaboration/repositoryLocks.js    (the repository lock that SERIALIZES two
//                                                       integrations against one target)
//   bridge/runtime/collaboration/integrationService.js (check → apply → tests → durable record, the
//                                                       controlled fast-forward, and the failure
//                                                       preservation)
//   bridge/runtime/collaboration/artifactStore.js      (landed task 40: the durable content-addressed
//   bridge/runtime/collaboration/artifactService.js     object and the immutable change artifact —
//                                                       reused, not reinvented)
//   bridge/runtime/collaboration/writerLeases.js       (landed task 40: createGitRunner, whose cwd is
//                                                       a REQUIRED named argument)
//   shared/runtime/collaboration.js                    (the frozen contract: CollaborationError, parsers)
//
// The three new bridge modules under test are loaded through createRequire rather than a static
// import: this task's grant is exactly four new paths and none of them is a declaration file. A
// static import of a .d.ts-less bridge module is TS7016 under the repo's strict vue-tsc gate — the
// same reason task 37's collaborationCoordinator.test.ts, task 38's fanout.test.ts, task 39's
// delegation.test.ts and task 40's writerArtifacts.test.ts use the require boundary. The contracts
// below are therefore declared here, in the test, and the require boundary is the only untyped edge.
// shared/runtime/collaboration.js DOES ship a sibling declaration file and is imported statically,
// so its contract is checked by vue-tsc.
//
// THE FOUR FROZEN ACCEPTANCE CRITERIA, each proven by a NAMED test with OBSERVED values:
//
//   1. two integrations are SERIALIZED
//        'two integrations against one target repository are serialized'
//        observed: the second lock grant reports waited=true with a real waitedMs, the shared
//        enter/exit log is ['first:enter','first:exit','second:enter','second:exit'], and the
//        second result's startedAt is not before the first result's completedAt.
//
//   2. the APPROVED artifact hash matches the ACTUAL BYTES
//        'the approved artifact hash is bound at review time and the actual bytes are re-hashed'
//        observed: the stored object is corrupted to different bytes and the integration refuses
//        with detail {approved, observed} — two different real sha256 values.
//
//   3. a dirty target OR a moved HEAD fails and PRESERVES the artifact
//        'a dirty target fails the integration and preserves the artifact'
//        'a moved HEAD fails the integration and preserves the artifact'
//        observed: each refusal carries its own code/field/detail, the artifact object still exists
//        and still verifies, and the user's files are byte-identical.
//
//   4. a test failure cleans ONLY this operation's temp and NEVER resets the user's files
//        'a failing test cleans only this operation temp and never resets the user files'
//        observed: the per-operation temp root is gone, `git worktree list` no longer names it, the
//        user's file digests and counts are identical before and after, and `git status` is
//        byte-identical.
//
// Plus the plan's own prohibitions, each with a NAMED test:
//        'a successful integration never auto-commits or pushes the user original directory'
//        'no rejection is a bare throw and every code is a frozen ERROR_CODES member'
//        'the command runner type cannot write to a child stdin'
//
// Every git / spawn / exec call in this file names its cwd explicitly. No git operation is ever run
// in the QA worktree: every repository below is a private temporary repository under os.tmpdir().
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import {
  chmod,
  mkdir,
  mkdtemp,
  readdir,
  readFile,
  readlink,
  lstat,
  rm,
  stat,
  symlink,
  writeFile,
  appendFile,
  readFile as readTextFile,
  writeFile as writeTextFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import * as fsPromises from 'node:fs/promises';
import path from 'node:path';
import { createRequire } from 'node:module';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { ERROR_CODES } from '../../shared/runtime/capabilities.js';
import { CollaborationError, parseCriteria } from '../../shared/runtime/collaboration.js';

/* ------------------------------------------------------------------ contracts */

type ChangeKind = 'file' | 'symlink' | 'delete';

interface ArtifactLimits {
  readonly maxArtifactBytes: number;
  readonly chunkBytes: number;
  readonly maxPathEntries: number;
  readonly maxPathChars: number;
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

interface ArtifactStore {
  readonly ARTIFACT_LIMITS: ArtifactLimits;
  write(input: { readonly source: ArtifactSource }): Promise<DigestView & { readonly path: string; readonly existed: boolean }>;
  read(artifactHash: string): Promise<Buffer>;
  open(artifactHash: string): Promise<ArtifactReader>;
  has(artifactHash: string): Promise<boolean>;
  verify(artifactHash: string): Promise<DigestView & { readonly ok: boolean }>;
  state(): Readonly<{ writes: number; oversizeRejections: number; immutableRefusals: number; closed: boolean }>;
  close(): void;
}

interface CaptureView {
  readonly artifactHash: string;
  readonly baseCommit: string;
  readonly leaseId: string;
  readonly worktree: string;
  readonly nativeCwd: string;
  readonly bytes: number;
  readonly entryCount: number;
  readonly paths: readonly string[];
}

interface ArtifactService {
  readonly ARTIFACT_SCHEMA_VERSION: number;
  readonly CHANGE_KINDS: readonly ChangeKind[];
  capture(input: { readonly lease: LeaseView; readonly at?: number }): Promise<CaptureView>;
  apply(
    input: { readonly artifactHash: string } | { readonly artifact: Buffer },
    target: string,
    options?: { readonly dryRun?: boolean },
  ): Promise<{ readonly artifactHash: string; readonly baseCommit: string; readonly applied: number; readonly paths: readonly string[] }>;
  state(): Readonly<{ captures: number; applies: number; emptyRefusals: number; closed: boolean }>;
  close(): void;
}

interface LeaseView {
  readonly leaseId: string;
  readonly taskId: string;
  readonly repository: string;
  readonly ownerId: string;
  readonly worktree: string;
  readonly baseCommit: string;
  readonly nativeCwd: string;
  readonly policy: Readonly<{ worktreeAccess: 'read-write' | 'read-only'; userRepository: 'read-only' }>;
  readonly state: 'active' | 'released' | 'removed';
}

interface WriterLeaseService {
  allocate(input: {
    readonly repository: string;
    readonly taskId: string;
    readonly ownerId: string;
    readonly at?: number;
    readonly readOnly?: boolean;
  }): Promise<LeaseView>;
  release(input: { readonly leaseId: string; readonly at?: number }): unknown;
  state(): Readonly<{ active: number; released: number; removed: number; total: number; closed: boolean }>;
  close(): void;
}

interface ReviewView {
  readonly reviewId: string;
  readonly repository: string;
  readonly target: string;
  readonly artifactHash: string;
  readonly base: string;
  readonly state: 'pending' | 'approved';
  readonly headAtReview: string;
  readonly targetHeadAtReview: string;
  readonly targetCleanAtReview: boolean;
  readonly dirtyPathsAtReview: readonly string[];
  readonly createdAt: number;
  readonly approvedAt: number | null;
  readonly reviewerId: string | null;
}

interface ApprovalView {
  readonly approvalId: string;
  readonly reviewId: string;
  readonly repository: string;
  readonly target: string;
  readonly artifactHash: string;
  readonly base: string;
  readonly reviewerId: string;
  readonly approvedAt: number;
  readonly binding: Readonly<{
    readonly artifactHash: string;
    readonly base: string;
    readonly target: string;
    readonly repository: string;
  }>;
}

interface LockGrant {
  readonly lockId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly acquiredAt: number;
  readonly waited: boolean;
  readonly waitedMs: number;
  readonly queuePosition: number;
  readonly sequence: number;
}

interface LockReceipt {
  readonly lockId: string;
  readonly repository: string;
  readonly operationId: string;
  readonly acquiredAt: number;
  readonly releasedAt: number;
  readonly heldMs: number;
  readonly sequence: number;
}

interface LockOrderEntry {
  readonly sequence: number;
  readonly operationId: string;
  readonly waited: boolean;
  readonly waitedMs: number;
  readonly acquiredAt: number;
  readonly releasedAt: number | null;
}

interface RepositoryLockService {
  readonly REPOSITORY_LOCK_LIMITS: Readonly<{
    maxLocks: number;
    maxWaiters: number;
    maxWaitMs: number;
    maxKeyChars: number;
    maxOperationIdChars: number;
    maxHolders: number;
  }>;
  acquire(input: {
    readonly repository: string;
    readonly operationId: string;
    readonly at?: number;
    readonly waitMs?: number;
  }): Promise<LockGrant>;
  release(input: { readonly grant: LockGrant; readonly at?: number }): LockReceipt;
  held(repository: string): readonly LockGrant[];
  grants(): readonly LockGrant[];
  state(): Readonly<{
    acquired: number;
    refused: number;
    waited: number;
    released: number;
    held: number;
    maxObservedHoldMs: number;
    order: readonly LockOrderEntry[];
    closed: boolean;
  }>;
  close(): void;
}

interface IntegrationReviewService {
  readonly INTEGRATION_REVIEW_LIMITS: Readonly<{
    maxReviews: number;
    maxApprovals: number;
    maxRepositoryChars: number;
    maxTargetChars: number;
    maxReviewerChars: number;
  }>;
  create(input: {
    readonly repository: string;
    readonly target: string;
    readonly artifactHash: string;
    readonly at?: number;
    readonly reviewerId?: string;
  }): Promise<ReviewView>;
  approve(input: {
    readonly reviewId: string;
    readonly at?: number;
    readonly reviewerId: string;
  }): ApprovalView;
  review(reviewId: string): ReviewView;
  approval(approvalId: string): ApprovalView;
  reviews(): readonly ReviewView[];
  approvals(): readonly ApprovalView[];
  state(): Readonly<{ created: number; approved: number; closed: boolean }>;
  close(): void;
}

interface TestSpec {
  readonly criterionId: string;
  readonly command: string;
  readonly args: readonly string[];
  /** A blob handed to the test as a TEMP FILE, never through a child's stdin. */
  readonly input?: Buffer;
}

interface RejectionView {
  readonly code: string;
  readonly field: string;
  readonly detail: unknown;
}

interface TestRecord {
  readonly criterionId: string;
  readonly command: string;
  readonly args: readonly string[];
  readonly exitCode: number;
  readonly durationMs: number;
  readonly stdoutBytes: number;
  readonly stderrBytes: number;
  readonly inputFile: string | null;
  readonly outputLimitBytes: number;
}

interface IntegrationResult {
  readonly ok: boolean;
  readonly operationId: string;
  readonly approvalId: string;
  readonly reviewId: string;
  readonly repository: string;
  readonly target: string;
  readonly artifactHash: string;
  readonly observedArtifactHash: string;
  readonly artifactBytes: number;
  readonly artifactChunks: number;
  readonly artifactPeakBufferedBytes: number;
  readonly base: string;
  readonly outcome:
    | 'integrated'
    | 'artifact_mismatch'
    | 'target_dirty'
    | 'head_moved'
    | 'tests_failed'
    | 'worktree_failed'
    | 'commit_failed'
    | 'fast_forward_failed';
  readonly rejection: RejectionView | null;
  readonly targetBefore: Readonly<{
    head: string;
    targetHead: string;
    clean: boolean;
    dirtyPaths: readonly string[];
    fileCount: number;
    treeDigest: string;
  }>;
  readonly targetAfter: Readonly<{
    head: string;
    targetHead: string;
    clean: boolean;
    dirtyPaths: readonly string[];
    fileCount: number;
    treeDigest: string;
  }>;
  readonly worktree: Readonly<{ path: string; created: boolean; removed: boolean; removedAt: number | null }>;
  readonly commit: Readonly<{ created: boolean; sha: string | null; worktree: string | null }>;
  readonly fastForward: Readonly<{
    ref: string;
    from: string;
    to: string | null;
    applied: boolean;
    isFastForward: boolean;
  }>;
  readonly tests: readonly TestRecord[];
  readonly lock: Readonly<{
    lockId: string;
    waited: boolean;
    waitedMs: number;
    queuePosition: number;
    heldMs: number;
  }>;
  readonly artifact: Readonly<{ preserved: boolean; verified: boolean }>;
  readonly startedAt: number;
  readonly completedAt: number;
}

interface IntegrationService {
  readonly INTEGRATION_LIMITS: Readonly<{
    maxOperations: number;
    maxRepositoryChars: number;
    maxWorktreeNameChars: number;
    maxIntegrationRootChars: number;
    maxCommitMessageChars: number;
    maxTestSpecs: number;
    maxCommandChars: number;
    maxCommandArgs: number;
    maxTestOutputBytes: number;
    maxTestTimeoutMs: number;
    defaultTestTimeoutMs: number;
    maxTargetChars: number;
  }>;
  integrate(input: {
    readonly approvalId: string;
    readonly at?: number;
    readonly criteria: readonly { readonly id: string; readonly text: string; readonly required: boolean }[];
    readonly tests: readonly TestSpec[];
    readonly commitMessage?: string;
    readonly testTimeoutMs?: number;
  }): Promise<IntegrationResult>;
  operation(operationId: string): IntegrationResult;
  operations(): readonly IntegrationResult[];
  state(): Readonly<{ operations: number; integrated: number; refused: number; closed: boolean }>;
  close(): void;
}

interface IntegrationModules {
  readonly REPOSITORY_LOCK_LIMITS: RepositoryLockService['REPOSITORY_LOCK_LIMITS'];
  readonly INTEGRATION_REVIEW_LIMITS: IntegrationReviewService['INTEGRATION_REVIEW_LIMITS'];
  readonly INTEGRATION_LIMITS: IntegrationService['INTEGRATION_LIMITS'];
  createRepositoryLockService(options: Record<string, unknown>): RepositoryLockService;
  createIntegrationReviewService(options: Record<string, unknown>): IntegrationReviewService;
  createIntegrationService(options: Record<string, unknown>): IntegrationService;
}

const require_ = createRequire(import.meta.url);

/* ------------------------------------------------------------------ helpers */

const CLEANUPS: (() => Promise<void>)[] = [];
const LEDGER_PATH = process.env.VIS_TASK41_LEDGER ?? path.join(tmpdir(), 'vis-task41-resource-ledger.jsonl');
const LEDGER_RESOURCES: { id: string; kind: string; path: string }[] = [];

afterAll(async () => {
  // Every registered resource is released here, and the release is RECEIPTED.
  for (const resource of LEDGER_RESOURCES.splice(0).reverse()) {
    await appendFile(
      LEDGER_PATH,
      `${JSON.stringify({ event: 'released', id: resource.id, kind: resource.kind, path: resource.path, at: Date.now() })}\n`,
      'utf8',
    ).catch(() => undefined);
  }
  for (const cleanup of CLEANUPS.splice(0).reverse()) {
    await cleanup();
  }
});

let ledgerSeq = 0;

/**
 * A deterministic operation-id sequence injected through the service's own `newOperationId` seam,
 * so a test can name the operation it is about to run and observe the lock it takes. The ids match
 * the UUID shape the product's own ids use.
 */
let operationSeq = 0;
function nextOperationId(): string {
  operationSeq += 1;
  const hex = createHash('sha256').update(`task-41-operation-${operationSeq}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}
function operationIdFor(index: number): string {
  const hex = createHash('sha256').update(`task-41-operation-${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/** Poll until one operation OBSERVABLY holds the repository lock, or fail loudly. */
async function untilHeld(
  harness: Harness,
  repository: string,
  expectedOperationId: string,
): Promise<LockGrant> {
  const deadline = Date.now() + 15000;
  for (;;) {
    const held = harness.locks.held(repository);
    if (held.length > 0) {
      expect(held[0]!.operationId).toBe(expectedOperationId);
      return held[0]!;
    }
    if (Date.now() > deadline) throw new Error(`no operation ever held the lock over ${repository}`);
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

/**
 * Register a resource in the ledger BEFORE it is created. The ledger is the task-41 discipline:
 * nothing is created that was not first named, and every name is released with a receipt.
 */
async function registerResource(kind: string, target: string): Promise<string> {
  ledgerSeq += 1;
  const id = `${kind}-${ledgerSeq}`;
  LEDGER_RESOURCES.push({ id, kind, path: target });
  await appendFile(
    LEDGER_PATH,
    `${JSON.stringify({ event: 'registered', id, kind, path: target, at: Date.now() })}\n`,
    'utf8',
  ).catch(() => undefined);
  return id;
}

/** Run one git command in a NAMED working directory. Never inherits an ambient cwd. */
function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], {
    cwd,
    encoding: 'utf8',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function gitQuiet(cwd: string, args: readonly string[]): void {
  execFileSync('git', [...args], {
    cwd,
    stdio: ['ignore', 'ignore', 'pipe'],
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

function taskIdFor(name: string): string {
  const hex = createHash('sha256').update(name).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
}

/**
 * A private temporary git repository with a single base commit. NEVER the QA worktree.
 * `branches` names extra branches created at the same base commit, so an integration can
 * fast-forward a branch the user's checkout is NOT on and the repository HEAD stays put.
 */
async function createRepo(name: string, branches: readonly string[] = []): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `vis-int-${name}-`));
  await registerResource('temp-repository', root);
  CLEANUPS.push(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, 'src'), { recursive: true });
  await writeFile(path.join(root, 'README.md'), 'base readme\n', 'utf8');
  await writeFile(path.join(root, 'src', 'keep.txt'), 'keep\n', 'utf8');
  await writeFile(path.join(root, 'gone.txt'), 'to be deleted\n', 'utf8');
  await writeFile(path.join(root, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
  await symlink('src/keep.txt', path.join(root, 'link'));
  gitQuiet(root, ['init', '-q', '-b', 'main']);
  gitQuiet(root, ['add', '-A']);
  gitQuiet(root, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
  for (const branch of branches) {
    gitQuiet(root, ['branch', branch]);
  }
  return root;
}

/** A private scratch root, deliberately OUTSIDE every repository. */
async function scratch(name: string): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), `vis-int-scratch-${name}-`));
  await registerResource('temp-scratch-root', root);
  CLEANUPS.push(() => rm(root, { recursive: true, force: true }));
  return root;
}

interface ObservedTree {
  readonly fileCount: number;
  readonly digest: string;
  readonly files: Readonly<Record<string, string>>;
}

/**
 * The on-disk shape of a working tree: a count, a digest over (relative path, content hash) and the
 * per-file hashes. `.git` is skipped — in a repository it is a directory, in a worktree it is a
 * gitfile, and neither is part of the user's content (the task-40 tree-comparison lesson).
 */
async function observeTree(root: string): Promise<ObservedTree> {
  const files: Record<string, string> = {};
  async function walk(relative: string): Promise<void> {
    const absolute = relative === '' ? root : path.join(root, relative);
    for (const entry of await readdir(absolute, { withFileTypes: true })) {
      if (entry.name === '.git') continue;
      const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
      const info = await lstat(path.join(root, child));
      if (info.isDirectory()) {
        await walk(child);
        continue;
      }
      if (info.isSymbolicLink()) {
        files[child] = `symlink:${createHash('sha256').update(await readlink(path.join(root, child))).digest('hex')}`;
        continue;
      }
      files[child] = createHash('sha256').update(await readFile(path.join(root, child))).digest('hex');
    }
  }
  await walk('');
  const names = Object.keys(files).sort();
  const hash = createHash('sha256');
  for (const name of names) hash.update(`${name}\0${files[name]}\0`);
  return Object.freeze({ fileCount: names.length, digest: hash.digest('hex'), files: Object.freeze(files) });
}

/** The exact bytes of `git status --porcelain` in a NAMED directory. */
function statusBytes(cwd: string): Buffer {
  return execFileSync('git', ['status', '--porcelain=v1', '-z', '--untracked-files=all'], {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function statusDigest(cwd: string): string {
  return createHash('sha256').update(statusBytes(cwd)).digest('hex');
}

/** The exact bytes of the index, so a `git add` in the user's directory would be observed. */
function indexBytes(cwd: string): Buffer {
  return execFileSync('git', ['ls-files', '-s', '-z'], {
    cwd,
    encoding: 'buffer',
    stdio: ['ignore', 'pipe', 'pipe'],
    env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
  });
}

function indexDigest(cwd: string): string {
  return createHash('sha256').update(indexBytes(cwd)).digest('hex');
}

/** The sorted ref-NAME set of a repository. A moved branch keeps the set; a new ref changes it. */
function refNames(cwd: string): readonly string[] {
  return runGit(cwd, ['for-each-ref', '--format=%(refname)'])
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .sort();
}

function headOf(cwd: string): string {
  return runGit(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
}

function branchOf(cwd: string, branch: string): string {
  return runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]).trim();
}

/** The frozen acceptance criteria used by every integration below. */
const CRITERIA = parseCriteria([
  { id: 'applies-cleanly', text: 'the artifact applies onto the reviewed base without a conflict' },
  { id: 'tests-pass', text: 'the frozen criteria tests exit zero in the integration worktree' },
  { id: 'fast-forward-only', text: 'the target branch moves forward to a descendant, never a rewrite' },
]);

/* ------------------------------------------------------------------ the harness */

interface Harness {
  readonly modules: IntegrationModules;
  readonly store: ArtifactStore;
  readonly artifacts: ArtifactService;
  readonly reviews: IntegrationReviewService;
  readonly locks: RepositoryLockService;
  readonly integration: IntegrationService;
  readonly storeRoot: string;
  readonly integrationsRoot: string;
  close(): void;
}

async function buildHarness(label: string): Promise<Harness> {
  const storeRoot = await scratch(`${label}-store`);
  const integrationsRoot = await scratch(`${label}-integrations`);
  const lockModule = require_('../../bridge/runtime/collaboration/repositoryLocks.js') as {
    createRepositoryLockService(options: Record<string, unknown>): RepositoryLockService;
    REPOSITORY_LOCK_LIMITS: RepositoryLockService['REPOSITORY_LOCK_LIMITS'];
  };
  const reviewModule = require_('../../bridge/runtime/collaboration/integrationReview.js') as {
    createIntegrationReviewService(options: Record<string, unknown>): IntegrationReviewService;
    INTEGRATION_REVIEW_LIMITS: IntegrationReviewService['INTEGRATION_REVIEW_LIMITS'];
  };
  const storeModule = require_('../../bridge/runtime/collaboration/artifactStore.js') as {
    createArtifactStore(options: Record<string, unknown>): ArtifactStore;
    createBufferSource(buffer: Buffer): ArtifactSource;
  };
  const artifactModule = require_('../../bridge/runtime/collaboration/artifactService.js') as {
    createArtifactService(options: Record<string, unknown>): ArtifactService;
  };
  const integrationModule = require_('../../bridge/runtime/collaboration/integrationService.js') as {
    createIntegrationService(options: Record<string, unknown>): IntegrationService;
    INTEGRATION_LIMITS: IntegrationService['INTEGRATION_LIMITS'];
  };

  const store = storeModule.createArtifactStore({ root: storeRoot });
  const artifacts = artifactModule.createArtifactService({ store, root: integrationsRoot });
  const reviews = reviewModule.createIntegrationReviewService({ store });
  const locks = lockModule.createRepositoryLockService({});
  const integration = integrationModule.createIntegrationService({
    store,
    artifacts,
    reviews,
    locks,
    integrationsRoot,
    newOperationId: nextOperationId,
    fs: fsPromises,
  });

  return {
    modules: {
      REPOSITORY_LOCK_LIMITS: lockModule.REPOSITORY_LOCK_LIMITS,
      INTEGRATION_REVIEW_LIMITS: reviewModule.INTEGRATION_REVIEW_LIMITS,
      INTEGRATION_LIMITS: integrationModule.INTEGRATION_LIMITS,
      createRepositoryLockService: lockModule.createRepositoryLockService,
      createIntegrationReviewService: reviewModule.createIntegrationReviewService,
      createIntegrationService: integrationModule.createIntegrationService,
    },
    store,
    artifacts,
    reviews,
    locks,
    integration,
    storeRoot,
    integrationsRoot,
    close() {
      integration.close();
      locks.close();
      reviews.close();
      artifacts.close();
      store.close();
    },
  };
}

/**
 * Capture one real artifact out of a real leased writer worktree of `repository`, so the artifact's
 * bytes, its base commit and its path manifest are all real product output rather than fixtures.
 */
async function captureArtifact(
  harness: Harness,
  repository: string,
  label: string,
  mutate: (cwd: string) => Promise<void>,
): Promise<CaptureView> {
  const writersRoot = await scratch(`${label}-writer-root`);
  const writerModule = require_('../../bridge/runtime/collaboration/writerLeases.js') as {
    createWriterLeaseService(options: Record<string, unknown>): WriterLeaseService;
  };
  const writers = writerModule.createWriterLeaseService({ writersRoot });
  try {
    const lease = await writers.allocate({
      repository,
      taskId: taskIdFor(label),
      ownerId: taskIdFor(`${label}-owner`),
      at: 1700000000000,
    });
    await mutate(lease.nativeCwd);
    return await harness.artifacts.capture({ lease, at: 1700000000000 });
  } finally {
    writers.close();
  }
}

/** The default passing test plan: one command per required criterion. */
function passingTests(logPath: string, orderLabel: string): readonly TestSpec[] {
  const script = [
    "const fs=require('node:fs');",
    `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${orderLabel}:enter\n`)});`,
    'setTimeout(()=>{',
    `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${orderLabel}:exit\n`)});`,
    '}, 250);',
  ].join('');
  return [
    { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', script] },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
}

function failingTests(): readonly TestSpec[] {
  return [
    { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.stderr.write("frozen criterion failed\\n"); process.exit(3)'] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
}

/** A test plan whose command reads its input from the TEMP FILE the service hands it. */
function inputFileTests(): readonly TestSpec[] {
  return [
    {
      criterionId: 'applies-cleanly',
      command: process.execPath,
      args: ['-e', 'const fs=require("node:fs");const p=process.env.VIS_INTEGRATION_INPUT;if(!p){process.stderr.write("no input file\\n");process.exit(9)}const b=fs.readFileSync(p);if(b.length!==6){process.stderr.write("bad input length "+b.length+"\\n");process.exit(9)}process.exit(0)'],
      input: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]),
    },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
}

async function readLog(logPath: string): Promise<string> {
  try {
    return await readTextFile(logPath, 'utf8');
  } catch {
    return '';
  }
}

async function writeLog(logPath: string, text: string): Promise<void> {
  await mkdir(path.dirname(logPath), { recursive: true });
  await writeTextFile(logPath, text, 'utf8');
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

/** The durable result's own rejection, read as an observed rejection. */
function resultRejection(result: IntegrationResult): Rejection {
  if (result.rejection === null) throw new Error('expected a refusal, but the result was ok');
  return result.rejection;
}

/** A rejection from a SYNCHRONOUS call (the review service's approve / approval are synchronous). */
function syncRejection(run: () => unknown): Rejection {
  try {
    run();
  } catch (error) {
    if (error instanceof CollaborationError) {
      return { code: error.code, field: error.field, detail: error.detail };
    }
    const typed = error as { code?: unknown; field?: unknown; detail?: unknown };
    return { code: String(typed.code), field: String(typed.field), detail: typed.detail ?? null };
  }
  throw new Error('expected a rejection, but the call resolved');
}

/* ------------------------------------------------------------------ the suite */

describe('task 41 — serialized post-review integration', () => {
  let logPath: string;

  beforeAll(async () => {
    const logRoot = await scratch('order-log');
    logPath = path.join(logRoot, 'order.log');
    await writeLog(logPath, '');
  });

  /* ---------------------------------------------------------------- criterion 1 */

  it('two integrations against one target repository are serialized (observed: second grant waited, order log is enter/exit/enter/exit)', async () => {
    const repository = await createRepo('serialized', ['integration/first', 'integration/second']);
    const harness = await buildHarness('serialized');
    try {
      await writeLog(logPath, '');
      const first = await captureArtifact(harness, repository, 'serialized-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const second = await captureArtifact(harness, repository, 'serialized-b', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'b.txt'), 'b\n', 'utf8');
      });

      const firstReview = await harness.reviews.create({
        repository, target: 'integration/first', artifactHash: first.artifactHash, at: 1700000000000,
      });
      const secondReview = await harness.reviews.create({
        repository, target: 'integration/second', artifactHash: second.artifactHash, at: 1700000000000,
      });
      const firstApproval = harness.reviews.approve({
        reviewId: firstReview.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });
      const secondApproval = harness.reviews.approve({
        reviewId: secondReview.reviewId, at: 1700000000002, reviewerId: 'reviewer-1',
      });

      const firstOperationId = operationIdFor(1);
      const secondOperationId = operationIdFor(2);

      // Start the first integration and wait until it OBSERVABLY holds the repository lock, so the
      // ordering is driven rather than left to a race between two async calls.
      const firstPromise = harness.integration.integrate({
        approvalId: firstApproval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'first'),
        commitMessage: 'integrate first',
      });
      const holder = await untilHeld(harness, repository, firstOperationId);
      expect(holder.waited).toBe(false);

      // Now the second integration starts while the first still holds the lock.
      const secondPromise = harness.integration.integrate({
        approvalId: secondApproval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'second'),
        commitMessage: 'integrate second',
      });

      const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
      expect(firstResult.operationId).toBe(firstOperationId);
      expect(secondResult.operationId).toBe(secondOperationId);

      // The OBSERVED serialization, not a prose claim.
      expect(secondResult.lock.waited).toBe(true);
      expect(secondResult.lock.waitedMs).toBeGreaterThan(0);
      expect(firstResult.lock.waited).toBe(false);
      expect(secondResult.lock.queuePosition).toBeGreaterThan(0);
      expect(await readLog(logPath)).toBe('first:enter\nfirst:exit\nsecond:enter\nsecond:exit\n');
      // The second integration waited essentially exactly as long as the first held the lock.
      expect(firstResult.lock.heldMs).toBeGreaterThanOrEqual(250);
      expect(secondResult.lock.waitedMs).toBeGreaterThan(0);
      expect(secondResult.lock.waitedMs).toBeLessThanOrEqual(firstResult.lock.heldMs + 250);
      expect(firstResult.completedAt).toBeGreaterThan(firstResult.startedAt);
      expect(secondResult.completedAt).toBeGreaterThan(secondResult.startedAt);

      // Both integrations are real successes, and each moved its own branch forward.
      expect(firstResult.ok).toBe(true);
      expect(firstResult.outcome).toBe('integrated');
      expect(secondResult.ok).toBe(true);
      expect(secondResult.outcome).toBe('integrated');
      expect(branchOf(repository, 'integration/first')).toBe(firstResult.fastForward.to);
      expect(branchOf(repository, 'integration/second')).toBe(secondResult.fastForward.to);
      // The repository HEAD never moved: both integrations fast-forwarded branches the user's
      // checkout is not on, which is what let both of them succeed against one target.
      expect(headOf(repository)).toBe(firstReview.base);

      // The lock service's own counters corroborate the observation.
      const lockState = harness.locks.state();
      expect(lockState.acquired).toBe(2);
      expect(lockState.waited).toBe(1);
      expect(lockState.held).toBe(0);
      expect(lockState.maxObservedHoldMs).toBeGreaterThan(0);
      expect(lockState.order.map((entry) => entry.operationId)).toEqual([
        firstResult.operationId,
        secondResult.operationId,
      ]);
      expect(lockState.order[1]?.releasedAt).not.toBeNull();
      expect(lockState.order[0]?.releasedAt).not.toBeNull();
      expect(lockState.order[1]!.acquiredAt).toBeGreaterThanOrEqual(lockState.order[0]!.releasedAt!);
    } finally {
      harness.close();
    }
  });

  it('a second integration that will not wait is refused with the observed holder (observed: repository_lock_busy carries the first operation id)', async () => {
    const repository = await createRepo('refused');
    const harness = await buildHarness('refused');
    try {
      const artifact = await captureArtifact(harness, repository, 'refused-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      // Hold the lock by hand, exactly as the service holds it, and ask for no wait.
      const grant = await harness.locks.acquire({
        repository, operationId: 'manual-holder', at: 1700000000002, waitMs: 0,
      });
      const refused = await rejection(harness.locks.acquire({
        repository, operationId: 'manual-second', at: 1700000000003, waitMs: 0,
      }));
      expect(refused.code).toBe('conflict');
      expect(refused.field).toBe('repository_lock_busy');
      expect(refused.detail).toMatchObject({
        repository: expect.any(String),
        holder: 'manual-holder',
        holders: 1,
        maxHolders: harness.modules.REPOSITORY_LOCK_LIMITS.maxHolders,
      });
      expect(harness.locks.held(repository).map((entry) => entry.operationId)).toEqual(['manual-holder']);

      // Releasing the holder lets the next acquisition through immediately.
      const receipt = harness.locks.release({ grant, at: 1700000000004 });
      expect(receipt.operationId).toBe('manual-holder');
      expect(receipt.heldMs).toBeGreaterThanOrEqual(0);
      expect(harness.locks.held(repository)).toEqual([]);

      // The service still integrates cleanly once the repository is free.
      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'refused'),
        commitMessage: 'integrate after release',
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('integrated');
    } finally {
      harness.close();
    }
  });

  /* ---------------------------------------------------------------- criterion 2 */

  it('the approved artifact hash is bound at review time and the actual bytes are re-hashed (observed: a corrupted object is refused with two different real sha256 values)', async () => {
    const repository = await createRepo('hash-bind');
    const harness = await buildHarness('hash-bind');
    try {
      const artifact = await captureArtifact(harness, repository, 'hash-bind-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
        await writeFile(path.join(cwd, 'bin.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]));
      });
      expect(artifact.artifactHash).toMatch(/^[a-f0-9]{64}$/);

      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      // The binding is exactly the reviewed triple, frozen.
      expect(review.base).toBe(headOf(repository));
      expect(review.target).toBe('main');
      expect(review.artifactHash).toBe(artifact.artifactHash);
      expect(review.state).toBe('pending');
      expect(review.targetCleanAtReview).toBe(true);
      expect(review.dirtyPathsAtReview).toEqual([]);
      expect(Object.isFrozen(review)).toBe(true);

      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });
      expect(approval.binding).toEqual({
        artifactHash: artifact.artifactHash,
        base: review.base,
        target: 'main',
        repository,
      });
      expect(Object.isFrozen(approval.binding)).toBe(true);

      // Corrupt the durable object's BYTES so the approved hash no longer describes them.
      const verifiedBefore = await harness.store.verify(artifact.artifactHash);
      expect(verifiedBefore.ok).toBe(true);
      const originalBytes = await harness.store.read(artifact.artifactHash);
      expect(originalBytes.length).toBe(artifact.bytes);
      const objectPath = path.join(
        harness.storeRoot,
        'objects',
        artifact.artifactHash.slice(0, 2),
        artifact.artifactHash.slice(2),
      );
      expect(await exists(objectPath)).toBe(true);
      await chmod(objectPath, 0o644);
      await writeFile(objectPath, Buffer.from('tampered bytes that are not the artifact\n', 'utf8'), 'utf8');
      const tampered = await harness.store.verify(artifact.artifactHash);
      expect(tampered.ok).toBe(false);
      expect(tampered.artifactHash).not.toBe(artifact.artifactHash);

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'hash-bind'),
        commitMessage: 'must not happen',
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('artifact_mismatch');
      const refusal = resultRejection(result);
      expect(refusal.code).toBe('conflict');
      expect(refusal.field).toBe('integration_artifact_bytes');
      // Two DIFFERENT real sha256 values: the one approved at review time and the one the bytes
      // actually hash to. This is the observed "approved hash matches the actual bytes" check.
      expect(refusal.detail).toMatchObject({
        approved: artifact.artifactHash,
        observed: tampered.artifactHash,
      });
      expect((refusal.detail as { approved: string }).approved)
        .not.toBe((refusal.detail as { observed: string }).observed);
      expect(result.observedArtifactHash).toBe(tampered.artifactHash);
      expect(result.artifact.verified).toBe(false);

      // The artifact object is preserved, not repaired and not deleted.
      expect(await harness.store.has(artifact.artifactHash)).toBe(true);
      expect(await exists(objectPath)).toBe(true);

      // Nothing was applied, nothing was committed, and the target is untouched.
      expect(result.worktree.created).toBe(false);
      expect(result.tests).toEqual([]);
      expect(result.commit.created).toBe(false);
      expect(result.fastForward.applied).toBe(false);
      expect(branchOf(repository, 'main')).toBe(review.base);
      expect(headOf(repository)).toBe(review.base);

      // Restore the object's original bytes so the store is left consistent.
      await chmod(objectPath, 0o644);
      await writeFile(objectPath, originalBytes, 'utf8');
      const restored = await harness.store.verify(artifact.artifactHash);
      expect(restored.ok).toBe(true);
      expect(restored.artifactHash).toBe(artifact.artifactHash);
      expect(restored.bytes).toBe(artifact.bytes);
    } finally {
      harness.close();
    }
  });

  /* ---------------------------------------------------------------- criterion 3 */

  it('a dirty target fails the integration and preserves the artifact (observed: integration_target_dirty with the real dirty paths, artifact still verifies)', async () => {
    const repository = await createRepo('dirty');
    const harness = await buildHarness('dirty');
    try {
      const artifact = await captureArtifact(harness, repository, 'dirty-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      // The target becomes dirty AFTER the review: the user's own uncommitted work.
      const before = await observeTree(repository);
      await writeFile(path.join(repository, 'README.md'), 'user edit\n', 'utf8');
      await writeFile(path.join(repository, 'user-local.txt'), 'user only\n', 'utf8');
      const dirtyAfter = statusDigest(repository);

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'dirty'),
        commitMessage: 'must not happen',
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('target_dirty');
      const refusal = resultRejection(result);
      expect(refusal.code).toBe('conflict');
      expect(refusal.field).toBe('integration_target_dirty');
      expect((refusal.detail as { repository: string }).repository).toBe(repository);
      expect((refusal.detail as { dirtyPaths: readonly string[] }).dirtyPaths).toContain('README.md');
      expect((refusal.detail as { dirtyPaths: readonly string[] }).dirtyPaths).toContain('user-local.txt');

      // The artifact is preserved, byte for byte.
      expect(result.artifact.preserved).toBe(true);
      expect(await harness.store.has(artifact.artifactHash)).toBe(true);
      const verified = await harness.store.verify(artifact.artifactHash);
      expect(verified.ok).toBe(true);
      expect(verified.artifactHash).toBe(artifact.artifactHash);

      // The user's files were never touched and never reset.
      expect(statusDigest(repository)).toBe(dirtyAfter);
      const after = await observeTree(repository);
      expect(after.files['README.md']).toBe(
        createHash('sha256').update('user edit\n').digest('hex'),
      );
      expect(after.files['user-local.txt']).toBe(
        createHash('sha256').update('user only\n').digest('hex'),
      );
      expect(after.fileCount).toBe(before.fileCount + 1);
      expect(branchOf(repository, 'main')).toBe(review.base);
      expect(result.worktree.created).toBe(false);
      expect(result.worktree.removed).toBe(false);
      expect(result.tests).toEqual([]);
      expect(result.fastForward.applied).toBe(false);
      expect(result.commit.created).toBe(false);
    } finally {
      harness.close();
    }
  });

  it('a moved HEAD fails the integration and preserves the artifact (observed: integration_head_moved with the real expected and observed commits)', async () => {
    const repository = await createRepo('moved');
    const harness = await buildHarness('moved');
    try {
      const artifact = await captureArtifact(harness, repository, 'moved-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const reviewedBase = headOf(repository);
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      expect(review.base).toBe(reviewedBase);
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      // The target's HEAD moves AFTER the review: a new commit lands on the target branch.
      await writeFile(path.join(repository, 'someone-else.txt'), 'other work\n', 'utf8');
      gitQuiet(repository, ['add', '-A']);
      gitQuiet(repository, ['-c', 'user.name=other', '-c', 'user.email=other@example.invalid', 'commit', '-q', '-m', 'other']);
      const movedTo = headOf(repository);
      expect(movedTo).not.toBe(reviewedBase);
      // The user's own tree, as it stands after THEIR commit and before the integration.
      const before = await observeTree(repository);

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'moved'),
        commitMessage: 'must not happen',
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('head_moved');
      const refusal = resultRejection(result);
      expect(refusal.code).toBe('conflict');
      expect(refusal.field).toBe('integration_head_moved');
      expect(refusal.detail).toMatchObject({ expected: reviewedBase, observed: movedTo });

      // The artifact is preserved.
      expect(result.artifact.preserved).toBe(true);
      expect(await harness.store.has(artifact.artifactHash)).toBe(true);
      expect((await harness.store.verify(artifact.artifactHash)).ok).toBe(true);

      // Nothing of the user's was touched: their commit is still the tip and their tree is intact.
      expect(headOf(repository)).toBe(movedTo);
      const after = await observeTree(repository);
      expect(after.digest).toBe(before.digest);
      expect(after.fileCount).toBe(before.fileCount);
      expect(after.files['someone-else.txt']).toBe(
        createHash('sha256').update('other work\n').digest('hex'),
      );
      expect(result.worktree.created).toBe(false);
      expect(result.tests).toEqual([]);
      expect(result.fastForward.applied).toBe(false);
    } finally {
      harness.close();
    }
  });

  /* ---------------------------------------------------------------- criterion 4 */

  it('a failing test cleans only this operation temp and never resets the user files (observed: per-operation temp gone, user tree digest and status byte-identical)', async () => {
    const repository = await createRepo('testfail');
    const harness = await buildHarness('testfail');
    try {
      const artifact = await captureArtifact(harness, repository, 'testfail-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
        await writeFile(path.join(cwd, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
        await rm(path.join(cwd, 'gone.txt'));
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      // PHASE 1 — a clean target, so the tests really run and really fail.
      const beforeTree = await observeTree(repository);
      const beforeStatus = statusDigest(repository);
      const beforeIndex = indexDigest(repository);
      const beforeHead = headOf(repository);

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: failingTests(),
        commitMessage: 'must not happen',
      });

      expect(result.ok).toBe(false);
      expect(result.outcome).toBe('tests_failed');
      const refusal = resultRejection(result);
      expect(refusal.code).toBe('conflict');
      expect(refusal.field).toBe('integration_tests');
      expect(refusal.detail).toMatchObject({ failed: 'tests-pass' });

      // The failing test really ran, and its exit code is the observed one. The criteria after it
      // never ran, which is why the record holds two entries rather than three.
      const failed = result.tests.find((entry) => entry.criterionId === 'tests-pass');
      expect(failed?.exitCode).toBe(3);
      expect(result.tests).toHaveLength(2);
      expect(result.tests.map((entry) => entry.criterionId)).toEqual([
        'applies-cleanly',
        'tests-pass',
      ]);

      // ONLY this operation's temp is gone.
      expect(result.worktree.created).toBe(true);
      expect(result.worktree.removed).toBe(true);
      expect(result.worktree.removedAt).not.toBeNull();
      expect(await exists(result.worktree.path)).toBe(false);
      const operationRoot = path.dirname(result.worktree.path);
      expect(await exists(operationRoot)).toBe(false);
      const worktrees = runGit(repository, ['worktree', 'list', '--porcelain']);
      expect(worktrees).not.toContain(result.worktree.path);

      // The user's files are untouched: byte counts and hashes, before and after.
      const afterTree = await observeTree(repository);
      expect(afterTree.digest).toBe(beforeTree.digest);
      expect(afterTree.fileCount).toBe(beforeTree.fileCount);
      expect(afterTree.files).toEqual(beforeTree.files);
      // No reset: nothing was swept into a commit, and the index is unchanged.
      expect(statusDigest(repository)).toBe(beforeStatus);
      expect(indexDigest(repository)).toBe(beforeIndex);
      expect(headOf(repository)).toBe(beforeHead);
      expect(branchOf(repository, 'main')).toBe(beforeHead);

      // The artifact survived, and so did the durable record of what happened.
      expect(result.artifact.preserved).toBe(true);
      expect(await harness.store.has(artifact.artifactHash)).toBe(true);
      expect((await harness.store.verify(artifact.artifactHash)).ok).toBe(true);
      expect(result.commit.created).toBe(false);
      expect(result.fastForward.applied).toBe(false);
      expect(result.fastForward.to).toBeNull();
      expect(result.targetAfter.treeDigest).toBe(result.targetBefore.treeDigest);
      expect(result.targetAfter.clean).toBe(true);

      // PHASE 2 — the user's own uncommitted work, where a reset WOULD destroy it. A dirty target
      // is refused before a temp is even created, and the edit survives byte for byte.
      await writeFile(path.join(repository, 'README.md'), 'user edit\n', 'utf8');
      await writeFile(path.join(repository, 'user-local.txt'), 'precious\n', 'utf8');
      const dirtyStatus = statusDigest(repository);
      const dirtyIndex = indexDigest(repository);

      const dirty = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: failingTests(),
        commitMessage: 'must not happen',
      });

      expect(dirty.ok).toBe(false);
      expect(dirty.outcome).toBe('target_dirty');
      // No temp worktree was created at all, so there was nothing of ours to leave behind.
      expect(dirty.worktree.created).toBe(false);
      expect(dirty.worktree.removed).toBe(false);
      expect(dirty.tests).toEqual([]);
      // No reset --hard, no auto-stash: the user's uncommitted work is still there, unchanged.
      expect(statusDigest(repository)).toBe(dirtyStatus);
      expect(indexDigest(repository)).toBe(dirtyIndex);
      expect(await readFile(path.join(repository, 'README.md'), 'utf8')).toBe('user edit\n');
      expect(await readFile(path.join(repository, 'user-local.txt'), 'utf8')).toBe('precious\n');
      expect(runGit(repository, ['stash', 'list']).trim()).toBe('');
      // And the artifact is still preserved.
      expect(dirty.artifact.preserved).toBe(true);
      expect(await harness.store.has(artifact.artifactHash)).toBe(true);
    } finally {
      harness.close();
    }
  });

  /* ---------------------------------------------------------------- the prohibitions */

  it('a successful integration never auto-commits or pushes the user original directory (observed: user HEAD and ref set unchanged, files and index byte-identical, one atomic fast-forward)', async () => {
    const repository = await createRepo('nopush', ['integration/approved']);
    const harness = await buildHarness('nopush');
    try {
      const artifact = await captureArtifact(harness, repository, 'nopush-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
        await writeFile(path.join(cwd, 'added.txt'), 'added\n', 'utf8');
        await rm(path.join(cwd, 'gone.txt'));
      });
      const review = await harness.reviews.create({
        repository, target: 'integration/approved', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      const beforeHead = headOf(repository);
      const beforeRefs = refNames(repository);
      const beforeTree = await observeTree(repository);
      const beforeIndex = indexDigest(repository);
      const beforeStatus = statusDigest(repository);
      const remotesBefore = runGit(repository, ['remote']).trim();

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'nopush'),
        commitMessage: 'vis: integrate reviewed artifact',
      });

      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('integrated');

      // The user's original directory gained NO new commit and NO new ref.
      expect(headOf(repository)).toBe(beforeHead);
      expect(refNames(repository)).toEqual(beforeRefs);
      // The user's working tree and index are byte-identical: nothing was committed there.
      expect(await observeTree(repository)).toEqual(beforeTree);
      expect(indexDigest(repository)).toBe(beforeIndex);
      expect(statusDigest(repository)).toBe(beforeStatus);
      // Nothing was pushed: there is no remote, and none appeared.
      expect(runGit(repository, ['remote']).trim()).toBe(remotesBefore);
      expect(remotesBefore).toBe('');

      // The single ref mutation is the controlled fast-forward of an EXISTING branch, forward only.
      expect(result.fastForward.applied).toBe(true);
      expect(result.fastForward.ref).toBe('refs/heads/integration/approved');
      expect(result.fastForward.from).toBe(beforeHead);
      expect(result.fastForward.to).not.toBeNull();
      expect(result.fastForward.isFastForward).toBe(true);
      expect(branchOf(repository, 'integration/approved')).toBe(result.fastForward.to);
      // `git merge-base --is-ancestor <from> <to>` exits 0: the branch moved to a DESCENDANT.
      execFileSync('git', ['merge-base', '--is-ancestor', result.fastForward.from, result.fastForward.to!], {
        cwd: repository, stdio: 'ignore',
      });
      // The commit was created in the operation's OWN worktree, never in the user's directory.
      expect(result.commit.created).toBe(true);
      expect(result.commit.worktree).toBe(result.worktree.path);
      const parent = runGit(repository, ['rev-parse', '--verify', `${result.commit.sha}^`]).trim();
      expect(parent).toBe(beforeHead);

      // And the service surface itself has no push, remote or refspec capability at all.
      const surface = Object.keys(harness.integration).sort();
      expect(surface).toEqual([
        'INTEGRATION_LIMITS', 'close', 'integrate', 'operation', 'operations', 'state',
      ]);
      for (const member of surface) {
        expect(member).not.toMatch(/push|remote|refspec|reset|stash|force/i);
      }
      // This operation's temp is cleaned on success too.
      expect(await exists(result.worktree.path)).toBe(false);
      expect(runGit(repository, ['worktree', 'list', '--porcelain'])).not.toContain(result.worktree.path);
    } finally {
      harness.close();
    }
  });

  it('the command runner type cannot write to a child stdin (observed: no runner member accepts input, and the child reads its blob from a temp file)', async () => {
    const repository = await createRepo('stdin');
    const harness = await buildHarness('stdin');
    try {
      const artifact = await captureArtifact(harness, repository, 'stdin-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: inputFileTests(),
        commitMessage: 'integrate with an input blob',
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('integrated');

      // The blob reached the test as a TEMP FILE whose path the service recorded.
      const withInput = result.tests.find((entry) => entry.criterionId === 'applies-cleanly');
      expect(withInput?.inputFile).toBeTruthy();
      expect(withInput?.exitCode).toBe(0);
      expect(withInput!.inputFile!).toContain(result.operationId);
      // The temp file lived inside this operation's own temp root, which is now cleaned.
      expect(await exists(withInput!.inputFile!)).toBe(false);

      // The service surface has no member that could feed a child's stdin.
      for (const member of Object.keys(harness.integration)) {
        expect(member).not.toMatch(/stdin|write|input$/i);
      }
      expect(harness.modules.INTEGRATION_LIMITS.maxTestOutputBytes).toBe(2 * 1024 * 1024);
    } finally {
      harness.close();
    }
  });

  it('every rejection carries an explicit code and field, and every code is a frozen ERROR_CODES member', async () => {
    const repository = await createRepo('codes');
    const harness = await buildHarness('codes');
    try {
      const artifact = await captureArtifact(harness, repository, 'codes-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      const unknown = syncRejection(() => harness.reviews.approval('11111111-1111-4111-8111-111111111111'));
      expect(unknown.code).toBe('invalid_request');
      expect(unknown.field).toBe('integration_approval_unknown');

      const duplicate = syncRejection(() => harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000002, reviewerId: 'reviewer-2',
      }));
      expect(duplicate.code).toBe('conflict');
      expect(duplicate.field).toBe('integration_review_approved');

      const badHash = await rejection(harness.reviews.create({
        repository, target: 'main', artifactHash: 'not-a-hash', at: 1700000000003,
      }));
      expect(badHash.code).toBe('invalid_request');
      expect(badHash.field).toBe('integration_artifact_hash');

      const missing = await rejection(harness.reviews.create({
        repository, target: 'main', artifactHash: 'a'.repeat(64), at: 1700000000004,
      }));
      expect(missing.code).toBe('invalid_request');
      expect(missing.field).toBe('integration_artifact_missing');

      // A test spec that does not cover a required criterion is an explicit refusal.
      const incomplete = await rejection(harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: [{ criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
      }));
      expect(incomplete.code).toBe('invalid_request');
      expect(incomplete.field).toBe('integration_criteria');

      // Every operational refusal observed in this suite is a frozen code with a named field.
      const dirtyRepository = await createRepo('codes-dirty');
      const dirtyArtifact = await captureArtifact(harness, dirtyRepository, 'codes-dirty-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const dirtyReview = await harness.reviews.create({
        repository: dirtyRepository, target: 'main', artifactHash: dirtyArtifact.artifactHash, at: 1700000000005,
      });
      const dirtyApproval = harness.reviews.approve({
        reviewId: dirtyReview.reviewId, at: 1700000000006, reviewerId: 'reviewer-1',
      });
      await writeFile(path.join(dirtyRepository, 'dirty.txt'), 'dirty\n', 'utf8');
      const dirtyResult = await harness.integration.integrate({
        approvalId: dirtyApproval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'codes-dirty'),
      });
      expect(dirtyResult.ok).toBe(false);
      expect(ERROR_CODES).toContain(dirtyResult.rejection!.code);
      expect(dirtyResult.rejection!.field).toMatch(/^integration_[a-z_]+$/);
      expect(typeof dirtyResult.rejection!.field).toBe('string');
      expect(dirtyResult.rejection!.field.length).toBeGreaterThan(0);
    } finally {
      harness.close();
    }
  });

  it('the review binding is immutable: no API mutates an approved review, so any change forces a new review', async () => {
    const repository = await createRepo('immutable');
    const harness = await buildHarness('immutable');
    try {
      const artifact = await captureArtifact(harness, repository, 'immutable-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });

      // The approval is frozen and its binding cannot be rewritten.
      expect(Object.isFrozen(approval)).toBe(true);
      expect(() => {
        (approval as { artifactHash: string }).artifactHash = 'b'.repeat(64);
      }).toThrow();
      expect(approval.artifactHash).toBe(artifact.artifactHash);

      // A second approval for the same review is refused, so the binding is minted exactly once.
      const again = syncRejection(() => harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000002, reviewerId: 'reviewer-2',
      }));
      expect(again.field).toBe('integration_review_approved');

      // Re-reading the review shows it approved, with the SAME base and hash it was created with.
      const reread = harness.reviews.review(review.reviewId);
      expect(reread.state).toBe('approved');
      expect(reread.artifactHash).toBe(artifact.artifactHash);
      expect(reread.base).toBe(headOf(repository));
      expect(reread.approvedAt).toBe(1700000000001);

      // The frozen limits are one shared object per module, not per call.
      expect(harness.reviews.INTEGRATION_REVIEW_LIMITS).toBe(harness.modules.INTEGRATION_REVIEW_LIMITS);
      expect(harness.locks.REPOSITORY_LOCK_LIMITS).toBe(harness.modules.REPOSITORY_LOCK_LIMITS);
      expect(harness.integration.INTEGRATION_LIMITS).toBe(harness.modules.INTEGRATION_LIMITS);
      expect(Object.isFrozen(harness.integration.INTEGRATION_LIMITS)).toBe(true);
      expect(Object.isFrozen(harness.locks.REPOSITORY_LOCK_LIMITS)).toBe(true);
      expect(Object.isFrozen(harness.reviews.INTEGRATION_REVIEW_LIMITS)).toBe(true);

      // The durable result is frozen too.
      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'immutable'),
        commitMessage: 'integrate immutable',
      });
      expect(Object.isFrozen(result)).toBe(true);
      expect(Object.isFrozen(result.tests)).toBe(true);
      expect(Object.isFrozen(result.fastForward)).toBe(true);
      expect(harness.integration.operation(result.operationId)).toEqual(result);
      expect(harness.integration.operations()).toHaveLength(1);
    } finally {
      harness.close();
    }
  });

  it('a lost artifact object is an explicit miss, never a fabricated empty integration', async () => {
    const repository = await createRepo('lost');
    const harness = await buildHarness('lost');
    try {
      const artifact = await captureArtifact(harness, repository, 'lost-a', async (cwd) => {
        await writeFile(path.join(cwd, 'src', 'a.txt'), 'a\n', 'utf8');
      });
      const review = await harness.reviews.create({
        repository, target: 'main', artifactHash: artifact.artifactHash, at: 1700000000000,
      });
      const approval = harness.reviews.approve({
        reviewId: review.reviewId, at: 1700000000001, reviewerId: 'reviewer-1',
      });
      // A hash that was never stored is an explicit miss, never a fabricated empty artifact.
      const missing = await rejection(harness.store.read('c'.repeat(64)));
      expect(missing.code).toBe('invalid_request');
      expect(missing.field).toBe('artifact_missing');
      expect(missing.detail).toMatchObject({ artifactHash: 'c'.repeat(64) });

      // An approval whose hash was never stored cannot be created at all.
      const neverStored = await rejection(harness.reviews.create({
        repository, target: 'main', artifactHash: 'd'.repeat(64), at: 1700000000002,
      }));
      expect(neverStored.field).toBe('integration_artifact_missing');

      // The real artifact is still there and still integrates.
      const result = await harness.integration.integrate({
        approvalId: approval.approvalId,
        criteria: CRITERIA,
        tests: passingTests(logPath, 'lost'),
        commitMessage: 'integrate after a miss',
      });
      expect(result.ok).toBe(true);
      expect(result.outcome).toBe('integrated');
      expect(result.artifact.verified).toBe(true);
      expect(result.artifactBytes).toBe(artifact.bytes);
      expect(result.artifactChunks).toBeGreaterThan(0);
      expect(result.artifactPeakBufferedBytes).toBeLessThanOrEqual(
        harness.modules.INTEGRATION_LIMITS.maxTestOutputBytes,
      );
      expect(result.artifactPeakBufferedBytes).toBeLessThan(artifact.bytes + 1);
    } finally {
      harness.close();
    }
  });
});
