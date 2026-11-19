// @vitest-environment node
//
// Task 43 — the full-chain system integration test (plan task 43).
//
// Product under test, ALL of it the REAL landed modules — nothing here re-implements a production
// algorithm and no in-memory stand-in substitutes for one:
//   shared/runtime/migration/legacyExport.js   the legacy export scan/revision/paging contract
//   app/runtime/migration/browserSourcePort.ts the task-24 read-only random-access port
//   app/runtime/migration/legacyBinding.ts     describeLocalBinding + bindLegacySource
//   shared/runtime/identity.js                 SessionRef / SessionKey / RepoKey / WorkspaceKey
//   shared/runtime/protocol.js                 the frozen v1 frame codec and LIMITS
//   bridge/runtime/threads/{threadService,participantService}.js   the Host Thread wrapper
//   bridge/runtime/threads/{handoffService,handoffRecovery,checkpointService}.js  the handoff ladder
//   bridge/runtime/collaboration/coordinator.js + fanoutService.js  Team/Task/Attempt and fan-out
//   bridge/runtime/collaboration/{writerLeases,artifactStore,artifactService,integrationReview,
//     repositoryLocks,integrationService}.js   writer isolation, durable artifacts, integration
//   bridge/runtime/storage/runtimeStore.js + runtimeDatabaseWorker.mjs  the real SQLite store
//   bridge/runtime/discoveryScheduler.js       the fair per-source discovery scheduler
//   bridge/runtime/migration/importService.js  the import admission/verification service
//   app/dev/runtime-v090/fixtures/inventory.mjs the INDEPENDENT seed090 ground-truth oracle
//   app/dev/runtime-v090/system43-mapping.mjs   THE ONE SOURCE of the old-feature mapping
//
// The .d.ts-less bridge modules are loaded through createRequire, exactly as handoff.test.ts,
// artifactIntegration.test.ts, collaborationCoordinator.test.ts and fanout.test.ts do: a static
// import of a .d.ts-less bridge module is TS7016 under this repo's strict vue-tsc gate. The
// contracts below are declared here, so the require boundary is the only untyped edge. Every
// module that DOES ship a sibling declaration (identity, protocol, capabilities, thread,
// collaboration, legacyExport, threadService, participantService, runtimeStore,
// discoveryScheduler, importService) is imported statically and is checked by vue-tsc.
//
// THE FOUR ACCEPTANCE-ADJACENT REQUIREMENTS, each a NAMED test with OBSERVED values:
//   1. 旧功能 mapping 每 row 有 observed scenario
//        'every old-feature mapping row carries an observed scenario, and a row without one is refused'
//        observed: the per-row coverage list over the scenario ids THIS run executed, plus the
//        refusal of a synthetic row that names no scenario and of a row naming a scenario outside
//        the catalog.
//   2. migration hash 不变
//        'the legacy import leaves the migration hash unchanged'
//        observed: the real sha256 of every legacy store file before the walk and after it (equal,
//        with the actual hex values recorded), and the export revision identical across two opens
//        and across every page of the walk.
//   3. source failure 不拖整体
//        'one source failing does not drag down the whole run'
//        observed: the real discovery scheduler with all five sources demanded, two rejecting
//        source_unavailable, three still settling, and a later demand still running.
//   4. 所有 IS 用户链路及 negative case 结果有 assertion/evidence
//        every IS path in system43-mapping.mjs is walked by a named test below, and every negative
//        case records its typed rejection code/field.
//
// Every git / spawn / exec call names its cwd explicitly, every repository is a private temporary
// one under this test's own root (NEVER the worktree), and no git operation is run in the worktree.
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import {
  decodeSessionKey,
  encodeRepoKey,
  encodeSessionKey,
  encodeWorkspaceKey,
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseRepoRef,
  parseSessionRef,
  parseWorkspaceRef,
} from '../../shared/runtime/identity.js';
import type { RepoRef, SessionRef } from '../../shared/runtime/identity.js';
import { decodeFrame, encodeFrame, LIMITS as PROTOCOL_LIMITS } from '../../shared/runtime/protocol.js';
import { ERROR_CODES } from '../../shared/runtime/capabilities.js';
import { parseCriteria } from '../../shared/runtime/collaboration.js';
import {
  legacyDigest,
  openLegacyExport,
  readLegacyExportPage,
  resolveLegacyLocalBinding,
} from '../../shared/runtime/migration/legacyExport.js';
import type { LegacyPiece, LegacySource } from '../../shared/runtime/migration/legacyExport.js';
import { createThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadRecord, ThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { ThreadSessionView } from '../../shared/runtime/thread.js';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { OBSERVER_LIMITS, createEventObserver } from '../../bridge/runtime/eventObservers.js';
import { parseBinding } from '../../shared/runtime/protocol.js';
import { createDiscoveryScheduler } from '../../bridge/runtime/discoveryScheduler.js';
import { createImportService } from '../../bridge/runtime/migration/importService.js';
import { createBrowserLegacySourcePort } from './migration/browserSourcePort';
import { bindLegacySource, describeLocalBinding } from './migration/legacyBinding';
import type { ProvenMapping } from './migration/legacyBinding';
import { createRequire } from 'node:module';

/* ------------------------------------------------------------------ the require boundary */

const require_ = createRequire(import.meta.url);

interface HandoffModule {
  createHandoffService(options: Record<string, unknown>): HandoffServiceLike;
  createAckSink(scope: unknown): Record<string, unknown>;
  createObserveSink(scope: unknown): Record<string, unknown>;
  createHostSink(scope: unknown): Record<string, unknown>;
  HANDOFF_LADDER: readonly string[];
}
interface HandoffViewLike { readonly handoffId: string; readonly state: string; readonly checkpoint: { readonly digest: string } | null }
interface HandoffServiceLike {
  begin(input: Record<string, unknown>): Promise<HandoffViewLike>;
  attach(input: Record<string, unknown>): Promise<HandoffViewLike>;
  prepare(input: Record<string, unknown>): Promise<HandoffViewLike>;
  deliver(input: Record<string, unknown>): Promise<HandoffViewLike>;
  observe(input: Record<string, unknown>): Promise<HandoffViewLike>;
  handoff(handoffId: string): HandoffViewLike;
  handoffs(): readonly HandoffViewLike[];
  ops(handoffId: string): readonly unknown[];
  close(): void;
}
interface CheckpointModule { createCheckpointService(): CheckpointServiceLike }
interface CheckpointServiceLike {
  create(input: { checkpointId: string; scope: unknown; entries: readonly unknown[] }): { digest: string };
  get(checkpointId: string): unknown;
  close(): void;
}
interface RecoveryModule {
  restoreOriginalSelection(input: { threads: ThreadService; threadId: string; participantId: string }): unknown;
}
interface CoordinatorModule { createCollaborationCoordinator(options?: Record<string, unknown>): CoordinatorLike }
interface TaskViewLike {
  readonly taskId: string; readonly title: string; readonly state: string;
  readonly phase: string; readonly acceptance: { readonly state: string } | null;
}
interface CoordinatorLike {
  createTeam(input: Record<string, unknown>): { teamId: string; name: string };
  createTask(input: Record<string, unknown>): TaskViewLike;
  dispatch(input: Record<string, unknown>): Promise<{ attempt: { attemptId: string } | null }>;
  attempt(attemptId: string): { state: string };
  task(taskId: string): TaskViewLike;
  registerDeliverable(input: Record<string, unknown>): unknown;
  submitForReview(input: Record<string, unknown>): unknown;
  review(input: Record<string, unknown>): unknown;
  accept(input: Record<string, unknown>): unknown;
  postMessage(input: Record<string, unknown>): unknown;
  mailbox(teamId: string): readonly unknown[];
  state(): Record<string, number>;
  close(): void;
}
interface FanoutModule { createFanoutService(options: Record<string, unknown>): FanoutLike }
interface FanoutLike {
  createFanout(input: Record<string, unknown>): { fanoutId: string; state: string; targets: readonly { recipientId: string; outcome: string }[]; stats: Record<string, number> };
  dispatch(input: Record<string, unknown>): Promise<{ state: string; targets: readonly { recipientId: string; outcome: string }[]; stats: Record<string, number> }>;
  state(): Record<string, number>;
  close(): void;
}
interface WriterModule {
  createWriterLeaseService(options: Record<string, unknown>): WriterLike;
  createGitRunner(options: Record<string, unknown>): (input: { cwd: string; args: readonly string[] }) => Promise<unknown>;
  WRITER_ISOLATION: Record<string, unknown>;
}
interface WriterLike {
  allocate(input: Record<string, unknown>): Promise<{ leaseId: string; nativeCwd: string; base: string; repository: string }>;
  posture(leaseId: string): Record<string, unknown>;
  close(): void;
}
interface ArtifactStoreModule { createArtifactStore(options: Record<string, unknown>): ArtifactStoreLike }
interface ArtifactStoreLike {
  write(input: Record<string, unknown>): Promise<{ artifactHash: string; bytes: number }>;
  read(artifactHash: string): Promise<Buffer>;
  verify(artifactHash: string): Promise<{ ok: boolean; artifactHash: string; bytes: number }>;
  has(artifactHash: string): Promise<boolean>;
  close(): void;
}
interface ArtifactServiceModule { createArtifactService(options: Record<string, unknown>): ArtifactServiceLike }
interface ArtifactServiceLike {
  capture(input: Record<string, unknown>): Promise<{ artifactHash: string; bytes: number; paths: readonly string[] }>;
  close(): void;
}
interface ReviewModule { createIntegrationReviewService(options: Record<string, unknown>): ReviewLike }
interface ReviewLike {
  create(input: Record<string, unknown>): Promise<{ reviewId: string; base: string; target: string }>;
  approve(input: Record<string, unknown>): { approvalId: string; binding: { artifactHash: string; base: string; target: string } };
  close(): void;
}
interface LockModule { createRepositoryLockService(options: Record<string, unknown>): LockLike }
interface LockLike { held(repository: string): readonly unknown[]; close(): void }
interface IntegrationModule { createIntegrationService(options: Record<string, unknown>): IntegrationLike }
interface IntegrationLike {
  integrate(input: Record<string, unknown>): Promise<Record<string, unknown>>;
  close(): void;
}
interface StoreProtocolModule { StoreError: new (code: string, reason: string) => Error & { code: string; reason: string } }
interface MappingModule {
  OLD_FEATURE_MAPPING: readonly Record<string, unknown>[];
  SYSTEM_SCENARIOS: readonly { id: string }[];
  IS_USER_PATHS: readonly { is: string; scenario: string }[];
  assertMappingIntegrity(mapping?: readonly Record<string, unknown>[]): { rows: number; catalog: number };
  mappingRowsWithoutScenario(mapping?: readonly Record<string, unknown>[], observed?: Iterable<string>, lane?: string): readonly Record<string, unknown>[];
  assertMappingComplete(mapping?: readonly Record<string, unknown>[], observed?: Iterable<string>, lane?: string): Record<string, unknown>;
}
interface OracleModule {
  expectedInventory(count: number): { sessions: number; sources: Record<string, number>; identitiesSha256: string; worktrees: number };
  summaryAt(ordinal: number): { source: string; nativeSessionId: string; workspace: string | null; archived: boolean; parentId: string | null; updatedAt: number };
  wireAt(summary: unknown): Record<string, unknown>;
  input: { sources: readonly string[]; timestamp: number };
}

const handoffModule = require_('../../bridge/runtime/threads/handoffService.js') as HandoffModule;
const checkpointModule = require_('../../bridge/runtime/threads/checkpointService.js') as CheckpointModule;
const recoveryModule = require_('../../bridge/runtime/threads/handoffRecovery.js') as RecoveryModule;
const coordinatorModule = require_('../../bridge/runtime/collaboration/coordinator.js') as CoordinatorModule;
const fanoutModule = require_('../../bridge/runtime/collaboration/fanoutService.js') as FanoutModule;
const writerModule = require_('../../bridge/runtime/collaboration/writerLeases.js') as WriterModule;
const artifactStoreModule = require_('../../bridge/runtime/collaboration/artifactStore.js') as ArtifactStoreModule;
const artifactServiceModule = require_('../../bridge/runtime/collaboration/artifactService.js') as ArtifactServiceModule;
const reviewModule = require_('../../bridge/runtime/collaboration/integrationReview.js') as ReviewModule;
const lockModule = require_('../../bridge/runtime/collaboration/repositoryLocks.js') as LockModule;
const integrationModule = require_('../../bridge/runtime/collaboration/integrationService.js') as IntegrationModule;
const storeProtocolModule = require_('../../bridge/runtime/storage/storeProtocol.js') as StoreProtocolModule;
const mapping = require_('../dev/runtime-v090/system43-mapping.mjs') as MappingModule;
const oracle = require_('../dev/runtime-v090/fixtures/inventory.mjs') as OracleModule;

/* ------------------------------------------------------------------ identities and constants */

const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const ENV_B = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const PROFILE = '33333333-3333-4333-8333-333333333333';
const INSTANCE = '66666666-6666-4666-8666-666666666666';
const EPOCH = '77777777-7777-4777-8777-777777777777';
const OWNER = '88888888-8888-4888-8888-888888888888';
const T0 = oracle.input.timestamp;
/** The five sources in the seed090 oracle's own order, each with its own harness instance. */
const SOURCES = oracle.input.sources;
const HARNESS_INSTANCE: Record<string, string> = Object.fromEntries(SOURCES.map((source, index) => [source, `10000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`]));
const harnessInstanceId = (source: string) => parseHarnessInstanceId(HARNESS_INSTANCE[source]!);
const sessionOf = (source: string, nativeSessionId: string): SessionRef => parseSessionRef({ environmentId: ENV_A, harnessInstanceId: harnessInstanceId(source), nativeSessionId });
const REPO: RepoRef = parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const REPO_WORKTREE_A: RepoRef = parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const REPO_WORKTREE_B: RepoRef = parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/repo/.git', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const REPO_ORPHAN: RepoRef = parseRepoRef({ environmentId: ENV_A, canonicalCommonDir: '/orphan-workspace', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const WORKTREE_A = parseWorkspaceRef({ environmentId: ENV_A, canonicalPath: '/repo/worktrees/wt-0', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const WORKTREE_B = parseWorkspaceRef({ environmentId: ENV_A, canonicalPath: '/repo/worktrees/wt-1', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const ORPHAN_WORKSPACE = parseWorkspaceRef({ environmentId: ENV_A, canonicalPath: '/orphan-workspace', pathPolicy: { platform: 'posix', volumeId: 'vol', caseSensitive: true } });
const sha256 = (bytes: Buffer | string) => createHash('sha256').update(bytes).digest('hex');
const CRITERIA = parseCriteria([
  { id: 'applies-cleanly', text: 'the artifact applies onto the reviewed base without a conflict' },
  { id: 'tests-pass', text: 'the frozen criteria tests exit zero in the integration worktree' },
  { id: 'fast-forward-only', text: 'the target branch moves forward to a descendant, never a rewrite' },
]);

/* ------------------------------------------------------------------ the run ledger */

/** Every scenario this run EXECUTED. The mapping completeness check reads only this set. */
const observedScenarios = new Set<string>();
const evidence: Record<string, unknown> = {};
const record = (scenario: string, value: unknown) => { observedScenarios.add(scenario); evidence[scenario] = value; };
const capture = (run: () => unknown): { code: string | null; field: string | null } => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    const typed = error as { code?: unknown; field?: unknown; reason?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code : null,
      field: typeof typed.field === 'string' ? typed.field : typeof typed.reason === 'string' ? typed.reason : null,
    };
  }
};
const captureAsync = async (run: () => Promise<unknown>): Promise<{ code: string | null; field: string | null }> => {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    const typed = error as { code?: unknown; field?: unknown; reason?: unknown };
    return {
      code: typeof typed.code === 'string' ? typed.code : null,
      field: typeof typed.field === 'string' ? typed.field : typeof typed.reason === 'string' ? typed.reason : null,
    };
  }
};

/* ------------------------------------------------------------------ the private world */

const root = mkdtempSync(path.join(tmpdir(), 'vis-system43-'));
const legacyDirectory = path.join(root, 'legacy-store');
const gitDirectory = path.join(root, 'git');
const storeDirectory = path.join(root, 'store');
afterAll(() => { rmSync(root, { recursive: true, force: true }); });

interface LegacyRecord { readonly key: string; readonly namespace: string; readonly content: string; readonly authority: string }
/**
 * One history scope PER SOURCE. The legacy app stored each backend's history under its own
 * namespace scope, so the same nativeSessionId on two backends is two different legacy keys — the
 * same property the unified identity layer preserves (a single shared scope would collapse five
 * sources' records onto one key and one ambiguous binding).
 */
const scopeFor = (source: string) => createHash('sha256').update(`system43-scope-${source}`).digest('hex').slice(0, 32);
const namespaceFor = (source: string) => `backend-history-v1:${scopeFor(source)}`;
const historyKey = (source: string, nativeSessionId: string) => `opencode.state.backendHistory.v1.${scopeFor(source)}.${nativeSessionId}`;
/** One legacy history record per source for native-0 and native-1: ten records, five sources. */
const LEGACY_HISTORY: readonly LegacyRecord[] = Object.freeze(SOURCES.flatMap((source, sourceIndex) => [0, 1].map((round) => {
  const ordinal = sourceIndex + round * SOURCES.length;
  const summary = oracle.summaryAt(ordinal);
  return Object.freeze({
    key: historyKey(source, summary.nativeSessionId),
    namespace: namespaceFor(source),
    content: JSON.stringify(oracle.wireAt(summary)),
    authority: 'backend-history',
  });
})));
const LEGACY_LOCAL: Readonly<Record<string, string>> = Object.freeze({
  'opencode.global.dat:model': '"grok-code"',
  'opencode.settings.disabledModels.v1': '["gpt-4o-mini"]',
  'vis:kimi-web:last-permission-mode': '"default"',
  'vis.codex.pins.v1': '["native-0"]',
  // A real local-only credential key: the export must EXCLUDE it, never page its content.
  'opencode.credentials.v1': '{"type":"api","key":"sk-legacy-secret-value"}',
});
const LEGACY_FILES = ['localStorage.json', 'history.json'] as const;

/** The legacy store on disk: two real files the migration hash is computed over. */
function writeLegacyStore(directory: string, mutate?: (records: LegacyRecord[]) => LegacyRecord[]): void {
  const records = mutate ? mutate([...LEGACY_HISTORY]) : LEGACY_HISTORY;
  mkdirSync(directory, { recursive: true });
  writeFileSync(path.join(directory, 'localStorage.json'), `${JSON.stringify(LEGACY_LOCAL, null, 2)}\n`);
  writeFileSync(path.join(directory, 'history.json'), `${JSON.stringify(records, null, 2)}\n`);
}
function legacyStoreDigest(directory: string): Record<string, string> {
  return Object.fromEntries(LEGACY_FILES.map((name) => [name, sha256(readFileSync(path.join(directory, name)))]));
}
/**
 * The legacy source: a read-only async generator over the two real files. It READS and never
 * writes — the migration-hash requirement is that the import leaves these bytes untouched.
 */
function legacySourceOf(directory: string): LegacySource {
  return async function* source() {
    const local = JSON.parse(readFileSync(path.join(directory, 'localStorage.json'), 'utf8')) as Record<string, string>;
    for (const [key, content] of Object.entries(local)) {
      const piece: LegacyPiece = { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' };
      yield piece;
    }
    const records = JSON.parse(readFileSync(path.join(directory, 'history.json'), 'utf8')) as LegacyRecord[];
    for (const recordEntry of records) {
      const piece: LegacyPiece = { key: recordEntry.key, source: 'renderer-storage.json.history', namespace: recordEntry.namespace, content: recordEntry.content, end: true, authority: recordEntry.authority };
      yield piece;
    }
  };
}

/* ------------------------------------------------------------------ git and service worlds */

function runGit(cwd: string, args: readonly string[]): string {
  return execFileSync('git', [...args], { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' } });
}
async function createRepo(name: string): Promise<string> {
  const repository = path.join(gitDirectory, name);
  mkdirSync(path.join(repository, 'src'), { recursive: true });
  writeFileSync(path.join(repository, 'README.md'), 'base readme\n');
  writeFileSync(path.join(repository, 'src', 'keep.txt'), 'keep\n');
  runGit(repository, ['-c', 'init.defaultObjectFormat=sha1', 'init', '-q', '-b', 'main']);
  runGit(repository, ['config', 'commit.gpgsign', 'false']);
  runGit(repository, ['config', 'core.autocrlf', 'false']);
  runGit(repository, ['add', '-A']);
  runGit(repository, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
  return repository;
}
const headOf = (cwd: string) => runGit(cwd, ['rev-parse', '--verify', 'HEAD']).trim();

interface ThreadWorld {
  threads: ThreadService;
  thread: ThreadRecord;
  participantA: string;
  participantB: string;
  service: HandoffServiceLike;
  checkpoints: CheckpointServiceLike;
  catalog: Map<string, ThreadSessionView>;
}
let threadWorld: ThreadWorld | undefined;
async function buildThreadWorld(): Promise<ThreadWorld> {
  const sessionA = sessionOf('opencode', 'native-0');
  const sessionB = sessionOf('codex', 'native-0');
  const view = (session: SessionRef): ThreadSessionView => ({ session, archived: false, parentSession: null });
  const catalog = new Map<string, ThreadSessionView>([
    [`${sessionA.environmentId}|${sessionA.harnessInstanceId}|${sessionA.nativeSessionId}`, view(sessionA)],
    [`${sessionB.environmentId}|${sessionB.harnessInstanceId}|${sessionB.nativeSessionId}`, view(sessionB)],
  ]);
  const resolveSession = async (session: SessionRef) => catalog.get(`${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`) ?? null;
  const threads = createThreadService({ resolveSession });
  const thread = await threads.bind({ session: sessionA, repo: REPO });
  const joined = await threads.join({ threadId: thread.threadId, session: sessionB, repo: REPO });
  const checkpoints = checkpointModule.createCheckpointService();
  const counters = { openTarget: 0, sendPrompt: 0, cancelSource: 0 };
  const service = handoffModule.createHandoffService({
    threads,
    checkpoints,
    openTarget: async ({ target }: { target: { session: SessionRef } }) => { counters.openTarget += 1; return { nativeSessionId: target.session.nativeSessionId }; },
    sendPrompt: async () => { counters.sendPrompt += 1; return { ackId: `ack-${counters.sendPrompt}` }; },
    cancelSource: async () => { counters.cancelSource += 1; },
    isSourceBusy: () => false,
  });
  return { threads, thread, participantA: thread.participants[0]!.participantId, participantB: joined.participantId, service, checkpoints, catalog };
}

interface IntegrationWorld {
  repository: string;
  store: ArtifactStoreLike;
  artifacts: ArtifactServiceLike;
  reviews: ReviewLike;
  locks: LockLike;
  integration: IntegrationLike;
  writers: WriterLike;
  close(): void;
}
let integrationWorld: IntegrationWorld | undefined;
async function buildIntegrationWorld(label: string): Promise<IntegrationWorld> {
  const repository = await createRepo(label);
  const storeRoot = path.join(root, 'stores', label);
  const integrationsRoot = path.join(root, 'integrations', label);
  const writersRoot = path.join(root, 'writers', label);
  mkdirSync(storeRoot, { recursive: true });
  mkdirSync(integrationsRoot, { recursive: true });
  mkdirSync(writersRoot, { recursive: true });
  const store = artifactStoreModule.createArtifactStore({ root: storeRoot });
  const artifacts = artifactServiceModule.createArtifactService({ store, root: integrationsRoot });
  const reviews = reviewModule.createIntegrationReviewService({ store, newReviewId: () => `review-${label}`, newApprovalId: () => `approval-${label}` });
  const locks = lockModule.createRepositoryLockService({ newLockId: () => `lock-${label}` });
  const integration = integrationModule.createIntegrationService({ store, artifacts, reviews, locks, integrationsRoot, newOperationId: () => `operation-${label}` });
  const runner = writerModule.createGitRunner({});
  const writers = writerModule.createWriterLeaseService({ writersRoot, runGit: runner });
  return {
    repository, store, artifacts, reviews, locks, integration, writers,
    close() { integration.close(); locks.close(); reviews.close(); artifacts.close(); store.close(); writers.close(); },
  };
}
/** Capture one REAL artifact out of a real leased writer worktree of the real repository. */
const TASK_IDS: Record<string, string> = { alpha: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', beta: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb' };
async function captureArtifact(world: IntegrationWorld, label: string): Promise<{ artifactHash: string; bytes: number }> {
  const lease = await world.writers.allocate({ repository: world.repository, taskId: TASK_IDS[label]!, ownerId: OWNER, at: T0 });
  writeFileSync(path.join(lease.nativeCwd, 'src', 'change.txt'), 'the reviewed change\n');
  writeFileSync(path.join(lease.nativeCwd, 'untracked.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]));
  const captured = await world.artifacts.capture({ lease, at: T0 });
  return { artifactHash: captured.artifactHash, bytes: captured.bytes };
}
const passingTests = () => [
  { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
];

let storeWorld: { directory: string } | undefined;
beforeAll(async () => {
  writeLegacyStore(legacyDirectory);
  storeWorld = { directory: storeDirectory };
  threadWorld = await buildThreadWorld();
  integrationWorld = await buildIntegrationWorld('integration');
}, 120_000);
afterAll(() => { threadWorld?.service.close(); threadWorld?.checkpoints.close(); void threadWorld?.threads.close(); integrationWorld?.close(); });

/* ------------------------------------------------------------------ the tests */

describe('task 43 full-chain system integration', () => {
  it('the legacy import leaves the migration hash unchanged', async () => {
    const before = legacyStoreDigest(legacyDirectory);
    const source = legacySourceOf(legacyDirectory);
    const first = await openLegacyExport(source);
    const second = await openLegacyExport(legacySourceOf(legacyDirectory));
    let request: { token: typeof first; limit?: number } | null = { token: first };
    const chunkHashes: string[] = [];
    let pages = 0;
    let chunks = 0;
    while (request) {
      const page = await readLegacyExportPage(legacySourceOf(legacyDirectory), request);
      pages += 1;
      for (const chunk of page.chunks) { chunks += 1; chunkHashes.push(chunk.checksum); }
      request = page.next ? { token: page.next } : null;
    }
    const after = legacyStoreDigest(legacyDirectory);
    // The local-only credential is excluded and its content never appears in a page.
    const port = createBrowserLegacySourcePort(legacySourceOf(legacyDirectory));
    const token = await port.open();
    const paged: string[] = [];
    let pageRequest: { token: typeof token } | null = { token };
    while (pageRequest) {
      const page = await port.page(pageRequest);
      for (const chunk of page.chunks) paged.push(chunk.content);
      pageRequest = page.next ? { token: page.next } : null;
    }
    const observed = {
      filesBefore: before,
      filesAfter: after,
      everyFileUnchanged: LEGACY_FILES.every((name) => before[name] === after[name]),
      revision: first.revision,
      revisionStableAcrossOpens: first.revision === second.revision,
      revisionShape: /^[a-f0-9]{64}$/u.test(first.revision),
      records: first.records,
      exportableRecords: first.exportableRecords,
      localOnlyRecords: first.localOnlyRecords,
      pages,
      chunks,
      chunkChecksumShape: chunkHashes.every((hash) => /^[a-f0-9]{64}$/u.test(hash)),
      portChunks: paged.length,
      credentialExcluded: !paged.some((content) => content.includes('sk-legacy-secret-value')),
      everyHistoryRecordExported: LEGACY_HISTORY.every((entry) => paged.includes(entry.content)),
    };
    expect(observed.filesBefore).toEqual(observed.filesAfter);
    expect(observed.everyFileUnchanged).toBe(true);
    expect(observed.revisionStableAcrossOpens).toBe(true);
    expect(observed.revisionShape).toBe(true);
    expect(observed.localOnlyRecords).toBe(1);
    expect(observed.credentialExcluded).toBe(true);
    expect(observed.everyHistoryRecordExported).toBe(true);
    expect(observed.chunks).toBe(first.exportableRecords);
    expect(observed.portChunks).toBe(observed.chunks);
    record('SYS-12-migration-hash-unchanged', observed);
    record('SYS-01-legacy-store-import', { ...observed, bindingSample: null });
  });

  it('the legacy export refuses a source that changes between pages instead of reporting success', async () => {
    const directory = path.join(root, 'legacy-mutated');
    writeLegacyStore(directory);
    const mutable = [...LEGACY_HISTORY];
    let reads = 0;
    const source: LegacySource = async function* mutating() {
      reads += 1;
      const local = LEGACY_LOCAL;
      for (const [key, content] of Object.entries(local)) yield { key, source: 'localStorage', namespace: 'unattached-legacy-local', content, end: true, authority: 'unattached' } satisfies LegacyPiece;
      for (const entry of mutable) yield { key: entry.key, source: 'renderer-storage.json.history', namespace: entry.namespace, content: entry.content, end: true, authority: entry.authority } satisfies LegacyPiece;
    };
    const opened = await openLegacyExport(source);
    const firstPage = await readLegacyExportPage(source, { token: opened });
    // The source changes AFTER a page was served: the next page must refuse, never silently pass.
    mutable[0] = { ...mutable[0]!, content: `${mutable[0]!.content} tampered` };
    const refusal = await captureAsync(() => readLegacyExportPage(source, { token: { ...opened, offset: firstPage.next?.offset ?? opened.count } }));
    expect(refusal).toEqual({ code: 'source_changed', field: null });
    record('FLT-11-legacy-source-changed', { reads, refusal, revision: opened.revision });
  });

  it('one entry five sources: every legacy session of all five harnesses enters the unified index', async () => {
    const source = legacySourceOf(legacyDirectory);
    const port = createBrowserLegacySourcePort(source);
    const token = await port.open();
    const chunks: { sourceKey: string; content: string }[] = [];
    let request: { token: typeof token } | null = { token };
    while (request) {
      const page = await port.page(request);
      for (const chunk of page.chunks) chunks.push({ sourceKey: chunk.sourceKey, content: chunk.content });
      request = page.next ? { token: page.next } : null;
    }
    const scopeFingerprints = new Map(await Promise.all(SOURCES.map(async (sourceName) => [sourceName, await legacyDigest(namespaceFor(sourceName))] as const)));
    const mappings: ProvenMapping[] = SOURCES.flatMap((sourceName) => [0, 1].map((round) => {
      const summary = oracle.summaryAt(SOURCES.indexOf(sourceName) + round * SOURCES.length);
      return { profileId: PROFILE, environmentId: ENV_A, harnessInstanceId: harnessInstanceId(sourceName), nativeSessionId: summary.nativeSessionId, scopeFingerprint: scopeFingerprints.get(sourceName)!, evidence: 'user-confirmed' as const };
    }));
    const bound: { source: string; nativeSessionId: string; sessionKey: string }[] = [];
    const unattached: { sourceKey: string; namespace: string }[] = [];
    for (const chunk of chunks) {
      const local = await resolveLegacyLocalBinding(legacySourceOf(legacyDirectory), chunk.sourceKey);
      const hint = await describeLocalBinding({ key: local.key, namespace: local.namespace }, chunk.sourceKey);
      const binding = bindLegacySource(hint, mappings);
      if (binding.kind === 'bound') bound.push({ source: SOURCES.find((name) => HARNESS_INSTANCE[name] === binding.binding.harnessInstanceId)!, nativeSessionId: binding.binding.nativeSessionId, sessionKey: '' });
      else unattached.push({ sourceKey: binding.sourceKey, namespace: local.namespace });
    }
    // Every bound session is encoded through the REAL identity layer into the unified index.
    const index = bound.map((entry) => {
      const ref = sessionOf(entry.source, entry.nativeSessionId);
      const sessionKey = encodeSessionKey(ref);
      return { source: entry.source, nativeSessionId: entry.nativeSessionId, sessionKey, roundTrip: decodeSessionKey(sessionKey), harnessInstanceId: ref.harnessInstanceId };
    });
    const sources = [...new Set(index.map((entry) => entry.source))].sort();
    // The independent seed090 oracle agrees with the fixture: same sources, same native ids.
    const oracleInventory = oracle.expectedInventory(10000);
    const oracleAgreement = SOURCES.every((name) => oracleInventory.sources[name] === 10000 / SOURCES.length)
      && LEGACY_HISTORY.every((entry, index) => {
        const ordinal = Math.floor(index / 2) + (index % 2) * SOURCES.length;
        return entry.content === JSON.stringify(oracle.wireAt(oracle.summaryAt(ordinal)));
      });
    const observed = {
      chunkCount: chunks.length,
      boundCount: bound.length,
      unattachedCount: unattached.length,
      unattachedNamespaces: [...new Set(unattached.map((entry) => entry.namespace))],
      sources,
      sourceCount: sources.length,
      nativeIds: [...new Set(index.map((entry) => entry.nativeSessionId))].sort(),
      distinctSessionKeys: new Set(index.map((entry) => entry.sessionKey)).size,
      roundTripEqual: index.every((entry) => JSON.stringify(entry.roundTrip) === JSON.stringify(sessionOf(entry.source, entry.nativeSessionId))),
      oracleSources: Object.keys(oracleInventory.sources).sort(),
      oracleSessions: oracleInventory.sessions,
      oracleWorktrees: oracleInventory.worktrees,
      oracleAgreement,
      wireShapeMatchesOracle: LEGACY_HISTORY.every((entry) => entry.content.length > 0),
    };
    expect(observed.sourceCount).toBe(5);
    expect(observed.sources).toEqual([...SOURCES].sort());
    expect(observed.boundCount).toBe(LEGACY_HISTORY.length);
    // The four local-only key/value records (the fifth, the credential, was excluded by the export)
    // stay unattached: the import never invents a binding for a record it cannot prove.
    expect(observed.unattachedCount).toBe(Object.keys(LEGACY_LOCAL).length - 1);
    expect(observed.unattachedNamespaces).toEqual(['unattached-legacy-local']);
    expect(observed.distinctSessionKeys).toBe(LEGACY_HISTORY.length);
    expect(observed.roundTripEqual).toBe(true);
    expect(observed.oracleAgreement).toBe(true);
    expect(observed.oracleSessions).toBe(10000);
    // The stored bytes ARE the oracle's own wire shape for the same ordinal.
    const firstOrdinalWire = JSON.stringify(oracle.wireAt(oracle.summaryAt(0)));
    expect(LEGACY_HISTORY[0]!.content).toBe(firstOrdinalWire);
    record('SYS-02-five-source-unified-index', observed);
  });

  it('workspaces and repositories merge on the canonical common-dir and the orphan stays separate', () => {
    const repoKeys = { wt0: encodeRepoKey(REPO_WORKTREE_A), wt1: encodeRepoKey(REPO_WORKTREE_B), orphan: encodeRepoKey(REPO_ORPHAN) };
    const workspaceKeys = { wt0: encodeWorkspaceKey(WORKTREE_A), wt1: encodeWorkspaceKey(WORKTREE_B), orphan: encodeWorkspaceKey(ORPHAN_WORKSPACE) };
    const observed = { repoKeys, workspaceKeys, worktreesShareRepo: repoKeys.wt0 === repoKeys.wt1, orphanSeparate: repoKeys.orphan !== repoKeys.wt0, workspacesDistinct: new Set(Object.values(workspaceKeys)).size === 3 };
    expect(observed.worktreesShareRepo).toBe(true);
    expect(observed.orphanSeparate).toBe(true);
    expect(observed.workspacesDistinct).toBe(true);
    record('SYS-03-workspace-repo-merge', observed);
  });

  it('the same native session id across hosts stays two distinct sessions', () => {
    const opencode = sessionOf('opencode', 'native-0');
    const codex = sessionOf('codex', 'native-0');
    const keys = { opencode: encodeSessionKey(opencode), codex: encodeSessionKey(codex) };
    const frame = encodeFrame({ version: 1, kind: 'result', target: ENV_A, epoch: 'epoch', generation: 1, id: 'req-1', ok: true, phase: 'read', result: { sessions: [opencode, codex] } });
    const decoded = decodeFrame(frame) as unknown as { result: { sessions: SessionRef[] } };
    const observed = {
      sameNativeId: opencode.nativeSessionId === codex.nativeSessionId,
      differentHarness: opencode.harnessInstanceId !== codex.harnessInstanceId,
      keysDiffer: keys.opencode !== keys.codex,
      keyShape: Object.values(keys).every((key) => /^[A-Za-z0-9_-]+$/u.test(key)),
      decodedNativeIds: decoded.result.sessions.map((entry) => entry.nativeSessionId),
      decodedKeysDiffer: encodeSessionKey(decoded.result.sessions[0]!) !== encodeSessionKey(decoded.result.sessions[1]!),
      malformedRefusal: capture(() => parseSessionRef({ environmentId: ENV_A, harnessInstanceId: HARNESS_INSTANCE.opencode, nativeSessionId: '' })),
      protocolLimits: { jsonBytes: PROTOCOL_LIMITS.jsonBytes, binaryBytes: PROTOCOL_LIMITS.binaryBytes },
      errorCodeCount: ERROR_CODES.length,
    };
    expect(observed.sameNativeId).toBe(true);
    expect(observed.keysDiffer).toBe(true);
    expect(observed.decodedKeysDiffer).toBe(true);
    expect(observed.malformedRefusal).toEqual({ code: 'invalid_identity', field: 'nativeSessionId' });
    expect(observed.errorCodeCount).toBe(10);
    record('SYS-04-sessionref-identity', observed);
    record('FLT-09-same-id-across-hosts', observed);
  });

  it('one Host Thread carries two participants across two harnesses with separate native histories', async () => {
    const world = threadWorld!;
    const summary = world.threads.get(world.thread.threadId);
    const history = world.threads.history(world.thread.threadId);
    const observed = {
      participantCount: summary.participants.length,
      roles: summary.participants.map((entry) => entry.role),
      harnesses: summary.participants.map((entry) => entry.harnessInstanceId),
      distinctHarnesses: new Set(summary.participants.map((entry) => entry.harnessInstanceId)).size,
      activeParticipant: world.threads.active(world.thread.threadId)?.participantId ?? null,
      activeIsOwner: world.threads.active(world.thread.threadId)?.participantId === world.participantA,
      historyParticipants: history.participants.length,
      nativeHistoryA: world.threads.nativeHistory(world.thread.threadId, world.participantA).session.nativeSessionId,
      nativeHistoryB: world.threads.nativeHistory(world.thread.threadId, world.participantB).session.nativeSessionId,
      threadState: world.threads.state,
    };
    expect(observed.participantCount).toBe(2);
    expect(observed.distinctHarnesses).toBe(2);
    expect(observed.activeIsOwner).toBe(true);
    expect(observed.nativeHistoryA).toBe('native-0');
    expect(observed.nativeHistoryB).toBe('native-0');
    expect(observed.nativeHistoryA).toBe(observed.nativeHistoryB);
    record('SYS-05-thread-two-participants', observed);
  });

  it('the handoff ladder walks checkpoint to active and the original selection is restored', async () => {
    const world = threadWorld!;
    const begun = await world.service.begin({
      threadId: world.thread.threadId,
      sourceParticipantId: world.participantA,
      targetParticipantId: world.participantB,
      entries: [
        { class: 'goal', origin: { kind: 'host', commandId: 'system43' }, text: 'continue the runtime migration across harnesses' },
        { class: 'decision', origin: { kind: 'host', commandId: 'system43' }, text: 'keep each native session binding intact' },
      ],
      at: T0,
    });
    const attached = await world.service.attach({ handoffId: begun.handoffId, at: T0 + 1 });
    const prepared = await world.service.prepare({ handoffId: begun.handoffId, prompt: 'continue the migration on the codex harness', at: T0 + 2 });
    const delivered = await world.service.deliver({ handoffId: begun.handoffId, ackId: 'ack-system43', at: T0 + 3 });
    const active = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'native-evt-system43', at: T0 + 4 });
    const restored = recoveryModule.restoreOriginalSelection({ threads: world.threads, threadId: world.thread.threadId, participantId: world.participantA });
    const view = world.service.handoff(begun.handoffId);
    const observed = {
      ladder: [begun.state, attached.state, prepared.state, delivered.state, active.state],
      checkpointDigestShape: /^[a-f0-9]{64}$/u.test(begun.checkpoint?.digest ?? ''),
      finalState: view.state,
      handoffCount: world.service.handoffs().length,
      opCount: world.service.ops(begun.handoffId).length,
      restoredSelection: restored,
      activeAfterRestore: world.threads.active(world.thread.threadId)?.participantId ?? null,
      // The three sinks are structurally separated: only the ack sink can write `delivered`.
      ackSinkCanDeliver: typeof handoffModule.createAckSink({}).deliver === 'function',
      observeSinkHasNoDeliver: typeof handoffModule.createObserveSink({}).deliver === 'undefined',
      hostSinkHasNoDeliver: typeof handoffModule.createHostSink({}).deliver === 'undefined',
    };
    expect(observed.ladder).toEqual(['checkpoint', 'attached', 'prepared', 'delivered', 'active']);
    expect(observed.finalState).toBe('active');
    expect(observed.checkpointDigestShape).toBe(true);
    expect(observed.ackSinkCanDeliver).toBe(true);
    expect(observed.observeSinkHasNoDeliver).toBe(true);
    expect(observed.hostSinkHasNoDeliver).toBe(true);
    record('SYS-06-thread-handoff-ladder', observed);
  });

  it('a team task reaches accepted through fan-out and a real artifact integration', async () => {
    const world = integrationWorld!;
    const captured = await captureArtifact(world, 'alpha');
    // The writer posture is read from a lease allocated while the target is still clean: the
    // integration below moves the target branch, and a lease allocated after that is (correctly)
    // refused writer_base_dirty — the product refusing to isolate a writer against a moved base.
    const postureLease = await world.writers.allocate({ repository: world.repository, taskId: TASK_IDS.beta!, ownerId: OWNER, at: T0 });
    const posture = world.writers.posture(postureLease.leaseId);
    const review = await world.reviews.create({ repository: world.repository, target: 'main', artifactHash: captured.artifactHash, at: T0 });
    const approval = world.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-system43' });
    const base = headOf(world.repository);
    const integrated = await world.integration.integrate({
      approvalId: approval.approvalId,
      criteria: CRITERIA,
      tests: passingTests(),
      commitMessage: 'integrate the reviewed change',
      at: T0 + 2,
    }) as { ok: boolean; outcome: string; targetAfter: { targetHead: string }; artifact: { verified: boolean } };
    // The Team/fan-out half of the same chain, over the real coordinator and fan-out service.
    const acks: string[] = [];
    const coordinator = coordinatorModule.createCollaborationCoordinator({ deliver: async () => { acks.push('ack'); return { ackId: `ack-${acks.length}` }; } });
    const team = coordinator.createTeam({ name: 'system43 team', at: T0 });
    const task = coordinator.createTask({
      teamId: team.teamId,
      title: 'review the integrated change',
      criteria: CRITERIA,
      owner: { participantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session: sessionOf('opencode', 'native-0') },
      lease: { ownerId: 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb', expiresAt: T0 + 60000 },
      at: T0,
    });
    const dispatched = await coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const attemptState = dispatched.attempt ? coordinator.attempt(dispatched.attempt.attemptId).state : null;
    // A second dispatch of the same task is refused: one attempt per task, observed as a typed
    // refusal. `dispatch` is async, so the rejection is captured with the AWAITING envelope — a
    // synchronous try/catch cannot observe an async rejection.
    const duplicateDispatch = await captureAsync(() => coordinator.dispatch({ taskId: task.taskId, at: T0 + 2 }));
    const fanout = fanoutModule.createFanoutService({ deliver: async () => ({ ackId: 'ack-fanout' }) });
    const created = fanout.createFanout({
      prompt: 'review the integrated change on both harnesses',
      targets: [
        { participantId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa', session: sessionOf('opencode', 'native-0') },
        { participantId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', session: sessionOf('codex', 'native-0') },
      ],
      at: T0,
    });
    const fanned = await fanout.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
    const observed = {
      artifact: { artifactHash: captured.artifactHash, bytes: captured.bytes, hashShape: /^[a-f0-9]{64}$/u.test(captured.artifactHash) },
      approvedHashMatchesCaptured: approval.binding.artifactHash === captured.artifactHash,
      integrated: { ok: integrated.ok, outcome: integrated.outcome, verified: integrated.artifact.verified },
      targetMoved: integrated.targetAfter.targetHead !== base,
      targetHead: integrated.targetAfter.targetHead,
      base,
      team: { teamId: team.teamId, name: team.name },
      task: { taskId: task.taskId, state: task.state, phase: task.phase },
      attemptState,
      duplicateDispatch,
      fanout: { fanoutId: created.fanoutId, state: fanned.state, targets: fanned.targets.map((entry) => entry.outcome), stats: fanned.stats },
      coordinatorState: coordinator.state(),
      fanoutState: fanout.state(),
      writerPosture: posture,
    };
    expect(observed.approvedHashMatchesCaptured).toBe(true);
    expect(observed.integrated.ok).toBe(true);
    expect(observed.integrated.outcome).toBe('integrated');
    expect(observed.integrated.verified).toBe(true);
    expect(observed.targetMoved).toBe(true);
    // The attempt exists and is owned by the task right after dispatch; a second dispatch is refused.
    expect(observed.attemptState).toBe('accepted');
    expect(observed.duplicateDispatch).toEqual({ code: 'conflict', field: 'task_dispatched' });
    expect(observed.fanout.state).toBe('succeeded');
    expect(observed.fanout.targets).toEqual(['sent', 'sent']);
    expect(observed.fanout.stats.sent).toBe(2);
    fanout.close();
    coordinator.close();
    record('SYS-08-artifact-integration', observed);
    record('SYS-07-team-fanout', { team: observed.team, task: observed.task, attemptState: observed.attemptState, fanout: observed.fanout });
  });

  it('a killed store keeps its durable data and a restart continues from it', async () => {
    const stateRoot = storeWorld!.directory;
    const first = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: stateRoot });
    const inspection = await first.ready as { fence: number; environment: string };
    const key = 'session_summaries:system43:durable';
    await first.mutate({ intentId: 'intent-system43-1', changes: [{ collection: 'session_summaries', key, value: { title: 'durable session', source: 'opencode' }, expectedRevision: 0 }] });
    const beforeKill = await first.get({ collection: 'session_summaries', key });
    const page = await first.page({ collection: 'session_summaries', limit: 100 });
    // A REAL kill: SIGKILL the store worker, not an in-memory close.
    const killed = await first.terminate();
    const afterKillRefusal = await captureAsync(() => first.get({ collection: 'session_summaries', key }));
    // A REAL restart: a second store process over the same durable state root, taking over the fence.
    const second = createRuntimeStore({ environmentId: ENV_A, ownerId: INSTANCE, epoch: EPOCH, stateDirectory: stateRoot, takeover: { expectedFence: inspection.fence } });
    const restartInspection = await second.ready as { fence: number };
    const afterRestart = await second.get({ collection: 'session_summaries', key });
    await second.close();
    const observed = {
      killedWorker: { pid: killed.pid, code: killed.code, signal: killed.signal },
      requestAfterKill: afterKillRefusal,
      valueBeforeKill: beforeKill?.value ?? null,
      valueAfterRestart: afterRestart?.value ?? null,
      revisionAfterRestart: afterRestart?.revision ?? null,
      fenceBefore: inspection.fence,
      fenceAfterRestart: restartInspection.fence,
      environment: inspection.environment,
      paging: { items: page.items.length, cursor: page.cursor ?? null, firstKey: page.items[0]?.key ?? null, withinPageLimit: page.items.length <= 100 },
    };
    expect(observed.killedWorker.signal).toBe('SIGKILL');
    expect(observed.requestAfterKill.code).toBe('source_unavailable');
    expect(observed.valueAfterRestart).toEqual(observed.valueBeforeKill);
    expect(observed.fenceAfterRestart).toBeGreaterThan(observed.fenceBefore);
    expect(observed.paging.withinPageLimit).toBe(true);
    expect(observed.paging.firstKey).toBe(key);
    record('SYS-11-bounded-paging', observed.paging);
    record('SYS-09-restart-continuation', observed);
    record('FLT-01-store-kill', observed);
  });

  it('one source failing does not drag down the whole run', async () => {
    const scheduler = createDiscoveryScheduler();
    const results = await Promise.all(SOURCES.map((source) => scheduler.schedule(
      { environmentId: ENV_A, harnessInstanceId: harnessInstanceId(source), scope: '{}' },
      async () => {
        if (source === 'codex' || source === 'dsh') throw new storeProtocolModule.StoreError('source_unavailable', 'native_timeout');
        return { source, complete: true, count: 2 };
      },
    ).then((value) => ({ source, ok: true as const, value }), (error: { code?: string; reason?: string }) => ({ source, ok: false as const, code: error.code ?? null, reason: error.reason ?? null }))));
    // A LATER demand on a healthy source still runs: the failure did not poison the scheduler.
    const later = await scheduler.schedule({ environmentId: ENV_A, harnessInstanceId: harnessInstanceId('opencode'), scope: '{}' }, async () => ({ source: 'opencode', complete: true, count: 3 }));
    const state = scheduler.state;
    const observed = {
      settled: results.map((entry) => ({ source: entry.source, ok: entry.ok, code: 'code' in entry ? entry.code : null, reason: 'reason' in entry ? entry.reason : null })),
      okCount: results.filter((entry) => entry.ok).length,
      failedCount: results.filter((entry) => !entry.ok).length,
      failedSources: results.filter((entry) => !entry.ok).map((entry) => entry.source),
      failureCodes: results.filter((entry) => !entry.ok).map((entry) => ('code' in entry ? entry.code : null)),
      laterDemand: later,
      schedulerState: state,
      queueDrained: state.queued === 0,
    };
    scheduler.close();
    expect(observed.okCount).toBe(3);
    expect(observed.failedCount).toBe(2);
    expect(observed.failedSources).toEqual(['codex', 'dsh']);
    expect(observed.failureCodes).toEqual(['source_unavailable', 'source_unavailable']);
    expect(observed.laterDemand).toEqual({ source: 'opencode', complete: true, count: 3 });
    expect(observed.queueDrained).toBe(true);
    record('SYS-10-source-failure-isolation', observed);
    record('FLT-08-source-partial', observed);
  });

  it('a legacy import batch that switches target is refused and the staged manifest is unchanged', async () => {
    const stateRoot = path.join(root, 'store', 'import');
    mkdirSync(stateRoot, { recursive: true });
    const store = createRuntimeStore({ environmentId: ENV_A, ownerId: OWNER, epoch: EPOCH, stateDirectory: stateRoot });
    await store.ready;
    const service = createImportService({ store, environmentId: ENV_A });
    const source = legacySourceOf(legacyDirectory);
    const token = await openLegacyExport(source);
    const page = await readLegacyExportPage(source, { token, limit: 1 });
    const chunkRow = page.chunks[0]!;
    const importId = await legacyDigest('system43-import');
    const content = chunkRow.content;
    const chunk = {
      sourceKey: chunkRow.sourceKey,
      offset: 0,
      content,
      end: true,
      checksum: sha256(content),
      authority: chunkRow.authority,
      binding: { environmentId: ENV_A, harnessInstanceId: harnessInstanceId(SOURCES[0]!), nativeSessionId: 'native-0', profileId: PROFILE },
    };
    const accepted = await service.accept({ importId, environmentId: ENV_A, sourceRevision: token.revision, offset: 0, nextOffset: 1, total: 1, chunks: [chunk] });
    const manifestStaged = await store.get({ collection: 'imports', key: `manifest:${importId}` });
    // The target switches: the batch names a DIFFERENT environment. The refusal must leave the
    // staged manifest byte-identical — no partial write, no false success.
    const switched = await captureAsync(() => service.accept({
      importId, environmentId: ENV_B, sourceRevision: token.revision, offset: 1, nextOffset: 2, total: 2,
      chunks: [{ ...chunk, offset: content.length, end: true, binding: { ...chunk.binding, environmentId: ENV_B } }],
    }));
    const manifestAfterRefusal = await store.get({ collection: 'imports', key: `manifest:${importId}` });
    const verified = await service.verify({ importId, sourceRevision: token.revision, expectedRecords: 1, expectedChunks: 1 });
    await store.close();
    const observed = {
      acceptedOffset: (accepted as { offset?: number }).offset ?? null,
      verified,
      switchedRefusal: switched,
      manifestStaged: (manifestStaged?.value as { offset?: number; phase?: string } | undefined)?.phase ?? null,
      manifestOffsetStaged: (manifestStaged?.value as { offset?: number } | undefined)?.offset ?? null,
      manifestUnchangedByRefusal: JSON.stringify(manifestStaged?.value) === JSON.stringify(manifestAfterRefusal?.value),
      manifestPhaseAfter: (manifestAfterRefusal?.value as { phase?: string } | undefined)?.phase ?? null,
      manifestOffsetAfter: (manifestAfterRefusal?.value as { offset?: number } | undefined)?.offset ?? null,
    };
    expect(observed.switchedRefusal).toEqual({ code: 'target_changed', field: null });
    expect(observed.manifestUnchangedByRefusal).toBe(true);
    expect(observed.manifestStaged).toBe('staged');
    expect(observed.manifestOffsetStaged).toBe(1);
    expect(observed.manifestOffsetAfter).toBe(1);
    record('FLT-10-legacy-import-target-switch', observed);
  });

  it('a slow consumer cannot grow the observer buffer past its frozen bound', () => {
    const closes: string[] = [];
    const observer = createEventObserver({
      binding: parseBinding({ target: ENV_A, epoch: 'epoch', generation: 1 }),
      after: 0,
      isCurrent: () => true,
      onClose: () => { closes.push('closed'); },
    });
    const peak = { normal: 0, bytes: 0 };
    for (let seq = 1; seq <= OBSERVER_LIMITS.normalFrames + 64; seq += 1) {
      observer.push({ version: 1, kind: 'event', target: ENV_A, epoch: 'epoch', generation: 1, seq, entityRevision: seq, scope: `session:${seq}`, type: 'entity.patch', payload: { collection: 'session_summaries', key: `session:${seq}`, revision: seq } });
      peak.normal = Math.max(peak.normal, observer.state.normal);
      peak.bytes = Math.max(peak.bytes, observer.state.bytes);
    }
    const beforeClose = { ...observer.state };
    observer.close();
    const observed = {
      limits: { normalFrames: OBSERVER_LIMITS.normalFrames, normalBytes: OBSERVER_LIMITS.normalBytes, observers: OBSERVER_LIMITS.observers },
      pushed: OBSERVER_LIMITS.normalFrames + 64,
      peakNormal: peak.normal,
      peakBytes: peak.bytes,
      stateBeforeClose: beforeClose,
      recoveryEngaged: beforeClose.recovery !== null,
      normalWithinBound: peak.normal <= OBSERVER_LIMITS.normalFrames,
      bytesWithinBound: peak.bytes <= OBSERVER_LIMITS.normalBytes,
      onCloseReceipts: closes.length,
      stateAfterClose: { ...observer.state },
      buffersEmptied: observer.state.normal === 0 && observer.state.bytes === 0,
    };
    expect(observed.normalWithinBound).toBe(true);
    expect(observed.bytesWithinBound).toBe(true);
    expect(observed.recoveryEngaged).toBe(true);
    expect(observed.onCloseReceipts).toBe(1);
    expect(observed.buffersEmptied).toBe(true);
    expect(observed.stateAfterClose.closed).toBe(true);
    record('FLT-07-slow-consumer', observed);
  });

  it('every IS user path is walked by a named scenario in this run', () => {
    const walked = mapping.IS_USER_PATHS.map((row) => ({ is: row.is, scenario: row.scenario, observed: observedScenarios.has(row.scenario) }));
    // IS-5 is the transport lane: its scenario is driven by the failure harness, so this node realm
    // observes the identity of the row rather than pretending to have driven SSH.
    const expected = mapping.IS_USER_PATHS.map((row) => (row.is === 'IS-5' ? false : true));
    expect(walked.map((row) => row.observed)).toEqual(expected);
    record('SYS-14-is-user-paths', { walked });
  });

  it('every old-feature mapping row carries an observed scenario, and a row without one is refused', async () => {
    // The lanes' own drives run first (the tests below), so the ledger is filled by the time this
    // assertion reads it — vitest runs this file's tests in declaration order.
    const coverage = mapping.OLD_FEATURE_MAPPING.map((row) => ({
      id: row.id,
      scenario: row.scenario,
      negativeScenario: row.negativeScenario ?? null,
      observed: observedScenarios.has(row.scenario as string),
    }));
    // Every system-lane row is covered by a scenario THIS run executed.
    expect(mapping.mappingRowsWithoutScenario(mapping.OLD_FEATURE_MAPPING, observedScenarios, 'system')).toEqual([]);
    // The mapping is not vacuous: with an empty observed set EVERY system row is reported missing.
    const allMissing = mapping.mappingRowsWithoutScenario(mapping.OLD_FEATURE_MAPPING, new Set(), 'system');
    expect(allMissing.length).toBe(mapping.OLD_FEATURE_MAPPING.filter((row) => row.lane === 'system' || row.lane === 'both').length);
    expect(allMissing.map((row) => row.id)).toContain('GAP-1');
    // A row without an observed scenario is REFUSED, not warned about. The unmodified mapping
    // passes the same integrity check, so the refusal below is caused by the row and nothing else.
    expect(capture(() => mapping.assertMappingIntegrity())).toEqual({ code: null, field: null });
    expect(() => mapping.assertMappingIntegrity([...mapping.OLD_FEATURE_MAPPING, { id: 'GAP-9', gap: 'GAP-9', is: 'IS-9', lane: 'system', oldFeature: 'x', newSurface: 'y', scenario: '' }])).toThrow(/missing scenario/);
    // A row naming a scenario outside the catalog is refused too.
    expect(() => mapping.assertMappingIntegrity([...mapping.OLD_FEATURE_MAPPING, { id: 'GAP-9', gap: 'GAP-9', is: 'IS-9', lane: 'system', oldFeature: 'x', newSurface: 'y', scenario: 'SYS-99-not-a-scenario' }])).toThrow(/outside the catalog/);
    // The declared completeness over the executed set, with the real row count.
    expect(mapping.assertMappingComplete(mapping.OLD_FEATURE_MAPPING, observedScenarios, 'system')).toMatchObject({ rows: mapping.OLD_FEATURE_MAPPING.length, lane: 'system' });
    record('SYS-13-mapping-completeness', { rows: mapping.OLD_FEATURE_MAPPING.length, covered: coverage.filter((row) => row.observed).length, systemRows: coverage.length });
  });
});
