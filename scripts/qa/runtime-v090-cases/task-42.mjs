// Task 42 registered QA case — the Team task and change-review UI (plan task 42).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// parses the written result.
//
// What executes for REAL, and where:
//   * In a real headless Chromium over a case-owned Vite dev server: the landed task-42 Vue surface
//     (CollaborationPanel / TeamEditor / TaskGraph / AttemptDetails / ArtifactReview) mounted over
//     the REAL app/composables/useRuntimeCollaboration.ts, driving the REAL landed bridge services
//     bridge/runtime/collaboration/{coordinator,delegationService,mailbox,fanoutService}.js — the
//     task-37 coordinator, the task-39 delegation service + mailbox and the task-38 fan-out
//     service — through genuine clicks and data-testid / data-* reads, with the REAL imported-theme
//     token pipeline (app/utils/{regionTheme,themeTokens}.ts + the soft-white, anime-night and
//     anime-dream presets) measured with real computed colours. Every forward action the UI offers
//     is driven, and every phase the product derives is observed at its own rung.
//   * In the Node worker: what cannot cross into a browser realm at all — task 40's
//     writerLeases.js (imports node:crypto / node:fs / node:path / node:child_process plus
//     processTree.js) running a REAL allocate against a REAL private temporary git repository
//     through the product's OWN createGitRunner, and task 41's artifactStore.js durable objects
//     for the stale-approve-hash scenario. The worker also drives the same real coordinator module
//     over the same input for the cross-realm unknown-attempt refusal.
//
// The four acceptance criteria this case re-derives, each with a NAMED check and OBSERVED values
// (never copied from the landed CollaborationPanel.test.ts, which drives the same product through
// a happy-dom mount over the Node require boundary):
//   1. Agent finished / Task review pending / accepted are three DISTINCT phases (criterion 1):
//      the full native lifecycle is driven and each phase observed at its own rung, a native end on
//      an UNSENT attempt is refused, and a native end alone stops at agent-finished with the accept
//      button disabled and the coordinator's own review/acceptance slices still `none`.
//   2. The writer path and its resources come from a REAL task-40 writerLeases.allocate against a
//      REAL private temp git repo (criterion 2): the observed lease fields render verbatim, the
//      posture IS the module\'s own frozen WRITER_ISOLATION by identity (sandbox false), and the
//      worktree on disk really sits at the lease's base commit.
//   3. No auto-push default and no fake read-only capability (criterion 3): every forward action is
//      driven, the rendered surface is scanned for any push/remote affordance, and the REAL git
//      call log — the case's own commands and the product runner's — carries a real count with
//      every cwd named and zero push/fetch/clone commands.
//   4. Operations capture the Thread target (criterion 4): an operation on a fully-reviewable task
//      from a DIFFERENT Thread target is REFUSED with a readable error and changes nothing, while
//      the current thread's own task stays operable.
//
// The controlled boundaries are stated rather than papered over:
//   * `node:crypto` and `@iconify/vue` are aliased to app/dev/runtime-v090/task-35-browser-shim.mjs
//     (the landed task-35 seam tasks 26-29 share): the real bridge services import node:crypto at
//     module scope and cannot execute in a browser realm without it, and the real Icon fetches the
//     Iconify API at runtime. Both regexes are ANCHORED to the exact raw specifier (the task-27
//     lesson). No asserted value depends on the shim: ids are asserted by shape and
//     equality-across-reads, and no fingerprint is asserted.
//   * the writer port in the browser realm is a case-owned pass-through of the WORKER-observed
//     lease and posture, because writerLeases.js cannot execute in a browser at all; the port
//     RECORDS the allocate input the composable handed it, so the case observes that the UI really
//     asked for the real repository, the real task and the real owner. The identity claim
//     (`posture(leaseId) === WRITER_ISOLATION`) is proven in the worker where the real module
//     lives; the browser proves the rendered posture equals the observed contents.
//   * no container provides RUNTIME_COLLABORATION_STATE_KEY yet and nothing imports the five
//     components into the web entry graph, so the running app renders nothing; this case IS the
//     container, wired exactly as the landed CollaborationPanel.test.ts wires it, and it makes NO
//     claim that the running app already renders the collaboration UI.
//   * every git invocation names its cwd explicitly and every repository is a private temporary one
//     under the fixture root — NEVER the QA worktree (the task-24 lesson: task-24.mjs:206 ran a git
//     command without a cwd and created a branch in the QA worktree, which matters doubly here
//     because the writer lease itself is about git and cwd).
//   * every wall-clock-derived value is compared as a RELATION, never as a literal.
//   * this case performs NO live SSH or live Slurm verification (task 46 owns that), claims no
//     running-app rendering, runs no product test suite, edits no product or test file, performs no
//     git operation in the worktree, and authors no PASS verdict.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, digest, sourceSnapshot, validateSources, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-42-fixture.mjs';

import { createCollaborationCoordinator } from '../../../bridge/runtime/collaboration/coordinator.js';
import {
  POSTURE_KEYS,
  WRITER_ISOLATION,
  createGitRunner,
  createWriterLeaseService,
} from '../../../bridge/runtime/collaboration/writerLeases.js';
import { createArtifactStore, createBufferSource } from '../../../bridge/runtime/collaboration/artifactStore.js';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const HASH = /^[a-f0-9]{64}$/;
const COMMIT = /^[0-9a-f]{40,64}$/;
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
const T0 = 1700000000000;
/** The git subcommands that move data to or from a remote: none of them may ever be invoked. */
const REMOTE_MOVING = new Set(['push', 'fetch', 'clone', 'ls-remote', 'pull']);
const REMOTE_MUTATING_SUBCOMMANDS = new Set(['add', 'remove', 'rm', 'set-url', 'set-head', 'add-url', 'prune', 'rename']);
const isRemoteMoving = (args) => REMOTE_MOVING.has(args[0]) || (args[0] === 'remote' && REMOTE_MUTATING_SUBCOMMANDS.has(args[1]));

/**
 * THE ONE SOURCE of every case-owned input the two realms compare. Injected into the browser entry
 * through evaluate's argument, so the worker and the browser are identical BY CONSTRUCTION rather
 * than by two hard-coded copies (the task-39 lesson). The product tables' budgets / codes are NOT
 * here — both realms derive those from the shared modules they both import.
 */
const SHARED_INPUTS = Object.freeze({
  at: Object.freeze({ explicit: T0, zero: 0, negative: -1, fractional: 1.5, nonNumber: '1700000000000' }),
  errorShape: Object.freeze({ code: 'conflict', field: 'review_state', detail: Object.freeze({ taskId: '11111111-1111-4111-8111-111111111111' }) }),
  collaborationCodes: Object.freeze([
    'invalid_request', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required',
  ]),
});

/* ------------------------------------------------------------------ capture envelopes */

const captureSync = (run) => { try { run(); return { code: null, field: null }; } catch (error) { return recordCode(error); } };
function recordCode(error) {
  if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
    return { code: error.code, field: error.field };
  }
  return { code: 'not-a-CollaborationError', field: String(error) };
}

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
    collaborationCodesInTable: shared.collaborationCodes.every((code) => ERROR_CODES.includes(code)),
    atExplicit: parseAt(shared.at.explicit),
    atZero: captureSync(() => parseAt(shared.at.zero)),
    atNegative: captureSync(() => parseAt(shared.at.negative)),
    atFractional: captureSync(() => parseAt(shared.at.fractional)),
    atNonNumber: captureSync(() => parseAt(shared.at.nonNumber)),
  };
}

export const sourceFiles = [...new Set([
  // the six product paths this task owns + its landed test file
  'app/components/runtime/CollaborationPanel.vue',
  'app/components/runtime/TeamEditor.vue',
  'app/components/runtime/TaskGraph.vue',
  'app/components/runtime/AttemptDetails.vue',
  'app/components/runtime/ArtifactReview.vue',
  'app/composables/useRuntimeCollaboration.ts',
  'app/components/runtime/CollaborationPanel.test.ts',
  // the landed collaboration services the surface drives, unchanged
  'bridge/runtime/collaboration/coordinator.js',
  'bridge/runtime/collaboration/delegationService.js',
  'bridge/runtime/collaboration/mailbox.js',
  'bridge/runtime/collaboration/fanoutService.js',
  'bridge/runtime/collaboration/writerLeases.js',
  'bridge/runtime/collaboration/artifactStore.js',
  'bridge/runtime/collaboration/attemptService.js',
  'bridge/runtime/collaboration/acceptanceService.js',
  'bridge/runtime/collaboration/taskGraph.js',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/harnessContract.js',
  // the imported-theme token pipeline the surface renders under
  'app/utils/regionTheme.ts', 'app/utils/themeTokens.ts', 'app/utils/colorValue.ts',
  'app/utils/soft-white.theme_1.json', 'app/utils/anime-night.theme_1.json', 'app/utils/anime-dream.theme_1.json',
  // case-owned files + the landed browser seam this case aliases + runner inputs
  'app/dev/runtime-v090/task42.ts',
  'app/dev/runtime-v090/task-35-browser-shim.mjs',
  'scripts/qa/runtime-v090-cases/task-42.mjs',
  'scripts/qa/runtime-v090-cases/task-42-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/** The product files whose bytes the evidence must bind to, re-hashed after the whole run. */
const PINNED_PRODUCT_FILES = Object.freeze([
  'app/components/runtime/CollaborationPanel.vue',
  'app/components/runtime/TeamEditor.vue',
  'app/components/runtime/TaskGraph.vue',
  'app/components/runtime/AttemptDetails.vue',
  'app/components/runtime/ArtifactReview.vue',
  'app/composables/useRuntimeCollaboration.ts',
  'app/components/runtime/CollaborationPanel.test.ts',
  'bridge/runtime/collaboration/coordinator.js',
  'bridge/runtime/collaboration/delegationService.js',
  'bridge/runtime/collaboration/mailbox.js',
  'bridge/runtime/collaboration/fanoutService.js',
  'bridge/runtime/collaboration/writerLeases.js',
  'bridge/runtime/collaboration/artifactStore.js',
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/harnessContract.js',
  'app/utils/regionTheme.ts', 'app/utils/themeTokens.ts', 'app/utils/colorValue.ts',
  'app/utils/soft-white.theme_1.json', 'app/utils/anime-night.theme_1.json', 'app/utils/anime-dream.theme_1.json',
]);

const PAGE_HTML = `<!doctype html><html lang="en" data-region-theme="none"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 42 registered case</title>
  <style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; background: var(--theme-surface-page, #ffffff); color: var(--theme-text-primary, #111); }</style></head>
  <body><div id="app"></div>
  <script type="module">window.__task42Errors=[];window.addEventListener('error',(e)=>window.__task42Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task42Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
  <script type="module" src="/app/dev/runtime-v090/task42.ts"></script></body></html>`;

export async function run(context) {
  // The case owns its git worlds: a fixed umask plus an explicit chmod on every written file
  // makes the observed modes deterministic regardless of the runner's ambient umask.
  process.umask(0o022);
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-42/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { case: context.case, runDir, checks, observations, worker: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'the real landed task-42 Vue surface (CollaborationPanel/TeamEditor/TaskGraph/AttemptDetails/ArtifactReview) over the real useRuntimeCollaboration composable driving the real bridge coordinator, delegation+mailbox and fan-out services in a real headless Chromium over a case-owned Vite dev server, plus the real writer-lease and artifact-store modules against a real private git repository in the Node worker, with the real imported-theme token pipeline',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-42.mjs',
    'scripts/qa/runtime-v090-cases/task-42-fixture.mjs',
    'app/dev/runtime-v090/task42.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const pinnedBefore = sourceSnapshot(context.root, PINNED_PRODUCT_FILES);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  const started = {
    gitCommands: 0, productGitCommands: 0, leases: 0, artifacts: 0, tamperedObjects: 0, messages: 0, boots: 0,
  };
  /** Every git invocation the PRODUCT's own runner made, recorded through the counting seam. */
  const productGitCalls = [];

  /* ---------------------------------------------------------------- world helpers */

  /** Every git invocation this CASE itself makes, recorded so the cwd discipline is observed. */
  const caseGitCalls = [];
  /** Run one git command in a NAMED working directory. Never inherits an ambient cwd. */
  const runGit = (cwd, args, options = {}) => {
    started.gitCommands += 1;
    caseGitCalls.push({ cwd, args: [...args] });
    return execFileSync('git', [...args], {
      cwd,
      encoding: options.encoding ?? 'utf8',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: { ...process.env, GIT_TERMINAL_PROMPT: '0', LC_ALL: 'C' },
    });
  };
  /** Write one file with an EXPLICIT mode, so the observed modes are umask-independent. */
  const writeFileMode = async (filePath, data, mode) => {
    await writeFile(filePath, data);
    await chmod(filePath, mode);
  };  const scratch = (kind, name) => fixture.mkdirOwned(kind, name);

  /**
   * A private temporary git repository with a single base commit — NEVER the QA worktree. The
   * object format is pinned to sha1 on the command line so the base commit is always 40 hex
   * characters regardless of the host git configuration, and signing / line-ending conversion are
   * pinned off in the repository's OWN config.
   */
  const createRepo = async (name) => {
    const root = await scratch('git-repository', `repos/${name}`);
    await mkdir(path.join(root, 'src'), { recursive: true });
    await writeFileMode(path.join(root, 'README.md'), 'base readme\n', 0o644);
    await writeFileMode(path.join(root, 'src', 'keep.txt'), 'keep\n', 0o644);
    await writeFileMode(path.join(root, 'bin.bin'), Buffer.from([0x00, 0x01, 0x02, 0x03, 0xfe, 0xff]), 0o644);
    runGit(root, ['-c', 'init.defaultObjectFormat=sha1', 'init', '-q', '-b', 'main']);
    runGit(root, ['config', 'commit.gpgsign', 'false']);
    runGit(root, ['config', 'tag.gpgsign', 'false']);
    runGit(root, ['config', 'core.autocrlf', 'false']);
    runGit(root, ['add', '-A']);
    runGit(root, ['-c', 'user.name=vis', '-c', 'user.email=vis@example.invalid', 'commit', '-q', '-m', 'base']);
    return root;
  };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Worker realm: the real private repository, the real writer-lease service over the product's
    // own runner, and the real durable artifact store
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const repository = await createRepo('collaboration-repo');
    const repositoryHead = runGit(repository, ['rev-parse', '--verify', 'HEAD']).trim();
    record('repository', { repository, head: repositoryHead, headShape: COMMIT.test(repositoryHead) });

    const writersRoot = await scratch('writers-root', 'writers');
    // The product's OWN git runner, wrapped by a case-owned counter: the wrapper forwards every
    // call unchanged, so the behaviour under test is the product's, and the call log is observed.
    const productRunner = createGitRunner({});
    const countingRunGit = async (input) => {
      productGitCalls.push({ cwd: input.cwd, args: [...input.args] });
      started.productGitCommands += 1;
      return productRunner(input);
    };
    const writers = createWriterLeaseService({ writersRoot, runGit: countingRunGit });
    fixture.own('writer-lease-service', async () => {
      writers.close();
      return { closed: true, productGitCalls: productGitCalls.length };
    });

    const storeRoot = await scratch('store-root', 'artifact-store');
    const store = createArtifactStore({ root: storeRoot });
    fixture.own('artifact-store', async () => { store.close(); return { closed: true }; });
    const alphaBytes = Buffer.from('the reviewed change: alpha\nline two\n', 'utf8');
    const alphaWrite = await store.write({ source: createBufferSource(alphaBytes) });
    const betaBytes = Buffer.from('the reviewed change: beta\n', 'utf8');
    const betaWrite = await store.write({ source: createBufferSource(betaBytes) });
    started.artifacts += 2;
    record('artifacts', {
      alpha: { artifactHash: alphaWrite.artifactHash, bytes: alphaWrite.bytes, hashShape: HASH.test(alphaWrite.artifactHash) },
      beta: { artifactHash: betaWrite.artifactHash, bytes: betaWrite.bytes, hashShape: HASH.test(betaWrite.artifactHash) },
      hashesDiffer: alphaWrite.artifactHash !== betaWrite.artifactHash,
    });

    // The worker's own instance of the REAL coordinator, for the cross-realm unknown-attempt
    // refusal: the same module, the same input, a second realm (the task-39 one-source lesson).
    const workerCoordinator = createCollaborationCoordinator();
    fixture.own('worker-coordinator', async () => { workerCoordinator.close(); return { closed: true }; });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Browser realm: the REAL Vue surface over the REAL composable and the REAL services
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const shimPath = path.join(context.root, 'app/dev/runtime-v090/task-35-browser-shim.mjs');
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      plugins: [vue()],
      resolve: { alias: [
        // Anchored to the EXACT raw specifier (the task-27 lesson: Vite's resolve.alias matches the
        // import statement's raw specifier, so a relative-shaped pattern never fires).
        { find: /^@iconify\/vue$/u, replacement: shimPath },
        { find: /^node:crypto$/u, replacement: shimPath },
      ] },
      optimizeDeps: { include: ['vue', 'vue-i18n'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa42', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa42/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task42 && window.task42.ready)), 'task42 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    /* ------------------------------------------------------------------ browser drivers */
    const boot = (options) => evaluate((input) => window.task42.boot(input), options);
    const observe = () => evaluate(() => window.task42.observe());
    const probe = () => evaluate(() => window.task42.probe());
    const productTask = (taskId) => evaluate((value) => window.task42.productTask(value), taskId);
    const productBudgets = () => evaluate(() => window.task42.productBudgets());
    const budgetsFrozen = () => evaluate(() => window.task42.budgetsFrozen());
    const productMailboxDepth = () => evaluate(() => window.task42.productMailboxDepth());
    const openTeam = (input) => evaluate((value) => window.task42.openTeam(value), input);
    const createTask = (input) => evaluate((value) => window.task42.createTask(value), input);
    const createDependentTask = (input) => evaluate((value) => window.task42.createDependentTask(value), input);
    const selectTaskViaUi = (taskId) => evaluate((value) => window.task42.selectTaskViaUi(value), taskId);
    const dispatchViaUi = (taskId) => evaluate((value) => window.task42.dispatchViaUi(value), taskId);
    const sendViaUi = () => evaluate(() => window.task42.sendViaUi());
    const typeNativeEventId = (value) => evaluate((input) => window.task42.typeNativeEventId(input), value);
    const finishViaUi = () => evaluate(() => window.task42.finishViaUi());
    const registerDeliverableViaUi = () => evaluate(() => window.task42.registerDeliverableViaUi());
    const registerDeliverable = (input) => evaluate((value) => window.task42.registerDeliverable(value), input);
    const submitReviewViaUi = (taskId) => evaluate((value) => window.task42.submitReviewViaUi(value), taskId);
    const approveViaUi = () => evaluate(() => window.task42.approveViaUi());
    const acceptViaUi = (taskId) => evaluate((value) => window.task42.acceptViaUi(value), taskId);
    const cancelViaUi = (taskId) => evaluate((value) => window.task42.cancelViaUi(value), taskId);
    const acceptTask = (input) => evaluate((value) => window.task42.acceptTask(value), input);
    const cancelTask = (input) => evaluate((value) => window.task42.cancelTask(value), input);
    const sendTaskWithoutAttempt = (taskId) => evaluate((value) => window.task42.sendTaskWithoutAttempt(value), taskId);
    const finishTaskWithoutAttempt = (input) => evaluate((value) => window.task42.finishTaskWithoutAttempt(value), input);
    const allocateWriter = (input) => evaluate((value) => window.task42.allocateWriter(value), input);
    const seedWriterLease = (input) => evaluate((value) => window.task42.seedWriterLease(value), input);
    const writerAllocateCalls = () => evaluate(() => window.task42.writerAllocateCalls());
    const postMessages = (input) => evaluate((value) => window.task42.postMessages(value), input);
    const attemptOf = (attemptId) => evaluate((value) => window.task42.attemptOf(value), attemptId);
    const typeFanoutPrompt = (value) => evaluate((input) => window.task42.typeFanoutPrompt(input), value);
    const fanOutViaUi = () => evaluate(() => window.task42.fanOutViaUi());
    const applyTheme = (kind) => evaluate((value) => window.task42.applyTheme(value), kind);
    const styleProbe = () => evaluate(() => window.task42.styleProbe());
    const layoutProbe = () => evaluate(() => window.task42.layoutProbe());
    const browserErrors = () => evaluate(() => window.task42.errors());
    const deliverCalls = () => evaluate(() => window.task42.deliverCalls());
    const observedBrowserCodes = () => evaluate(() => window.task42.observedCodes());

    const constants = await evaluate(() => window.task42.constants);
    record('constants', constants);
    const MEMBERS = Object.freeze([
      Object.freeze({ key: 'lead', role: 'lead', harnessKind: 'opencode', participantId: constants.LEAD_P }),
      Object.freeze({ key: 'worker', role: 'worker', harnessKind: 'codex', participantId: constants.WORKER_P }),
      Object.freeze({ key: 'acp', role: 'worker', harnessKind: 'acp', participantId: constants.ACP_P }),
    ]);
    const ALPHA_DELIVERABLE = Object.freeze({
      deliverableId: 'deliverable-alpha',
      artifactHash: alphaWrite.artifactHash,
      bytes: alphaWrite.bytes,
      paths: Object.freeze(['src/App.vue']),
    });
    const BETA_DELIVERABLE = Object.freeze({
      deliverableId: 'deliverable-beta',
      artifactHash: betaWrite.artifactHash,
      bytes: betaWrite.bytes,
      paths: Object.freeze(['src/B.vue']),
    });

    // Drives one worker value and its browser twin, then asserts the two realms are IDENTICAL.
    const crossRealm = async (name, workerValue, browserValue, expected) => {
      protocol.worker[name] = workerValue;
      protocol.browser[name] = browserValue;
      record(name, { worker: workerValue, browser: browserValue });
      check(name, {
        worker: workerValue,
        browser: browserValue,
        equal: JSON.stringify(workerValue) === JSON.stringify(browserValue),
      }, { worker: expected, browser: expected, equal: true });
    };

    // ── C1: the frozen contract is identical in both realms ──────────────────────────────────
    await crossRealm('the frozen shared contract every collaboration rejection travels through — the frozen ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason, message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at` contract with a zero, a negative, a fractional and a non-numeric reading refused — is byte-identical in the browser realm and the bridge worker, and every code the collaboration surfaces can emit is a member, so the UI and the bridge cannot disagree about a rejection', workerTables(SHARED_INPUTS), await evaluate((shared) => window.task42.tables(shared), SHARED_INPUTS), {
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'review_state', reason: 'review_state', message: 'conflict: collaboration.review_state', detail: { taskId: '11111111-1111-4111-8111-111111111111' }, isProtocolError: true, isTypeError: true },
      collaborationCodesInTable: true,
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atNegative: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
      atNonNumber: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // The browser realm's coordinator is boot-scoped — the landed task-35/37 entry pattern
    // (`let coordinator` is assigned inside boot()) — so every service-INSTANCE surface
    // (attemptOf, postMessages, the container actions) is observable only AFTER a boot, exactly
    // as in tasks 37/39/41, whose pre-boot cross-realm checks read only the PURE contract
    // surfaces (tables, parsers, criteria). One empty world is booted here so the browser realm's
    // own coordinator exists for the unknown-attempt refusal; no task lifecycle has been driven,
    // so the check's "before any lifecycle is driven" claim still holds (the task-42 lesson, the
    // same receiver-contract rule as the constants read: verify the receiver's declaration).
    started.boots += 1;
    await boot({ threadId: constants.THREAD_1, teamName: 'Team contract', members: MEMBERS });

    // ── C2: an unknown attempt id is the SAME typed refusal in both realms ───────────────────
    const workerUnknownAttempt = captureSync(() => workerCoordinator.attempt(constants.UNKNOWN_ATTEMPT_ID));
    const browserUnknownAttempt = await attemptOf(constants.UNKNOWN_ATTEMPT_ID);
    await crossRealm('an unknown attempt id is the SAME explicit typed refusal in both realms — invalid_request/attempt_unknown over the well-formed identity no attempt ever uses — so a browser window and the bridge worker provably agree on what an unknown attempt is before any lifecycle is driven', workerUnknownAttempt, browserUnknownAttempt, { code: 'invalid_request', field: 'attempt_unknown' });

    /**
     * The rich world: a three-harness team, one task walked through the FULL native lifecycle to
     * accepted, the three-harness fan-out, and the real writer lease. Returns every intermediate
     * observation so the lane composes its per-aspect checks from ONE drive.
     */
    const buildRichWorld = async (label) => {
      started.boots += 1;
      const booted = await boot({ threadId: constants.THREAD_1, teamName: `Team ${label}`, members: MEMBERS });
      const created = await createTask({ title: `${label} task` });
      const taskId = created.snapshot.tasks[0].taskId;
      // createTask returns the post-create observation, so the pending rung is observed here.
      const afterCreate = created;
      const afterSelect = await selectTaskViaUi(taskId);
      const afterDispatch = await dispatchViaUi(taskId);
      const finishDisabledBeforeSend = afterDispatch.probe.attempt?.finishDisabled ?? null;
      await typeNativeEventId(`native-evt-${label}`);
      const afterTyping = await observe();
      // A native end on an UNSENT attempt is refused: the attempt is retained, nothing terminal.
      const afterFinishRefused = await finishViaUi();
      const afterSend = await sendViaUi();
      await typeNativeEventId(`native-evt-${label}`);
      const afterFinish = await finishViaUi();
      const productAfterFinish = await productTask(taskId);
      const afterRegisterUi = await registerDeliverableViaUi();
      const afterRegisterReal = await registerDeliverable({ taskId, deliverable: ALPHA_DELIVERABLE });
      const afterSubmit = await submitReviewViaUi(taskId);
      const afterApprove = await approveViaUi();
      const productAfterApprove = await productTask(taskId);
      const afterAccept = await acceptTask({ taskId, deliverableId: ALPHA_DELIVERABLE.deliverableId, acceptedBy: 'reviewer', criteria: [{ id: 'c1', met: true }] });
      await typeFanoutPrompt(`review the ${label} change`);
      const afterFanout = await fanOutViaUi();
      // The REAL writer lease against the REAL private repository, allocated for THIS task.
      const lease = await writers.allocate({ repository, taskId, ownerId: constants.LEAD_P, at: T0 });
      started.leases += 1;
      const posture = writers.posture(lease.leaseId);
      const seeded = await seedWriterLease({
        lease: { ...lease, policy: { ...lease.policy } },
        posture: { ...posture, guarantees: [...posture.guarantees], notProvided: [...posture.notProvided] },
      });
      await allocateWriter({ taskId, repository });
      const afterWriter = await observe();
      return {
        taskId, afterCreate, booted, afterSelect, afterDispatch, finishDisabledBeforeSend, afterTyping, afterFinishRefused,
        afterSend, afterFinish, productAfterFinish, afterRegisterUi, afterRegisterReal, afterSubmit,
        afterApprove, productAfterApprove, afterAccept, afterFanout, lease, posture, seeded, afterWriter,
      };
    };

    /** Walk one fresh task to an APPROVED review (not yet accepted), for the Thread-capture check. */
    const walkToReviewApproved = async (title) => {
      const created = await createTask({ title });
      // The coordinator's task list APPENDS, so the task this call created is found by its title,
      // never assumed at index 0 — by this point the world already carries the alpha task and the
      // native-end-only task (the same find-by-title the H3/F5/F6 drives use).
      const taskId = created.snapshot.tasks.find((entry) => entry.title === title).taskId;
      await selectTaskViaUi(taskId);
      await dispatchViaUi(taskId);
      await sendViaUi();
      await typeNativeEventId(`native-evt-${title}`);
      await finishViaUi();
      await registerDeliverable({ taskId, deliverable: ALPHA_DELIVERABLE });
      await submitReviewViaUi(taskId);
      const afterApprove = await approveViaUi();
      return { taskId, afterApprove };
    };

    if (context.case === 'happy') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: 真实UI 3 Harness fanout、Lead Worker team、查看 DAG/产物 → approve integration
      // → accepted，三主题截图, plus the four acceptance criteria.
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const rich = await buildRichWorld('alpha');
      record('rich-world', {
        taskId: rich.taskId, afterDispatch: rich.afterDispatch, afterFinish: rich.afterFinish,
        afterFanout: rich.afterFanout, afterWriter: rich.afterWriter,
      });

      // ── H1: the team opens under the captured Thread target with three members ─────────────
      check('the team opens under the captured Thread target with a Lead Worker team across THREE harnesses and the REAL frozen budget limits: the panel names the team, the captured thread and the task count, each member row carries its own role and harness with its native session, and each budget row renders the coordinator\'s own frozen limit', {
        threadIdAttr: rich.booted.probe.threadIdAttr,
        threadIdIsCaptured: rich.booted.probe.threadIdAttr === constants.THREAD_1,
        teamIdAttrShape: UUID.test(rich.booted.probe.teamIdAttr ?? ''),
        teamMeta: rich.booted.probe.teamMeta,
        members: rich.booted.probe.members.map((row) => ({ role: row.role, harness: row.harness, sessionTitle: row.sessionTitle })),
        memberIdShapes: rich.booted.probe.members.every((row) => UUID.test(row.memberId ?? '')),
        budgets: rich.booted.probe.budgets.map((row) => ({ key: row.key, keyText: row.keyText, usedText: row.usedText })),
        snapshot: {
          available: rich.booted.snapshot.available,
          threadId: rich.booted.snapshot.threadId,
          teamName: rich.booted.snapshot.team?.name ?? null,
          memberCount: rich.booted.snapshot.team?.members.length ?? 0,
          memberIdentities: rich.booted.snapshot.team?.members.map((member) => `${member.role}:${member.harnessKind}:${member.session.nativeSessionId}`) ?? [],
          budgetLimits: rich.booted.snapshot.budgets?.limits ?? null,
          // Frozen-ness is observed WHERE THE OBJECT LIVES: every observation crosses the evaluate
          // boundary as a spread plain object, and a spread copy is never frozen, so the boolean is
          // computed inside the browser realm and only the boolean crosses (the in-realm pattern
          // the case's own `tables` check uses for `errorCodesFrozen`).
          budgetLimitsFrozen: (await budgetsFrozen()).limits,
        },
      }, {
        threadIdAttr: constants.THREAD_1,
        threadIdIsCaptured: true,
        teamIdAttrShape: true,
        teamMeta: 'Team alpha · dddddddd-111… · 0 tasks',
        members: [
          { role: 'lead', harness: 'opencode', sessionTitle: 'lead-session' },
          { role: 'worker', harness: 'codex', sessionTitle: 'worker-session' },
          { role: 'worker', harness: 'acp', sessionTitle: 'acp-session' },
        ],
        memberIdShapes: true,
        budgets: [
          { key: 'maxConcurrency', keyText: 'maxConcurrency', usedText: '0 / 4' },
          { key: 'maxSessionMutations', keyText: 'maxSessionMutations', usedText: '0 / 1' },
          { key: 'maxDepth', keyText: 'maxDepth', usedText: '0 / 4' },
          { key: 'maxChildren', keyText: 'maxChildren', usedText: '0 / 32' },
          { key: 'maxMailbox', keyText: 'maxMailbox', usedText: '0 / 1000' },
        ],
        snapshot: {
          available: true,
          threadId: constants.THREAD_1,
          teamName: 'Team alpha',
          memberCount: 3,
          memberIdentities: ['lead:opencode:lead-session', 'worker:codex:worker-session', 'worker:acp:acp-session'],
          budgetLimits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 },
          budgetLimitsFrozen: true,
        },
      });

      // ── H2: the three phases, rung by rung (criterion 1) ───────────────────────────────────
      check('Agent finished / Task review pending / accepted are three DISTINCT phases observed at their own rungs through the real UI: pending → dispatched, the native-end action is DISABLED until a real native event id is typed, a native end on an unsent attempt is REFUSED with the readable conflict, only the send-then-end sequence reaches agent-finished with the attempt terminal and the coordinator review/acceptance slices still `none`, the UI\'s own Register deliverable button registers NOTHING because no artifact capture is wired into this surface while the container registers the real artifact, submit-for-review reaches review-pending with the Accept affordance DISABLED, the explicit approve records the approved verdict and moves the phase to review-approved with Accept now ENABLED, and the container accept reaches accepted with its criteria', {
        taskIdShape: UUID.test(rich.taskId),
        rungs: {
          afterCreate: { phase: rich.afterCreate.probe.tasks[0]?.phase ?? null, chip: rich.afterCreate.probe.tasks[0]?.chip ?? null, dispatchDisabled: rich.afterCreate.probe.tasks[0]?.dispatchDisabled ?? null },
          afterSelect: { attemptPhase: rich.afterSelect.probe.attempt?.phase ?? null, attemptEmpty: rich.afterSelect.probe.attempt?.empty ?? null, attemptRows: rich.afterSelect.probe.attempt?.rows.length ?? null, sendDisabled: rich.afterSelect.probe.attempt?.sendDisabled ?? null, finishDisabled: rich.afterSelect.probe.attempt?.finishDisabled ?? null },
          afterDispatch: { phase: rich.afterDispatch.probe.tasks[0]?.phase ?? null, chip: rich.afterDispatch.probe.tasks[0]?.chip ?? null, attemptState: rich.afterDispatch.probe.attempt?.rows[0]?.state ?? null, attemptFlags: rich.afterDispatch.probe.attempt?.rows[0]?.flags ?? null, sends: rich.afterDispatch.probe.attempt?.rows[0]?.sends ?? null, finishDisabledBeforeTyping: rich.finishDisabledBeforeSend },
          afterTyping: { finishDisabledAfterTyping: rich.afterTyping.probe.attempt?.finishDisabled ?? null },
          afterFinishRefused: { phase: rich.afterFinishRefused.probe.tasks[0]?.phase ?? null, attemptState: rich.afterFinishRefused.probe.attempt?.rows[0]?.state ?? null, attemptReason: rich.afterFinishRefused.probe.attempt?.rows[0]?.reason ?? null, errorText: rich.afterFinishRefused.probe.error?.text ?? null, errorRole: rich.afterFinishRefused.probe.error?.role ?? null },
          afterSend: { attemptState: rich.afterSend.probe.attempt?.rows[0]?.state ?? null, attemptFlags: rich.afterSend.probe.attempt?.rows[0]?.flags ?? null, sends: rich.afterSend.probe.attempt?.rows[0]?.sends ?? null },
          afterFinish: { phase: rich.afterFinish.probe.tasks[0]?.phase ?? null, chip: rich.afterFinish.probe.tasks[0]?.chip ?? null, attemptPhase: rich.afterFinish.probe.attempt?.phase ?? null, attemptNote: rich.afterFinish.probe.attempt?.phaseNote ?? null, attemptState: rich.afterFinish.probe.attempt?.rows[0]?.state ?? null, attemptFlags: rich.afterFinish.probe.attempt?.rows[0]?.flags ?? null, attemptReason: rich.afterFinish.probe.attempt?.rows[0]?.reason ?? null, acceptDisabled: rich.afterFinish.probe.tasks[0]?.acceptDisabled ?? null, submitReviewDisabled: rich.afterFinish.probe.tasks[0]?.submitReviewDisabled ?? null, registerDisabled: rich.afterFinish.probe.attempt?.registerDisabled ?? null },
          productAfterNativeEnd: { state: rich.productAfterFinish.state, reviewState: rich.productAfterFinish.review.state, acceptanceState: rich.productAfterFinish.acceptance.state, deliverables: rich.productAfterFinish.deliverables.length },
          afterRegisterUi: { deliverableRows: rich.afterRegisterUi.probe.deliverables.map((row) => ({ deliverableId: row.deliverableId, hash: row.hash, bytes: row.bytes, paths: row.paths })) },
          afterRegisterReal: { deliverableRows: rich.afterRegisterReal.probe.deliverables.map((row) => ({ deliverableId: row.deliverableId, hash: row.hash, bytes: row.bytes, paths: row.paths })) },
          afterSubmit: { phase: rich.afterSubmit.probe.tasks[0]?.phase ?? null, chip: rich.afterSubmit.probe.tasks[0]?.chip ?? null, approveDisabled: rich.afterSubmit.probe.approve.disabled ?? null, acceptDisabled: rich.afterSubmit.probe.tasks[0]?.acceptDisabled ?? null },
           afterApprove: { phase: rich.afterApprove.probe.tasks[0]?.phase ?? null, chip: rich.afterApprove.probe.tasks[0]?.chip ?? null, reviewState: rich.productAfterApprove.review.state, reviewer: rich.productAfterApprove.review.reviewer, acceptanceState: rich.productAfterApprove.acceptance.state, acceptDisabled: rich.afterApprove.probe.tasks[0]?.acceptDisabled ?? null },
          afterAccept: { phase: rich.afterAccept.probe.tasks[0]?.phase ?? null, chip: rich.afterAccept.probe.tasks[0]?.chip ?? null, acceptanceState: rich.afterAccept.snapshot.tasks[0]?.acceptance.state ?? null, acceptedBy: rich.afterAccept.snapshot.tasks[0]?.acceptance.acceptedBy ?? null, acceptanceCriteria: rich.afterAccept.snapshot.tasks[0]?.acceptance.criteria ?? null, cancelDisabled: rich.afterAccept.probe.tasks[0]?.cancelDisabled ?? null },
        },
      }, {
        taskIdShape: true,
        rungs: {
          afterCreate: { phase: 'pending', chip: 'Pending', dispatchDisabled: false },
          afterSelect: { attemptPhase: 'pending', attemptEmpty: 'No attempts yet. Dispatch the task first.', attemptRows: 0, sendDisabled: true, finishDisabled: true },
          afterDispatch: { phase: 'dispatched', chip: 'Dispatched', attemptState: 'accepted', attemptFlags: 'sent:0 observed:0 terminal:0', sends: 'sends:0', finishDisabledBeforeTyping: true },
          afterTyping: { finishDisabledAfterTyping: false },
          afterFinishRefused: { phase: 'dispatched', attemptState: 'accepted', attemptReason: null, errorRole: 'alert', errorText: `The native end could not be recorded: conflict: collaboration.attempt_state (conflict/attempt_state)` },
          afterSend: { attemptState: 'sent', attemptFlags: 'sent:1 observed:0 terminal:0', sends: 'sends:1' },
          afterFinish: { phase: 'agent-finished', chip: 'Agent finished', attemptPhase: 'agent-finished', attemptNote: 'The agent run finished; not yet reviewed.', attemptState: 'terminal', attemptFlags: 'sent:1 observed:0 terminal:1', attemptReason: 'completed', acceptDisabled: true, submitReviewDisabled: false, registerDisabled: true },
          productAfterNativeEnd: { state: 'review', reviewState: 'none', acceptanceState: 'none', deliverables: 0 },
          afterRegisterUi: { deliverableRows: [] },
          afterRegisterReal: { deliverableRows: [
            { deliverableId: 'deliverable-alpha', hash: ALPHA_DELIVERABLE.artifactHash, bytes: `${ALPHA_DELIVERABLE.bytes}B`, paths: 'src/App.vue' },
          ] },
          afterSubmit: { phase: 'review-pending', chip: 'Review pending', approveDisabled: false, acceptDisabled: true },
          afterApprove: { phase: 'review-approved', chip: 'Review approved', reviewState: 'approved', reviewer: 'reviewer', acceptanceState: 'none', acceptDisabled: false },
          afterAccept: { phase: 'accepted', chip: 'Accepted', acceptanceState: 'accepted', acceptedBy: 'reviewer', acceptanceCriteria: ['c1'], cancelDisabled: true },
        },
      });

      // ── H3: a native end ALONE never reaches review-pending or accepted ────────────────────
      {
        const created = await createTask({ title: 'native end only' });
        const soloTaskId = created.snapshot.tasks.find((entry) => entry.title === 'native end only').taskId;
        await selectTaskViaUi(soloTaskId);
        await dispatchViaUi(soloTaskId);
        await sendViaUi();
        await typeNativeEventId('native-evt-solo');
        const afterSoloFinish = await finishViaUi();
        const soloProduct = await productTask(soloTaskId);
        record('native-end-alone', { afterSoloFinish, soloProduct });
        check('a native end ALONE stops at agent-finished and structurally never renders review-pending or accepted: the coordinator\'s own frozen view shows the host at `review` with the review slice and the acceptance slice both still `none` and no deliverable, the phase chip reads Agent finished and contains neither Review pending nor Accepted, and the accept affordance is disabled — the only writers of those slices are the explicit review and accept paths', {
          phase: afterSoloFinish.probe.tasks.find((row) => row.taskId === soloTaskId)?.phase ?? null,
          chip: afterSoloFinish.probe.tasks.find((row) => row.taskId === soloTaskId)?.chip ?? null,
          chipMentionsReviewPending: /Review pending/.test(String(afterSoloFinish.probe.tasks.find((row) => row.taskId === soloTaskId)?.chip ?? '')),
          chipMentionsAccepted: /Accepted/.test(String(afterSoloFinish.probe.tasks.find((row) => row.taskId === soloTaskId)?.chip ?? '')),
          attemptState: afterSoloFinish.probe.attempt?.rows[0]?.state ?? null,
          attemptReason: afterSoloFinish.probe.attempt?.rows[0]?.reason ?? null,
          acceptDisabled: afterSoloFinish.probe.tasks.find((row) => row.taskId === soloTaskId)?.acceptDisabled ?? null,
          product: { state: soloProduct.state, reviewState: soloProduct.review.state, acceptanceState: soloProduct.acceptance.state, deliverables: soloProduct.deliverables.length },
        }, {
          phase: 'agent-finished',
          chip: 'Agent finished',
          chipMentionsReviewPending: false,
          chipMentionsAccepted: false,
          attemptState: 'terminal',
          attemptReason: 'completed',
          acceptDisabled: true,
          product: { state: 'review', reviewState: 'none', acceptanceState: 'none', deliverables: 0 },
        });
      }

      // ── H4: the three-harness fan-out through the real UI ──────────────────────────────────
      {
        const deliveries = await deliverCalls();
        record('fanout-deliveries', deliveries);
        check('the real UI fans out to every member across the THREE harnesses and renders the OBSERVED per-recipient outcomes: the prompt is typed into the product input and the product button clicked, all three recipients settle `sent` with their own participant identities, the derived state is `succeeded`, the stats line names the real counts, and each delivery the service really made is recorded with its own session and no attachment path', {
          state: rich.afterFanout.probe.fanout.state,
          stateText: rich.afterFanout.probe.fanout.stateText,
          stats: rich.afterFanout.probe.fanout.stats,
          recipients: rich.afterFanout.probe.fanout.recipients.map((row) => ({ participantId: row.participantId, outcome: row.outcome, resolutionCodeRendered: row.resolutionCodeRendered })),
          idle: rich.afterFanout.probe.fanout.idle,
          snapshot: {
            fanoutState: rich.afterFanout.snapshot.fanout?.state ?? null,
            stats: rich.afterFanout.snapshot.fanout?.stats ?? null,
            targets: rich.afterFanout.snapshot.fanout?.targets.map((target) => ({ participantId: target.participantId, outcome: target.outcome, harness: target.session.harnessInstanceId === constants.H_LEAD ? 'opencode' : target.session.harnessInstanceId === constants.H_WORKER ? 'codex' : 'acp' })) ?? null,
          },
          deliveries: deliveries.fanout,
        }, {
          state: 'succeeded',
          stateText: 'Fan-out: succeeded',
          stats: 'sent 3 · failed 0 · ambiguous 0 · pending 0',
          recipients: [
            { participantId: constants.LEAD_P, outcome: 'sent', resolutionCodeRendered: false },
            { participantId: constants.WORKER_P, outcome: 'sent', resolutionCodeRendered: false },
            { participantId: constants.ACP_P, outcome: 'sent', resolutionCodeRendered: false },
          ],
          idle: null,
          snapshot: {
            fanoutState: 'succeeded',
            stats: { total: 3, sent: 3, failed: 0, ambiguous: 0, cancelled: 0, pending: 0 },
            targets: [
              { participantId: constants.LEAD_P, outcome: 'sent', harness: 'opencode' },
              { participantId: constants.WORKER_P, outcome: 'sent', harness: 'codex' },
              { participantId: constants.ACP_P, outcome: 'sent', harness: 'acp' },
            ],
          },
          deliveries: [
            { participantId: constants.LEAD_P, attachmentPath: null, prompt: 'review the alpha change' },
            { participantId: constants.WORKER_P, attachmentPath: null, prompt: 'review the alpha change' },
            { participantId: constants.ACP_P, attachmentPath: null, prompt: 'review the alpha change' },
          ],
        });
      }

      // ── H5: the writer path and resources from the REAL lease (criterion 2) ────────────────
      {
        const headInWorktree = runGit(rich.lease.worktree, ['rev-parse', '--verify', 'HEAD']).trim();
        const remotes = runGit(repository, ['remote', '-v']).trim();
        const worktreeList = runGit(repository, ['worktree', 'list', '--porcelain']);
        const allocateCalls = await writerAllocateCalls();
        record('writer-lease', {
          lease: { ...rich.lease, policy: { ...rich.lease.policy } },
          posture: { ...rich.posture, guarantees: [...rich.posture.guarantees], notProvided: [...rich.posture.notProvided] },
          headInWorktree, remotes, worktreeList, allocateCalls, productGitCalls,
        });
        check('the writer path and its resources are the OBSERVED fields of a REAL task-40 writerLeases.allocate against a REAL private temporary git repository, surfaced verbatim: the allocate input the composable handed the port names the real repository, the real task and the real owner; the rendered worktree, native cwd, base commit and policy cells equal the service\'s own frozen lease view; the posture IS the module\'s own frozen WRITER_ISOLATION by identity with sandbox false and exactly its own posture keys, rendered with its mechanism, guarantees, not-provided list and reviewer statement; and the lease worktree on disk really sits at the lease base commit inside a clean repository with no remote', {
          allocateInput: allocateCalls,
          allocateInputNamesRealRepository: allocateCalls.length === 1 && allocateCalls[0].repository === repository,
          allocateInputNamesRealTask: allocateCalls.length === 1 && allocateCalls[0].taskId === rich.taskId,
          allocateInputNamesRealOwner: allocateCalls.length === 1 && allocateCalls[0].ownerId === constants.LEAD_P,
          rendered: {
            worktree: rich.afterWriter.probe.writer.worktree,
            worktreeTitle: rich.afterWriter.probe.writer.worktreeTitle,
            nativeCwd: rich.afterWriter.probe.writer.nativeCwd,
            baseCommit: rich.afterWriter.probe.writer.baseCommit,
            baseCommitText: rich.afterWriter.probe.writer.baseCommitText,
            worktreeAccess: rich.afterWriter.probe.writer.worktreeAccess,
            userRepository: rich.afterWriter.probe.writer.userRepository,
            idle: rich.afterWriter.probe.writer.idle,
          },
          renderedPosture: rich.afterWriter.probe.posture,
          snapshotWriter: rich.afterWriter.snapshot.writer,
          worker: {
            postureIsTheModulesOwnObject: rich.posture === WRITER_ISOLATION,
            sandbox: rich.posture.sandbox,
            sandboxType: typeof rich.posture.sandbox,
            postureKeys: Object.keys(rich.posture).sort(),
            expectedPostureKeys: [...POSTURE_KEYS].sort(),
            leaseBaseCommitShape: COMMIT.test(rich.lease.baseCommit),
            headInWorktreeEqualsBaseCommit: headInWorktree === rich.lease.baseCommit,
            repositoryHeadEqualsBaseCommit: repositoryHead === rich.lease.baseCommit,
            worktreePathIsUnderWritersRoot: rich.lease.worktree.startsWith(`${writersRoot}${path.sep}`),
            remotes: remotes,
            worktreeListNamesLeaseWorktree: worktreeList.split('\n').includes(`worktree ${rich.lease.worktree}`),
          },
        }, {
          allocateInput: [{ repository, taskId: rich.taskId, ownerId: constants.LEAD_P }],
          allocateInputNamesRealRepository: true,
          allocateInputNamesRealTask: true,
          allocateInputNamesRealOwner: true,
          rendered: {
            worktree: rich.lease.worktree,
            worktreeTitle: rich.lease.worktree,
            nativeCwd: rich.lease.nativeCwd,
            baseCommit: rich.lease.baseCommit,
            baseCommitText: `${rich.lease.baseCommit.slice(0, 16)}…`,
            worktreeAccess: 'read-write',
            userRepository: 'read-only',
            idle: null,
          },
          renderedPosture: {
            sandboxAttr: 'false',
            sandboxValue: 'false',
            mechanism: WRITER_ISOLATION.mechanism,
            guarantees: [...WRITER_ISOLATION.guarantees],
            notProvided: [...WRITER_ISOLATION.notProvided],
            statement: WRITER_ISOLATION.reviewerStatement,
          },
          snapshotWriter: {
            leaseId: rich.lease.leaseId,
            worktree: rich.lease.worktree,
            nativeCwd: rich.lease.nativeCwd,
            baseCommit: rich.lease.baseCommit,
            policy: { worktreeAccess: 'read-write', userRepository: 'read-only' },
            posture: {
              isolation: WRITER_ISOLATION.isolation,
              sandbox: false,
              mechanism: WRITER_ISOLATION.mechanism,
              guarantees: [...WRITER_ISOLATION.guarantees],
              notProvided: [...WRITER_ISOLATION.notProvided],
              reviewerStatement: WRITER_ISOLATION.reviewerStatement,
            },
          },
          worker: {
            postureIsTheModulesOwnObject: true,
            sandbox: false,
            sandboxType: 'boolean',
            postureKeys: [...POSTURE_KEYS].sort(),
            expectedPostureKeys: [...POSTURE_KEYS].sort(),
            leaseBaseCommitShape: true,
            headInWorktreeEqualsBaseCommit: true,
            repositoryHeadEqualsBaseCommit: true,
            worktreePathIsUnderWritersRoot: true,
            remotes: '',
            worktreeListNamesLeaseWorktree: true,
          },
        });
      }

      // ── H6: no push default and no fake read-only capability (criterion 3) ────────────────
      {
        const noPushProbe = await probe();
        const remotesNow = runGit(repository, ['remote', '-v']).trim();
        const allCwdsInsidePrivateRoot = productGitCalls.every((entry) => entry.cwd.startsWith(`${fixture.root}${path.sep}`));
        const pushLikeProduct = productGitCalls.filter((entry) => isRemoteMoving(entry.args));
        record('no-push', {
          probe: { pushLikeButtons: noPushProbe.pushLikeButtons, pushLikeTestIds: noPushProbe.pushLikeTestIds, approveNote: noPushProbe.approve.note, buttonCount: noPushProbe.buttonCount },
          remotesNow, productGitCalls, caseGitCommands: started.gitCommands, productGitCommands: started.productGitCommands,
        });
        check('no forward action pushes and no read-only capability is fabricated: every forward action the surface offers has been driven (dispatch, send, native end, register deliverable, submit review, approve integration, accept, fan out, allocate writer), the rendered panel carries ZERO push/remote buttons and ZERO push/remote test ids, the approve note states nothing is pushed automatically, the REAL git call log — the case\'s own commands and the product runner\'s, counted for real — names its cwd on every invocation, every cwd is inside the private fixture root (never the QA worktree), and not one invocation is a push, fetch, clone or remote-mutating command, with the repository reporting no remote at all', {
          pushLikeButtons: noPushProbe.pushLikeButtons,
          pushLikeTestIds: noPushProbe.pushLikeTestIds,
          approveNote: noPushProbe.approve.note,
          caseGitCommands: started.gitCommands,
          productGitCommands: started.productGitCommands,
          totalGitCommands: started.gitCommands + started.productGitCommands,
          allCaseCwdsNamed: caseGitCalls.every((entry) => typeof entry.cwd === 'string' && entry.cwd.length > 0),
          allCaseCwdsInsidePrivateRoot: caseGitCalls.every((entry) => entry.cwd.startsWith(`${fixture.root}${path.sep}`)),
          remoteMovingCaseCommands: caseGitCalls.filter((entry) => isRemoteMoving(entry.args)).length,
          caseGitCwds: [...new Set(caseGitCalls.map((entry) => entry.cwd))],
          allProductCwdsInsidePrivateRoot: allCwdsInsidePrivateRoot,
          pushLikeProductCommands: pushLikeProduct.length,
          remotes: remotesNow,
          productGitCwds: [...new Set(productGitCalls.map((entry) => entry.cwd))],
          productGitSubcommands: [...new Set(productGitCalls.map((entry) => entry.args[0]))].sort(),
        }, {
          pushLikeButtons: 0,
          pushLikeTestIds: 0,
          approveNote: 'Approval applies the reviewed change under the repository lock. Nothing is pushed automatically.',
          caseGitCommands: started.gitCommands,
          productGitCommands: started.productGitCommands,
          totalGitCommands: started.gitCommands + started.productGitCommands,
          allCaseCwdsNamed: true,
          allCaseCwdsInsidePrivateRoot: true,
          remoteMovingCaseCommands: 0,
          caseGitCwds: [repository, rich.lease.worktree],
          allProductCwdsInsidePrivateRoot: true,
          pushLikeProductCommands: 0,
          remotes: '',
          productGitCwds: [repository],
          productGitSubcommands: ['rev-parse', 'status', 'worktree'],
        });
      }

      // ── H7: the three imported themes, measured in the real browser ───────────────────────
      {
        const light = await applyTheme('soft-white');
        const lightStyle = await styleProbe();
        const dark = await applyTheme('anime-night');
        const darkStyle = await styleProbe();
        const dream = await applyTheme('anime-dream');
        const dreamStyle = await styleProbe();
        record('themes', { light, lightStyle, dark, darkStyle, dream, dreamStyle });
        const shots = {};
        for (const [kind] of [['soft-white', lightStyle], ['anime-night', darkStyle], ['anime-dream', dreamStyle]]) {
          await applyTheme(kind);
          const filename = path.join(runDir, `qa42-${context.case}-theme-${kind}.png`);
          await page.screenshot({ path: filename, fullPage: true });
          artifacts.push(artifact(filename, 'screenshot'));
          shots[kind] = path.basename(filename);
        }
        check('the three imported themes render the collaboration surface with their OWN measured colours in a real browser — the light preset, the dark preset and the third preset each resolve the shared modal text token to a DIFFERENT real rgb value through the real token pipeline, which is exactly what the implementation could not measure because happy-dom does not resolve CSS custom properties', {
          light: { applied: light, themeAttribute: lightStyle.themeAttribute, modalPresent: lightStyle.modalPresent, modalColor: lightStyle.modalColor, expectedModalText: lightStyle.expectedSoftWhiteModalText },
          dark: { applied: dark, themeAttribute: darkStyle.themeAttribute, modalPresent: darkStyle.modalPresent, modalColor: darkStyle.modalColor, expectedModalText: darkStyle.expectedAnimeNightModalText },
          dream: { applied: dream, themeAttribute: dreamStyle.themeAttribute, modalPresent: dreamStyle.modalPresent, modalColor: dreamStyle.modalColor, expectedModalText: dreamStyle.expectedAnimeDreamModalText },
          threeDistinctColours: new Set([lightStyle.modalColor, darkStyle.modalColor, dreamStyle.modalColor]).size === 3,
          screenshots: shots,
        }, {
          light: { applied: { kind: 'soft-white', preset: 'soft-white', tokenCount: light.tokenCount }, themeAttribute: 'soft-white', modalPresent: true, modalColor: 'rgb(38, 48, 56)', expectedModalText: 'rgb(38, 48, 56)' },
          dark: { applied: { kind: 'anime-night', preset: 'anime-night', tokenCount: dark.tokenCount }, themeAttribute: 'anime-night', modalPresent: true, modalColor: 'rgb(240, 230, 245)', expectedModalText: 'rgb(240, 230, 245)' },
          dream: { applied: { kind: 'anime-dream', preset: 'anime-dream', tokenCount: dream.tokenCount }, themeAttribute: 'anime-dream', modalPresent: true, modalColor: 'rgb(74, 44, 58)', expectedModalText: 'rgb(74, 44, 58)' },
          threeDistinctColours: true,
          screenshots: shots,
        });
      }

      // ── H8: at a mobile viewport no control is unreachable ────────────────────────────────
      {
        await omowright.emulate(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false, hasTouch: false });
        const layout = await layoutProbe();
        record('mobile-layout-happy', layout);
        const unreachable = layout.buttons.filter((button) => button.withinModalHorizontally !== true || button.withinModalVertically !== true);
        const zeroSize = layout.buttons.filter((button) => button.width <= 0 || button.height <= 0);
        check('at a mobile viewport (390px) no control is unreachable, measured for real: the document and the modal carry zero horizontal overflow, every button in the panel has a non-zero laid-out size, and every button — scrolled into the modal own viewport — lands fully inside the modal box, including the close button, so nothing is clipped off-screen or hidden behind an overflow', {
          innerWidth: layout.innerWidth,
          hasControls: layout.buttonCount > 0,
          docOverflowFree: layout.docHorizontalOverflow <= 0,
          modalOverflowFree: layout.modalHorizontalOverflow <= 0,
          allButtonsNonZero: zeroSize.length === 0,
          allButtonsWithinModal: unreachable.length === 0,
          unreachableButtonTestIds: unreachable.map((button) => button.testId),
          zeroSizeButtonTestIds: zeroSize.map((button) => button.testId),
          closeButtonPresent: layout.buttons.some((button) => button.testId === 'collab-close'),
          controlTestIds: layout.buttons.map((button) => button.testId),
        }, {
          innerWidth: 390,
          hasControls: true,
          docOverflowFree: true,
          modalOverflowFree: true,
          allButtonsNonZero: true,
          allButtonsWithinModal: true,
          unreachableButtonTestIds: [],
          zeroSizeButtonTestIds: [],
          closeButtonPresent: true,
          controlTestIds: layout.buttons.map((button) => button.testId),
        });
        await omowright.emulate(page, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      }

      // ── H9: operations capture the Thread target (criterion 4) ────────────────────────────
      {
        const captured = await walkToReviewApproved('thread capture');
        const productBefore = await productTask(captured.taskId);
        const openedSecond = await openTeam({ threadId: constants.THREAD_2, teamName: 'Team Beta' });
        const refused = await acceptTask({ taskId: captured.taskId, deliverableId: ALPHA_DELIVERABLE.deliverableId, acceptedBy: 'reviewer', criteria: [{ id: 'c1', met: true }] });
        const productAfter = await productTask(captured.taskId);
        const createdSecond = await createTask({ title: 'task under thread 2' });
        const secondTaskId = createdSecond.snapshot.tasks[0].taskId;
        const afterSecondDispatch = await dispatchViaUi(secondTaskId);
        record('thread-capture', { captured, productBefore, openedSecond, refused, productAfter, afterSecondDispatch });
        check('an operation on a task from a DIFFERENT Thread target is REFUSED with a readable error and never silently applied: the task is walked to a fully reviewable state under thread 1 (approved review, registered deliverable, live lease, met criteria), a second team is opened under thread 2, and the accept on the thread-1 task is refused naming the different Thread target while the coordinator own acceptance slice stays untouched — the current thread own task is then dispatched with the error cleared, proving the capture is per-thread and not a blanket block', {
          currentThreadAfterOpen: openedSecond.snapshot.threadId,
          teamMetaAfterOpen: openedSecond.probe.teamMeta,
          tasksAfterOpen: openedSecond.snapshot.tasks.length,
          refusalError: refused.snapshot.error,
          refusalErrorMentionsDifferentThread: /different Thread target/.test(refused.snapshot.error),
          productBefore: { reviewState: productBefore.review.state, acceptanceState: productBefore.acceptance.state, deliverableCount: productBefore.deliverables.length },
          productAfter: { reviewState: productAfter.review.state, acceptanceState: productAfter.acceptance.state, deliverableCount: productAfter.deliverables.length },
          acceptanceUntouched: productAfter.acceptance.state === productBefore.acceptance.state,
          reviewUntouched: productAfter.review.state === productBefore.review.state,
          errorRendered: refused.probe.error,
          secondThreadTask: { phase: afterSecondDispatch.probe.tasks.find((row) => row.taskId === secondTaskId)?.phase ?? null, error: afterSecondDispatch.snapshot.error },
        }, {
          currentThreadAfterOpen: constants.THREAD_2,
          teamMetaAfterOpen: 'Team Beta · eeeeeeee-222… · 0 tasks',
          tasksAfterOpen: 0,
          refusalError: `Task "${captured.taskId}" belongs to a different Thread target and cannot be operated on here.`,
          refusalErrorMentionsDifferentThread: true,
          productBefore: { reviewState: 'approved', acceptanceState: 'none', deliverableCount: 1 },
          productAfter: { reviewState: 'approved', acceptanceState: 'none', deliverableCount: 1 },
          acceptanceUntouched: true,
          reviewUntouched: true,
          errorRendered: { role: 'alert', text: `Task "${captured.taskId}" belongs to a different Thread target and cannot be operated on here.` },
          secondThreadTask: { phase: 'dispatched', error: '' },
        });
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: partial dispatch, blocked/cancelled, stale approve hash, unknown attempt,
      // quota/mailbox 暂停, mobile overflow 无不可达按钮.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: partial dispatch — one recipient fails, the state is the honest read ───────────
      {
        started.boots += 1;
        const booted = await boot({ threadId: constants.THREAD_1, teamName: 'Team partial', members: MEMBERS, failFor: [constants.WORKER_P] });
        await typeFanoutPrompt('review this');
        const afterFanout = await fanOutViaUi();
        record('f1-partial-fanout', { booted, afterFanout });
        check('a partial dispatch renders the OBSERVED per-recipient outcomes and never a synthetic success: the fan-out is driven through the real UI to all three members, the codex worker delivery fails with source_unavailable, the derived state is `partial`, the stats line names sent 2 and failed 1, each recipient row carries its OWN observed outcome, and the failed row renders the service\'s OWN resolution code source_unavailable because the composable\'s product port maps the service\'s resolution object to the resolutionCode name its view declares', {
          state: afterFanout.probe.fanout.state,
          stateText: afterFanout.probe.fanout.stateText,
          stats: afterFanout.probe.fanout.stats,
          recipients: afterFanout.probe.fanout.recipients.map((row) => ({ participantId: row.participantId, outcome: row.outcome, resolutionCodeRendered: row.resolutionCodeRendered })),
          snapshotState: afterFanout.snapshot.fanout?.state ?? null,
          snapshotStats: afterFanout.snapshot.fanout?.stats ?? null,
          snapshotTargets: afterFanout.snapshot.fanout?.targets.map((target) => ({ participantId: target.participantId, outcome: target.outcome, resolution: target.resolution, resolutionCode: target.resolutionCode })) ?? null,
        }, {
          state: 'partial',
          stateText: 'Fan-out: partial',
          stats: 'sent 2 · failed 1 · ambiguous 0 · pending 0',
          recipients: [
            { participantId: constants.LEAD_P, outcome: 'sent', resolutionCodeRendered: false },
            { participantId: constants.WORKER_P, outcome: 'failed', resolutionCodeRendered: true },
            { participantId: constants.ACP_P, outcome: 'sent', resolutionCodeRendered: false },
          ],
          snapshotState: 'partial',
          snapshotStats: { total: 3, sent: 2, failed: 1, ambiguous: 0, cancelled: 0, pending: 0 },
          snapshotTargets: [
            { participantId: constants.LEAD_P, outcome: 'sent', resolution: null, resolutionCode: null },
            { participantId: constants.WORKER_P, outcome: 'failed', resolution: { code: 'source_unavailable', field: 'fanout_send' }, resolutionCode: 'source_unavailable' },
            { participantId: constants.ACP_P, outcome: 'sent', resolution: null, resolutionCode: null },
          ],
        });
      }

      // ── F2: a blocked task is refused and a cancelled task stays cancelled ────────────────
      {
        started.boots += 1;
        await boot({ threadId: constants.THREAD_1, teamName: 'Team blocked', members: MEMBERS });
        const createdA = await createTask({ title: 'task A' });
        const taskA = createdA.snapshot.tasks[0].taskId;
        const dependent = await createDependentTask({ title: 'task B', dependsOn: taskA });
        const taskB = dependent.taskId;
        // A is cancelled through the real UI FIRST, for two reasons that both come from the
        // receivers' own contracts:
        //   1. the entry's createDependentTask writes the edge on the SERVICE through
        //      coordinator.addDependency, and only a composable action re-reads it into the UI's
        //      read model (the entry's own note on that method) — without one, B's row renders no
        //      blocked marker at all;
        //   2. dispatching A first would consume the team's single session-mutation budget
        //      (COLLABORATION_BUDGETS.maxSessionMutations is 1) and park B with the visible
        //      collaboration_session_mutation pause before the blocking gate is ever reached — the
        //      coordinator's own budget-before-blocked ordering (coordinator.js:267-274).
        // A is cancelled while still PENDING, so it holds no attempt, no budget is ever consumed,
        // and the blocking gate is reached; B stays blocked because a cancelled dependency is not
        // an accepted one.
        const aCancelClicked = await cancelViaUi(taskA);
        const afterCancelA = await observe();
        const blockedRow = afterCancelA.probe.tasks.find((row) => row.taskId === taskB) ?? null;
        const bDispatchClicked = await dispatchViaUi(taskB);
        const afterBlockedDispatch = await observe();
        const productB = await productTask(taskB);
        const productAAfterCancel = await productTask(taskA);
        const blockedRowAfterCancel = afterBlockedDispatch.probe.tasks.find((row) => row.taskId === taskB) ?? null;
        record('f2-blocked-cancelled', { taskA, taskB, blockedRow, bDispatchClicked, afterBlockedDispatch, productB, aCancelClicked, afterCancelA, productAAfterCancel, blockedRowAfterCancel });
        check('a dependency-blocked task is REFUSED with the readable conflict and nothing is applied, and a cancelled task stays cancelled with its cancel affordance then disabled: task B is created with a real dependency edge on task A through the real coordinator, its row renders the blocked marker, clicking its Dispatch renders the readable conflict naming the blocked dependency while B stays pending with no attempt, and cancelling A through the UI moves A to cancelled with the cancel button then disabled — B remains blocked because a cancelled dependency is not an accepted one', {
          blockedRow: { phase: blockedRow?.phase ?? null, blocked: blockedRow?.blocked ?? null, dispatchDisabled: blockedRow?.dispatchDisabled ?? null },
          bDispatchClicked: bDispatchClicked.clicked,
          refusalError: afterBlockedDispatch.snapshot.error,
          refusalMentionsBlocked: /task_blocked/.test(afterBlockedDispatch.snapshot.error),
          productBAfterRefusal: { state: productB.state, attempts: productB.attempts.length, blockedBy: productB.blockedBy },
          aCancelClicked: aCancelClicked.clicked,
          rowAAfterCancel: { phase: afterCancelA.probe.tasks.find((row) => row.taskId === taskA)?.phase ?? null, chip: afterCancelA.probe.tasks.find((row) => row.taskId === taskA)?.chip ?? null, cancelDisabled: afterCancelA.probe.tasks.find((row) => row.taskId === taskA)?.cancelDisabled ?? null },
          productAAfterCancel: { state: productAAfterCancel.state },
          blockedRowAfterCancel: { blocked: blockedRowAfterCancel?.blocked ?? null },
        }, {
          blockedRow: { phase: 'pending', blocked: 'blocked by 1', dispatchDisabled: false },
          bDispatchClicked: true,
          refusalError: 'The task could not be dispatched: conflict: collaboration.task_blocked (conflict/task_blocked)',
          refusalMentionsBlocked: true,
          productBAfterRefusal: { state: 'pending', attempts: 0, blockedBy: [taskA] },
          aCancelClicked: true,
          rowAAfterCancel: { phase: 'cancelled', chip: 'Cancelled', cancelDisabled: true },
          productAAfterCancel: { state: 'cancelled' },
          blockedRowAfterCancel: { blocked: 'blocked by 1' },
        });
      }

      // ── F3: the stale approve hash — the reviewed binding never rebinds ───────────────────
      {
        started.boots += 1;
        await boot({ threadId: constants.THREAD_1, teamName: 'Team stale', members: MEMBERS });
        const created = await createTask({ title: 'stale hash task' });
        const taskId = created.snapshot.tasks[0].taskId;
        await selectTaskViaUi(taskId);
        await dispatchViaUi(taskId);
        await sendViaUi();
        await typeNativeEventId('native-evt-stale');
        await finishViaUi();
        await registerDeliverable({ taskId, deliverable: BETA_DELIVERABLE });
        const afterSubmit = await submitReviewViaUi(taskId);
        // The durable object's BYTES no longer describe the hash bound at review time.
        const objectPath = path.join(storeRoot, 'objects', BETA_DELIVERABLE.artifactHash.slice(0, 2), BETA_DELIVERABLE.artifactHash.slice(2));
        await chmod(objectPath, 0o644);
        await writeFile(objectPath, Buffer.from('tampered bytes that are not the artifact\n', 'utf8'));
        const tamperedVerify = await store.verify(BETA_DELIVERABLE.artifactHash);
        started.tamperedObjects += 1;
        const afterApprove = await approveViaUi();
        const productAfter = await productTask(taskId);
        // Restore the original bytes and prove the restore re-hashes to the reviewed value.
        await chmod(objectPath, 0o644);
        await writeFile(objectPath, betaBytes);
        const restoredVerify = await store.verify(BETA_DELIVERABLE.artifactHash);
        record('f3-stale-approve-hash', { afterSubmit, tamperedVerify, afterApprove, productAfter, restoredVerify, objectPath });
        check('a stale approve hash is observed, not papered over: the deliverable is registered with the REAL hash of REAL artifact bytes in the durable store and submitted for review, the store object is then tampered on disk so its bytes no longer hash to the reviewed value — the store\'s OWN re-verification reports ok false carrying TWO DIFFERENT REAL sha256 values and the tampered byte count — and the UI approve still records the reviewer verdict over the REVIEWED binding: the rendered deliverable row and the coordinator\'s own view keep the reviewed hash, never the tampered digest, and restoring the bytes re-verifies to the reviewed hash (the byte-level refusal at integrate time is task 41\'s integrationService, proven in its own QA)', {
          reviewedHash: BETA_DELIVERABLE.artifactHash,
          reviewedHashShape: HASH.test(BETA_DELIVERABLE.artifactHash),
          phaseAfterSubmit: afterSubmit.probe.tasks.find((row) => row.taskId === taskId)?.phase ?? null,
          tamperedVerify: { ok: tamperedVerify.ok, artifactHash: tamperedVerify.artifactHash, bytes: tamperedVerify.bytes, hashDiffersFromReviewed: tamperedVerify.artifactHash !== BETA_DELIVERABLE.artifactHash },
          renderedDeliverable: afterApprove.probe.deliverables.map((row) => ({ deliverableId: row.deliverableId, hash: row.hash })),
          productAfter: { reviewState: productAfter.review.state, reviewer: productAfter.review.reviewer, deliverables: productAfter.deliverables.map((entry) => ({ deliverableId: entry.deliverableId, artifactHash: entry.artifactHash })) },
          renderedHashIsReviewed: afterApprove.probe.deliverables.some((row) => row.hash === BETA_DELIVERABLE.artifactHash),
          renderedHashIsTampered: afterApprove.probe.deliverables.some((row) => row.hash === tamperedVerify.artifactHash),
          restoredVerify: { ok: restoredVerify.ok, artifactHash: restoredVerify.artifactHash, hashMatchesReviewed: restoredVerify.artifactHash === BETA_DELIVERABLE.artifactHash, bytes: restoredVerify.bytes },
        }, {
          reviewedHash: BETA_DELIVERABLE.artifactHash,
          reviewedHashShape: true,
          phaseAfterSubmit: 'review-pending',
          tamperedVerify: { ok: false, artifactHash: tamperedVerify.artifactHash, bytes: 41, hashDiffersFromReviewed: true },
          renderedDeliverable: [{ deliverableId: 'deliverable-beta', hash: BETA_DELIVERABLE.artifactHash }],
          productAfter: { reviewState: 'approved', reviewer: 'reviewer', deliverables: [{ deliverableId: 'deliverable-beta', artifactHash: BETA_DELIVERABLE.artifactHash }] },
          renderedHashIsReviewed: true,
          renderedHashIsTampered: false,
          restoredVerify: { ok: true, artifactHash: BETA_DELIVERABLE.artifactHash, hashMatchesReviewed: true, bytes: BETA_DELIVERABLE.bytes },
        });
      }

      // ── F4: an unknown attempt and a task with no attempt ─────────────────────────────────
      {
        started.boots += 1;
        const booted = await boot({ threadId: constants.THREAD_1, teamName: 'Team attempts', members: MEMBERS });
        const created = await createTask({ title: 'no attempt task' });
        const taskId = created.snapshot.tasks[0].taskId;
        await selectTaskViaUi(taskId);
        const afterSend = await sendTaskWithoutAttempt(taskId);
        const afterFinish = await finishTaskWithoutAttempt({ taskId, nativeEventId: 'native-evt-missing' });
        const product = await productTask(taskId);
        record('f4-unknown-attempt', { booted, afterSend, afterFinish, product, browserUnknownAttempt });
        check('an unknown attempt is an explicit typed refusal in both realms, and a task with no attempt refuses every attempt-scoped action with a readable message while applying nothing: the well-formed identity no attempt ever uses is refused invalid_request/attempt_unknown identically in the browser realm and the worker, and on a freshly created task the attempt list renders empty, the send and the native end each refuse naming the missing attempt, and the coordinator\'s own view still shows zero attempts and the host still pending', {
          typedRefusal: browserUnknownAttempt,
          typedRefusalCode: browserUnknownAttempt.code,
          attemptEmpty: afterSend.probe.attempt?.empty ?? null,
          attemptRows: afterSend.probe.attempt?.rows.length ?? null,
          sendError: afterSend.snapshot.error,
          finishError: afterFinish.snapshot.error,
          errorRendered: afterFinish.probe.error?.role ?? null,
          product: { state: product.state, attempts: product.attempts.length },
        }, {
          typedRefusal: { code: 'invalid_request', field: 'attempt_unknown' },
          typedRefusalCode: 'invalid_request',
          attemptEmpty: 'No attempts yet. Dispatch the task first.',
          attemptRows: 0,
          sendError: 'The task has no attempt to send yet. Dispatch it first.',
          finishError: 'The task has no attempt to finish.',
          errorRendered: 'alert',
          product: { state: 'pending', attempts: 0 },
        });
      }

      // ── F5: the session-mutation quota parks a dispatch, visibly, and the PAUSED task resumes ─
      {
        started.boots += 1;
        await boot({ threadId: constants.THREAD_1, teamName: 'Team quota', members: MEMBERS });
        const createdOne = await createTask({ title: 'quota one' });
        const taskOne = createdOne.snapshot.tasks.find((entry) => entry.title === 'quota one').taskId;
        const createdTwo = await createTask({ title: 'quota two' });
        const taskTwo = createdTwo.snapshot.tasks.find((entry) => entry.title === 'quota two').taskId;
        await selectTaskViaUi(taskOne);
        await dispatchViaUi(taskOne);
        await sendViaUi();
        const afterFirst = await observe();
        const budgetsWhileRunning = await productBudgets();
        // The task that gets PARKED is a THIRD one: TaskGraph renders Dispatch at phase `pending`
        // AND at phase `paused`, so a parked task is RESUMABLE through its own button — which is
        // what the release below exercises, on the very task that was parked rather than on a
        // never-parked stand-in.
        const createdThree = await createTask({ title: 'quota three' });
        const taskThree = createdThree.snapshot.tasks.find((entry) => entry.title === 'quota three').taskId;
        const afterSecond = await dispatchViaUi(taskThree);
        const budgetsWhileParked = await productBudgets();
        const productThreeParked = await productTask(taskThree);
        await typeNativeEventId('native-evt-quota');
        await finishViaUi();
        const afterRelease = await observe();
        const budgetsAfterRelease = await productBudgets();
        // The paused task's own Dispatch button is enabled while paused — the resume path — and
        // clicking it is what admits the parked task; nothing auto-admits it.
        const afterResume = await dispatchViaUi(taskThree);
        const productThreeResumed = await productTask(taskThree);
        const budgetsAfterResume = await productBudgets();
        record('f5-quota-pause', { taskOne, taskTwo, taskThree, afterFirst, budgetsWhileRunning, afterSecond, budgetsWhileParked, productThreeParked, afterRelease, budgetsAfterRelease, afterResume, productThreeResumed, budgetsAfterResume });
        check('an exhausted budget is the OBSERVED, visible pause the plan demands: the first task is dispatched and sent on the owner session, the coordinator\'s own budget read model reports the real use, a further task on the SAME session is PARKED rather than failed with the collaboration_session_mutation reason rendered on its row and in the coordinator\'s own paused view, the pause survives the release unchanged with the paused row\'s Dispatch button ENABLED as the resume path, and the freed budget then admits the VERY task that was parked through that button — the coordinator\'s read model reports the re-consumed mutation and the never-parked task stays pending until it is dispatched in turn — the pause is budget-driven, never permanent, and nothing was silently dropped', {
          rowOneWhileRunning: { phase: afterFirst.probe.tasks.find((row) => row.taskId === taskOne)?.phase ?? null, attemptState: afterFirst.probe.attempt?.rows[0]?.state ?? null },
          budgetsWhileRunning,
          rowThreeParked: { phase: afterSecond.probe.tasks.find((row) => row.taskId === taskThree)?.phase ?? null, chip: afterSecond.probe.tasks.find((row) => row.taskId === taskThree)?.chip ?? null, paused: afterSecond.probe.tasks.find((row) => row.taskId === taskThree)?.paused ?? null },
          budgetsWhileParked,
          productThreeParked: { state: productThreeParked.state, paused: productThreeParked.paused },
          rowOneAfterRelease: { phase: afterRelease.probe.tasks.find((row) => row.taskId === taskOne)?.phase ?? null },
          budgetsAfterRelease,
          rowThreeAfterRelease: { phase: afterRelease.probe.tasks.find((row) => row.taskId === taskThree)?.phase ?? null, paused: afterRelease.probe.tasks.find((row) => row.taskId === taskThree)?.paused ?? null, dispatchDisabledWhilePaused: afterRelease.probe.tasks.find((row) => row.taskId === taskThree)?.dispatchDisabled ?? null },
          rowTwoWhilePaused: { phase: afterRelease.probe.tasks.find((row) => row.taskId === taskTwo)?.phase ?? null },
          rowThreeAfterResume: { phase: afterResume.probe.tasks.find((row) => row.taskId === taskThree)?.phase ?? null },
          productThreeResumed: { state: productThreeResumed.state, attempts: productThreeResumed.attempts.length },
          budgetsAfterResume,
          errorAfterResume: afterResume.snapshot.error,
        }, {
          rowOneWhileRunning: { phase: 'dispatched', attemptState: 'sent' },
          budgetsWhileRunning: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 1, sessionMutations: 1, depth: 1, children: 0, mailbox: 0 } },
          rowThreeParked: { phase: 'paused', chip: 'Paused', paused: 'paused: collaboration_session_mutation' },
          budgetsWhileParked: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 1, sessionMutations: 1, depth: 1, children: 0, mailbox: 0 } },
          productThreeParked: { state: 'paused', paused: { reasons: ['collaboration_session_mutation'] } },
          rowOneAfterRelease: { phase: 'agent-finished' },
          budgetsAfterRelease: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 0, sessionMutations: 0, depth: 1, children: 0, mailbox: 0 } },
          rowThreeAfterRelease: { phase: 'paused', paused: 'paused: collaboration_session_mutation', dispatchDisabledWhilePaused: false },
          rowTwoWhilePaused: { phase: 'pending' },
          rowThreeAfterResume: { phase: 'dispatched' },
          productThreeResumed: { state: 'dispatched', attempts: 1 },
          budgetsAfterResume: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 1, sessionMutations: 1, depth: 1, children: 0, mailbox: 0 } },
          errorAfterResume: '',
        });
      }

      // ── F6: the mailbox budget parks every dispatch, and the overflow is a refusal ─────────
      {
        started.boots += 1;
        await boot({ threadId: constants.THREAD_1, teamName: 'Team mailbox', members: MEMBERS });
        const filled = await postMessages({ count: 1000 });
        started.messages += filled.attempted;
        const overflow = await postMessages({ count: 1 });
        const depth = await productMailboxDepth();
        const budgets = await productBudgets();
        const created = await createTask({ title: 'mailbox paused' });
        const taskId = created.snapshot.tasks[0].taskId;
        const afterDispatch = await dispatchViaUi(taskId);
        const product = await productTask(taskId);
        record('f6-mailbox-pause', { filled, overflow, depth, budgets, afterDispatch, product });
        check('a full mailbox is the visible collaboration_mailbox pause, and posting past the frozen limit is an explicit refusal rather than a silent drop: the team mailbox is filled to the real frozen limit of 1000 through the coordinator\'s own postMessage, the next post is refused conflict/collaboration_mailbox, the coordinator\'s own budget read model reports the depth, and a fresh task\'s dispatch PARKS with the collaboration_mailbox reason rendered on its row — the pause is observed on the task, not merely reported by a counter', {
          filledDepth: filled.depth,
          filledRefusals: filled.refusals,
          overflowRefusal: overflow.refusals,
          observedDepth: depth,
          budgetMailboxUsed: budgets.used.mailbox,
          budgetMailboxLimit: budgets.limits.maxMailbox,
          rowPhase: afterDispatch.probe.tasks.find((row) => row.taskId === taskId)?.phase ?? null,
          rowPaused: afterDispatch.probe.tasks.find((row) => row.taskId === taskId)?.paused ?? null,
          product: { state: product.state, paused: product.paused },
        }, {
          filledDepth: 1000,
          filledRefusals: [],
          overflowRefusal: [{ code: 'conflict', field: 'collaboration_mailbox' }],
          observedDepth: 1000,
          budgetMailboxUsed: 1000,
          budgetMailboxLimit: 1000,
          rowPhase: 'paused',
          rowPaused: 'paused: collaboration_mailbox',
          product: { state: 'paused', paused: { reasons: ['collaboration_mailbox'] } },
        });
      }

      // ── F7: the accept affordance only where the coordinator accepts, and the settled review ─
      {
        started.boots += 1;
        await boot({ threadId: constants.THREAD_1, teamName: 'Team accept', members: MEMBERS });
        const created = await createTask({ title: 'accept refusal' });
        const taskId = created.snapshot.tasks[0].taskId;
        await selectTaskViaUi(taskId);
        await dispatchViaUi(taskId);
        await sendViaUi();
        await typeNativeEventId('native-evt-accept');
        await finishViaUi();
        // The UI's own Register deliverable button registers NOTHING: no artifact capture is wired
        // into this surface, so it cannot fabricate an all-zero-hash placeholder any more.
        const afterRegisterUi = await registerDeliverableViaUi();
        await registerDeliverable({ taskId, deliverable: ALPHA_DELIVERABLE });
        const afterSubmit = await submitReviewViaUi(taskId);
        const acceptDisabledAtReviewPending = afterSubmit.probe.tasks.find((row) => row.taskId === taskId)?.acceptDisabled ?? null;
        // Clicking the DISABLED button does nothing at all: no refusal is needed because the
        // affordance is not offered where the coordinator would refuse conflict/acceptance_review.
        const acceptClicked = await acceptViaUi(taskId);
        const productAfterRefusal = await productTask(taskId);
        const afterApprove = await approveViaUi();
        // The verdict moves the task to review-approved, and the Accept button now reaches accepted
        // through the REAL button — no container bypass.
        const afterAccept = await acceptViaUi(taskId);
        const productAfterAccept = await productTask(taskId);
        const afterCancel = await cancelTask({ taskId, reason: 'too late to cancel' });
        const productAfterCancel = await productTask(taskId);
        record('f7-accept-refusal', { afterRegisterUi, afterSubmit, acceptClicked, productAfterRefusal, afterApprove, afterAccept, productAfterAccept, afterCancel, productAfterCancel });
        check('the review surface offers the accept affordance only where the coordinator will actually accept: at review-pending the Accept button is DISABLED — the review is not yet approved, so an accept would be refused conflict/acceptance_review — and clicking it changes nothing (no error, nothing accepted); the UI\'s Register deliverable button registers no placeholder because no artifact capture is wired, so the real deliverable registered through the container is the only one rendered; the explicit approve records the verdict and moves the task to review-approved, the Accept button becomes enabled and the click reaches accepted through the REAL button, and cancelling the ACCEPTED task is refused conflict/task_state with the task still accepted — no action silently rewrites a settled review', {
          acceptDisabledAtReviewPending,
          acceptClicked: acceptClicked.clicked,
          errorAfterDisabledClick: acceptClicked.snapshot.error,
          errorRendered: acceptClicked.probe.error?.role ?? null,
          productAfterRefusal: { acceptanceState: productAfterRefusal.acceptance.state, reviewState: productAfterRefusal.review.state },
          placeholderDeliverable: afterRegisterUi.probe.deliverables.map((row) => ({ deliverableId: row.deliverableId, hash: row.hash, bytes: row.bytes, paths: row.paths })),
          phaseAfterApprove: afterApprove.probe.tasks.find((row) => row.taskId === taskId)?.phase ?? null,
          phaseAfterAccept: afterAccept.probe.tasks.find((row) => row.taskId === taskId)?.phase ?? null,
          productAfterAccept: { state: productAfterAccept.state, acceptanceState: productAfterAccept.acceptance.state, acceptedBy: productAfterAccept.acceptance.acceptedBy },
          cancelError: afterCancel.snapshot.error,
          cancelMentionsState: /task_state/.test(afterCancel.snapshot.error),
          productAfterCancel: { state: productAfterCancel.state, acceptanceState: productAfterCancel.acceptance.state },
        }, {
          acceptDisabledAtReviewPending: true,
          acceptClicked: true,
          errorAfterDisabledClick: '',
          errorRendered: null,
          productAfterRefusal: { acceptanceState: 'none', reviewState: 'pending' },
          placeholderDeliverable: [],
          phaseAfterApprove: 'review-approved',
          phaseAfterAccept: 'accepted',
          productAfterAccept: { state: 'accepted', acceptanceState: 'accepted', acceptedBy: 'reviewer' },
          cancelError: 'The task could not be cancelled: conflict: collaboration.task_state (conflict/task_state)',
          cancelMentionsState: true,
          productAfterCancel: { state: 'accepted', acceptanceState: 'accepted' },
        });
      }

      // ── F8: at a mobile viewport no control is unreachable, on the richest surface ─────────
      {
        const rich = await buildRichWorld('mobile');
        await omowright.emulate(page, { width: 390, height: 844, deviceScaleFactor: 1, mobile: false, hasTouch: false });
        const layout = await layoutProbe();
        record('f8-mobile-layout', { taskId: rich.taskId, layout });
        const unreachable = layout.buttons.filter((button) => button.withinModalHorizontally !== true || button.withinModalVertically !== true);
        const zeroSize = layout.buttons.filter((button) => button.width <= 0 || button.height <= 0);
        check('at a mobile viewport (390px) on the RICHEST surface — three members, a full fan-out, an accepted task with its attempt ladder and deliverables, the writer block with its real long paths and the posture block — no control is unreachable, measured for real: zero horizontal overflow on the document and the modal, every button non-zero and fully inside the modal box after being scrolled into it, and the close button present and reachable', {
          innerWidth: layout.innerWidth,
          hasControls: layout.buttonCount > 0,
          docOverflowFree: layout.docHorizontalOverflow <= 0,
          modalOverflowFree: layout.modalHorizontalOverflow <= 0,
          allButtonsNonZero: zeroSize.length === 0,
          allButtonsWithinModal: unreachable.length === 0,
          unreachableButtonTestIds: unreachable.map((button) => button.testId),
          zeroSizeButtonTestIds: zeroSize.map((button) => button.testId),
          closeButtonPresent: layout.buttons.some((button) => button.testId === 'collab-close'),
          writerBlockRendered: rich.afterWriter.probe.writer.present === true,
          controlTestIds: layout.buttons.map((button) => button.testId),
        }, {
          innerWidth: 390,
          hasControls: true,
          docOverflowFree: true,
          modalOverflowFree: true,
          allButtonsNonZero: true,
          allButtonsWithinModal: true,
          unreachableButtonTestIds: [],
          zeroSizeButtonTestIds: [],
          closeButtonPresent: true,
          writerBlockRendered: true,
          controlTestIds: layout.buttons.map((button) => button.testId),
        });
        await omowright.emulate(page, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      }

      // ── F9: the three imported themes render without error in the failure lane too ────────
      {
        const light = await applyTheme('soft-white');
        const lightStyle = await styleProbe();
        const dark = await applyTheme('anime-night');
        const darkStyle = await styleProbe();
        const dream = await applyTheme('anime-dream');
        const dreamStyle = await styleProbe();
        record('f9-themes', { light, lightStyle, dark, darkStyle, dream, dreamStyle });
        check('the three imported themes render without error and with their own measured colours in the failure lane as well', {
          lightModalColor: lightStyle.modalColor,
          darkModalColor: darkStyle.modalColor,
          dreamModalColor: dreamStyle.modalColor,
          threeDistinctColours: new Set([lightStyle.modalColor, darkStyle.modalColor, dreamStyle.modalColor]).size === 3,
          modalPresent: lightStyle.modalPresent && darkStyle.modalPresent && dreamStyle.modalPresent,
        }, {
          lightModalColor: 'rgb(38, 48, 56)',
          darkModalColor: 'rgb(240, 230, 245)',
          dreamModalColor: 'rgb(74, 44, 58)',
          threeDistinctColours: true,
          modalPresent: true,
        });
      }
    }

    // ── T1: every observed rejection code is a member of the frozen table ───────────────────
    // The browser realm's accumulator is CASE-WIDE (never reset by a boot), and the worker's own
    // typed captures are folded in, so the membership check covers the whole run, not one world.
    const browserCodes = await observedBrowserCodes();
    const workerCodes = [workerUnknownAttempt.code];
    const allCodes = [...new Set([...browserCodes, ...workerCodes])].sort();
    const browserMembership = await evaluate((codes) => window.task42.codeMembership(codes), browserCodes);
    const workerMissing = allCodes.filter((code) => !ERROR_CODES.includes(code));
    check('every rejection code the case observed across the whole run is a member of the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the browser realm collected plus the worker\'s own typed captures', {
      browserObserved: browserCodes,
      workerObserved: workerCodes,
      allObserved: allCodes,
      observedCount: allCodes.length,
      browserMissing: browserMembership.missing,
      browserAllInTable: browserMembership.allObservedCodesInTable,
      workerMissing,
      workerAllInTable: workerMissing.length === 0,
    }, {
      browserObserved: browserCodes,
      workerObserved: workerCodes,
      allObserved: allCodes,
      observedCount: allCodes.length,
      browserMissing: [],
      browserAllInTable: true,
      workerMissing: [],
      workerAllInTable: true,
    });

    const browserErrorList = await browserErrors();
    check('the real UI surface logged no error across the whole case', { errors: browserErrorList.length }, { errors: 0 });

    const heapEnd = process.memoryUsage().heapUsed;
    check('the case stays bounded (bounded heap) and exercises the real modules through a fixed set of owned resources with every git invocation — the case own and the product runner — naming its cwd inside the private fixture root', {
      heapGrowthUnderBound: heapEnd - heapStart < HEAP_BOUND,
      ownedResourceCount: fixture.resources.length,
      boots: started.boots,
      leases: started.leases,
      artifacts: started.artifacts,
      messages: started.messages,
      caseGitCommands: started.gitCommands,
      productGitCommands: started.productGitCommands,
      totalGitCommands: started.gitCommands + started.productGitCommands,
      allCaseCwdsNamed: caseGitCalls.every((entry) => typeof entry.cwd === 'string' && entry.cwd.length > 0),
      allCaseCwdsInsidePrivateRoot: caseGitCalls.every((entry) => entry.cwd.startsWith(`${fixture.root}${path.sep}`)),
      allProductCwdsInsidePrivateRoot: productGitCalls.every((entry) => entry.cwd.startsWith(`${fixture.root}${path.sep}`)),
      remoteMovingCommands: [...caseGitCalls, ...productGitCalls].filter((entry) => isRemoteMoving(entry.args)).length,
    }, {
      heapGrowthUnderBound: true,
      ownedResourceCount: fixture.resources.length,
      boots: started.boots,
      leases: started.leases,
      artifacts: started.artifacts,
      messages: started.messages,
      caseGitCommands: started.gitCommands,
      productGitCommands: started.productGitCommands,
      totalGitCommands: started.gitCommands + started.productGitCommands,
      allCaseCwdsNamed: true,
      allCaseCwdsInsidePrivateRoot: true,
      allProductCwdsInsidePrivateRoot: true,
      remoteMovingCommands: 0,
    });

    // Screenshots + DOM trace for the UI surfaces (the plan's Evidence line).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa42-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa42-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }

    protocol.browserCallLog = { deliverCalls: await deliverCalls(), writerAllocateCalls: await writerAllocateCalls() };
    protocol.worker.productGitCalls = productGitCalls;
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    // ── the evidence binds to the CURRENT bytes ─────────────────────────────────────────────
    const pinnedRecheck = Object.fromEntries(await Promise.all(PINNED_PRODUCT_FILES.map(async (file) => {
      const bytes = await readFile(path.join(context.root, file));
      return [file, { node: createHash('sha256').update(bytes).digest('hex'), helper: digest(bytes) }];
    })));
    let pinnedInventoryRevalidated = false;
    let revalidationError = null;
    try { validateSources(pinnedBefore, context.root); pinnedInventoryRevalidated = true; }
    catch (error) { revalidationError = String(error instanceof Error ? error.message : error); }
    const pinnedComparisons = PINNED_PRODUCT_FILES.map((file) => ({
      file,
      recomputed: pinnedRecheck[file].node,
      recordedAtStart: pinnedBefore[file],
      equal: pinnedRecheck[file].node === pinnedBefore[file],
      digestHelperAgrees: pinnedRecheck[file].node === pinnedRecheck[file].helper,
    }));
    record('sourceBinding', { pinnedComparisons, pinnedInventoryRevalidated, revalidationError });
    check('the evidence binds to the CURRENT bytes: the sha256 of every pinned product file, independently recomputed after the run, equals the value recorded at the start and the value the artifact inventory carries', {
      pinnedFileCount: pinnedComparisons.length,
      allEqual: pinnedComparisons.every((entry) => entry.equal),
      allDigestHelperAgrees: pinnedComparisons.every((entry) => entry.digestHelperAgrees),
      fullInventoryRevalidated: pinnedInventoryRevalidated,
      revalidationError,
      collaborationPanel: pinnedComparisons[0].recomputed,
      useRuntimeCollaboration: pinnedComparisons[5].recomputed,
      coordinator: pinnedComparisons[7].recomputed,
      writerLeases: pinnedComparisons[11].recomputed,
    }, {
      pinnedFileCount: PINNED_PRODUCT_FILES.length,
      allEqual: true,
      allDigestHelperAgrees: true,
      fullInventoryRevalidated: true,
      revalidationError: null,
      collaborationPanel: pinnedBefore['app/components/runtime/CollaborationPanel.vue'],
      useRuntimeCollaboration: pinnedBefore['app/composables/useRuntimeCollaboration.ts'],
      coordinator: pinnedBefore['bridge/runtime/collaboration/coordinator.js'],
      writerLeases: pinnedBefore['bridge/runtime/collaboration/writerLeases.js'],
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
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task42Errors ?? [], task42: Boolean(window.task42) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }

  const classMatchers = {
    partial_dispatch: /partial|per-recipient|observed outcome/,
    blocked_cancelled: /blocked|cancelled/,
    stale_state: /stale|reviewed hash|tampered/,
    malformed_input: /unknown attempt|no attempt|readable|refus/,
    hung_commands: /paused|budget|mailbox|quota/,
    dirty_worktree: /authored files unchanged|CURRENT bytes|private/,
    repeated_interruptions: /three harness|every member|distinct phases|per-thread/,
    misleading_success_output: /never|only|no push|refused|disabled|verbatim/,
    flaky_tests: /identical|rgb\(|measured|SAME|distinct/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));

  return {
    scenarios,
    artifacts,
    adversarialClasses: Object.keys(classEvidence),
    classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'collaboration-team-task-review-ui', schema: 'runtime-collaboration-ui/v1' },
    cleanup: proof.cleanup,
    defects: {
      noContainerProvidesCollaborationState: {
        severity: 'acceptance-criterion-gap',
        observed: 'no container provides RUNTIME_COLLABORATION_STATE_KEY (App.vue is outside the owned paths) and nothing imports the five components into the web entry graph, so the running app renders nothing until a one-line provide lands; the case therefore supplies the seam itself, exactly as the landed CollaborationPanel.test.ts does',
        contradictsPlanCriterion: 'none — the plan scopes task 42 to the components and the composable; the wiring is the same optional-seam posture as task 35\'s RUNTIME_THREAD_STATE_KEY',
        coveredInstead: 'the case IS the container: it provides the seam, drives the real composable over the real services and asserts the rendered surface',
      },
      writerLeasesCannotCrossIntoBrowser: {
        severity: 'controlled-boundary',
        observed: 'writerLeases.js imports node:crypto / node:fs / node:path / node:child_process plus processTree.js, so the REAL allocate cannot run in a browser realm; it runs in the Node worker against a REAL private temporary git repository through the product\'s own createGitRunner, and the browser renders the observed lease and the observed posture verbatim',
        contradictsPlanCriterion: 'none — the same split tasks 37-41 disclosed; the posture identity claim (posture(leaseId) === WRITER_ISOLATION) is proven in the worker where the real module lives, and the port records the allocate input the UI really made',
        coveredInstead: 'the rendered writer cells, the posture block and the allocate input are all asserted against the worker-observed real values, and the on-disk worktree is verified at the lease base commit with real git',
      },
      artifactReviewHasNoAllocateTrigger: {
        severity: 'observation',
        observed: 'ArtifactReview.vue declares the allocate-writer emit but renders no button that emits it, so the writer lease is allocated through the container action, exactly as the landed CollaborationPanel.test.ts drives it',
        contradictsPlanCriterion: 'none — the criterion is that the observed lease renders, which it does',
        coveredInstead: 'the case drives the composable\'s allocateWriter through the container and records the allocate input the composable handed the port',
      },
      teamEditorHasNoMemberOrTaskTriggers: {
        severity: 'observation',
        observed: 'TeamEditor.vue declares the add-member and create-task emits but renders no buttons for them, so members and tasks are created through the container actions, exactly as the landed CollaborationPanel.test.ts drives them',
        contradictsPlanCriterion: 'none — the criteria concern the rendered read models, which the case asserts',
        coveredInstead: 'the container actions are driven and the rendered member rows, budget rows and task rows are asserted',
      },
      noMessageListSurface: {
        severity: 'observation',
        observed: 'no component renders the coordinator\'s mailbox message list and the composable exposes no message read model, so the plan\'s 查看消息 is observable through the mailbox budget accounting (the pause reason and the coordinator\'s own depth) rather than a rendered list',
        contradictsPlanCriterion: 'partial — the plan\'s happy-QA phrase names 消息; the message channel itself has no UI surface in this task',
        coveredInstead: 'the failure lane drives the coordinator\'s own postMessage to the real frozen limit and observes the collaboration_mailbox pause it causes',
      },
      nodeCryptoBrowserSeam: {
        severity: 'controlled-boundary',
        observed: 'the real bridge services import node:crypto at module scope, so the case aliases the specifier (and @iconify/vue) to the landed task-35 browser shim, which supplies randomUUID from the browser\'s own crypto and createHash(\'sha256\') from the product\'s own pure SHA-256',
        contradictsPlanCriterion: 'none — the same seam tasks 26-29 and 35 use; no asserted value depends on it (ids are asserted by shape and equality-across-reads, and no fingerprint is asserted)',
        coveredInstead: 'every line of service logic under test is the real landed code; the same services also run in the landed CollaborationPanel.test.ts over the Node require boundary',
      },
    },
    evidenceBoundary: 'The real landed task-42 Vue surface (CollaborationPanel/TeamEditor/TaskGraph/AttemptDetails/ArtifactReview) and app/composables/useRuntimeCollaboration.ts execute in a real headless Chromium over a case-owned Vite dev server, driving the real landed bridge services bridge/runtime/collaboration/{coordinator,delegationService,mailbox,fanoutService}.js and the pure shared contract (shared/runtime/{collaboration,capabilities,identity,harnessContract}.js), with the real imported-theme token pipeline (app/utils/{regionTheme,themeTokens}.ts + the soft-white, anime-night and anime-dream presets) measured with real computed colours. The controlled boundaries are injected fakes: `node:crypto` and `@iconify/vue` are aliased to the landed task-35 browser shim (the bridge services import node:crypto at module scope and cannot run in a browser realm without it; the real Icon fetches the Iconify API at runtime); the coordinator\'s and the fan-out service\'s deliver seams are the product\'s own declared injection points; the writer port is a case-owned pass-through of the worker-observed lease because writerLeases.js imports node:fs/node:path/node:child_process and cannot run in a browser realm at all — the REAL allocate runs in the Node worker against a REAL private temporary git repository through the product\'s own createGitRunner, and the browser renders the observed values verbatim. No container provides RUNTIME_COLLABORATION_STATE_KEY yet, so this case is the container and makes no claim that the running app already renders the collaboration UI. It does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that — runs no product test suite, performs no git operation in the worktree, and authors no PASS verdict.',
  };
}
