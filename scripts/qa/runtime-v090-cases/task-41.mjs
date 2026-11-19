// Task 41 registered QA case — serialized post-review integration with failure preservation.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/collaboration/
//     integrationService.js, integrationReview.js and repositoryLocks.js, composed exactly as the
//     product composes them (the integration service over the review service, the repository lock
//     service, task 40's artifact store and task 40's artifact service, which in turn captures out
//     of a real detached git worktree of a real private repository through the product's own
//     createGitRunner) — over the frozen shared/runtime/collaboration.js contract. Nothing is
//     stubbed. The ONLY case-owned seams are the services' own declared injection points —
//     newOperationId, newReviewId, newApprovalId and newLockId — each backed by a deterministic
//     counter, so an operation's own temporary worktree path is derivable and assertable. Every
//     git invocation is either the product's own (createGitRunner, whose cwd is a REQUIRED named
//     argument) or the case's runGit, and every repository is a private temporary one under the
//     fixture root — NEVER the QA worktree (the task-24 lesson: task-24.mjs:206 ran a git command
//     without a cwd and created a branch in the QA worktree, so EVERY call in this case names its
//     cwd explicitly, which matters doubly here because task 41 is itself about git and cwd).
//   * In a real headless Chromium: the frozen shared contract every integration rejection travels
//     through — the frozen ten-entry ERROR_CODES table, the CollaborationError shape, the
//     explicit-`at` contract, and the frozen criteria vocabulary (parseCriteria / parseCriterion)
//     the integration service validates every caller through — recomputed in a second JS realm
//     from the same pure shared/runtime modules the worker imports, over the SAME case-owned
//     input object the worker uses (the task-39 one-source lesson), plus the membership check
//     over every rejection code the worker actually observed.
//
// The five acceptance criteria this case re-derives, each with a NAMED check and OBSERVED values:
//   1. two integrations against one target are SERIALIZED (H2) — re-derived here from the case's
//      own worlds and its own hold duration, not copied from the product's own unit test.
//   2. the APPROVED artifact hash matches the ACTUAL BYTES (H3 on the happy path, F1 on the
//      corrupted path) — the hash is bound at review time and the bytes are re-hashed at integrate
//      time through the durable object's own streaming hasher.
//   3. a dirty target OR a moved HEAD fails and PRESERVES the artifact (F2a and F2b, driven
//      SEPARATELY so each cause is observed on its own).
//   4. a test failure cleans ONLY this operation's temp and NEVER resets the user's files (F3) —
//      proven with real before/after byte counts, per-path content hashes, a status digest, an
//      index digest and a `git worktree list` read.
//   5. a successful integration never auto-commits or pushes the user's original directory (H4).
//
// The controlled boundaries are stated rather than papered over:
//   * the stateful product cannot cross into the browser at all — integrationService.js:1-9,
//     integrationReview.js:1-3 and repositoryLocks.js:1-3 each import node:* builtins — so create,
//     approve, acquire, release, integrate, the durable results, the temporary integration
//     worktree and the controlled fast-forward are proven in the worker only. The split is exactly
//     the posture tasks 37, 38, 39 and 40 disclosed.
//   * no browser shim is needed: the browser closure is shared/runtime/collaboration.js ->
//     capabilities.js + identity.js, pure ESM with no node:* builtin and no bare or aliased
//     specifier — a strict subset of the closure task 38 booted in a real headless Chromium over
//     the case's exact Vite server options. No resolve.alias is authored at all, so the task-27
//     unanchored-regex trap cannot be hit.
//   * the plan's `bridge/workspaceCommand.js` stdin limitation is honoured by the product's own
//     runner TYPE — `stdio: ['ignore','pipe','pipe']` and no member that accepts input — and is
//     asserted by observation in H3: a blob reaches the test as a TEMP FILE named in
//     VIS_INTEGRATION_INPUT, inside this operation's own temp root, and is cleaned with it.
//   * every wall-clock-derived value (durationMs, waitedMs, heldMs, startedAt, completedAt,
//     acquiredAt, releasedAt, removedAt) is compared as a RELATION (>= 0, > 0, <= bound, A before
//     B), never as a literal, because a literal would be a snapshot of one machine's scheduling
//     rather than an assertion about the product.
//   * durability across a real process death is NOT claimed: the durable result is proven to
//     survive the operation ending IN-PROCESS (`integration.operation()` reads it back
//     byte-identically and the service counters survive). Cross-process repository-lock exclusion
//     is not proven either — the lock service is in-memory and single-process, exactly the
//     disclosure task 40 made for its writer leases; task 10's worktreeLease.js is the durable
//     cross-process lease.
//   * this case performs NO live SSH or live Slurm verification (task 46 owns that), claims NO UI
//     rendering (task 42 owns the collaboration UI), authors no PASS verdict, edits no product or
//     test file, and performs NO git operation in the worktree.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import {
  chmod, lstat, mkdir, readdir, readFile, readlink, rm, stat, symlink, writeFile,
} from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-41-fixture.mjs';

import {
  INTEGRATION_LIMITS,
  createIntegrationService,
} from '../../../bridge/runtime/collaboration/integrationService.js';
import {
  INTEGRATION_REVIEW_LIMITS,
  createIntegrationReviewService,
} from '../../../bridge/runtime/collaboration/integrationReview.js';
import {
  REPOSITORY_LOCK_LIMITS,
  createRepositoryLockService,
} from '../../../bridge/runtime/collaboration/repositoryLocks.js';
import {
  ARTIFACT_LIMITS,
  createArtifactStore,
} from '../../../bridge/runtime/collaboration/artifactStore.js';
import { createArtifactService } from '../../../bridge/runtime/collaboration/artifactService.js';
import { createWriterLeaseService } from '../../../bridge/runtime/collaboration/writerLeases.js';
import {
  CollaborationError,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_CHARS,
  MAX_CRITERION_ID_CHARS,
  parseAt,
  parseCriteria,
} from '../../../shared/runtime/collaboration.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const COMMIT = /^[0-9a-f]{40,64}$/;
const HASH = /^[a-f0-9]{64}$/;
const T0 = 1700000000000;
// The case's OWN serialization hold: how long the first integration's frozen-criteria test sleeps
// before it exits. Re-derived here rather than copied from the product's own unit test.
const SERIALIZED_HOLD_MS = 600;
const LOCK_WAIT_MS = 60;
// The product reports the elapsed wait as `Date.now() - startedAt` (repositoryLocks.js:147,199) and
// that measurement is EXACT — it equals the wall clock around the very same call in every trial. What
// it cannot do is be `>= limit` on a 60 ms horizon: Node schedules the timer on libuv's MONOTONIC
// clock, so the callback can run when the WALL clock has advanced only limit-1 ms (observed directly,
// 3 of 12 trials, delta -1, never worse). Demanding `observed >= limit` therefore demanded a
// precision the platform does not sell. The band below keeps the proof two-sided and STRONGER than
// the one-sided original: the caller really waited out essentially the whole limit (it did NOT
// return early — an early return would read ~0) AND it did not hang (the original `>= limit` would
// have passed a 10-second stall happily).
const LOCK_WAIT_EARLY_MS = 5;
const LOCK_WAIT_LATE_MS = 1000;
// A test that kills itself: the runner reports exitCode -1 with the observed signal.
const CRASHED_EXIT_CODE = -1;
const CRASH_SIGNAL = 'SIGKILL';

/**
 * THE ONE SOURCE of every case-owned input the two realms compare. Injected into the browser
 * entry through evaluate's argument, so the worker and the browser are identical BY CONSTRUCTION
 * rather than by two hard-coded copies (the task-39 lesson). It carries the raw criteria array the
 * real integration service is fed, the explicit-`at` readings and the CollaborationError shape
 * arguments. The product tables' budgets / ceilings / codes are NOT here — both realms derive
 * those from the shared modules they both import.
 */
const CRITERIA_RAW = Object.freeze([
  Object.freeze({ id: 'applies-cleanly', text: 'the artifact applies onto the reviewed base without a conflict' }),
  Object.freeze({ id: 'tests-pass', text: 'the frozen criteria tests exit zero in the integration worktree' }),
  Object.freeze({ id: 'fast-forward-only', text: 'the target branch moves forward to a descendant, never a rewrite' }),
]);
const CRITERIA = parseCriteria(CRITERIA_RAW);
const SHARED_INPUTS = Object.freeze({
  at: Object.freeze({ explicit: T0, zero: 0, negative: -1, fractional: 1.5, nonNumber: '1700000000000' }),
  errorShape: Object.freeze({ code: 'conflict', field: 'integration_target_dirty', detail: Object.freeze({ repository: '/repo' }) }),
  integrationCodes: Object.freeze([
    'invalid_request', 'unsupported', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable',
  ]),
});

/**
 * The frozen criteria ceilings, derived ONCE here from the shared module's own exported constants
 * and used by BOTH the worker mirror and the C2 expectation. The task-39 one-source lesson applied
 * to the OUTPUT as well as the INPUT: task 39's two realms each hard-coded the same array with
 * different contents, and the same class of asymmetry reappeared on the way OUT when the browser
 * entry reported the ceilings and this mirror did not. Deriving both sides from the product's own
 * exports means a change to the product's budgets moves both realms together and the comparison can
 * never silently go stale, and it is why the values are never spelled out literally here.
 */
const CRITERIA_CEILINGS = Object.freeze({
  maxCriteriaCount: MAX_CRITERIA_COUNT,
  maxCriterionIdChars: MAX_CRITERION_ID_CHARS,
  maxCriterionChars: MAX_CRITERION_CHARS,
});

/* ------------------------------------------------------------------ deterministic ids */

const idFor = (salt, index) => {
  const hex = createHash('sha256').update(`${salt}-${index}`).digest('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-4${hex.slice(13, 16)}-8${hex.slice(17, 20)}-${hex.slice(20, 32)}`;
};
const taskIdFor = (name) => idFor('vis-qa-task41-task', createHash('sha256').update(name).digest('hex').slice(0, 12));

let operationSeq = 0;
let reviewSeq = 0;
let approvalSeq = 0;
let lockSeq = 0;
const resetIds = () => { operationSeq = 0; reviewSeq = 0; approvalSeq = 0; lockSeq = 0; };
const operationIdFor = (index) => idFor('vis-qa-task41-operation', index);
const nextOperationId = () => { operationSeq += 1; return operationIdFor(operationSeq); };
const reviewIdFor = (index) => idFor('vis-qa-task41-review', index);
const nextReviewId = () => { reviewSeq += 1; return reviewIdFor(reviewSeq); };
const approvalIdFor = (index) => idFor('vis-qa-task41-approval', index);
const nextApprovalId = () => { approvalSeq += 1; return approvalIdFor(approvalSeq); };
const lockIdFor = (index) => idFor('vis-qa-task41-lock', index);
const nextLockId = () => { lockSeq += 1; return lockIdFor(lockSeq); };

/* ------------------------------------------------------------------ capture envelopes */

/**
 * The typed rejection envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously (reviews.approve, reviews.approval,
 * reviews.review, locks.release, parseAt, parseCriteria). `reviews.create`, `locks.acquire`,
 * `integration.integrate`, `store.read` / `open` / `verify` / `has` and `artifacts.apply` are
 * `async function`s — they RETURN A PROMISE and reject instead of throwing, so a synchronous
 * try/catch cannot observe their rejection: use capture (which awaits) for those (the task-34
 * lesson). Where the rejection DETAIL is itself asserted, captureDetail carries it.
 */
const observedCodes = new Set();
const recordCode = (error) => {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
    observedCodes.add(error.code);
    return { code: error.code, field: error.field };
  }
  return { code: 'not-a-CollaborationError', field: String(error) };
};
const captureSync = (run) => { try { run(); return { code: null, field: null }; } catch (error) { return recordCode(error); } };
const captureDetail = async (run) => {
  try { await run(); return { code: null, field: null, detail: null }; } catch (error) { return { ...recordCode(error), detail: error?.detail ?? null }; }
};

/**
 * The repository-lock service's own waiter timer is unref'd (repositoryLocks.js:202), so a process
 * whose ONLY pending work is a lock wait lets the event loop empty before the product's timer can
 * fire and the rejection never happens. Hold a REF'd interval for the duration of a wait so the
 * product's own timer is the thing that settles it. This is a case-owned scheduling aid, not a
 * product seam: nothing about the lock's behaviour is changed by it.
 */
const withKeepAlive = async (promise) => {
  const keepAlive = setInterval(() => {}, 25);
  try { return await promise; } finally { clearInterval(keepAlive); }
};

/** The worker mirror of the browser entry's frozen-contract table, over the SAME shared input. */
function workerTables(shared) {
  return {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError(shared.errorShape.code, shared.errorShape.field, shared.errorShape.detail);
      return {
        name: error.name,
        code: error.code,
        field: error.field,
        reason: error.reason,
        message: error.message,
        detail: error.detail === null ? null : { ...error.detail },
        isProtocolError: error instanceof ProtocolError,
        isTypeError: error instanceof TypeError,
      };
    })(),
    integrationCodesInTable: shared.integrationCodes.every((code) => ERROR_CODES.includes(code)),
    atExplicit: parseAt(shared.at.explicit),
    atZero: captureSync(() => parseAt(shared.at.zero)),
    atNegative: captureSync(() => parseAt(shared.at.negative)),
    atFractional: captureSync(() => parseAt(shared.at.fractional)),
    atNonNumber: captureSync(() => parseAt(shared.at.nonNumber)),
  };
}

/** The worker mirror of the browser entry's frozen-criteria table, over the SAME raw array. */
function workerCriteria(raw) {
  const parsed = parseCriteria(raw);
  return {
    parsed: parsed.map((entry) => ({ id: entry.id, text: entry.text, required: entry.required })),
    frozen: Object.isFrozen(parsed),
    entryFrozen: Object.isFrozen(parsed[0]),
    defaultsRequired: parseCriteria([{ id: 'build', text: 'a' }])[0].required,
    rejectsMissingText: captureSync(() => parseCriteria([{ id: 'build' }])),
    rejectsExtraKey: captureSync(() => parseCriteria([{ id: 'build', text: 'a', extra: 1 }])),
    rejectsEmpty: captureSync(() => parseCriteria([])),
    rejectsDuplicateIds: captureSync(() => parseCriteria([{ id: 'build', text: 'a' }, { id: 'build', text: 'b' }])),
    // The ceilings the shared module's own parseCriteria enforces, reported so BOTH realms prove
    // they read the SAME frozen budgets. The browser entry reports these too (app/dev/
    // runtime-v090/task41.ts), so omitting them here made the cross-realm equality unsatisfiable —
    // the receiver-contract lesson: the value handed to a deepEqual must be checked against the
    // RECEIVER's payload, never assumed to be the smaller of the two.
    ceilings: { ...CRITERIA_CEILINGS },
  };
}

export const sourceFiles = [...new Set([
  // the three product modules this task owns
  'bridge/runtime/collaboration/integrationService.js',
  'bridge/runtime/collaboration/integrationReview.js',
  'bridge/runtime/collaboration/repositoryLocks.js',
  // the product's own regression suite, unchanged
  'app/runtime/artifactIntegration.test.ts',
  // the landed task 40 modules this task composes and reuses, unchanged
  'bridge/runtime/collaboration/artifactStore.js',
  'bridge/runtime/collaboration/artifactService.js',
  'bridge/runtime/collaboration/writerLeases.js',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  // the plan's own stdin-limitation reference for this task
  'bridge/workspaceCommand.js',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task41.ts',
  'scripts/qa/runtime-v090-cases/task-41.mjs',
  'scripts/qa/runtime-v090-cases/task-41-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/**
 * The product files whose bytes the evidence must bind to. Every one of them is in sourceFiles, so
 * the independent gate can compare the recorded digests against the artifact's own sourceHashes
 * mechanically.
 */
const PRODUCT_FILES = [
  'bridge/runtime/collaboration/integrationService.js',
  'bridge/runtime/collaboration/integrationReview.js',
  'bridge/runtime/collaboration/repositoryLocks.js',
  'app/runtime/artifactIntegration.test.ts',
  'bridge/runtime/collaboration/artifactStore.js',
  'bridge/runtime/collaboration/artifactService.js',
  'bridge/runtime/collaboration/writerLeases.js',
  'shared/runtime/collaboration.js',
  'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js',
  'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js',
  'shared/runtime/identity.d.ts',
  'bridge/workspaceCommand.js',
];

function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 41 registered case</title>
 <style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
 <body><div id="app"></div>
 <script type="module">window.__task41Errors=[];window.addEventListener('error',(e)=>window.__task41Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task41Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
 <script type="module" src="/app/dev/runtime-v090/task41.ts"></script></body></html>`;

/** The 512-byte binary holding every byte value, used as the untracked binary change. */
const EVERY_BYTE_BLOB = Buffer.from(Array.from({ length: 512 }, (_, index) => index % 256));

export async function run(context) {
  // The case owns its git worlds: a fixed umask plus an explicit chmod on every written file
  // makes the observed modes deterministic regardless of the runner's ambient umask (git checkout
  // and writeFile both mask with it).
  process.umask(0o022);
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-41/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  let cleanupFailure = null;
  let peakHeap = process.memoryUsage().heapUsed;
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    peakHeap = Math.max(peakHeap, process.memoryUsage().heapUsed);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'the real landed bridge integration-service, integration-review and repository-lock modules composed exactly as the product composes them over task 40 artifact store/service and the frozen shared/runtime/collaboration.js contract in the Node worker — real private git repositories, real product-created detached integration worktrees, real atomic fast-forwards, real frozen-criteria test processes — plus the frozen shared contract recomputed in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-41.mjs',
    'scripts/qa/runtime-v090-cases/task-41-fixture.mjs',
    'app/dev/runtime-v090/task41.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const productHashesBefore = productHashes(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  const started = {
    gitCommands: 0, operations: 0, reviews: 0, approvals: 0, lockGrants: 0,
    captures: 0, applies: 0, writes: 0, largestArtifactBytes: 0,
  };

  /* ---------------------------------------------------------------- world helpers */

  /** Run one git command in a NAMED working directory. Never inherits an ambient cwd. */
  const runGit = (cwd, args, options = {}) => {
    started.gitCommands += 1;
    return execFileSync('git', [...args], {
      cwd,
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  };
  const exists = async (filePath) => { try { await stat(filePath); return true; } catch { return false; } };
  /** Write one file with an EXPLICIT mode, so the observed modes are umask-independent. */
  const writeFileMode = async (filePath, data, mode) => {
    await writeFile(filePath, data);
    await chmod(filePath, mode);
  };
  const scratch = (kind, name) => fixture.mkdirOwned(kind, name);

  /**
   * A private temporary git repository with a single base commit — NEVER the QA worktree. The
   * object format is pinned to sha1 on the command line so the base commit is always 40 hex
   * characters regardless of the host git configuration, and signing / line-ending conversion are
   * pinned off in the repository's OWN config so neither the case's commits nor the product's
   * integration commit can be reshaped by ambient host configuration.
   */
  const createRepo = async (name, branches = []) => {
    const root = await scratch('git-repository', `repos/${name}`);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFileMode(path.join(root, 'README.md'), 'base readme\n', 0o644);
    await writeFileMode(path.join(root, 'src', 'keep.txt'), 'keep\n', 0o644);
    await writeFileMode(path.join(root, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]), 0o644);
    await writeFileMode(path.join(root, 'script.sh'), 'echo hi\n', 0o644);
    await writeFileMode(path.join(root, 'gone.txt'), 'to be deleted\n', 0o644);
    await symlink('src/keep.txt', path.join(root, 'link'));
    runGit(root, ['-c', 'init.defaultObjectFormat=sha1', 'init', '-q', '-b', 'main']);
    runGit(root, ['config', 'commit.gpgsign', 'false']);
    runGit(root, ['config', 'tag.gpgsign', 'false']);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    runGit(root, ['add', '-A']);
    runGit(root, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
    for (const branch of branches) runGit(root, ['branch', branch]);
    return root;
  };

  /**
   * The on-disk shape of a working tree: a file count, a TOTAL BYTE count, a digest over
   * (relative path, content hash) and the per-file hashes. `.git` is skipped — in a repository it
   * is a directory, in a worktree it is a gitfile, and neither is part of the user's content (the
   * task-40 tree-comparison lesson).
   */
  async function observeTree(root) {
    const files = {};
    let totalBytes = 0;
    async function walk(relative) {
      const absolute = relative === '' ? root : path.join(root, relative);
      for (const entry of await readdir(absolute, { withFileTypes: true })) {
        if (entry.name === '.git') continue;
        const child = relative === '' ? entry.name : `${relative}/${entry.name}`;
        const info = await lstat(path.join(root, child));
        if (info.isDirectory()) { await walk(child); continue; }
        if (info.isSymbolicLink()) {
          const target = await readlink(path.join(root, child));
          files[child] = `symlink:${createHash('sha256').update(target).digest('hex')}`;
          continue;
        }
        const content = await readFile(path.join(root, child));
        totalBytes += content.length;
        files[child] = createHash('sha256').update(content).digest('hex');
      }
    }
    await walk('');
    const names = Object.keys(files).sort();
    const hash = createHash('sha256');
    for (const name of names) hash.update(`${name}\0${files[name]}\0`);
    return Object.freeze({
      fileCount: names.length, totalBytes, treeDigest: hash.digest('hex'), files: Object.freeze(files),
    });
  }

  /** The exact bytes of `git status --porcelain` in a NAMED directory. */
  const statusDigest = (cwd) => createHash('sha256')
    .update(runGit(cwd, ['status', '--porcelain=v1', '-z', '--untracked-files=all'], { encoding: 'buffer' }))
    .digest('hex');
  /** The exact bytes of the index, so a `git add` in the user's directory would be observed. */
  const indexDigest = (cwd) => createHash('sha256')
    .update(runGit(cwd, ['ls-files', '-s', '-z'], { encoding: 'buffer' }))
    .digest('hex');
  /** The sorted ref-NAME set of a repository. A moved branch keeps the set; a new ref changes it. */
  const refNames = (cwd) => runGit(cwd, ['for-each-ref', '--format=%(refname)'])
    .split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort();
  const headOf = (cwd) => runGit(cwd, ['rev-parse', '--verify', 'HEAD']).trim();
  const branchOf = (cwd, branch) => runGit(cwd, ['rev-parse', '--verify', `refs/heads/${branch}`]).trim();
  const worktreeList = (cwd) => runGit(cwd, ['worktree', 'list', '--porcelain']);

  /** The product's own composition, wired exactly as the product wires it. */
  async function buildHarness(label) {
    const storeRoot = await scratch('store-root', `${label}-store`);
    const integrationsRoot = await scratch('integrations-root', `${label}-integrations`);
    const store = createArtifactStore({ root: storeRoot });
    const artifactsSvc = createArtifactService({ store, root: integrationsRoot });
    const reviews = createIntegrationReviewService({ store, newReviewId: nextReviewId, newApprovalId: nextApprovalId });
    const locks = createRepositoryLockService({ newLockId: nextLockId });
    const integration = createIntegrationService({
      store,
      artifacts: artifactsSvc,
      reviews,
      locks,
      integrationsRoot,
      newOperationId: nextOperationId,
    });
    return {
      store, artifacts: artifactsSvc, reviews, locks, integration, storeRoot, integrationsRoot,
      close() {
        integration.close(); locks.close(); reviews.close(); artifactsSvc.close(); store.close();
      },
    };
  }

  /**
   * Capture one REAL artifact out of a real leased writer worktree of `repository`, so the
   * artifact's bytes, its base commit and its path manifest are all real product output rather
   * than fixtures. The writer root is a private scratch directory OUTSIDE the repository, so the
   * product-created worktree never lands inside the user's tree.
   */
  async function captureArtifact(harness, repository, label, mutate) {
    const writersRoot = await scratch('writers-root', `${label}-writers`);
    const writers = createWriterLeaseService({ writersRoot });
    try {
      const lease = await writers.allocate({
        repository, taskId: taskIdFor(label), ownerId: taskIdFor(`${label}-owner`), at: T0,
      });
      await mutate(lease.nativeCwd);
      const captured = await harness.artifacts.capture({ lease, at: T0 });
      started.captures += 1;
      started.writes += 1;
      started.largestArtifactBytes = Math.max(started.largestArtifactBytes, captured.bytes);
      return captured;
    } finally {
      writers.close();
    }
  }

  /** The frozen criteria's tests. `holdMs` makes an integration observably hold the lock. */
  const passingTests = (logPath, label, holdMs = 0) => {
    const script = [
      "const fs=require('node:fs');",
      `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${label}:enter\n`)});`,
      'setTimeout(()=>{',
      `fs.appendFileSync(${JSON.stringify(logPath)}, ${JSON.stringify(`${label}:exit\n`)});`,
      `}, ${holdMs});`,
    ].join('');
    return [
      { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', script] },
      { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
      { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    ];
  };
  const failingTests = () => [
    { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.stderr.write("frozen criterion failed\\n"); process.exit(3)'] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
  /** A test that CRASHES: the child kills itself, so the runner observes a signal, not an exit. */
  const crashingTests = () => [
    { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', `process.kill(process.pid, ${JSON.stringify(CRASH_SIGNAL)})`] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
  /** A test plan whose command reads its blob from the TEMP FILE the service hands it. */
  const inputFileTests = () => [
    {
      criterionId: 'applies-cleanly',
      command: process.execPath,
      args: ['-e', 'const fs=require("node:fs");const p=process.env.VIS_INTEGRATION_INPUT;if(!p){process.stderr.write("no input file\\n");process.exit(9)}const b=fs.readFileSync(p);if(b.length!==6){process.stderr.write("bad input length "+b.length+"\\n");process.exit(9)}if(b[0]!==0||b[1]!==1||b[2]!==2||b[3]!==3||b[4]!==254||b[5]!==255){process.stderr.write("bad input bytes\\n");process.exit(9)}process.exit(0)'],
      input: Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]),
    },
    { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
    { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
  ];
  const readLog = async (logPath) => { try { return await readFile(logPath, 'utf8'); } catch { return ''; } };
  const writeLog = async (logPath, text) => {
    await mkdir(path.dirname(logPath), { recursive: true });
    await writeFile(logPath, text, 'utf8');
  };

  /** Poll until one operation OBSERVABLY holds the repository lock, or fail loudly. */
  const untilHeld = async (harness, repository, expectedOperationId) => {
    const deadline = Date.now() + 20000;
    for (;;) {
      const held = harness.locks.held(repository);
      if (held.length > 0) {
        assert.equal(held[0].operationId, expectedOperationId);
        return held[0];
      }
      if (Date.now() > deadline) throw new Error(`no operation ever held the lock over ${repository}`);
      await new Promise((resolve) => setTimeout(resolve, 2));
    }
  };

  // Drives one worker value and its browser twin, then asserts the two realms are IDENTICAL.
  const crossRealm = async (name, workerValue, browserValue, expected) => {
    protocol.node[name] = workerValue;
    protocol.browser[name] = browserValue;
    record(name, { worker: workerValue, browser: browserValue });
    check(name, {
      worker: workerValue,
      browser: browserValue,
      equal: JSON.stringify(workerValue) === JSON.stringify(browserValue),
    }, { worker: expected, browser: expected, equal: true });
  };
  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the frozen shared contract (no shim: no node:* builtin anywhere
    // in the closure)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa41', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa41/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task41 && window.task41.ready)), 'task41 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the frozen contract is identical in both realms ──
    await crossRealm('the frozen shared contract every integration rejection travels through — the frozen ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason, message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at` contract with a zero, a negative, a fractional and a non-numeric reading refused — is byte-identical in the browser realm and the bridge worker, and every code the integration surfaces can emit (invalid_request, unsupported, unauthorized, conflict, cancelled, timeout, source_unavailable) is a member, so the app and the bridge cannot disagree about a rejection', workerTables(SHARED_INPUTS), await evaluate((shared) => window.task41.tables(shared), SHARED_INPUTS), {
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'integration_target_dirty', reason: 'integration_target_dirty', message: 'conflict: collaboration.integration_target_dirty', detail: { repository: '/repo' }, isProtocolError: true, isTypeError: true },
      integrationCodesInTable: true,
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atNegative: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
      atNonNumber: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // ── C2: the frozen criteria vocabulary is identical in both realms ──
    await crossRealm('the frozen criteria vocabulary the integration service validates every caller through is identical in both realms — the three frozen criteria parse to exactly their ids, texts and required flags, the list and its entries are frozen, `required` defaults to true, and a criterion with no text, a criterion with an extra key, an empty list and a duplicate id are each an explicit typed refusal rather than a bare throw — so a browser window and the bridge worker provably agree on what a frozen criterion is before any integration is driven', workerCriteria(CRITERIA_RAW), await evaluate((raw) => window.task41.criteria(raw), CRITERIA_RAW), {
      parsed: [
        { id: 'applies-cleanly', text: 'the artifact applies onto the reviewed base without a conflict', required: true },
        { id: 'tests-pass', text: 'the frozen criteria tests exit zero in the integration worktree', required: true },
        { id: 'fast-forward-only', text: 'the target branch moves forward to a descendant, never a rewrite', required: true },
      ],
      frozen: true,
      entryFrozen: true,
      defaultsRequired: true,
      rejectsMissingText: { code: 'invalid_request', field: 'task_criteria' },
      rejectsExtraKey: { code: 'invalid_request', field: 'task_criteria' },
      rejectsEmpty: { code: 'invalid_request', field: 'task_criteria' },
      rejectsDuplicateIds: { code: 'conflict', field: 'task_criteria' },
      ceilings: { ...CRITERIA_CEILINGS },
    });

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: a bound hash that no longer describes the bytes, a dirty target and a moved
      // HEAD driven SEPARATELY, a frozen criterion that fails and one that CRASHES, a worktree
      // that cannot be created, a duplicate approval, and an expired repository-lock wait — none
      // of them overwrites the user's content or reports a false success.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: the approved hash is bound at review time; the ACTUAL BYTES are re-hashed ──
      {
        const repository = await createRepo('hash-bind', ['integration/target']);
        const harness = await buildHarness('hash-bind');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'hash-bind-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
            await writeFileMode(path.join(cwd, 'bin.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef]), 0o644);
            await writeFileMode(path.join(cwd, 'untracked.bin'), Buffer.from([0x00, 0xff, 0x10, 0x7f]), 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          started.reviews += 1;
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const approvedHash = approval.binding.artifactHash;
          // Corrupt the durable object's BYTES so the approved hash no longer describes them.
          const originalBytes = await harness.store.read(captured.artifactHash);
          const objectPath = path.join(harness.storeRoot, 'objects', captured.artifactHash.slice(0, 2), captured.artifactHash.slice(2));
          await chmod(objectPath, 0o644);
          await writeFile(objectPath, Buffer.from('tampered bytes that are not the artifact\n', 'utf8'));
          const tampered = await harness.store.verify(captured.artifactHash);
          const userBefore = await observeTree(repository);
          const logRoot = await scratch('log-root', 'hash-bind-log');
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: passingTests(path.join(logRoot, 'order.log'), 'hash-bind'),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const userAfter = await observeTree(repository);
          // The artifact object is PRESERVED: it is neither repaired nor deleted.
          const preserved = {
            objectStillThere: await exists(objectPath),
            storeStillHas: await harness.store.has(captured.artifactHash),
            bytesStillTampered: (await readFile(objectPath)).toString('utf8') === 'tampered bytes that are not the artifact\n',
          };
          // Restore the original bytes, and prove the restore re-hashes to the approved value.
          await chmod(objectPath, 0o644);
          await writeFile(objectPath, originalBytes);
          const restored = await harness.store.verify(captured.artifactHash);
          check('the APPROVED artifact hash is bound at review time and the ACTUAL BYTES are re-hashed at integrate time, so a durable object whose bytes no longer describe the approved hash is refused BEFORE anything is written: the review binds the hash the writer really produced, the approval freezes that binding, and after the object is corrupted to different bytes the integration refuses conflict/integration_artifact_bytes carrying TWO DIFFERENT REAL sha256 values (the approved one and the one the bytes actually hash to) plus the observed byte count — the observedArtifactHash is the tampered digest, artifact.verified is false, no worktree was created, no test ran, no commit was made, no fast-forward happened, the target branch and HEAD are still the reviewed base, the user tree digest and byte count are unchanged, and the artifact object itself is PRESERVED rather than repaired or deleted (it is still there, still hashed under its approved name, still holding the tampered bytes) — and restoring the original bytes re-verifies to the approved hash with the original byte count', {
            approvedHash,
            approvedHashShape: HASH.test(approvedHash),
            approvedEqualsCaptured: approvedHash === captured.artifactHash,
            bindingEqualsApproved: approval.binding.artifactHash === approvedHash,
            bindingBaseEqualsReview: approval.binding.base === review.base,
            bindingTarget: approval.binding.target,
            tamperedVerify: { ok: tampered.ok, hashDiffersFromApproved: tampered.artifactHash !== approvedHash, bytes: tampered.bytes },
            result: {
              ok: result.ok,
              outcome: result.outcome,
              rejection: result.rejection,
              observedArtifactHash: result.observedArtifactHash,
              observedIsTamperedDigest: result.observedArtifactHash === tampered.artifactHash,
              observedDiffersFromApproved: result.observedArtifactHash !== approvedHash,
              artifactBytes: result.artifactBytes,
              artifactChunks: result.artifactChunks,
              artifactVerified: result.artifact.verified,
              worktreeCreated: result.worktree.created,
              testCount: result.tests.length,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
              targetHeadAfter: result.targetAfter.targetHead,
              headAfter: result.targetAfter.head,
            },
            preserved,
            restored: { ok: restored.ok, hashMatchesApproved: restored.artifactHash === approvedHash, bytes: restored.bytes },
            userTreeUnchanged: {
              digestEqual: userAfter.treeDigest === userBefore.treeDigest,
              byteCountEqual: userAfter.totalBytes === userBefore.totalBytes,
              fileCountEqual: userAfter.fileCount === userBefore.fileCount,
              perFileEqual: JSON.stringify(userAfter.files) === JSON.stringify(userBefore.files),
            },
            branchUnmoved: branchOf(repository, 'main') === review.base,
          }, {
            approvedHash: captured.artifactHash,
            approvedHashShape: true,
            approvedEqualsCaptured: true,
            bindingEqualsApproved: true,
            bindingBaseEqualsReview: true,
            bindingTarget: 'integration/target',
            tamperedVerify: { ok: false, hashDiffersFromApproved: true, bytes: 41 },
            result: {
              ok: false,
              outcome: 'artifact_mismatch',
              rejection: {
                code: 'conflict',
                field: 'integration_artifact_bytes',
                detail: { approved: captured.artifactHash, observed: tampered.artifactHash, bytes: 41 },
              },
              observedArtifactHash: tampered.artifactHash,
              observedIsTamperedDigest: true,
              observedDiffersFromApproved: true,
              artifactBytes: 41,
              artifactChunks: 1,
              artifactVerified: false,
              worktreeCreated: false,
              testCount: 0,
              commitCreated: false,
              fastForwardApplied: false,
              targetHeadAfter: review.base,
              headAfter: review.base,
            },
            preserved: { objectStillThere: true, storeStillHas: true, bytesStillTampered: true },
            restored: { ok: true, hashMatchesApproved: true, bytes: captured.bytes },
            userTreeUnchanged: { digestEqual: true, byteCountEqual: true, fileCountEqual: true, perFileEqual: true },
            branchUnmoved: true,
          });
        } finally { harness.close(); }
      }

      // ── F2a: a DIRTY target fails and preserves the artifact ──
      {
        const repository = await createRepo('dirty-target', ['integration/target']);
        const harness = await buildHarness('dirty-target');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'dirty-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const cleanBefore = await observeTree(repository);
          const cleanStatus = statusDigest(repository);
          // The target becomes dirty AFTER the review: the user's own uncommitted work.
          await writeFileMode(path.join(repository, 'README.md'), 'user edit\n', 0o644);
          await writeFileMode(path.join(repository, 'user-local.txt'), 'user only\n', 0o644);
          const dirtyStatus = statusDigest(repository);
          const dirtyTree = await observeTree(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: failingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          check('a DIRTY target fails the integration and preserves the artifact, with NOTHING of the user own uncommitted work disturbed: after the review the user edits a tracked file and adds an untracked one, and the integration refuses conflict/integration_target_dirty naming the repository and BOTH real porcelain dirty paths, with targetBefore reporting clean false and the same two paths while targetAfter reports them unchanged — the artifact is preserved (still stored, still re-verifying to the approved hash), no worktree was created so there was no temp of ours to leave behind, no test ran, no commit was made, no fast-forward happened, the branch is still the reviewed base, and the user own edit and untracked file survive byte for byte with the status digest, the tree digest, the total byte count and the per-file hashes all unchanged from the moment the target went dirty', {
            rejection: result.rejection,
            targetBefore: {
              clean: result.targetBefore.clean,
              dirtyPaths: result.targetBefore.dirtyPaths,
              head: result.targetBefore.head,
              targetHead: result.targetBefore.targetHead,
            },
            targetAfter: {
              clean: result.targetAfter.clean,
              dirtyPaths: result.targetAfter.dirtyPaths,
              digestEqualsBefore: result.targetAfter.treeDigest === result.targetBefore.treeDigest,
            },
            artifactPreserved: {
              reported: result.artifact.preserved,
              stored: await harness.store.has(captured.artifactHash),
              verifies: (await harness.store.verify(captured.artifactHash)).ok,
              hashMatches: (await harness.store.verify(captured.artifactHash)).artifactHash === captured.artifactHash,
            },
            nothingOfOursCreated: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              testCount: result.tests.length,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
              fastForwardTo: result.fastForward.to,
            },
            userWorkSurvives: {
              statusDigestEqual: statusDigest(repository) === dirtyStatus,
              cleanStatusDiffers: dirtyStatus !== cleanStatus,
              treeDigestEqual: afterTree.treeDigest === dirtyTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === dirtyTree.totalBytes,
              fileCountEqual: afterTree.fileCount === dirtyTree.fileCount,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(dirtyTree.files),
              readmeIsUserEdit: afterTree.files['README.md'] === createHash('sha256').update('user edit\n').digest('hex'),
              userLocalIsUserOnly: afterTree.files['user-local.txt'] === createHash('sha256').update('user only\n').digest('hex'),
              fileCountGrewByOne: afterTree.fileCount === cleanBefore.fileCount + 1,
              branchUnmoved: branchOf(repository, 'main') === review.base,
              headUnmoved: headOf(repository) === review.base,
            },
          }, {
            rejection: {
              code: 'conflict',
              field: 'integration_target_dirty',
              detail: { repository, target: 'integration/target', dirtyPaths: ['README.md', 'user-local.txt'] },
            },
            targetBefore: { clean: false, dirtyPaths: ['README.md', 'user-local.txt'], head: review.base, targetHead: review.base },
            targetAfter: { clean: false, dirtyPaths: ['README.md', 'user-local.txt'], digestEqualsBefore: true },
            artifactPreserved: { reported: true, stored: true, verifies: true, hashMatches: true },
            nothingOfOursCreated: {
              worktreeCreated: false, worktreeRemoved: false, worktreePathAbsent: true,
              testCount: 0, commitCreated: false, fastForwardApplied: false, fastForwardTo: null,
            },
            userWorkSurvives: {
              statusDigestEqual: true, cleanStatusDiffers: true, treeDigestEqual: true,
              totalBytesEqual: true, fileCountEqual: true, perFileEqual: true,
              readmeIsUserEdit: true, userLocalIsUserOnly: true, fileCountGrewByOne: true,
              branchUnmoved: true, headUnmoved: true,
            },
          });
        } finally { harness.close(); }
      }

      // ── F2b: a MOVED HEAD fails and preserves the artifact ──
      {
        const repository = await createRepo('moved-head', ['integration/target']);
        const harness = await buildHarness('moved-head');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'moved-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const reviewedBase = headOf(repository);
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          // The target's HEAD moves AFTER the review: a new commit lands, and the target branch is
          // advanced to it (the branch is NOT checked out anywhere, which is what makes advancing
          // it by hand the realistic "someone else pushed" move rather than the checked-out
          // refusal the product now makes).
          await writeFileMode(path.join(repository, 'someone-else.txt'), 'other work\n', 0o644);
          runGit(repository, ['add', '-A']);
          runGit(repository, ['-c', 'user.name=other', '-c', 'user.email=other@example.invalid', 'commit', '-q', '-m', 'other']);
          const movedTo = headOf(repository);
          runGit(repository, ['update-ref', 'refs/heads/integration/target', movedTo]);
          const userBefore = await observeTree(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: failingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const userAfter = await observeTree(repository);
          check('a MOVED HEAD fails the integration and preserves the artifact, driven SEPARATELY from the dirty target so each cause is observed on its own: after the review a NEW COMMIT lands on the target branch (the tree stays CLEAN, which is what proves the refusal came from the HEAD move and not from dirt), and the integration refuses conflict/integration_head_moved carrying the reviewed base as `expected` and the real new commit as `observed` with targetBefore reporting clean true and the moved head — the artifact is preserved and still re-verifies, no worktree was created, no test ran, no fast-forward happened, the user own commit is still the tip of the branch and of HEAD, and the user tree digest, total byte count, file count and per-file hashes are all unchanged, so the integration neither rewound nor overwrote the work that landed after the review', {
            rejection: result.rejection,
            movedTo,
            movedDiffersFromBase: movedTo !== reviewedBase,
            targetBefore: {
              head: result.targetBefore.head,
              headIsMovedCommit: result.targetBefore.head === movedTo,
              clean: result.targetBefore.clean,
              dirtyPathCount: result.targetBefore.dirtyPaths.length,
              targetHead: result.targetBefore.targetHead,
            },
            artifactPreserved: {
              reported: result.artifact.preserved,
              stored: await harness.store.has(captured.artifactHash),
              verifies: (await harness.store.verify(captured.artifactHash)).ok,
            },
            nothingOfOursCreated: {
              worktreeCreated: result.worktree.created,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              testCount: result.tests.length,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
            },
            userWorkSurvives: {
              headStillMovedCommit: headOf(repository) === movedTo,
              branchStillMovedCommit: branchOf(repository, 'main') === movedTo,
              treeDigestEqual: userAfter.treeDigest === userBefore.treeDigest,
              totalBytesEqual: userAfter.totalBytes === userBefore.totalBytes,
              fileCountEqual: userAfter.fileCount === userBefore.fileCount,
              perFileEqual: JSON.stringify(userAfter.files) === JSON.stringify(userBefore.files),
              someoneElseStillThere: userAfter.files['someone-else.txt'] === createHash('sha256').update('other work\n').digest('hex'),
            },
          }, {
            rejection: {
              code: 'conflict',
              field: 'integration_head_moved',
              detail: { expected: reviewedBase, observed: movedTo },
            },
            movedTo: movedTo,
            movedDiffersFromBase: true,
            targetBefore: {
              head: movedTo, headIsMovedCommit: true, clean: true, dirtyPathCount: 0, targetHead: movedTo,
            },
            artifactPreserved: { reported: true, stored: true, verifies: true },
            nothingOfOursCreated: {
              worktreeCreated: false, worktreePathAbsent: true, testCount: 0,
              commitCreated: false, fastForwardApplied: false,
            },
            userWorkSurvives: {
              headStillMovedCommit: true, branchStillMovedCommit: true, treeDigestEqual: true,
              totalBytesEqual: true, fileCountEqual: true, perFileEqual: true, someoneElseStillThere: true,
            },
          });
        } finally { harness.close(); }
      }

      // ── F3: a failing test cleans ONLY this operation's temp, never the user's files ──
      {
        const repository = await createRepo('test-fail', ['integration/target']);
        const harness = await buildHarness('test-fail');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'testfail-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
            await writeFileMode(path.join(cwd, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]), 0o644);
            await rm(path.join(cwd, 'gone.txt'));
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
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
          started.operations += 1;
          const afterTree = await observeTree(repository);
          const operationRoot = path.dirname(result.worktree.path);
          const worktrees = worktreeList(repository);
          check('a failing frozen criterion cleans ONLY this operation own temp and NEVER resets the user files, proven with real before/after byte counts and hashes: the artifact really applies into the operation own temporary integration worktree, the second frozen criterion then exits 3 with its own stderr, and the integration refuses conflict/integration_tests naming the failed criterion and the OBSERVED exit code while the criteria after it never ran (the durable record holds two test entries, not three) — the per-operation temp root and its worktree are GONE from disk, `git worktree list` no longer names the path, and the user repository is byte-for-byte what it was: the tree digest, the total byte count, the file count and every per-file content hash are unchanged, the porcelain status digest and the index digest are byte-identical (so nothing was swept into a commit and nothing was `add`ed), HEAD and the target branch are still the reviewed base, `git stash list` is empty, and the artifact is preserved and still re-verifies — so the failure cleaned exactly one operation temp and touched nothing of the user own', {
            outcome: result.outcome,
            rejection: result.rejection,
            testRecords: result.tests.map((entry) => ({
              criterionId: entry.criterionId,
              exitCode: entry.exitCode,
              stdoutBytes: entry.stdoutBytes,
              stderrBytes: entry.stderrBytes,
              inputFile: entry.inputFile,
              durationNonNegative: entry.durationMs >= 0,
              commandIsThisNode: entry.command === process.execPath,
            })),
            failedExitCode: result.tests.find((entry) => entry.criterionId === 'tests-pass')?.exitCode,
            onlyThisOperationsTempCleaned: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              removedAtNonNegative: typeof result.worktree.removedAt === 'number' && result.worktree.removedAt > 0,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              operationRootAbsent: !(await exists(operationRoot)),
              operationRootWasUnderIntegrationsRoot: operationRoot.startsWith(`${harness.integrationsRoot}${path.sep}`),
              worktreeListOmitsPath: !worktrees.includes(result.worktree.path),
              worktreeListStillNamesRepository: worktrees.includes(repository),
            },
            userFilesUntouched: {
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              fileCountEqual: afterTree.fileCount === beforeTree.fileCount,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              indexDigestEqual: indexDigest(repository) === beforeIndex,
              headUnmoved: headOf(repository) === beforeHead,
              branchUnmoved: branchOf(repository, 'main') === beforeHead,
              stashEmpty: runGit(repository, ['stash', 'list']).trim() === '',
              beforeByteCount: beforeTree.totalBytes,
              afterByteCount: afterTree.totalBytes,
              beforeFileCount: beforeTree.fileCount,
              afterFileCount: afterTree.fileCount,
            },
            artifactPreserved: {
              reported: result.artifact.preserved,
              stored: await harness.store.has(captured.artifactHash),
              verifies: (await harness.store.verify(captured.artifactHash)).ok,
            },
            noFalseSuccess: {
              ok: result.ok,
              commitCreated: result.commit.created,
              commitSha: result.commit.sha,
              fastForwardApplied: result.fastForward.applied,
              fastForwardTo: result.fastForward.to,
              targetAfterDigestEqualsBefore: result.targetAfter.treeDigest === result.targetBefore.treeDigest,
              targetAfterClean: result.targetAfter.clean,
            },
          }, {
            outcome: 'tests_failed',
            rejection: {
              code: 'conflict',
              field: 'integration_tests',
              detail: { failed: 'tests-pass', exitCode: 3, command: process.execPath, stderr: 'frozen criterion failed\n' },
            },
            testRecords: [
              { criterionId: 'applies-cleanly', exitCode: 0, stdoutBytes: 0, stderrBytes: 0, inputFile: null, durationNonNegative: true, commandIsThisNode: true },
              { criterionId: 'tests-pass', exitCode: 3, stdoutBytes: 0, stderrBytes: 24, inputFile: null, durationNonNegative: true, commandIsThisNode: true },
            ],
            failedExitCode: 3,
            onlyThisOperationsTempCleaned: {
              worktreeCreated: true, worktreeRemoved: true, removedAtNonNegative: true,
              worktreePathAbsent: true, operationRootAbsent: true, operationRootWasUnderIntegrationsRoot: true,
              worktreeListOmitsPath: true, worktreeListStillNamesRepository: true,
            },
            userFilesUntouched: {
              treeDigestEqual: true, totalBytesEqual: true, fileCountEqual: true, perFileEqual: true,
              statusDigestEqual: true, indexDigestEqual: true, headUnmoved: true, branchUnmoved: true,
              stashEmpty: true,
              beforeByteCount: beforeTree.totalBytes,
              afterByteCount: beforeTree.totalBytes,
              beforeFileCount: beforeTree.fileCount,
              afterFileCount: beforeTree.fileCount,
            },
            artifactPreserved: { reported: true, stored: true, verifies: true },
            noFalseSuccess: {
              ok: false, commitCreated: false, commitSha: null, fastForwardApplied: false, fastForwardTo: null,
              targetAfterDigestEqualsBefore: true, targetAfterClean: true,
            },
          });
        } finally { harness.close(); }
      }
      // ── F4: a test that CRASHES after the apply is a failure, not a success ──
      {
        const repository = await createRepo('test-crash', ['integration/target']);
        const harness = await buildHarness('test-crash');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'testcrash-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const beforeTree = await observeTree(repository);
          const beforeStatus = statusDigest(repository);
          const beforeIndex = indexDigest(repository);
          const beforeHead = headOf(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: crashingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          const worktrees = worktreeList(repository);
          check('a frozen criterion whose test process CRASHES after the artifact has been applied is reported as a FAILURE with the OBSERVED signal, never as a success: the artifact is applied into the operation own temporary worktree, the second criterion child then kills itself with SIGKILL, and the runner records exitCode -1 rather than a synthetic zero — the integration refuses conflict/integration_tests with that observed exit code, the per-operation temp root is gone from disk and `git worktree list` no longer names it, and the user repository is byte-for-byte unchanged (tree digest, total byte count, file count, per-file hashes, porcelain status digest, index digest, HEAD and the target branch) with `git stash list` empty — so a crash AFTER the apply neither overwrites the user content nor produces a false success', {
            outcome: result.outcome,
            rejection: result.rejection,
            crashed: {
              exitCode: result.tests.find((entry) => entry.criterionId === 'tests-pass')?.exitCode,
              testCount: result.tests.length,
            },
            tempCleaned: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              operationRootAbsent: !(await exists(path.dirname(result.worktree.path))),
              worktreeListOmitsPath: !worktrees.includes(result.worktree.path),
            },
            userFilesUntouched: {
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              fileCountEqual: afterTree.fileCount === beforeTree.fileCount,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              indexDigestEqual: indexDigest(repository) === beforeIndex,
              headUnmoved: headOf(repository) === beforeHead,
              branchUnmoved: branchOf(repository, 'main') === beforeHead,
              stashEmpty: runGit(repository, ['stash', 'list']).trim() === '',
            },
            noFalseSuccess: {
              ok: result.ok,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
              artifactPreserved: result.artifact.preserved,
              artifactStored: await harness.store.has(captured.artifactHash),
              artifactVerifies: (await harness.store.verify(captured.artifactHash)).ok,
            },
          }, {
            outcome: 'tests_failed',
            rejection: {
              code: 'conflict',
              field: 'integration_tests',
              detail: { failed: 'tests-pass', exitCode: CRASHED_EXIT_CODE, command: process.execPath, stderr: '' },
            },
            crashed: { exitCode: CRASHED_EXIT_CODE, testCount: 2 },
            tempCleaned: {
              worktreeCreated: true, worktreeRemoved: true, worktreePathAbsent: true,
              operationRootAbsent: true, worktreeListOmitsPath: true,
            },
            userFilesUntouched: {
              treeDigestEqual: true, totalBytesEqual: true, fileCountEqual: true, perFileEqual: true,
              statusDigestEqual: true, indexDigestEqual: true, headUnmoved: true, branchUnmoved: true, stashEmpty: true,
            },
            noFalseSuccess: {
              ok: false, commitCreated: false, fastForwardApplied: false, artifactPreserved: true,
              artifactStored: true, artifactVerifies: true,
            },
          });
        } finally { harness.close(); }
      }

      // ── F5: the artifact object is GONE before the apply — nothing is written ──
      {
        const repository = await createRepo('lost-object', ['integration/target']);
        const harness = await buildHarness('lost-object');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'lost-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          // The disk LOSES the durable object after the review: the approval still names it.
          const objectPath = path.join(harness.storeRoot, 'objects', captured.artifactHash.slice(0, 2), captured.artifactHash.slice(2));
          await rm(objectPath, { force: true });
          const beforeTree = await observeTree(repository);
          const beforeStatus = statusDigest(repository);
          const beforeHead = headOf(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: failingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          check('a durable object that the disk has LOST between the review and the apply is an EXPLICIT miss, never a fabricated empty integration: the review and the approval both bound a hash whose object is then deleted, and the integration refuses invalid_request/integration_artifact_missing naming that hash — before any worktree, any test, any commit or any fast-forward — with the user repository byte-for-byte unchanged (tree digest, total byte count, per-file hashes, porcelain status digest, HEAD and the target branch) and the target branch still at the reviewed base, so a lost object can neither be silently replaced by an empty change set nor reported as a success', {
            rejection: result.rejection,
            objectGone: { storeHas: await harness.store.has(captured.artifactHash), pathAbsent: !(await exists(objectPath)) },
            result: {
              ok: result.ok,
              outcome: result.outcome,
              observedArtifactHash: result.observedArtifactHash,
              artifactVerified: result.artifact.verified,
              worktreeCreated: result.worktree.created,
              testCount: result.tests.length,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
            },
            userFilesUntouched: {
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              headUnmoved: headOf(repository) === beforeHead,
              branchUnmoved: branchOf(repository, 'main') === review.base,
            },
          }, {
            rejection: {
              code: 'invalid_request',
              field: 'integration_artifact_missing',
              detail: { artifactHash: captured.artifactHash },
            },
            objectGone: { storeHas: false, pathAbsent: true },
            result: {
              ok: false, outcome: 'artifact_mismatch', observedArtifactHash: captured.artifactHash,
              artifactVerified: false, worktreeCreated: false, testCount: 0, commitCreated: false,
              fastForwardApplied: false,
            },
            userFilesUntouched: {
              treeDigestEqual: true, totalBytesEqual: true, perFileEqual: true,
              statusDigestEqual: true, headUnmoved: true, branchUnmoved: true,
            },
          });
        } finally { harness.close(); }
      }

      // ── F6: the operation's own temporary worktree cannot be created ──
      {
        const repository = await createRepo('worktree-blocked', ['integration/target']);
        const harness = await buildHarness('worktree-blocked');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'blocked-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          // The deterministic operation id lets the case name the exact worktree path the product
          // is about to derive and block it with a REAL non-empty directory, so `git worktree add`
          // fails for real rather than being talked into failing.
          const expectedOperationId = operationIdFor(1);
          const blockedWorktree = path.join(harness.integrationsRoot, expectedOperationId, 'worktree');
          await mkdir(blockedWorktree, { recursive: true });
          await writeFileMode(path.join(blockedWorktree, 'blocker.txt'), 'occupied\n', 0o644);
          const beforeTree = await observeTree(repository);
          const beforeStatus = statusDigest(repository);
          const beforeIndex = indexDigest(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: failingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          check('an operation whose own temporary worktree cannot be created fails BEFORE the apply and leaves nothing behind: the deterministic operation id lets the case name the exact worktree path the product derives and occupy it with a real non-empty directory, so the product own `git worktree add --detach` fails for real with source_unavailable/integration_worktree carrying the repository, the worktree path and the base — the artifact is applied nowhere (no apply, no test, no commit, no fast-forward), the operation own temp root is still swept away afterwards, and the user repository is byte-for-byte unchanged (tree digest, total byte count, per-file hashes, porcelain status digest, index digest, HEAD and the target branch) with the artifact preserved and still re-verifying', {
            operationId: result.operationId,
            operationIdIsDerived: result.operationId === expectedOperationId,
            rejection: {
              code: result.rejection.code,
              field: result.rejection.field,
              detail: {
                repositoryMatches: result.rejection.detail.repository === repository,
                worktreeMatches: result.rejection.detail.worktree === blockedWorktree,
                baseMatches: result.rejection.detail.base === review.base,
                stderrNamesAlreadyExists: /already exists/i.test(String(result.rejection.detail.stderr)),
              },
            },
            nothingApplied: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              operationRootAbsent: !(await exists(path.dirname(result.worktree.path))),
              testCount: result.tests.length,
              commitCreated: result.commit.created,
              fastForwardApplied: result.fastForward.applied,
            },
            userFilesUntouched: {
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              indexDigestEqual: indexDigest(repository) === beforeIndex,
              headUnmoved: headOf(repository) === review.base,
              branchUnmoved: branchOf(repository, 'main') === review.base,
            },
            artifactPreserved: {
              reported: result.artifact.preserved,
              stored: await harness.store.has(captured.artifactHash),
              verifies: (await harness.store.verify(captured.artifactHash)).ok,
            },
          }, {
            operationId: expectedOperationId,
            operationIdIsDerived: true,
            rejection: {
              code: 'source_unavailable',
              field: 'integration_worktree',
              detail: {
                repositoryMatches: true, worktreeMatches: true, baseMatches: true, stderrNamesAlreadyExists: true,
              },
            },
            nothingApplied: {
              worktreeCreated: false, worktreeRemoved: false, worktreePathAbsent: true,
              operationRootAbsent: true, testCount: 0, commitCreated: false, fastForwardApplied: false,
            },
            userFilesUntouched: {
              treeDigestEqual: true, totalBytesEqual: true, perFileEqual: true,
              statusDigestEqual: true, indexDigestEqual: true, headUnmoved: true, branchUnmoved: true,
            },
            artifactPreserved: { reported: true, stored: true, verifies: true },
          });
        } finally { harness.close(); }
      }

      // ── F7: a duplicate approval, and an EXPIRED repository-lock wait ──
      {
        const repository = await createRepo('approval-once', ['integration/target']);
        const harness = await buildHarness('approval-once');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'approval-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          // A SECOND approval for the same review is refused, so the binding is minted exactly once.
          // The detail is asserted below, so the capture must be captureDetail: captureSync drops the
          // rejection's detail (the case's own documented rule) and the expectation names it.
          const duplicate = await captureDetail(() => harness.reviews.approve({
            reviewId: review.reviewId, at: T0 + 2, reviewerId: 'reviewer-2',
          }));
          const reread = harness.reviews.review(review.reviewId);
          const approvals = harness.reviews.approvals();
          const approvalReadBack = harness.reviews.approval(approval.approvalId);
          const surface = Object.keys(harness.reviews).sort();
          // The repository lock: a holder that will not yield, a caller that will not wait, and a
          // waiter whose requested wait EXPIRES.
          const held = await harness.locks.acquire({
            repository, operationId: 'manual-holder', at: T0 + 3, waitMs: 0,
          });
          started.lockGrants += 1;
          const refusedNoWait = await captureDetail(() => harness.locks.acquire({
            repository, operationId: 'manual-second', at: T0 + 4, waitMs: 0,
          }));
          const expiredWait = await captureDetail(() => withKeepAlive(harness.locks.acquire({
            repository, operationId: 'manual-waiter', at: T0 + 5, waitMs: LOCK_WAIT_MS,
          })));
          const holderAfterExpiry = harness.locks.held(repository);
          const lockStateAfterExpiry = harness.locks.state();
          const receipt = harness.locks.release({ grant: held, at: T0 + 6 });
          const repositoryFreeAfterRelease = harness.locks.held(repository).length;
          const beforeTree = await observeTree(repository);
          const beforeStatus = statusDigest(repository);
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: failingTests(),
            commitMessage: 'must not happen',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          check('the review binding is minted EXACTLY ONCE and an EXPIRED repository-lock wait is an explicit refusal that overwrites nothing and reports no success: a second approval for the same review is refused conflict/integration_review_approved carrying the review id, the first approval time and the first reviewer, the re-read review is still approved with the SAME artifact hash, base and target it was created with, exactly one approval exists and reads back byte-identically, and the review service surface exposes no member that could accept a new hash, base or target for an existing review — so any change forces a NEW review. The repository lock then refuses a caller that will not wait with conflict/repository_lock_busy naming the OBSERVED holder, the frozen holders constant 1 and the frozen maxHolders 1, and refuses a caller whose requested wait EXPIRES with timeout/repository_lock_wait carrying the requested limit and an observed elapsed time that really waited that limit out — neither returning early nor hanging — while the ORIGINAL holder still holds; releasing that holder hands the lock on, and the following integration runs against a free repository and still fails its own frozen criterion with the user repository byte-for-byte unchanged', {
            duplicate,
            reread: {
              state: reread.state,
              artifactHash: reread.artifactHash,
              base: reread.base,
              target: reread.target,
              approvedAt: reread.approvedAt,
              reviewerId: reread.reviewerId,
            },
            approvalCount: approvals.length,
            approvalReadBackEquals: JSON.stringify(approvalReadBack) === JSON.stringify(approval),
            reviewSurface: surface,
            surfaceHasNoRebindMember: !surface.some((member) => /hash|base|target|rebind|update|set/i.test(member)),
            refusedNoWait,
            expiredWait: {
              code: expiredWait.code,
              field: expiredWait.field,
              detail: {
                repositoryMatches: expiredWait.detail?.repository === path.resolve(repository),
                holder: expiredWait.detail?.holder,
                limit: expiredWait.detail?.limit,
                waitedOutTheLimit:
                  expiredWait.detail?.observed >= expiredWait.detail?.limit - LOCK_WAIT_EARLY_MS
                  && expiredWait.detail?.observed <= expiredWait.detail?.limit + LOCK_WAIT_LATE_MS,
              },
            },
            holderAfterExpiry: holderAfterExpiry.map((entry) => entry.operationId),
            lockStateAfterExpiry: {
              acquired: lockStateAfterExpiry.acquired,
              refused: lockStateAfterExpiry.refused,
              waited: lockStateAfterExpiry.waited,
              released: lockStateAfterExpiry.released,
              held: lockStateAfterExpiry.held,
            },
            receipt: { operationId: receipt.operationId, heldMsNonNegative: receipt.heldMs >= 0 },
            repositoryFreeAfterRelease,
            integration: {
              ok: result.ok,
              outcome: result.outcome,
              rejectionField: result.rejection.field,
              lockWaited: result.lock.waited,
              lockQueuePosition: result.lock.queuePosition,
            },
            userFilesUntouched: {
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              branchUnmoved: branchOf(repository, 'main') === review.base,
            },
          }, {
            duplicate: {
              code: 'conflict',
              field: 'integration_review_approved',
              detail: { reviewId: review.reviewId, approvedAt: T0 + 1, reviewerId: 'reviewer-1' },
            },
            reread: {
              state: 'approved',
              artifactHash: captured.artifactHash,
              base: review.base,
              target: 'integration/target',
              approvedAt: T0 + 1,
              reviewerId: 'reviewer-1',
            },
            approvalCount: 1,
            approvalReadBackEquals: true,
            reviewSurface: [
              'INTEGRATION_REVIEW_LIMITS', 'approval', 'approvals', 'approve', 'close', 'create', 'review', 'reviews', 'state',
            ],
            surfaceHasNoRebindMember: true,
            refusedNoWait: {
              code: 'conflict',
              field: 'repository_lock_busy',
              detail: { repository: path.resolve(repository), holder: 'manual-holder', holders: 1, maxHolders: 1 },
            },
            expiredWait: {
              code: 'timeout',
              field: 'repository_lock_wait',
              detail: {
                repositoryMatches: true, holder: 'manual-holder', limit: LOCK_WAIT_MS, waitedOutTheLimit: true,
              },
            },
            holderAfterExpiry: ['manual-holder'],
            lockStateAfterExpiry: { acquired: 1, refused: 2, waited: 0, released: 0, held: 1 },
            receipt: { operationId: 'manual-holder', heldMsNonNegative: true },
            repositoryFreeAfterRelease: 0,
            integration: { ok: false, outcome: 'tests_failed', rejectionField: 'integration_tests', lockWaited: false, lockQueuePosition: 0 },
            userFilesUntouched: {
              treeDigestEqual: true, totalBytesEqual: true, perFileEqual: true,
              statusDigestEqual: true, branchUnmoved: true,
            },
          });
          // The repository lock is free again: the following integration acquires it first-through.
        } finally { harness.close(); }
      }

      // ── F8: the typed rejections, the frozen limits and the frozen durable result ──
      {
        const repository = await createRepo('typed', ['integration/target']);
        const harness = await buildHarness('typed');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'typed-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const unknownApproval = captureSync(() => harness.reviews.approval('11111111-1111-4111-8111-111111111111'));
          const unknownReview = captureSync(() => harness.reviews.review('22222222-2222-4222-8222-222222222222'));
          const badHash = await captureDetail(() => harness.reviews.create({
            repository, target: 'main', artifactHash: 'not-a-hash', at: T0 + 2,
          }));
          const neverStored = await captureDetail(() => harness.reviews.create({
            repository, target: 'main', artifactHash: 'a'.repeat(64), at: T0 + 3,
          }));
          const badTarget = await captureDetail(() => harness.reviews.create({
            repository, target: '..', artifactHash: captured.artifactHash, at: T0 + 4,
          }));
          const unknownTargetRaw = await captureDetail(() => harness.reviews.create({
            repository, target: 'no/such-branch', artifactHash: captured.artifactHash, at: T0 + 5,
          }));
          // The refusal carries the real git stderr (integrationReview.js:126-130), whose literal
          // bytes belong to the git version and not to this case — so, exactly as F6 does for its
          // own git stderr, pin the parts the case OWNS (the repository is THIS repository, the
          // target is the one it asked for) and assert the git-owned text by SHAPE, never literal.
          const unknownTarget = {
            code: unknownTargetRaw.code,
            field: unknownTargetRaw.field,
            detail: {
              repositoryMatches: unknownTargetRaw.detail?.repository === repository,
              target: unknownTargetRaw.detail?.target ?? null,
              stderrNamesMissingRevision: /needed a single revision/i.test(String(unknownTargetRaw.detail?.stderr)),
            },
          };
          const incomplete = await captureDetail(() => harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: [{ criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] }],
          }));
          const unknownTestCriterion = await captureDetail(() => harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: [
              { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'] },
              { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
              { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
              { criterionId: 'not-a-criterion', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            ],
          }));
          const badTestInput = await captureDetail(() => harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: [
              { criterionId: 'applies-cleanly', command: process.execPath, args: ['-e', 'process.exit(0)'], input: 'not-a-buffer' },
              { criterionId: 'tests-pass', command: process.execPath, args: ['-e', 'process.exit(0)'] },
              { criterionId: 'fast-forward-only', command: process.execPath, args: ['-e', 'process.exit(0)'] },
            ],
          }));
          const lockBadWait = await captureDetail(() => harness.locks.acquire({
            repository, operationId: 'bad-wait', at: T0 + 6, waitMs: -1,
          }));
          const lockBadOperation = await captureDetail(() => harness.locks.acquire({
            repository, operationId: '', at: T0 + 7, waitMs: 0,
          }));
          const lockStaleGrant = captureSync(() => harness.locks.release({
            grant: { lockId: 'forged', repository, operationId: 'nobody' }, at: T0 + 8,
          }));
          const dirtyRepository = await createRepo('typed-dirty');
          const dirtyCaptured = await captureArtifact(harness, dirtyRepository, 'typed-dirty-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const dirtyReview = await harness.reviews.create({
            repository: dirtyRepository, target: 'main', artifactHash: dirtyCaptured.artifactHash, at: T0 + 9,
          });
          const dirtyApproval = harness.reviews.approve({ reviewId: dirtyReview.reviewId, at: T0 + 10, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          await writeFileMode(path.join(dirtyRepository, 'dirty.txt'), 'dirty\n', 0o644);
          const dirtyResult = await harness.integration.integrate({
            approvalId: dirtyApproval.approvalId, criteria: CRITERIA, tests: failingTests(),
          });
          started.operations += 1;
          const lockState = harness.locks.state();
          const integrationSurface = Object.keys(harness.integration).sort();
          check('every malformed caller input and every boundary is a TYPED refusal with an explicit code and field, never a bare throw, and every frozen budget is ONE shared object: an unknown approval id and an unknown review id are invalid_request/integration_approval_unknown and integration_review_unknown; a malformed artifact hash is integration_artifact_hash and a well-formed hash that was never stored is integration_artifact_missing; a `..` target is integration_target and a well-formed target with no such branch is conflict/integration_review_target; a test plan that does not cover every required criterion is invalid_request/integration_criteria naming the missing ids, a test naming an unknown criterion carries that criterionId, and a non-Buffer input blob is invalid_request/integration_test_input_blob; a negative lock wait is repository_lock_wait, an empty operation id is repository_lock_operation, and a forged grant is conflict/repository_lock_not_held — while the operational dirty-target refusal still carries a frozen ERROR_CODES member with an integration_-prefixed field. The three services expose exactly their declared surfaces with NO push, remote, refspec, reset, stash, force or stdin member anywhere, every frozen limit object is frozen and identical to the module-level export the services hand back, and the durable result of a refused integration is frozen with a frozen tests array and a frozen fast-forward view that reads back byte-identically', {
            unknownApproval,
            unknownReview,
            badHash,
            neverStored,
            badTarget,
            unknownTarget,
            incomplete,
            unknownTestCriterion,
            badTestInput,
            lockBadWait,
            lockBadOperation,
            lockStaleGrant,
            dirtyOperational: {
              code: dirtyResult.rejection.code,
              inFrozenTable: ERROR_CODES.includes(dirtyResult.rejection.code),
              fieldShape: /^integration_[a-z_]+$/.test(dirtyResult.rejection.field),
            },
            surfaces: {
              integration: integrationSurface,
              review: Object.keys(harness.reviews).sort(),
              locks: Object.keys(harness.locks).sort(),
              integrationHasNoMutationMember: !integrationSurface.some((member) => /push|remote|refspec|reset|stash|force|stdin|write/i.test(member)),
            },
            frozenLimits: {
              review: { ...INTEGRATION_REVIEW_LIMITS },
              reviewFrozen: Object.isFrozen(INTEGRATION_REVIEW_LIMITS),
              lock: { ...REPOSITORY_LOCK_LIMITS },
              lockFrozen: Object.isFrozen(REPOSITORY_LOCK_LIMITS),
              integration: { ...INTEGRATION_LIMITS },
              integrationFrozen: Object.isFrozen(INTEGRATION_LIMITS),
              artifact: { ...ARTIFACT_LIMITS },
              artifactFrozen: Object.isFrozen(ARTIFACT_LIMITS),
              sharedObjects: [
                harness.reviews.INTEGRATION_REVIEW_LIMITS === INTEGRATION_REVIEW_LIMITS,
                harness.locks.REPOSITORY_LOCK_LIMITS === REPOSITORY_LOCK_LIMITS,
                harness.integration.INTEGRATION_LIMITS === INTEGRATION_LIMITS,
              ],
            },
            frozenResult: {
              resultFrozen: Object.isFrozen(dirtyResult),
              testsFrozen: Object.isFrozen(dirtyResult.tests),
              fastForwardFrozen: Object.isFrozen(dirtyResult.fastForward),
              lockFrozen: Object.isFrozen(dirtyResult.lock),
              worktreeFrozen: Object.isFrozen(dirtyResult.worktree),
              readBackEquals: JSON.stringify(harness.integration.operation(dirtyResult.operationId)) === JSON.stringify(dirtyResult),
            },
            counters: {
              integration: harness.integration.state(),
              review: harness.reviews.state(),
              // The product acquires the repository lock at step 2 and only re-observes the target at
              // step 3 (integrationService.js:560-564), so the one dirty-target integration above
              // really does take the lock and really does release it — `acquired: 0` was written
              // against the opposite order and could never have held. An order entry's timestamps
              // and hold duration are wall-clock, so they are asserted by identity against the
              // operation the case itself drove and by shape, never by literal.
              lock: {
                acquired: lockState.acquired,
                refused: lockState.refused,
                waited: lockState.waited,
                released: lockState.released,
                held: lockState.held,
                maxObservedHoldMsNonNegative: lockState.maxObservedHoldMs >= 0,
                order: lockState.order.map((entry) => ({
                  sequence: entry.sequence,
                  operationIdMatchesDirtyOperation: entry.operationId === dirtyResult.operationId,
                  waited: entry.waited,
                  waitedMs: entry.waitedMs,
                  holdMsNonNegative: entry.releasedAt - entry.acquiredAt >= 0,
                })),
                closed: lockState.closed,
              },
              artifacts: harness.artifacts.state(),
              store: harness.store.state(),
            },
          }, {
            unknownApproval: { code: 'invalid_request', field: 'integration_approval_unknown' },
            unknownReview: { code: 'invalid_request', field: 'integration_review_unknown' },
            badHash: { code: 'invalid_request', field: 'integration_artifact_hash', detail: null },
            neverStored: { code: 'invalid_request', field: 'integration_artifact_missing', detail: { artifactHash: 'a'.repeat(64) } },
            badTarget: { code: 'invalid_request', field: 'integration_target', detail: null },
            unknownTarget: { code: 'conflict', field: 'integration_review_target', detail: { repositoryMatches: true, target: 'no/such-branch', stderrNamesMissingRevision: true } },
            incomplete: { code: 'invalid_request', field: 'integration_criteria', detail: { missing: ['applies-cleanly', 'fast-forward-only'] } },
            unknownTestCriterion: { code: 'invalid_request', field: 'integration_tests', detail: { criterionId: 'not-a-criterion' } },
            badTestInput: { code: 'invalid_request', field: 'integration_test_input_blob', detail: null },
            lockBadWait: { code: 'invalid_request', field: 'repository_lock_wait', detail: null },
            lockBadOperation: { code: 'invalid_request', field: 'repository_lock_operation', detail: null },
            lockStaleGrant: { code: 'conflict', field: 'repository_lock_not_held' },
            dirtyOperational: { code: 'conflict', inFrozenTable: true, fieldShape: true },
            surfaces: {
              integration: ['INTEGRATION_LIMITS', 'close', 'integrate', 'operation', 'operations', 'state'],
              review: ['INTEGRATION_REVIEW_LIMITS', 'approval', 'approvals', 'approve', 'close', 'create', 'review', 'reviews', 'state'],
              locks: ['REPOSITORY_LOCK_LIMITS', 'acquire', 'close', 'grants', 'held', 'release', 'state'],
              integrationHasNoMutationMember: true,
            },
            frozenLimits: {
              review: { maxReviews: 256, maxApprovals: 256, maxRepositoryChars: 1024, maxTargetChars: 256, maxReviewerChars: 128 },
              reviewFrozen: true,
              lock: { maxLocks: 64, maxWaiters: 32, maxWaitMs: 60000, maxKeyChars: 1024, maxOperationIdChars: 128, maxHolders: 1 },
              lockFrozen: true,
              integration: {
                maxOperations: 256, maxRepositoryChars: 1024, maxWorktreeNameChars: 128, maxIntegrationRootChars: 1024,
                maxCommitMessageChars: 512, maxTestSpecs: 32, maxCommandChars: 1024, maxCommandArgs: 128,
                maxTestOutputBytes: 2097152, maxTestTimeoutMs: 120000, defaultTestTimeoutMs: 30000, maxTargetChars: 256,
              },
              integrationFrozen: true,
              artifact: { maxArtifactBytes: 33554432, chunkBytes: 65536, maxPathEntries: 4096, maxPathChars: 1024 },
              artifactFrozen: true,
              sharedObjects: [true, true, true],
            },
            frozenResult: {
              resultFrozen: true, testsFrozen: true, fastForwardFrozen: true, lockFrozen: true,
              worktreeFrozen: true, readBackEquals: true,
            },
            counters: {
              integration: { operations: 1, integrated: 0, refused: 1, closed: false },
              review: { created: 2, approved: 2, closed: false },
              lock: { acquired: 1, refused: 0, waited: 0, released: 1, held: 0, maxObservedHoldMsNonNegative: true, order: [{ sequence: 1, operationIdMatchesDirtyOperation: true, waited: false, waitedMs: 0, holdMsNonNegative: true }], closed: false },
              artifacts: { captures: 2, applies: 0, emptyRefusals: 0, closed: false },
              store: { writes: 2, oversizeRejections: 0, immutableRefusals: 0, closed: false },
            },
          });
        } finally { harness.close(); }
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: a review that binds hash/base/target, TWO integrations serialized against one
      // target, a binary/untracked artifact applied into the operation's own temporary worktree,
      // the frozen criteria's tests run for real, a controlled fast-forward, and the user's
      // original directory never committed to and never pushed.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── H1: the review BINDS the artifact hash, the base and the target ──
      {
        const repository = await createRepo('binding', ['integration/target']);
        const harness = await buildHarness('binding');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'binding-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const observedHead = headOf(repository);
          const observedTargetHead = branchOf(repository, 'main');
          const review = await harness.reviews.create({
            repository, target: 'integration/target', artifactHash: captured.artifactHash, at: T0,
          });
          started.reviews += 1;
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const neverStored = await captureDetail(() => harness.reviews.create({
            repository, target: 'main', artifactHash: 'a'.repeat(64), at: T0 + 2,
          }));
          const malformedHash = await captureDetail(() => harness.reviews.create({
            repository, target: 'main', artifactHash: 'not-a-hash', at: T0 + 3,
          }));
          const duplicate = await captureDetail(() => harness.reviews.approve({
            reviewId: review.reviewId, at: T0 + 4, reviewerId: 'reviewer-2',
          }));
          const reread = harness.reviews.review(review.reviewId);
          check('a review BINDS the artifact hash, the base and the target, all three OBSERVED from the repository itself rather than claimed by a caller: the base the review records is the HEAD the product read with real git in the named repository, the target head it records is the same commit read from refs/heads/main, the cleanliness it records is the real porcelain status (clean true, no dirty paths), the artifact hash is the one the writer really produced and that the store really holds — and the approval freezes exactly that four-part binding, frozen, so even a caller holding the approval cannot rewrite it. A review for a hash that was never stored is refused invalid_request/integration_artifact_missing at creation, a malformed hash is invalid_request/integration_artifact_hash, a second approval for the same review is conflict/integration_review_approved, and re-reading the review shows it approved with the SAME hash, base and target — so there is exactly one binding and no function accepts a new one, which is what makes "any change forces a re-review" structural rather than conditional', {
            review: {
              repository: review.repository,
              repositoryIsResolved: review.repository === path.resolve(repository),
              target: review.target,
              artifactHash: review.artifactHash,
              base: review.base,
              baseEqualsObservedHead: review.base === observedHead,
              baseEqualsObservedTargetHead: review.base === observedTargetHead,
              baseShape: COMMIT.test(review.base),
              state: review.state,
              headAtReview: review.headAtReview,
              targetHeadAtReview: review.targetHeadAtReview,
              targetCleanAtReview: review.targetCleanAtReview,
              dirtyPathsAtReview: review.dirtyPathsAtReview,
              createdAt: review.createdAt,
              approvedAt: review.approvedAt,
              reviewerId: review.reviewerId,
              frozen: Object.isFrozen(review),
            },
            approval: {
              approvalId: approval.approvalId,
              reviewId: approval.reviewId,
              reviewerId: approval.reviewerId,
              approvedAt: approval.approvedAt,
              binding: approval.binding,
              bindingFrozen: Object.isFrozen(approval.binding),
              approvalFrozen: Object.isFrozen(approval),
              bindingIsExactlyTheReviewedFour: JSON.stringify(approval.binding) === JSON.stringify({
                artifactHash: review.artifactHash, base: review.base, target: review.target, repository: review.repository,
              }),
            },
            storeHoldsApprovedHash: await harness.store.has(captured.artifactHash),
            neverStored,
            malformedHash,
            duplicate,
            reread: {
              state: reread.state,
              artifactHash: reread.artifactHash,
              base: reread.base,
              target: reread.target,
              approvedAt: reread.approvedAt,
            },
            // The creation snapshot is a FROZEN view taken at `at`, so it can never retroactively
            // gain the approval: it stays pending with a null approvedAt and a null reviewerId
            // forever, and the approval is observed ONLY through the fresh re-read and through the
            // approval object itself. This is the product's own documented contract (the review
            // type is `readonly state: 'pending' | 'approved'; readonly approvedAt: number | null`,
            // and create() returns Object.freeze(reviewView(record))) and it is asserted here
            // explicitly rather than assumed — the receiver-contract lesson once more: the value
            // handed to a deepEqual must be checked against the RECEIVER's contract, and here the
            // receiver is the product's own immutable-snapshot guarantee.
            snapshotNeverGainsApproval: {
              snapshotState: review.state,
              snapshotApprovedAt: review.approvedAt,
              snapshotReviewerId: review.reviewerId,
              snapshotFrozen: Object.isFrozen(review),
              rereadState: reread.state,
              rereadApprovedAt: reread.approvedAt,
              rereadReviewerId: reread.reviewerId,
              rereadFrozen: Object.isFrozen(reread),
              approvalCarriesSameApprovedAt: approval.approvedAt === reread.approvedAt,
              approvalCarriesSameReviewerId: approval.reviewerId === reread.reviewerId,
            },
            approvalCount: harness.reviews.approvals().length,
            reviewCount: harness.reviews.reviews().length,
            limits: { ...INTEGRATION_REVIEW_LIMITS },
            limitsFrozen: Object.isFrozen(INTEGRATION_REVIEW_LIMITS),
            sharedLimitObject: harness.reviews.INTEGRATION_REVIEW_LIMITS === INTEGRATION_REVIEW_LIMITS,
          }, {
            review: {
              repository: repository,
              repositoryIsResolved: true,
              target: 'integration/target',
              artifactHash: captured.artifactHash,
              base: observedHead,
              baseEqualsObservedHead: true,
              baseEqualsObservedTargetHead: true,
              baseShape: true,
              state: 'pending',
              headAtReview: observedHead,
              targetHeadAtReview: observedTargetHead,
              targetCleanAtReview: true,
              dirtyPathsAtReview: [],
              createdAt: T0,
              // The creation snapshot is taken at `at` and frozen: still pending, never approved.
              approvedAt: null,
              reviewerId: null,
              frozen: true,
            },
            approval: {
              approvalId: approvalIdFor(1),
              reviewId: reviewIdFor(1),
              reviewerId: 'reviewer-1',
              approvedAt: T0 + 1,
              binding: { artifactHash: captured.artifactHash, base: observedHead, target: 'integration/target', repository },
              bindingFrozen: true,
              approvalFrozen: true,
              bindingIsExactlyTheReviewedFour: true,
            },
            storeHoldsApprovedHash: true,
            neverStored: { code: 'invalid_request', field: 'integration_artifact_missing', detail: { artifactHash: 'a'.repeat(64) } },
            malformedHash: { code: 'invalid_request', field: 'integration_artifact_hash', detail: null },
            duplicate: {
              code: 'conflict',
              field: 'integration_review_approved',
              detail: { reviewId: review.reviewId, approvedAt: T0 + 1, reviewerId: 'reviewer-1' },
            },
            reread: { state: 'approved', artifactHash: captured.artifactHash, base: observedHead, target: 'integration/target', approvedAt: T0 + 1 },
            snapshotNeverGainsApproval: {
              snapshotState: 'pending',
              snapshotApprovedAt: null,
              snapshotReviewerId: null,
              snapshotFrozen: true,
              rereadState: 'approved',
              rereadApprovedAt: T0 + 1,
              rereadReviewerId: 'reviewer-1',
              rereadFrozen: true,
              approvalCarriesSameApprovedAt: true,
              approvalCarriesSameReviewerId: true,
            },
            approvalCount: 1,
            reviewCount: 1,
            limits: { maxReviews: 256, maxApprovals: 256, maxRepositoryChars: 1024, maxTargetChars: 256, maxReviewerChars: 128 },
            limitsFrozen: true,
            sharedLimitObject: true,
          });
        } finally { harness.close(); }
      }

      // ── H2: TWO integrations against one target are SERIALIZED ──
      {
        const repository = await createRepo('serialized', ['integration/first', 'integration/second']);
        const harness = await buildHarness('serialized');
        resetIds();
        try {
          const logRoot = await scratch('log-root', 'serialized-log');
          const logPath = path.join(logRoot, 'order.log');
          await writeLog(logPath, '');
          const first = await captureArtifact(harness, repository, 'serialized-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
          });
          const second = await captureArtifact(harness, repository, 'serialized-b', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'b.txt'), 'b\n', 0o644);
          });
          const firstReview = await harness.reviews.create({
            repository, target: 'integration/first', artifactHash: first.artifactHash, at: T0,
          });
          const secondReview = await harness.reviews.create({
            repository, target: 'integration/second', artifactHash: second.artifactHash, at: T0,
          });
          started.reviews += 2;
          const firstApproval = harness.reviews.approve({ reviewId: firstReview.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          const secondApproval = harness.reviews.approve({ reviewId: secondReview.reviewId, at: T0 + 2, reviewerId: 'reviewer-1' });
          started.approvals += 2;
          const base = firstReview.base;
          const baseEqualsHead = base === headOf(repository);
          // Drive the ordering rather than leaving it to a race: start the first integration and
          // wait until it OBSERVABLY holds the repository lock, then start the second.
          const firstPromise = harness.integration.integrate({
            approvalId: firstApproval.approvalId,
            criteria: CRITERIA,
            tests: passingTests(logPath, 'first', SERIALIZED_HOLD_MS),
            commitMessage: 'integrate first',
          });
          const holder = await untilHeld(harness, repository, operationIdFor(1));
          const secondPromise = harness.integration.integrate({
            approvalId: secondApproval.approvalId,
            criteria: CRITERIA,
            tests: passingTests(logPath, 'second', 0),
            commitMessage: 'integrate second',
          });
          const [firstResult, secondResult] = await Promise.all([firstPromise, secondPromise]);
          started.operations += 2;
          const orderLog = await readLog(logPath);
          const lockState = harness.locks.state();
          check('two integrations against ONE target repository are SERIALIZED, observed rather than claimed: the first integration takes the repository lock first-through (waited false, queuePosition 0) and is OBSERVED holding it by the lock service own read model before the second integration is even started, the second grant then reports waited TRUE with a real non-zero waitedMs and queuePosition 1, the shared enter/exit log the two frozen-criteria test processes append to is exactly first:enter, first:exit, second:enter, second:exit — so the second test never ran inside the first critical section — the first grant was held for at least the case own hold duration, the lock service own timeline lists the two grants in that order with the second acquiredAt not before the first releasedAt and both released, both integrations are real successes that each fast-forwarded their OWN branch to a descendant of the same base, and the repository HEAD never moved because both targets were branches the user checkout is not on', {
            first: {
              operationId: firstResult.operationId,
              operationIdIsDerived: firstResult.operationId === operationIdFor(1),
              ok: firstResult.ok,
              outcome: firstResult.outcome,
              lockWaited: firstResult.lock.waited,
              lockWaitedMs: firstResult.lock.waitedMs,
              lockQueuePosition: firstResult.lock.queuePosition,
              lockHeldMsAtLeastHold: firstResult.lock.heldMs >= SERIALIZED_HOLD_MS,
              lockHeldMs: firstResult.lock.heldMs,
              completedAfterStarted: firstResult.completedAt > firstResult.startedAt,
              fastForwardApplied: firstResult.fastForward.applied,
              fastForwardIsFF: firstResult.fastForward.isFastForward,
              fastForwardFromEqualsBase: firstResult.fastForward.from === base,
              branchMovedToCommit: branchOf(repository, 'integration/first') === firstResult.fastForward.to,
            },
            second: {
              operationId: secondResult.operationId,
              operationIdIsDerived: secondResult.operationId === operationIdFor(2),
              ok: secondResult.ok,
              outcome: secondResult.outcome,
              lockWaited: secondResult.lock.waited,
              lockWaitedMsGreaterThanZero: secondResult.lock.waitedMs > 0,
              lockWaitedMs: secondResult.lock.waitedMs,
              lockQueuePosition: secondResult.lock.queuePosition,
              lockWaitedMsWithinHold: secondResult.lock.waitedMs <= firstResult.lock.heldMs + SERIALIZED_HOLD_MS,
              startedBeforeFirstCompleted: secondResult.startedAt <= firstResult.completedAt,
              completedAfterStarted: secondResult.completedAt > secondResult.startedAt,
              fastForwardApplied: secondResult.fastForward.applied,
              fastForwardIsFF: secondResult.fastForward.isFastForward,
              fastForwardFromEqualsBase: secondResult.fastForward.from === base,
              branchMovedToCommit: branchOf(repository, 'integration/second') === secondResult.fastForward.to,
            },
            observedHolderBeforeSecond: { operationId: holder.operationId, waited: holder.waited },
            sharedOrderLog: orderLog,
            orderLogIsStrictlySerial: orderLog === `first:enter\nfirst:exit\nsecond:enter\nsecond:exit\n`,
            lockTimeline: {
              acquired: lockState.acquired,
              waited: lockState.waited,
              released: lockState.released,
              held: lockState.held,
              orderOperationIds: lockState.order.map((entry) => entry.operationId),
              orderSequences: lockState.order.map((entry) => entry.sequence),
              orderWaitedFlags: lockState.order.map((entry) => entry.waited),
              secondAcquiredNotBeforeFirstReleased: lockState.order[1].acquiredAt >= lockState.order[0].releasedAt,
              bothReleased: lockState.order.every((entry) => entry.releasedAt !== null),
              maxObservedHoldMsAtLeastHold: lockState.maxObservedHoldMs >= SERIALIZED_HOLD_MS,
            },
            bothSucceeded: { first: firstResult.ok, second: secondResult.ok, outcomes: [firstResult.outcome, secondResult.outcome] },
            baseShared: firstResult.base === secondResult.base,
            baseEqualsRepositoryHead: baseEqualsHead,
            headNeverMoved: headOf(repository) === base,
            descendants: [
              runGit(repository, ['merge-base', '--is-ancestor', firstResult.fastForward.from, firstResult.fastForward.to]) === '',
              runGit(repository, ['merge-base', '--is-ancestor', secondResult.fastForward.from, secondResult.fastForward.to]) === '',
            ],
          }, {
            first: {
              operationId: operationIdFor(1),
              operationIdIsDerived: true,
              ok: true,
              outcome: 'integrated',
              lockWaited: false,
              lockWaitedMs: 0,
              lockQueuePosition: 0,
              lockHeldMsAtLeastHold: true,
              lockHeldMs: firstResult.lock.heldMs,
              completedAfterStarted: true,
              fastForwardApplied: true,
              fastForwardIsFF: true,
              fastForwardFromEqualsBase: true,
              branchMovedToCommit: true,
            },
            second: {
              operationId: operationIdFor(2),
              operationIdIsDerived: true,
              ok: true,
              outcome: 'integrated',
              lockWaited: true,
              lockWaitedMsGreaterThanZero: true,
              lockWaitedMs: secondResult.lock.waitedMs,
              lockQueuePosition: 1,
              lockWaitedMsWithinHold: true,
              startedBeforeFirstCompleted: true,
              completedAfterStarted: true,
              fastForwardApplied: true,
              fastForwardIsFF: true,
              fastForwardFromEqualsBase: true,
              branchMovedToCommit: true,
            },
            observedHolderBeforeSecond: { operationId: operationIdFor(1), waited: false },
            sharedOrderLog: 'first:enter\nfirst:exit\nsecond:enter\nsecond:exit\n',
            orderLogIsStrictlySerial: true,
            lockTimeline: {
              acquired: 2,
              waited: 1,
              released: 2,
              held: 0,
              orderOperationIds: [operationIdFor(1), operationIdFor(2)],
              orderSequences: [1, 2],
              orderWaitedFlags: [false, true],
              secondAcquiredNotBeforeFirstReleased: true,
              bothReleased: true,
              maxObservedHoldMsAtLeastHold: true,
            },
            bothSucceeded: { first: true, second: true, outcomes: ['integrated', 'integrated'] },
            baseShared: true,
            baseEqualsRepositoryHead: true,
            headNeverMoved: true,
            descendants: [true, true],
          });
        } finally { harness.close(); }
      }
      // ── H3: a reviewed binary/untracked artifact → temp apply → frozen criteria → fast-forward ──
      {
        const repository = await createRepo('happy-integrate', ['integration/approved']);
        const built = await buildHarness('happy-integrate');
        resetIds();
        try {
          const captured = await captureArtifact(built, repository, 'happy-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'keep.txt'), 'kept and changed\nsecond line\n', 0o644);
            await writeFileMode(path.join(cwd, 'bin.bin'), Buffer.from([0xde, 0xad, 0xbe, 0xef, 0x00, 0x10]), 0o644);
            await chmod(path.join(cwd, 'script.sh'), 0o755);
            await rm(path.join(cwd, 'gone.txt'));
            await rm(path.join(cwd, 'link'));
            await symlink('src/keep.txt', path.join(cwd, 'link'));
            await writeFileMode(path.join(cwd, 'blob.dat'), EVERY_BYTE_BLOB, 0o644);
            await writeFileMode(path.join(cwd, 'notes.md'), '# notes\n', 0o644);
          });
          const review = await built.reviews.create({
            repository, target: 'integration/approved', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = built.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const result = await built.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: inputFileTests(),
            commitMessage: 'vis: integrate reviewed artifact',
          });
          started.operations += 1;
          started.applies += 1;
          const landedTree = runGit(repository, ['ls-tree', '-r', '--name-only', result.fastForward.to])
            .split('\n').map((line) => line.trim()).filter((line) => line.length > 0).sort();
          const landedModes = runGit(repository, ['ls-tree', '-r', result.fastForward.to])
            .split('\n').map((line) => line.trim()).filter((line) => line.length > 0)
            .map((line) => { const [meta, name] = line.split('\t'); return { name, mode: meta.split(' ')[0] }; })
            .sort((left, right) => (left.name < right.name ? -1 : 1));
          const blobSha = createHash('sha256')
            .update(runGit(repository, ['cat-file', 'blob', `${result.fastForward.to}:blob.dat`], { encoding: 'buffer' }))
            .digest('hex');
          const keepSha = createHash('sha256')
            .update(runGit(repository, ['cat-file', 'blob', `${result.fastForward.to}:src/keep.txt`], { encoding: 'buffer' }))
            .digest('hex');
          const notesSha = createHash('sha256')
            .update(runGit(repository, ['cat-file', 'blob', `${result.fastForward.to}:notes.md`], { encoding: 'buffer' }))
            .digest('hex');
          const commitParent = runGit(repository, ['rev-parse', '--verify', `${result.commit.sha}^`]).trim();
          const withInput = result.tests.find((entry) => entry.criterionId === 'applies-cleanly');
          const worktrees = worktreeList(repository);
          check('a reviewed binary / untracked artifact is applied into the operation own temporary clean integration worktree, its frozen criteria tests really run there, and the target branch is fast-forwarded cleanly, with the DURABLE RESULT recording the artifact and the test evidence: the approved hash is re-hashed out of the durable object and MATCHES (observedArtifactHash equals the approved hash, artifact.verified true, the observed byte and chunk counts equal the captured ones), the tracked text edit, the tracked binary edit, the tracked mode-only change to 0o755, the tracked symlink retarget, the tracked deletion, the untracked 512-byte binary holding every byte value and the untracked text file all LAND in the fast-forwarded commit — read back out of the target branch with real `git ls-tree` / `git cat-file` — the commit is a DESCENDANT of the reviewed base with the base as its parent and was created in the operation own worktree and nowhere else, every frozen criterion really ran with exit code 0 and its input blob reached the test as a TEMP FILE inside the operation own root named in VIS_INTEGRATION_INPUT (the workspaceCommand stdin limitation honoured by the runner TYPE, not by a rule), the durable result reads back byte-identically through operation() and is counted in the service own counters, and the operation own temp root is gone with `git worktree list` no longer naming it', {
            artifact: {
              approvedHash: captured.artifactHash,
              observedArtifactHash: result.observedArtifactHash,
              observedEqualsApproved: result.observedArtifactHash === captured.artifactHash,
              verified: result.artifact.verified,
              preserved: result.artifact.preserved,
              bytes: result.artifactBytes,
              bytesEqualCaptured: result.artifactBytes === captured.bytes,
              chunks: result.artifactChunks,
              chunksEqualCaptured: result.artifactChunks === captured.chunks,
              peakBufferedBytes: result.artifactPeakBufferedBytes,
              peakWithinCeiling: result.artifactPeakBufferedBytes <= ARTIFACT_LIMITS.maxArtifactBytes,
              capturedEntryCount: captured.entryCount,
              capturedPaths: captured.paths,
            },
            landedInTargetBranch: {
              ref: result.fastForward.ref,
              applied: result.fastForward.applied,
              isFastForward: result.fastForward.isFastForward,
              from: result.fastForward.from,
              fromEqualsBase: result.fastForward.from === review.base,
              to: result.fastForward.to,
              branchTipEqualsCommit: branchOf(repository, 'integration/approved') === result.fastForward.to,
              tree: landedTree,
              modes: landedModes,
              blobSha,
              blobShaIsDigestOfWriterBytes: blobSha === createHash('sha256').update(EVERY_BYTE_BLOB).digest('hex'),
              keepSha,
              keepShaIsDigestOfWriterBytes: keepSha === createHash('sha256').update('kept and changed\nsecond line\n').digest('hex'),
              notesSha,
              notesShaIsDigestOfWriterBytes: notesSha === createHash('sha256').update('# notes\n').digest('hex'),
              isAncestor: runGit(repository, ['merge-base', '--is-ancestor', result.fastForward.from, result.fastForward.to]) === '',
              commitParentEqualsBase: commitParent === review.base,
              commitCreatedInOperationWorktree: result.commit.worktree === result.worktree.path,
            },
            frozenCriteriaReallyRan: {
              criteria: CRITERIA.map((entry) => entry.id),
              testCount: result.tests.length,
              records: result.tests.map((entry) => ({
                criterionId: entry.criterionId,
                exitCode: entry.exitCode,
                durationNonNegative: entry.durationMs >= 0,
                stdoutBytes: entry.stdoutBytes,
                stderrBytes: entry.stderrBytes,
                outputLimitBytes: entry.outputLimitBytes,
              })),
              inputFileRecorded: withInput?.inputFile ?? null,
              inputFileInsideOperationRoot: typeof withInput?.inputFile === 'string'
                && withInput.inputFile.startsWith(`${path.dirname(result.worktree.path)}${path.sep}`),
              inputFileNamesOperation: typeof withInput?.inputFile === 'string' && withInput.inputFile.includes(result.operationId),
              inputFileAbsentAfterCleanup: typeof withInput?.inputFile === 'string' ? !(await exists(withInput.inputFile)) : null,
            },
            durableResult: {
              operationId: result.operationId,
              operationIdIsDerived: result.operationId === operationIdFor(1),
              ok: result.ok,
              outcome: result.outcome,
              reviewId: result.reviewId,
              approvalId: result.approvalId,
              repository: result.repository,
              target: result.target,
              base: result.base,
              startedAtPositive: result.startedAt > 0,
              completedNotBeforeStarted: result.completedAt >= result.startedAt,
              readBackEquals: JSON.stringify(built.integration.operation(result.operationId)) === JSON.stringify(result),
              operationsCount: built.integration.operations().length,
              serviceState: built.integration.state(),
              targetAfterClean: result.targetAfter.clean,
              targetAfterHeadIsBase: result.targetAfter.head === review.base,
              targetAfterTargetHeadIsCommit: result.targetAfter.targetHead === result.fastForward.to,
            },
            stdinLimitationHonoured: {
              serviceSurface: Object.keys(built.integration).sort(),
              surfaceHasNoStdinMember: !Object.keys(built.integration).some((member) => /stdin|write|input$/i.test(member)),
              maxTestOutputBytes: INTEGRATION_LIMITS.maxTestOutputBytes,
              maxTestOutputBytesIsTwoMiB: INTEGRATION_LIMITS.maxTestOutputBytes === 2 * 1024 * 1024,
              inputBlobReachedTestAsFile: withInput?.exitCode === 0,
            },
            // `exists` answers "is it there", so an "…Absent" key must NEGATE it. Every such key in
            // this case was originally written as `await exists(…)` with an expected `true`, which
            // literally required the temp to be PRESENT while claiming to prove it was gone — the
            // assertion proved the opposite of what it said. The polarity is fixed here and at
            // every sibling site, so the expected `true` now really means "gone from disk".
            tempCleaned: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              operationRootAbsent: !(await exists(path.dirname(result.worktree.path))),
              worktreeListOmitsPath: !worktrees.includes(result.worktree.path),
            },
          }, {
            artifact: {
              approvedHash: captured.artifactHash,
              observedArtifactHash: captured.artifactHash,
              observedEqualsApproved: true,
              verified: true,
              preserved: true,
              bytes: captured.bytes,
              bytesEqualCaptured: true,
              chunks: captured.chunks,
              chunksEqualCaptured: true,
              peakBufferedBytes: result.artifactPeakBufferedBytes,
              peakWithinCeiling: true,
              capturedEntryCount: captured.entryCount,
              capturedPaths: captured.paths,
            },
            landedInTargetBranch: {
              ref: 'refs/heads/integration/approved',
              applied: true,
              isFastForward: true,
              from: review.base,
              fromEqualsBase: true,
              to: result.fastForward.to,
              branchTipEqualsCommit: true,
              tree: ['README.md', 'bin.bin', 'blob.dat', 'link', 'notes.md', 'script.sh', 'src/keep.txt'],
              modes: [
                { name: 'README.md', mode: '100644' },
                { name: 'bin.bin', mode: '100644' },
                { name: 'blob.dat', mode: '100644' },
                { name: 'link', mode: '120000' },
                { name: 'notes.md', mode: '100644' },
                { name: 'script.sh', mode: '100755' },
                { name: 'src/keep.txt', mode: '100644' },
              ],
              blobSha: createHash('sha256').update(EVERY_BYTE_BLOB).digest('hex'),
              blobShaIsDigestOfWriterBytes: true,
              keepSha: createHash('sha256').update('kept and changed\nsecond line\n').digest('hex'),
              keepShaIsDigestOfWriterBytes: true,
              notesSha: createHash('sha256').update('# notes\n').digest('hex'),
              notesShaIsDigestOfWriterBytes: true,
              isAncestor: true,
              commitParentEqualsBase: true,
              commitCreatedInOperationWorktree: true,
            },
            frozenCriteriaReallyRan: {
              criteria: ['applies-cleanly', 'tests-pass', 'fast-forward-only'],
              testCount: 3,
              records: [
                { criterionId: 'applies-cleanly', exitCode: 0, durationNonNegative: true, stdoutBytes: 0, stderrBytes: 0, outputLimitBytes: 2097152 },
                { criterionId: 'tests-pass', exitCode: 0, durationNonNegative: true, stdoutBytes: 0, stderrBytes: 0, outputLimitBytes: 2097152 },
                { criterionId: 'fast-forward-only', exitCode: 0, durationNonNegative: true, stdoutBytes: 0, stderrBytes: 0, outputLimitBytes: 2097152 },
              ],
              inputFileRecorded: withInput?.inputFile ?? null,
              inputFileInsideOperationRoot: true,
              inputFileNamesOperation: true,
              inputFileAbsentAfterCleanup: true,
            },
            durableResult: {
              operationId: operationIdFor(1),
              operationIdIsDerived: true,
              ok: true,
              outcome: 'integrated',
              reviewId: reviewIdFor(1),
              approvalId: approvalIdFor(1),
              repository: repository,
              target: 'integration/approved',
              base: review.base,
              startedAtPositive: true,
              completedNotBeforeStarted: true,
              readBackEquals: true,
              operationsCount: 1,
              serviceState: { operations: 1, integrated: 1, refused: 0, closed: false },
              targetAfterClean: true,
              targetAfterHeadIsBase: true,
              targetAfterTargetHeadIsCommit: true,
            },
            stdinLimitationHonoured: {
              serviceSurface: ['INTEGRATION_LIMITS', 'close', 'integrate', 'operation', 'operations', 'state'],
              surfaceHasNoStdinMember: true,
              maxTestOutputBytes: 2097152,
              maxTestOutputBytesIsTwoMiB: true,
              inputBlobReachedTestAsFile: true,
            },
            tempCleaned: {
              worktreeCreated: true, worktreeRemoved: true, worktreePathAbsent: true,
              operationRootAbsent: true, worktreeListOmitsPath: true,
            },
          });
        } finally { built.close(); }
      }

      // ── H4: a successful integration never auto-commits or pushes the user's original directory ──
      {
        const repository = await createRepo('no-push', ['integration/approved']);
        const harness = await buildHarness('no-push');
        resetIds();
        try {
          const captured = await captureArtifact(harness, repository, 'nopush-a', async (cwd) => {
            await writeFileMode(path.join(cwd, 'src', 'a.txt'), 'a\n', 0o644);
            await writeFileMode(path.join(cwd, 'added.txt'), 'added\n', 0o644);
            await rm(path.join(cwd, 'gone.txt'));
          });
          const review = await harness.reviews.create({
            repository, target: 'integration/approved', artifactHash: captured.artifactHash, at: T0,
          });
          const approval = harness.reviews.approve({ reviewId: review.reviewId, at: T0 + 1, reviewerId: 'reviewer-1' });
          started.approvals += 1;
          const beforeHead = headOf(repository);
          const beforeRefs = refNames(repository);
          const beforeTree = await observeTree(repository);
          const beforeIndex = indexDigest(repository);
          const beforeStatus = statusDigest(repository);
          const remotesBefore = runGit(repository, ['remote']).trim();
          const result = await harness.integration.integrate({
            approvalId: approval.approvalId,
            criteria: CRITERIA,
            tests: passingTests(path.join(await scratch('log-root', 'no-push-log'), 'order.log'), 'no-push'),
            commitMessage: 'vis: integrate reviewed artifact',
          });
          started.operations += 1;
          const afterTree = await observeTree(repository);
          const worktrees = worktreeList(repository);
          check('a SUCCESSFUL integration never auto-commits or pushes the user original directory: after the controlled fast-forward the user own HEAD is still the reviewed base, the ref-NAME set is unchanged (a moved branch keeps the set; only the one target branch value moved), the working tree digest, the total byte count and every per-file hash are identical, the porcelain status digest and the index digest are byte-identical so nothing was swept into a commit or staged there, `git remote` is still empty and no remote appeared, and `git stash list` is empty — the SINGLE ref mutation is the atomic forward-only `git update-ref` of an EXISTING branch, whose tip now equals the commit, whose parent is the reviewed base, whose ancestor check exits 0, and which was created in the operation own temporary worktree and nowhere else; the operation own temp root is gone, `git worktree list` no longer names it, and the integration service surface exposes no push, remote, refspec, reset, stash or force member at all', {
            ok: result.ok,
            outcome: result.outcome,
            fastForward: {
              ref: result.fastForward.ref,
              applied: result.fastForward.applied,
              isFastForward: result.fastForward.isFastForward,
              from: result.fastForward.from,
              fromEqualsBase: result.fastForward.from === review.base,
              to: result.fastForward.to,
              branchTipEqualsCommit: branchOf(repository, 'integration/approved') === result.fastForward.to,
              isAncestor: runGit(repository, ['merge-base', '--is-ancestor', result.fastForward.from, result.fastForward.to]) === '',
            },
            commit: {
              created: result.commit.created,
              sha: result.commit.sha,
              worktreeIsOperationWorktree: result.commit.worktree === result.worktree.path,
              parentEqualsBase: runGit(repository, ['rev-parse', '--verify', `${result.commit.sha}^`]).trim() === review.base,
              shaShape: COMMIT.test(result.commit.sha ?? ''),
            },
            userDirectoryUntouched: {
              headUnchanged: headOf(repository) === beforeHead,
              refNamesUnchanged: JSON.stringify(refNames(repository)) === JSON.stringify(beforeRefs),
              treeDigestEqual: afterTree.treeDigest === beforeTree.treeDigest,
              totalBytesEqual: afterTree.totalBytes === beforeTree.totalBytes,
              fileCountEqual: afterTree.fileCount === beforeTree.fileCount,
              perFileEqual: JSON.stringify(afterTree.files) === JSON.stringify(beforeTree.files),
              indexDigestEqual: indexDigest(repository) === beforeIndex,
              statusDigestEqual: statusDigest(repository) === beforeStatus,
              stashEmpty: runGit(repository, ['stash', 'list']).trim() === '',
              remotesUnchanged: runGit(repository, ['remote']).trim() === remotesBefore,
              remotesWereEmpty: remotesBefore === '',
            },
            surface: {
              members: Object.keys(harness.integration).sort(),
              hasNoMutationMember: !Object.keys(harness.integration).some((member) => /push|remote|refspec|reset|stash|force/i.test(member)),
            },
            tempCleaned: {
              worktreeCreated: result.worktree.created,
              worktreeRemoved: result.worktree.removed,
              worktreePathAbsent: !(await exists(result.worktree.path)),
              operationRootAbsent: !(await exists(path.dirname(result.worktree.path))),
              worktreeListOmitsPath: !worktrees.includes(result.worktree.path),
            },
          }, {
            ok: true,
            outcome: 'integrated',
            fastForward: {
              ref: 'refs/heads/integration/approved',
              applied: true,
              isFastForward: true,
              from: review.base,
              fromEqualsBase: true,
              to: result.fastForward.to,
              branchTipEqualsCommit: true,
              isAncestor: true,
            },
            commit: {
              created: true,
              sha: result.commit.sha,
              worktreeIsOperationWorktree: true,
              parentEqualsBase: true,
              shaShape: true,
            },
            userDirectoryUntouched: {
              headUnchanged: true,
              refNamesUnchanged: true,
              treeDigestEqual: true,
              totalBytesEqual: true,
              fileCountEqual: true,
              perFileEqual: true,
              indexDigestEqual: true,
              statusDigestEqual: true,
              stashEmpty: true,
              remotesUnchanged: true,
              remotesWereEmpty: true,
            },
            surface: {
              members: ['INTEGRATION_LIMITS', 'close', 'integrate', 'operation', 'operations', 'state'],
              hasNoMutationMember: true,
            },
            tempCleaned: {
              worktreeCreated: true, worktreeRemoved: true, worktreePathAbsent: true,
              operationRootAbsent: true, worktreeListOmitsPath: true,
            },
          });
        } finally { harness.close(); }
      }
    }
    // ── every rejection code the product emitted belongs to the frozen canonical table ──
    const codes = [...observedCodes].sort();
    const browserMembership = await evaluate((list) => window.task41.codeMembership(list), codes);
    protocol.browser.codeMembership = browserMembership;
    record('codeMembership', { codes, browserMembership });
    check('every rejection code the product actually emitted across this case belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the worker collected — no integration, review or lock rejection ever carries a code outside the protocol vocabulary', {
      observedCodes: codes,
      workerAllInTable: codes.every((code) => ERROR_CODES.includes(code)),
      browser: browserMembership,
    }, {
      observedCodes: codes,
      workerAllInTable: true,
      browser: { observedCount: codes.length, missing: [], allObservedCodesInTable: true, distinctObserved: new Set(codes).size },
    });

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task41.errors());
    check('the browser entry logged no error while recomputing the frozen shared contract and the frozen criteria vocabulary and checking the observed rejection codes against the frozen table in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa41-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa41-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task41.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapPeak: peakHeap, heapEnd, heapGrowthBytes });
    // The load-bearing boundedness evidence is the PRODUCT'S OWN counters and read models, exactly
    // as tasks 38 and 40 used their services' own stats: no artifact this case wrote can exceed the
    // frozen 32 MiB ceiling, every operation holds a frozen durable result, and the largest
    // observed artifact is a fraction of one chunk. The heap numbers are recorded as a GC-TIMING
    // ARTEFACT, not a retention proof, and decide nothing (the task-36 lesson).
    check('the case stays bounded in the PRODUCT OWN counters, not in a raw heap delta: every operation, review, approval, lock grant, capture and store write this case drove is counted from the product own frozen read models, the largest artifact the case produced is far below the frozen 32 MiB ceiling so the streaming path is the only large one, every private git world is registered in the resource ledger before creation, the observed git-command count is recorded, and the observed heap numbers are RECORDED as a GC-timing artefact rather than a retention proof', {
      operations: started.operations,
      reviews: started.reviews,
      approvals: started.approvals,
      lockGrants: started.lockGrants,
      captures: started.captures,
      applies: started.applies,
      writes: started.writes,
      largestArtifactBytes: started.largestArtifactBytes,
      largestWithinCeiling: started.largestArtifactBytes <= ARTIFACT_LIMITS.maxArtifactBytes,
      gitCommandsStarted: started.gitCommands,
      ownedResourceCount: fixture.resources.length,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
    }, {
      operations: started.operations,
      reviews: started.reviews,
      approvals: started.approvals,
      lockGrants: started.lockGrants,
      captures: started.captures,
      applies: started.applies,
      writes: started.writes,
      largestArtifactBytes: started.largestArtifactBytes,
      largestWithinCeiling: true,
      gitCommandsStarted: started.gitCommands,
      ownedResourceCount: fixture.resources.length,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: true,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    }, {
      authoredFileCount: 3,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    });

    // ── the evidence binds to the CURRENT bytes of the product ──
    // Independently recomputed here at the end of the run and compared with the values recomputed
    // before any scenario ran; a green report against the wrong bytes is worthless (this exact
    // failure made task 21's first gate return REJECT). The comparison against the artifact's own
    // sourceHashes is mechanical for the independent gate, because every path below is in
    // sourceFiles.
    const productHashesAfter = productHashes(context.root);
    record('sourceBinding', { before: productHashesBefore, after: productHashesAfter });
    check('the evidence binds to the current bytes: the sha256 of all fourteen pinned product files is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product byte moved under the case — the fourteen hashes are recorded for the independent gate to compare against the artifact sourceHashes', {
      pinnedProductFileCount: PRODUCT_FILES.length,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    }, {
      pinnedProductFileCount: 14,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: true,
      allSha256Shaped: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task41Errors ?? [], task41: Boolean(window.task41) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    // A cleanup failure is EVIDENCE, not a footnote: the receipts are persisted here and the
    // failure is re-thrown after this block, so the run fails instead of reporting green evidence
    // over a teardown that did not happen (an owned directory left behind, an owned PID alive).
    try {
      proof.cleanup = await fixture.close();
    } catch (error) {
      proof.cleanup = {
        failed: true,
        message: error?.message ?? String(error),
        errors: Array.isArray(error?.errors) ? error.errors.map((entry) => String(entry)) : [],
      };
      cleanupFailure = error;
    }
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }
  if (cleanupFailure !== null) throw cleanupFailure;

  return {
    scenarios,
    artifacts,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'serialized-post-review-integration', schema: 'runtime-collaboration-artifact-integration/v1' },
    cleanup: proof.cleanup,
    defects: {
      lockServiceIsInProcess: {
        severity: 'acceptance-criterion-gap',
        observed: 'the repository-lock service is in-memory and single-process: two integrations in two SEPARATE processes are not proven to be mutually exclusive here',
        coveredInstead: 'every in-process serialization is proven by observation: the first grant is waited false / queuePosition 0 and is OBSERVED holding the lock before the second starts, the second grant is waited true with a real waitedMs and queuePosition 1, the shared enter/exit log is strictly enter/exit/enter/exit, and the lock service own timeline corroborates it; task 10 worktreeLease.js is the durable cross-process lease and is complementary',
      },
      durabilityAcrossProcessDeathNotClaimed: {
        severity: 'acceptance-criterion-gap',
        observed: 'the durable result is proven to survive the operation ending IN-PROCESS (operation() reads it back byte-identically and the counters survive); a power-loss fsync test is out of scope',
        coveredInstead: 'F1 and F5 prove a corrupted object and a LOST object are each an explicit refusal rather than a fabricated integration, and the artifact object is preserved rather than repaired or deleted',
      },
      fastForwardRaceNotForced: {
        severity: 'acceptance-criterion-gap',
        observed: 'the atomic `git update-ref <ref> <new> <old>` failure path (integration_fast_forward) is not forced, because the repository lock serializes the check and the update inside one service instance and no external ref move can be interleaved',
        coveredInstead: 'the forward-only property is proven by observation instead: merge-base --is-ancestor exits 0 for both fast-forwards, the commit parent is the reviewed base, and the HEAD / ref-name / tree / index / status of the user directory are unchanged; the not-a-descendant refusal is reachable only by an interleaving this single-process service cannot produce',
      },
      testRunnerFailureIsADurableResult: {
        severity: 'observation',
        observed: 'a frozen-criteria test that exceeds testTimeoutMs, fails to spawn or overflows the output limit is recorded as ONE durable refused result (outcome test_runner_failed, the runner own code and field) instead of escaping integrate() as an exception, and the runner STOPS the child on timeout rather than waiting for it to exit',
        assertedAs: 'asserted in app/runtime/artifactIntegration.test.ts R5: the runner stops the child exactly once on a 10ms timeout and the service returns one durable refused result whose operation is queryable; the crash path that IS asserted here (F4) is a child that dies by signal, which the runner records as exitCode -1 with the signal',
      },
      applyToMissingTargetIsRawFsError: {
        severity: 'observation',
        observed: 'the integration worktree is created by the product itself inside the operation own temp root, so apply() is never handed a missing target by this case; task 40 disclosed that apply() against a NON-EXISTENT target surfaces the raw fs ENOENT',
        assertedAs: 'recorded here and in the DoneClaim, deliberately NOT asserted, because the integration service always creates the worktree first and an existing non-directory target is already typed in task 40',
      },
      liveHarnessNotExercised: {
        severity: 'out-of-scope',
        observed: 'the frozen-criteria tests are REAL child processes started through the product own runner (node -e), and every git command is a real git invocation, but no live opencode, codex, kimi-web, dsh or acp backend is contacted',
        carriedAs: 'task 46 owns end-to-end live verification; the case performs no SSH and no Slurm work and its header and evidenceBoundary say so',
      },
      collaborationUiNotExercised: {
        severity: 'out-of-scope',
        observed: 'the browser realm recomputes the frozen shared contract and the frozen criteria vocabulary and checks the observed rejection codes against the frozen table; it renders no collaboration surface and claims none',
        carriedAs: 'task 42 owns the collaboration UI',
      },
    },
    evidenceBoundary: 'The real landed bridge modules bridge/runtime/collaboration/integrationService.js, integrationReview.js and repositoryLocks.js run in the Node worker composed exactly as the product composes them, over task 40 artifactStore.js / artifactService.js / writerLeases.js and the frozen shared/runtime/collaboration.js contract: real private temporary git repositories, real product-created detached integration worktrees inside each operation own temp root, real frozen-criteria test child processes through the product own runner, and real atomic `git update-ref` fast-forwards. The ONLY case-owned seams are the services own declared newOperationId / newReviewId / newApprovalId / newLockId injection points, each backed by a deterministic counter so an operation own worktree path is derivable. The frozen shared contract (the ten-entry ERROR_CODES table, the CollaborationError shape, the explicit-at contract, the frozen criteria vocabulary) also runs in a real headless Chromium served by a case-owned Vite server, and the membership of every observed rejection code is checked in that realm too. The stateful product cannot cross into the browser realm at all (all three bridge modules import node:* builtins), so its lifecycle is proven in the worker only and that split is stated rather than papered over. Every git invocation names its cwd explicitly and every repository is a private temporary one under the fixture root — never the QA worktree. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 42 owns the collaboration UI), claims NO durability across a real process death, claims NO cross-process repository-lock exclusion, and authors no PASS verdict.',
  };
}
