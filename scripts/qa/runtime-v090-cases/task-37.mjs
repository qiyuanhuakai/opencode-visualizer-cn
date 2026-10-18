// Task 37 registered QA case — the Team / Task / Attempt coordinator and its five budgets.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/collaboration/coordinator.js,
//     taskGraph.js, attemptService.js and acceptanceService.js, composed exactly as the product
//     composes them (createCollaborationCoordinator builds the graph, the attempt service and the
//     acceptance service itself), over the frozen shared/runtime/collaboration.js contract. Nothing
//     is stubbed: the ONLY case-owned seam is the `deliver` prompt port the coordinator's own
//     signature declares as an injection point (coordinator.js:70-76), and it is backed by a
//     counting, recording fake so "exactly one prompt was ever sent", "the source error is carried
//     verbatim" and "an unreadable outcome is never retried" are OBSERVED, not argued. The sink
//     constructors (createNativeSink / createDeliverySink / createHostSink from attemptService.js
//     and createAcceptanceSink from acceptanceService.js) are the product's own exported boundary
//     constructors, so the structural guarantee — no native terminal event can reach a task's
//     review/acceptance/deliverable scope — is driven through the real code.
//   * In a real headless Chromium: the frozen shared contract — the five coordination budgets, the
//     task/attempt/review/acceptance state tables, the budget-reason table, the frozen ceilings,
//     the canonical native-session keys the Session-mutation budget is counted under, the id and
//     shape parsers every rejection travels through, and the frozen protocol error-code table —
//     recomputed in a second JS realm from the same pure modules. The case asserts the browser
//     values EQUAL the values the worker computes, so the contract the bridge enforces is provably
//     the contract the app sees.
//
// The controlled boundaries are stated rather than papered over:
//   * the stateful coordinator cannot cross into the browser at all — coordinator.js:1,
//     taskGraph.js:1 and attemptService.js:1 each import from node:crypto — so the ladder, the
//     journal, the sinks, the budget gate and the restart retention pass are proven in the worker
//     only. The split is exactly the posture task 34 disclosed for its in-memory journal.
//   * the acceptance-sink and attempt-sink constructors are proven in the worker only: neither
//     module ships a sibling declaration file, so a static import would be TS7016 under the repo's
//     strict vue-tsc gate (the same reason the product's own
//     app/runtime/collaborationCoordinator.test.ts uses a createRequire boundary for them).
//   * no browser shim is needed: the browser closure is shared/runtime/collaboration.js ->
//     capabilities.js + identity.js, pure ESM with no node:* builtin and no bare or aliased
//     specifier, so Vite resolves every import natively. task-30 needed a shim only because the
//     real Icon component fetches from the Iconify API at runtime.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// claims no UI rendering (task 42 owns the collaboration UI), authors no PASS verdict, edits no
// product or test file, and performs no git operation. It claims no durability across a real
// process death: the restart pass re-derives its counters and reconciles its ambiguous attempts
// IN-PROCESS, because the single-writer durable store is task 8's surface and is not exercised
// here. The five budgets are enforced inside ONE coordinator instance and are not claimed across
// processes or coordinators.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-37-fixture.mjs';

import { createCollaborationCoordinator } from '../../../bridge/runtime/collaboration/coordinator.js';
import {
  ACCEPTANCE_STATES,
  ATTEMPT_STATES,
  ATTEMPT_TERMINAL_REASONS,
  BUDGET_REASONS,
  COLLABORATION_BUDGETS,
  COLLABORATION_SCHEMA_VERSION,
  CollaborationError,
  MAX_CRITERIA_COUNT,
  MAX_CRITERION_CHARS,
  MAX_CRITERION_ID_CHARS,
  MAX_DELIVERABLES,
  MAX_DELIVERABLE_PATHS,
  MAX_MAILBOX_TEXT_CHARS,
  MAX_NAMES,
  MAX_PATH_CHARS,
  MAX_TASK_TITLE_CHARS,
  REVIEW_STATES,
  TASK_STATES,
  collaborationBudgetLimits,
  parseAt,
  parseCriteria,
  parseCriteriaVerdicts,
  parseCriterion,
  parseDeliverable,
  parseLeaseInput,
  parseOwner,
  parseSessionMutationKey,
  parseTaskId,
  parseTaskTitle,
  parseTeamName,
} from '../../../shared/runtime/collaboration.js';
import { createNativeSink, createDeliverySink, createHostSink } from '../../../bridge/runtime/collaboration/attemptService.js';
import { createAcceptanceSink } from '../../../bridge/runtime/collaboration/acceptanceService.js';
import { decodeSessionKey, encodeSessionKey, parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../../shared/runtime/identity.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

// The five harness kinds of this plan: opencode, codex, kimi-web, dsh, acp. Each task in the
// multi-harness DAG is owned by a participant working in a DISTINCT native session, so only the
// concurrency budget can ever pair two of them.
const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const H = {
  codex: parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  acp: parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  kimi: parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  dsh: parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  opencode: parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
  extra1: parseHarnessInstanceId('66666666-6666-4666-8666-666666666666'),
  extra2: parseHarnessInstanceId('77777777-7777-4777-8777-777777777777'),
};
const SESSIONS = {
  codex: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' }),
  acp: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.acp, nativeSessionId: 'native:acp-1' }),
  kimi: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.kimi, nativeSessionId: 'native:kimi-1' }),
  dsh: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.dsh, nativeSessionId: 'native:dsh-1' }),
  opencode: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.opencode, nativeSessionId: 'native:opencode-1' }),
  extra1: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.extra1, nativeSessionId: 'native:extra1-1' }),
  extra2: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.extra2, nativeSessionId: 'native:extra2-1' }),
};
const HARNESS_ORDER = ['codex', 'acp', 'kimi', 'dsh', 'opencode', 'extra1', 'extra2'];
const PARTICIPANT = (index) => `15151515-1515-4515-8515-15151515151${index}`;
const LEASE_OWNER = (index) => `12121212-1212-4212-8212-12121212121${index}`;

const CRITERIA = Object.freeze([
  { id: 'build', text: 'the production build passes' },
  { id: 'tests', text: 'the focused regression passes', required: true },
]);
const DELIVERABLE = Object.freeze({
  deliverableId: 'deliverable-1',
  artifactHash: 'f'.repeat(64),
  bytes: 4096,
  paths: Object.freeze(['bridge/runtime/collaboration/coordinator.js']),
});
const REVIEWER = '13131313-1313-4313-8313-131313131313';
const ACCEPTER = '14141414-1414-4414-8414-141414141414';
const T0 = 1700000000000;
const LEASE_TTL = 600000;

/**
 * The typed capture envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously. `dispatch` and `send` are
 * `async function`s — they RETURN A PROMISE and reject instead of throwing, so a synchronous
 * try/catch cannot observe their rejection: use capture (which awaits) for those, or the error
 * escapes as an unhandled rejection and the worker dies.
 */
const observedCodes = new Set();
const captureSync = (run) => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
};
const capture = async (run) => {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-CollaborationError', field: String(error) };
  }
};

/**
 * The case world: the REAL coordinator with the `deliver` prompt port — the one seam the product's
 * own signature declares (coordinator.js:70-76) — backed by a counting, recording fake. Every
 * task defaults to a distinct harness session per ownerIndex, so the concurrency budget is the
 * only budget that can pair two tasks unless a scenario says otherwise.
 */
function makeWorld(deliver) {
  const counters = { deliver: 0 };
  const deliverCalls = [];
  const deliverPort = deliver ?? (async (input) => {
    counters.deliver += 1;
    deliverCalls.push({ attemptId: input.attemptId, taskId: input.taskId, prompt: input.prompt, ownerSession: input.owner.session.nativeSessionId });
    return { ackId: `ack-${counters.deliver}` };
  });
  const coordinator = createCollaborationCoordinator({ deliver: deliverPort });
  const team = coordinator.createTeam({ name: 'runtime-migration', at: T0 });
  let sequence = 0;
  const makeTask = (input = {}) => {
    const at = input.at ?? T0;
    const ownerIndex = input.ownerIndex ?? 0;
    const harness = HARNESS_ORDER[ownerIndex];
    if (harness === undefined) throw new Error(`no harness fixture at ownerIndex ${ownerIndex}`);
    sequence += 1;
    return coordinator.createTask({
      teamId: team.teamId,
      title: input.title ?? `task ${sequence}`,
      criteria: input.criteria ?? CRITERIA,
      owner: { participantId: PARTICIPANT(ownerIndex + 1), session: SESSIONS[harness] },
      lease: { ownerId: LEASE_OWNER(ownerIndex + 1), expiresAt: at + (input.leaseTtl ?? LEASE_TTL) },
      ...(input.parentId === undefined ? {} : { parentId: input.parentId }),
      ...(input.dependsOn === undefined ? {} : { dependsOn: input.dependsOn }),
      at,
    });
  };
  const acceptAll = (taskId, at) => coordinator.accept({
    taskId,
    deliverableId: DELIVERABLE.deliverableId,
    criteria: [{ id: 'build', met: true }, { id: 'tests', met: true }],
    acceptedBy: ACCEPTER,
    at,
  });
  return { coordinator, teamId: team.teamId, counters, deliverCalls, makeTask, acceptAll };
}

/** The worker mirror of the browser entry's frozen-contract table. */
function workerTables() {
  return {
    schemaVersion: COLLABORATION_SCHEMA_VERSION,
    budgets: { ...COLLABORATION_BUDGETS },
    budgetsFrozen: Object.isFrozen(COLLABORATION_BUDGETS),
    limitsFromFunction: { ...collaborationBudgetLimits() },
    taskStates: [...TASK_STATES],
    attemptStates: [...ATTEMPT_STATES],
    terminalReasons: [...ATTEMPT_TERMINAL_REASONS],
    reviewStates: [...REVIEW_STATES],
    acceptanceStates: [...ACCEPTANCE_STATES],
    budgetReasons: [...BUDGET_REASONS],
    ceilings: {
      maxTaskTitleChars: MAX_TASK_TITLE_CHARS,
      maxCriteriaCount: MAX_CRITERIA_COUNT,
      maxCriterionIdChars: MAX_CRITERION_ID_CHARS,
      maxCriterionChars: MAX_CRITERION_CHARS,
      maxDeliverables: MAX_DELIVERABLES,
      maxDeliverablePaths: MAX_DELIVERABLE_PATHS,
      maxPathChars: MAX_PATH_CHARS,
      maxMailboxTextChars: MAX_MAILBOX_TEXT_CHARS,
      maxNames: { ...MAX_NAMES },
    },
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'task_cycle', { taskId: 'x' });
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
    coordinationCodesInTable: ['invalid_request', 'conflict', 'cancelled', 'source_unavailable', 'reconcile_required']
      .every((code) => ERROR_CODES.includes(code)),
  };
}

/** The worker mirror of the browser entry's canonical-session-key table. */
function workerSessionKeys() {
  return {
    codex: encodeSessionKey(SESSIONS.codex),
    acp: encodeSessionKey(SESSIONS.acp),
    kimi: encodeSessionKey(SESSIONS.kimi),
    dsh: encodeSessionKey(SESSIONS.dsh),
    opencode: encodeSessionKey(SESSIONS.opencode),
    codexDuplicate: encodeSessionKey(parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' })),
    mutationKeyCodex: parseSessionMutationKey(SESSIONS.codex),
    mutationKeyEqualsEncode: parseSessionMutationKey(SESSIONS.codex) === encodeSessionKey(SESSIONS.codex),
    mutationKeyDiffersAcrossHarnesses: parseSessionMutationKey(SESSIONS.codex) !== parseSessionMutationKey(SESSIONS.acp),
    mutationKeyMalformed: captureSync(() => parseSessionMutationKey({ environmentId: ENV_A })),
    decoded: (() => {
      const decoded = decodeSessionKey(encodeSessionKey(SESSIONS.kimi));
      return { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId };
    })(),
  };
}

/** The worker mirror of the browser entry's parser-boundary table. */
function workerParsers() {
  const owner = { participantId: PARTICIPANT(1), session: SESSIONS.codex };
  return {
    taskId: parseTaskId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
    taskIdLowercased: parseTaskId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
    badTaskId: captureSync(() => parseTaskId('nope')),
    teamName512: parseTeamName('t'.repeat(512)).length,
    teamNameEmpty: captureSync(() => parseTeamName('')),
    teamName513: captureSync(() => parseTeamName('t'.repeat(513))),
    taskTitle512: parseTaskTitle('t'.repeat(512)).length,
    taskTitle513: captureSync(() => parseTaskTitle('t'.repeat(513))),
    criteriaParsed: parseCriteria(CRITERIA).map((entry) => ({ id: entry.id, required: entry.required })),
    criteriaEmpty: captureSync(() => parseCriteria([])),
    criteriaDuplicateIds: captureSync(() => parseCriteria([{ id: 'build', text: 'a' }, { id: 'build', text: 'b' }])),
    criterionDefaultsRequired: parseCriterion({ id: 'build', text: 'a' }).required,
    criterionRejectsExtraKey: captureSync(() => parseCriterion({ id: 'build', text: 'a', extra: 1 })),
    ownerParsed: (() => {
      const parsed = parseOwner(owner);
      return { participantId: parsed.participantId, nativeSessionId: parsed.session.nativeSessionId, frozen: Object.isFrozen(parsed) };
    })(),
    ownerMissingSession: captureSync(() => parseOwner({ participantId: PARTICIPANT(1) })),
    leaseInput: (() => {
      const parsed = parseLeaseInput({ ownerId: LEASE_OWNER(1), expiresAt: 1700000600000 });
      return { ownerId: parsed.ownerId, expiresAt: parsed.expiresAt };
    })(),
    leaseBadExpiry: captureSync(() => parseLeaseInput({ ownerId: LEASE_OWNER(1), expiresAt: -1 })),
    deliverable: (() => {
      const parsed = parseDeliverable(DELIVERABLE);
      return { deliverableId: parsed.deliverableId, artifactHash: parsed.artifactHash, bytes: parsed.bytes, paths: [...parsed.paths] };
    })(),
    deliverableBadHash: captureSync(() => parseDeliverable({ deliverableId: 'd', artifactHash: 'nope', bytes: 1, paths: ['a'] })),
    deliverableEmptyPaths: captureSync(() => parseDeliverable({ deliverableId: 'd', artifactHash: 'f'.repeat(64), bytes: 1, paths: [] })),
    verdicts: parseCriteriaVerdicts([{ id: 'build', met: true }, { id: 'tests', met: false }], parseCriteria(CRITERIA)).map((entry) => ({ id: entry.id, met: entry.met })),
    verdictsWrongCount: captureSync(() => parseCriteriaVerdicts([{ id: 'build', met: true }], parseCriteria(CRITERIA))),
    verdictsUnknownId: captureSync(() => parseCriteriaVerdicts([{ id: 'build', met: true }, { id: 'nope', met: true }], parseCriteria(CRITERIA))),
    atExplicit: parseAt(T0),
    atZero: captureSync(() => parseAt(0)),
    atFractional: captureSync(() => parseAt(1.5)),
  };
}

export const sourceFiles = [...new Set([
  // the four product modules this task owns
  'bridge/runtime/collaboration/coordinator.js',
  'bridge/runtime/collaboration/taskGraph.js',
  'bridge/runtime/collaboration/attemptService.js',
  'bridge/runtime/collaboration/acceptanceService.js',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  // the product's own regression suite, unchanged
  'app/runtime/collaborationCoordinator.test.ts',
  // the shared modules the product pulls in
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task37.ts',
  'scripts/qa/runtime-v090-cases/task-37.mjs',
  'scripts/qa/runtime-v090-cases/task-37-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/**
 * The seven product files whose bytes the evidence must bind to. Every one of them is in
 * sourceFiles, so the independent gate can compare the recorded digests against the artifact's own
 * sourceHashes mechanically.
 */
const PRODUCT_FILES = [
  'bridge/runtime/collaboration/coordinator.js',
  'bridge/runtime/collaboration/taskGraph.js',
  'bridge/runtime/collaboration/attemptService.js',
  'bridge/runtime/collaboration/acceptanceService.js',
  'shared/runtime/collaboration.js',
  'shared/runtime/collaboration.d.ts',
  'app/runtime/collaborationCoordinator.test.ts',
];

function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 37 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task37Errors=[];window.addEventListener('error',(e)=>window.__task37Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task37Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task37.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-37/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
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
      surface: 'the real landed bridge collaboration coordinator coordinator.js composed from the real taskGraph.js, attemptService.js and acceptanceService.js over the frozen shared/runtime/collaboration.js contract in the Node worker, with the coordinator\'s own declared deliver prompt port backed by a counting recording fake, plus the frozen shared contract recomputed in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-37.mjs',
    'scripts/qa/runtime-v090-cases/task-37-fixture.mjs',
    'app/dev/runtime-v090/task37.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const productHashesBefore = productHashes(context.root);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

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
    // Real headless Chromium over the frozen shared contract (no shim: no node:* builtin anywhere)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa37', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa37/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task37 && window.task37.ready)), 'task37 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the frozen contract is identical in both realms ──
    await crossRealm('the frozen collaboration contract — the five coordination budgets (concurrency 4, Session mutation 1, depth 4, children 32, mailbox 1000) taken from the one frozen shared object, the task/attempt/terminal-reason/review/acceptance state tables, the five budget reasons, every frozen ceiling, the CollaborationError shape and the frozen ten-entry ERROR_CODES table — is byte-identical in the browser realm and the bridge worker, and every table is frozen, so the app and the bridge cannot disagree about a limit or a state name', workerTables(), await evaluate(() => window.task37.tables()), {
      schemaVersion: 1,
      budgets: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 },
      budgetsFrozen: true,
      limitsFromFunction: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 },
      taskStates: ['pending', 'dispatched', 'review', 'accepted', 'failed', 'cancelled', 'paused'],
      attemptStates: ['accepted', 'sent', 'observed', 'terminal', 'reconcile'],
      terminalReasons: ['completed', 'failed', 'cancelled', 'timeout', 'aborted'],
      reviewStates: ['none', 'pending', 'approved', 'rejected'],
      acceptanceStates: ['none', 'pending', 'accepted', 'rejected'],
      budgetReasons: ['collaboration_concurrency', 'collaboration_session_mutation', 'collaboration_depth', 'collaboration_children', 'collaboration_mailbox'],
      ceilings: {
        maxTaskTitleChars: 512, maxCriteriaCount: 32, maxCriterionIdChars: 128, maxCriterionChars: 512,
        maxDeliverables: 16, maxDeliverablePaths: 64, maxPathChars: 1024, maxMailboxTextChars: 512,
        maxNames: { team: 512, participant: 128, owner: 128, reviewer: 128 },
      },
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'task_cycle', reason: 'task_cycle', message: 'conflict: collaboration.task_cycle', detail: { taskId: 'x' }, isProtocolError: true, isTypeError: true },
      coordinationCodesInTable: true,
    });

    // ── C2: the canonical session keys are engine-independent and tie to the real records ──
    await crossRealm('the canonical native-session key each of the five harness kinds produces is identical in both realms, round-trips through decodeSessionKey back to the exact referenced native session, is the SAME key for the same session under a second spelling, and is the very key parseSessionMutationKey counts the Session-mutation budget under — so a browser window and the bridge worker provably agree on the identity a task owner carries', workerSessionKeys(), await evaluate(() => window.task37.sessionKeys()), {
      codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
      kimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
      dsh: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJkZGRkZGRkZC1kZGRkLTRkZGQtOGRkZC1kZGRkZGRkZGRkZGQiLCJuYXRpdmU6ZHNoLTEiXQ',
      opencode: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlZWVlZWVlZS1lZWVlLTRlZWUtOGVlZS1lZWVlZWVlZWVlZWUiLCJuYXRpdmU6b3BlbmNvZGUtMSJd',
      codexDuplicate: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      mutationKeyCodex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      mutationKeyEqualsEncode: true,
      mutationKeyDiffersAcrossHarnesses: true,
      mutationKeyMalformed: { code: 'invalid_request', field: 'collaboration_session' },
      decoded: { environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeSessionId: 'native:kimi-1' },
    });

    // ── C3: the parsers every rejection travels through are engine-independent ──
    await crossRealm('the id and shape parsers every rejection travels through — task id lowercasing and the non-UUID refusal, the 512-char team-name and task-title ceilings with the 513th refused, the criteria parser (one entry per id, required defaulting to true, an extra key refused, an empty list and duplicate ids refused with their own codes), the owner/lease/deliverable shapes, the criteria-verdict arity and unknown-id refusals, and the explicit-`at` contract — are byte-identical in both realms, so a rejection the bridge raises is a rejection the app can reproduce', workerParsers(), await evaluate(() => window.task37.parsers()), {
      taskId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      taskIdLowercased: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
      badTaskId: { code: 'invalid_request', field: 'task_id' },
      teamName512: 512,
      teamNameEmpty: { code: 'invalid_request', field: 'team_name' },
      teamName513: { code: 'invalid_request', field: 'team_name' },
      taskTitle512: 512,
      taskTitle513: { code: 'invalid_request', field: 'task_title' },
      criteriaParsed: [{ id: 'build', required: true }, { id: 'tests', required: true }],
      criteriaEmpty: { code: 'invalid_request', field: 'task_criteria' },
      criteriaDuplicateIds: { code: 'conflict', field: 'task_criteria' },
      criterionDefaultsRequired: true,
      criterionRejectsExtraKey: { code: 'invalid_request', field: 'task_criteria' },
      ownerParsed: { participantId: '15151515-1515-4515-8515-151515151511', nativeSessionId: 'native:codex-1', frozen: true },
      ownerMissingSession: { code: 'invalid_request', field: 'task_owner' },
      leaseInput: { ownerId: '12121212-1212-4212-8212-121212121211', expiresAt: 1700000600000 },
      leaseBadExpiry: { code: 'invalid_request', field: 'task_lease' },
      deliverable: { deliverableId: 'deliverable-1', artifactHash: 'f'.repeat(64), bytes: 4096, paths: ['bridge/runtime/collaboration/coordinator.js'] },
      deliverableBadHash: { code: 'invalid_request', field: 'acceptance_deliverable' },
      deliverableEmptyPaths: { code: 'invalid_request', field: 'acceptance_deliverable' },
      verdicts: [{ id: 'build', met: true }, { id: 'tests', met: false }],
      verdictsWrongCount: { code: 'invalid_request', field: 'acceptance_criteria' },
      verdictsUnknownId: { code: 'invalid_request', field: 'acceptance_criteria' },
      atExplicit: 1700000000000,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // ── C4: the sink boundary — a native end structurally cannot reach the acceptance scope ──
    {
      const nativeSink = createNativeSink({ observation: { observed: false, terminal: false } });
      const deliverySink = createDeliverySink({ delivery: { delivered: false } });
      const hostSink = createHostSink({ host: {}, resolution: { value: null } });
      const acceptanceSink = createAcceptanceSink({
        review: { state: 'none', reviewer: null, reason: null, at: null },
        acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
        deliverables: [],
      });
      // Drive the native sink through its WHOLE surface against an acceptance-shaped scope built
      // from a TASK record: nothing in review/acceptance/deliverables moves.
      const scope = {
        review: { state: 'none', reviewer: null, reason: null, at: null },
        acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
        deliverables: [],
      };
      const sink = createAcceptanceSink(scope);
      const native = createNativeSink({ observation: { observed: false, terminal: false } });
      native.observe({ nativeEventId: 'evt-1' });
      native.end({ reason: 'completed', nativeEventId: 'evt-2' });
      const observationScope = { observed: false, terminal: false };
      // The delivery sink's own idempotency: the second ack is a detected duplicate and the FIRST
      // writer is retained.
      const delivery = { delivered: false, deliveredAt: null, deliveredBy: null };
      const ack = createDeliverySink({ delivery });
      const ackFirst = ack.deliver({ ackId: 'ack-1', at: 7 });
      const ackSecond = ack.deliver({ ackId: 'ack-2', at: 8 });
      // The native sink's own terminal refusal: a second native end is a conflict.
      const nativeTwice = createNativeSink({ observation: { observed: false, terminal: false } });
      nativeTwice.end({ reason: 'completed', at: 9 });
      const secondEnd = captureSync(() => nativeTwice.end({ reason: 'failed', at: 10 }));
      const badScope = captureSync(() => createAcceptanceSink({ review: {} }));
      check('the load-bearing structural guarantee holds at the sink boundary, driven through the product OWN exported constructors: the native sink exposes ONLY observe and end and has no member that could review or accept a task, the delivery sink ONLY deliver (so a native ack cannot advance an attempt past sent, and its second ack is a detected duplicate retaining the first writer), the Host sink ONLY the four Host commands and touches neither native slice, and the acceptance sink — the ONLY writer of review, acceptance and deliverables — is built from a TASK record whose scope no attempt record can produce; driving the native sink through its entire surface leaves the acceptance-shaped scope at review none / acceptance none / deliverables [], the observation slice type has no member named acceptance or review, a second native end is refused conflict/attempt_state, and an acceptance sink built from a malformed scope is refused invalid_request/acceptance_scope', {
        nativeSinkKeys: Object.keys(nativeSink),
        nativeSinkHasNoAcceptanceMembers: ['accept', 'review', 'deliverable', 'submitReview', 'reject'].every((key) => nativeSink[key] === undefined),
        deliverySinkKeys: Object.keys(deliverySink),
        deliverySinkHasNoNativeMembers: ['observe', 'end'].every((key) => deliverySink[key] === undefined),
        hostSinkKeys: Object.keys(hostSink),
        hostSinkHasNoNativeMembers: ['deliver', 'observe', 'end'].every((key) => hostSink[key] === undefined),
        acceptanceSinkKeys: Object.keys(acceptanceSink),
        sinksFrozen: [Object.isFrozen(nativeSink), Object.isFrozen(deliverySink), Object.isFrozen(hostSink), Object.isFrozen(acceptanceSink)],
        observationScopeHasNoAcceptanceMember: 'acceptance' in observationScope,
        observationScopeHasNoReviewMember: 'review' in observationScope,
        afterNativeEnd: { review: scope.review.state, acceptance: scope.acceptance.state, deliverables: scope.deliverables },
        acceptanceSinkKeysAfter: Object.keys(sink),
        ackFirst, ackSecond,
        deliveryAfterTwoAcks: { ...delivery },
        secondNativeEnd: secondEnd,
        acceptanceSinkBadScope: badScope,
      }, {
        nativeSinkKeys: ['observe', 'end'],
        nativeSinkHasNoAcceptanceMembers: true,
        deliverySinkKeys: ['deliver'],
        deliverySinkHasNoNativeMembers: true,
        hostSinkKeys: ['accept', 'cancel', 'fail', 'reconcile'],
        hostSinkHasNoNativeMembers: true,
        acceptanceSinkKeys: ['deliverable', 'submitReview', 'review', 'accept', 'reject'],
        sinksFrozen: [true, true, true, true],
        observationScopeHasNoAcceptanceMember: false,
        observationScopeHasNoReviewMember: false,
        afterNativeEnd: { review: 'none', acceptance: 'none', deliverables: [] },
        acceptanceSinkKeysAfter: ['deliverable', 'submitReview', 'review', 'accept', 'reject'],
        ackFirst: { applied: true, duplicate: false },
        ackSecond: { applied: false, duplicate: true },
        deliveryAfterTwoAcks: { delivered: true, deliveredAt: 7, deliveredBy: 'ack-1' },
        secondNativeEnd: { code: 'conflict', field: 'attempt_state' },
        acceptanceSinkBadScope: { code: 'invalid_request', field: 'acceptance_scope' },
      });
    }

    // ── C5: the coordinator reports the frozen limits verbatim and never throws bare ──
    {
      const world = makeWorld();
      const task = world.makeTask({ title: 'contract probe' });
      check('the coordinator reports the SAME frozen limits verbatim through its own budget read model (the limits object IS the shared frozen object, not a copy), every accessor returns a frozen read model, and every rejection carries an explicit code plus the plain rejection field — an unknown task id is invalid_request/task_unknown, a non-UUID id is invalid_request/task_id, an unknown team is invalid_request/team_unknown, a duplicate team under a reused id is conflict/team_duplicate, and the deliver port refuses a non-function with invalid_request/coordinator_deliver', {
        budgets: { limits: world.coordinator.budgets().limits, used: world.coordinator.budgets().used },
        budgetsFrozen: [Object.isFrozen(world.coordinator.budgets()), Object.isFrozen(world.coordinator.budgets().limits)],
        limitsAreTheSharedObject: world.coordinator.budgets().limits === COLLABORATION_BUDGETS,
        frozen: [Object.isFrozen(world.coordinator.task(task.taskId)), Object.isFrozen(world.coordinator.tasks()), Object.isFrozen(world.coordinator.team(world.teamId)), Object.isFrozen(world.coordinator.teams()), Object.isFrozen(world.coordinator.mailbox(world.teamId))],
        taskViewShape: {
          state: world.coordinator.task(task.taskId).state,
          depth: world.coordinator.task(task.taskId).depth,
          criteria: world.coordinator.task(task.taskId).criteria.map((entry) => entry.id),
          ownerSession: world.coordinator.task(task.taskId).owner.session.nativeSessionId,
          leaseExpiresAt: world.coordinator.task(task.taskId).lease.expiresAt,
          leaseIdIsUuid: UUID.test(world.coordinator.task(task.taskId).lease.leaseId),
          blockedBy: world.coordinator.task(task.taskId).blockedBy,
          paused: world.coordinator.task(task.taskId).paused,
          ambiguous: world.coordinator.task(task.taskId).ambiguous,
          attempts: world.coordinator.task(task.taskId).attempts,
          review: world.coordinator.task(task.taskId).review,
          acceptance: world.coordinator.task(task.taskId).acceptance,
          deliverables: world.coordinator.task(task.taskId).deliverables,
        },
        unknownTask: captureSync(() => world.coordinator.task('22222222-2222-4222-8222-222222222222')),
        badTaskId: captureSync(() => world.coordinator.task('nope')),
        unknownTeam: captureSync(() => world.coordinator.team('22222222-2222-4222-8222-222222222222')),
        duplicateTeam: captureSync(() => world.coordinator.createTeam({ teamId: world.teamId, name: 'again', at: T0 })),
        badDeliverPort: captureSync(() => createCollaborationCoordinator({ deliver: 'nope' })),
        state: world.coordinator.state(),
      }, {
        budgets: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 0, sessionMutations: 0, depth: 1, children: 0, mailbox: 0 } },
        budgetsFrozen: [true, true],
        limitsAreTheSharedObject: true,
        frozen: [true, true, true, true, true],
        taskViewShape: {
          state: 'pending',
          depth: 1,
          criteria: ['build', 'tests'],
          ownerSession: 'native:codex-1',
          leaseExpiresAt: T0 + LEASE_TTL,
          leaseIdIsUuid: true,
          blockedBy: [],
          paused: null,
          ambiguous: false,
          attempts: [],
          review: { state: 'none', reviewer: null, reason: null, at: null },
          acceptance: { state: 'none', acceptedBy: null, acceptedAt: null, deliverableId: null, criteria: [] },
          deliverables: [],
        },
        unknownTask: { code: 'invalid_request', field: 'task_unknown' },
        badTaskId: { code: 'invalid_request', field: 'task_id' },
        unknownTeam: { code: 'invalid_request', field: 'team_unknown' },
        duplicateTeam: { code: 'conflict', field: 'team_duplicate' },
        badDeliverPort: { code: 'invalid_request', field: 'coordinator_deliver' },
        state: { teams: 1, tasks: 1, attempts: 0, dispatches: 0, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 0, closed: false },
      });
    }

    // ── C6: the ladder order is enforced, and every non-completed terminal reason fails the task ──
    {
      const world = makeWorld();
      const task = world.makeTask({ title: 'ladder order' });
      const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
      const attemptId = dispatched.attempt.attemptId;
      const observeBeforeSend = captureSync(() => world.coordinator.observe({ attemptId, nativeEventId: 'evt-1', at: T0 + 2 }));
      const endBeforeSend = captureSync(() => world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 3 }));
      const badReason = captureSync(() => world.coordinator.observeNativeEnd({ attemptId, reason: 'nope', at: T0 + 4 }));
      await world.coordinator.send({ attemptId, at: T0 + 5 });
      const ended = world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 6 });
      const reobserve = captureSync(() => world.coordinator.observe({ attemptId, nativeEventId: 'evt-2', at: T0 + 7 }));
      const reasons = {};
      for (const reason of ['failed', 'cancelled', 'timeout', 'aborted']) {
        const lane = makeWorld();
        const laneTask = lane.makeTask({ title: `reason ${reason}` });
        const laneDispatched = await lane.coordinator.dispatch({ taskId: laneTask.taskId, at: T0 + 1 });
        await lane.coordinator.send({ attemptId: laneDispatched.attempt.attemptId, at: T0 + 2 });
        const laneEnded = lane.coordinator.observeNativeEnd({ attemptId: laneDispatched.attempt.attemptId, reason, at: T0 + 3 });
        reasons[reason] = {
          attempt: { state: laneEnded.state, terminalReason: laneEnded.terminalReason },
          task: { state: lane.coordinator.task(laneTask.taskId).state, acceptance: lane.coordinator.task(laneTask.taskId).acceptance.state },
          failures: lane.coordinator.state().failures,
        };
      }
      check('the attempt ladder is enforced in order — observe before the send and a native end before the send are each conflict/attempt_state, an unknown terminal reason is invalid_request/attempt_terminal_reason, and a second observe after the terminal rung is conflict/attempt_state — while every NON-completed native terminal reason (failed, cancelled, timeout, aborted) drives the attempt to terminal with that reason and drives the TASK to failed with acceptance still none: a native end is never a task success, and only completed reaches review', {
        observeBeforeSend,
        endBeforeSend,
        badReason,
        ended: { state: ended.state, terminalReason: ended.terminalReason },
        reobserve,
        ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
        reasons,
        running: world.coordinator.state().running,
      }, {
        observeBeforeSend: { code: 'conflict', field: 'attempt_state' },
        endBeforeSend: { code: 'conflict', field: 'attempt_state' },
        badReason: { code: 'invalid_request', field: 'attempt_terminal_reason' },
        ended: { state: 'terminal', terminalReason: 'completed' },
        reobserve: { code: 'conflict', field: 'attempt_state' },
        ops: ['accept:applied', 'deliver:applied', 'end:applied'],
        reasons: {
          failed: { attempt: { state: 'terminal', terminalReason: 'failed' }, task: { state: 'failed', acceptance: 'none' }, failures: 1 },
          cancelled: { attempt: { state: 'terminal', terminalReason: 'cancelled' }, task: { state: 'failed', acceptance: 'none' }, failures: 1 },
          timeout: { attempt: { state: 'terminal', terminalReason: 'timeout' }, task: { state: 'failed', acceptance: 'none' }, failures: 1 },
          aborted: { attempt: { state: 'terminal', terminalReason: 'aborted' }, task: { state: 'failed', acceptance: 'none' }, failures: 1 },
        },
        running: 0,
      });
    }

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: a cycle and a duplicate assignment, a source error, a failure after the send
      // ack, a self-reported done with no deliverable, a duplicate terminal and a cancel race, an
      // owner-lease expiry that must not auto-mark success, an ambiguous send, the Host-stop budget
      // observation, the restart retention pass and the closed coordinator.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: a cycle and a duplicate assignment ──
      {
        const world = makeWorld();
        const a = world.makeTask({ title: 'task a' });
        const b = world.makeTask({ title: 'task b', dependsOn: [a.taskId] });
        const cycle2 = captureSync(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: b.taskId, at: T0 + 10 }));
        const self = captureSync(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: a.taskId, at: T0 + 11 }));
        const c = world.makeTask({ title: 'task c', dependsOn: [b.taskId] });
        const cycle3 = captureSync(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: c.taskId, at: T0 + 12 }));
        const unknownDependency = captureSync(() => world.coordinator.addDependency({ taskId: a.taskId, dependsOn: '22222222-2222-4222-8222-222222222222', at: T0 + 13 }));
        const duplicateDependency = captureSync(() => world.coordinator.addDependency({ taskId: b.taskId, dependsOn: a.taskId, at: T0 + 14 }));
        // Snapshot BEFORE any dispatch happens: this is the moment the refusal evidence above
        // describes, so the expectation must describe THIS moment too — a snapshot's capture point
        // and the expectation's assumed point are the same point (the task-37 snapshot-timing
        // lesson). It also proves the refused edges left task a at its initial pending state.
        const aBeforeAnyDispatch = world.coordinator.task(a.taskId);
        const dispatchesBeforeBlocked = world.coordinator.state().dispatches;
        const blocked = await capture(() => world.coordinator.dispatch({ taskId: b.taskId, at: T0 + 15 }));
        // Read immediately after the blocked dispatch and before a's own dispatch, so the field is
        // the DELTA the blocked task caused — not the global counter — which is the stronger
        // assertion: it proves the blocked dispatch dispatched nothing.
        const dispatchesAfterBlocked = world.coordinator.state().dispatches - dispatchesBeforeBlocked;
        const attemptsAfterBlocked = world.coordinator.attempts(b.taskId).length;
        await world.coordinator.dispatch({ taskId: a.taskId, at: T0 + 16 });
        // Snapshot AFTER a's own dispatch: the pair proves the pending → dispatched transition
        // rather than asserting a single point in time.
        const aAfterDispatch = world.coordinator.task(a.taskId);
        const duplicateAssignment = await capture(() => world.coordinator.dispatch({ taskId: a.taskId, at: T0 + 17 }));
        check('the DAG stays acyclic and a task is never assigned twice: a two-cycle, a self-dependency and a three-cycle are each refused conflict/task_cycle, an unknown dependency is invalid_request/task_unknown and a duplicate dependency conflict/task_dependency — and every refused edge leaves NO trace, so a still has no dependencies and depth 1 while b and c still carry exactly their original edges; a blocked dependency refuses dispatch with conflict/task_blocked and mints no attempt, and a second dispatch of an already-dispatched task is conflict/task_dispatched with still exactly one attempt and one dispatch — task a is observed at pending before ANY dispatch and at dispatched after its own dispatch, so the transition itself is proven, and the blocked dispatch moved the global dispatch counter by exactly zero', {
          cycle2, self, cycle3, unknownDependency, duplicateDependency,
          aBeforeAnyDispatch: { dependsOn: aBeforeAnyDispatch.dependsOn, depth: aBeforeAnyDispatch.depth, state: aBeforeAnyDispatch.state },
          aAfterDispatch: { dependsOn: aAfterDispatch.dependsOn, depth: aAfterDispatch.depth, state: aAfterDispatch.state },
          bDependsOn: world.coordinator.task(b.taskId).dependsOn,
          cDependsOn: world.coordinator.task(c.taskId).dependsOn,
          blocked,
          dispatchesAfterBlocked,
          attemptsAfterBlocked,
          duplicateAssignment,
          attemptsOnA: world.coordinator.attempts(a.taskId).length,
          dispatches: world.coordinator.state().dispatches,
        }, {
          cycle2: { code: 'conflict', field: 'task_cycle' },
          self: { code: 'conflict', field: 'task_cycle' },
          cycle3: { code: 'conflict', field: 'task_cycle' },
          unknownDependency: { code: 'invalid_request', field: 'task_unknown' },
          duplicateDependency: { code: 'conflict', field: 'task_dependency' },
          aBeforeAnyDispatch: { dependsOn: [], depth: 1, state: 'pending' },
          aAfterDispatch: { dependsOn: [], depth: 1, state: 'dispatched' },
          bDependsOn: [a.taskId],
          cDependsOn: [b.taskId],
          blocked: { code: 'conflict', field: 'task_blocked' },
          dispatchesAfterBlocked: 0,
          attemptsAfterBlocked: 0,
          duplicateAssignment: { code: 'conflict', field: 'task_dispatched' },
          attemptsOnA: 1,
          dispatches: 1,
        });
      }

      // ── F2: a source error fails the attempt and the task, carrying the typed rejection ──
      {
        const world = makeWorld(async () => { throw new CollaborationError('source_unavailable', 'attempt_send'); });
        const task = world.makeTask({ title: 'source broken' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        const failed = await capture(() => world.coordinator.send({ attemptId, at: T0 + 2 }));
        const after = world.coordinator.task(task.taskId);
        const attempt = world.coordinator.attempt(attemptId);
        check('a source error in the deliver port is carried VERBATIM out of send as source_unavailable/attempt_send, fails the task to state failed with acceptance still none, retains the failed attempt as an observable record whose projected state is the reconcile stop with the typed resolution attached, steps the failure counter exactly once, and releases the concurrency slot — the failed attempt is never a success', {
          failed,
          task: { state: after.state, acceptance: after.acceptance.state, attempts: after.attempts.length },
          attempt: { state: attempt.state, resolution: attempt.resolution },
          ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
          state: world.coordinator.state(),
        }, {
          failed: { code: 'source_unavailable', field: 'attempt_send' },
          task: { state: 'failed', acceptance: 'none', attempts: 1 },
          attempt: { state: 'reconcile', resolution: { kind: 'failed', code: 'source_unavailable', field: 'attempt_send', reason: null, at: T0 + 2 } },
          ops: ['accept:applied', 'deliver:failed'],
          state: { teams: 1, tasks: 1, attempts: 1, dispatches: 1, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 1, closed: false },
        });
      }

      // ── F3: a failure AFTER the send ack is never a success ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'ack then fail' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        await world.coordinator.send({ attemptId, at: T0 + 2 });
        const afterAck = world.coordinator.attempt(attemptId);
        world.coordinator.observe({ attemptId, nativeEventId: 'evt-1', at: T0 + 3 });
        const ended = world.coordinator.observeNativeEnd({ attemptId, nativeEventId: 'evt-2', reason: 'failed', at: T0 + 4 });
        const afterNativeFail = world.coordinator.task(task.taskId);
        // The same outcome through the Host failTask path.
        const hostWorld = makeWorld();
        const hostTask = hostWorld.makeTask({ title: 'ack then failTask' });
        const hostDispatched = await hostWorld.coordinator.dispatch({ taskId: hostTask.taskId, at: T0 + 1 });
        await hostWorld.coordinator.send({ attemptId: hostDispatched.attempt.attemptId, at: T0 + 2 });
        const failTaskResult = hostWorld.coordinator.failTask({ taskId: hostTask.taskId, code: 'source_unavailable', field: 'attempt_send', reason: 'worker died', at: T0 + 3 });
        const hostAttempt = hostWorld.coordinator.attempt(hostDispatched.attempt.attemptId);
        const redispatchAfterFail = await capture(() => hostWorld.coordinator.dispatch({ taskId: hostTask.taskId, at: T0 + 4 }));
        check('a failure that arrives AFTER the send ack is never read as success: the ack leaves the attempt at sent with sends 1, the native end with reason failed drives the attempt to terminal with terminalReason failed and the TASK to failed with acceptance none, and the Host failTask path does the same while retaining the failed attempt with its typed resolution AND releasing the concurrency and Session-mutation slots the running attempt held (running and sessionMutations back to 0) — a failed task refuses re-dispatch with conflict/task_state', {
          afterAck: { state: afterAck.state, sent: afterAck.sent, sends: afterAck.sends },
          ended: { state: ended.state, terminalReason: ended.terminalReason },
          afterNativeFail: { state: afterNativeFail.state, acceptance: afterNativeFail.acceptance.state },
          failTaskResult: { state: failTaskResult.state, acceptance: failTaskResult.acceptance.state },
          hostAttempt: { state: hostAttempt.state, resolution: hostAttempt.resolution },
          redispatchAfterFail,
          hostState: hostWorld.coordinator.state(),
        }, {
          afterAck: { state: 'sent', sent: true, sends: 1 },
          ended: { state: 'terminal', terminalReason: 'failed' },
          afterNativeFail: { state: 'failed', acceptance: 'none' },
          failTaskResult: { state: 'failed', acceptance: 'none' },
          hostAttempt: { state: 'reconcile', resolution: { kind: 'failed', code: 'source_unavailable', field: 'attempt_send', reason: 'worker died', at: T0 + 3 } },
          redispatchAfterFail: { code: 'conflict', field: 'task_state' },
          hostState: { teams: 1, tasks: 1, attempts: 1, dispatches: 1, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 1, closed: false },
        });
      }

      // ── F4: reporting done with no deliverable is refused, and the task is not accepted ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'self-reported done' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        await world.coordinator.send({ attemptId: dispatched.attempt.attemptId, at: T0 + 2 });
        world.coordinator.observe({ attemptId: dispatched.attempt.attemptId, nativeEventId: 'evt-1', at: T0 + 3 });
        const ended = world.coordinator.observeNativeEnd({ attemptId: dispatched.attempt.attemptId, nativeEventId: 'evt-2', reason: 'completed', at: T0 + 4 });
        const afterEnd = world.coordinator.task(task.taskId);
        const noDeliverable = captureSync(() => world.acceptAll(task.taskId, T0 + 5));
        const afterRefusal = world.coordinator.task(task.taskId);
        // The Host review path is reachable, but it still cannot accept without a deliverable.
        world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 6 });
        const noReview = captureSync(() => world.acceptAll(task.taskId, T0 + 7));
        check('a native end that reports completed with NO registered deliverable cannot be success: the attempt reaches terminal with terminalReason completed, the TASK moves only to review with acceptance none and an empty deliverable list, and an acceptance is refused invalid_request/acceptance_deliverable with the task still in review and acceptance still none — and once a deliverable IS registered but no reviewer has approved, the acceptance is refused conflict/acceptance_review, so a self-reported done never becomes accepted', {
          ended: { state: ended.state, terminalReason: ended.terminalReason },
          afterEnd: { state: afterEnd.state, acceptance: afterEnd.acceptance.state, deliverables: afterEnd.deliverables.length, review: afterEnd.review.state },
          noDeliverable,
          afterRefusal: { state: afterRefusal.state, acceptance: afterRefusal.acceptance.state },
          noReview,
          afterSecondRefusal: { state: world.coordinator.task(task.taskId).state, acceptance: world.coordinator.task(task.taskId).acceptance.state, review: world.coordinator.task(task.taskId).review.state },
        }, {
          ended: { state: 'terminal', terminalReason: 'completed' },
          afterEnd: { state: 'review', acceptance: 'none', deliverables: 0, review: 'none' },
          noDeliverable: { code: 'invalid_request', field: 'acceptance_deliverable' },
          afterRefusal: { state: 'review', acceptance: 'none' },
          noReview: { code: 'conflict', field: 'acceptance_review' },
          afterSecondRefusal: { state: 'review', acceptance: 'none', review: 'none' },
        });
      }

      // ── F5: a duplicate terminal and a cancel race record exactly one outcome ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'double end' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        await world.coordinator.send({ attemptId, at: T0 + 2 });
        world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 3 });
        const duplicateEnd = captureSync(() => world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 4 }));
        const duplicateEndOtherReason = captureSync(() => world.coordinator.observeNativeEnd({ attemptId, reason: 'failed', at: T0 + 5 }));
        const cancelRace = captureSync(() => world.coordinator.cancelAttempt({ attemptId, at: T0 + 6 }));
        const after = world.coordinator.attempt(attemptId);
        const taskAfter = world.coordinator.task(task.taskId);
        const endOps = world.coordinator.ops(attemptId).filter((op) => op.kind === 'end');
        // An accepted task refuses both Host stops.
        const acceptedWorld = makeWorld();
        const acceptedTask = acceptedWorld.makeTask({ title: 'cancel after accept' });
        const acceptedDispatched = await acceptedWorld.coordinator.dispatch({ taskId: acceptedTask.taskId, at: T0 + 1 });
        await acceptedWorld.coordinator.send({ attemptId: acceptedDispatched.attempt.attemptId, at: T0 + 2 });
        acceptedWorld.coordinator.observeNativeEnd({ attemptId: acceptedDispatched.attempt.attemptId, reason: 'completed', at: T0 + 3 });
        acceptedWorld.coordinator.registerDeliverable({ taskId: acceptedTask.taskId, deliverable: DELIVERABLE, at: T0 + 4 });
        acceptedWorld.coordinator.submitForReview({ taskId: acceptedTask.taskId, reviewer: REVIEWER, at: T0 + 5 });
        acceptedWorld.coordinator.review({ taskId: acceptedTask.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 6 });
        acceptedWorld.acceptAll(acceptedTask.taskId, T0 + 7);
        const cancelAccepted = captureSync(() => acceptedWorld.coordinator.cancelTask({ taskId: acceptedTask.taskId, at: T0 + 8 }));
        const failAccepted = captureSync(() => acceptedWorld.coordinator.failTask({ taskId: acceptedTask.taskId, code: 'x', field: 'y', at: T0 + 9 }));
        // And a mid-flight cancel is a visible stop, never a success.
        const cancelWorld = makeWorld();
        const cancelTask = cancelWorld.makeTask({ title: 'cancel me' });
        const cancelDispatched = await cancelWorld.coordinator.dispatch({ taskId: cancelTask.taskId, at: T0 + 1 });
        await cancelWorld.coordinator.send({ attemptId: cancelDispatched.attempt.attemptId, at: T0 + 2 });
        const cancelled = cancelWorld.coordinator.cancelAttempt({ attemptId: cancelDispatched.attempt.attemptId, reason: 'user stopped', at: T0 + 3 });
        check('a duplicate terminal and a cancel that races a terminal attempt record EXACTLY one outcome: the second native end — with the same reason and with a different one — is conflict/attempt_state, a cancel racing the terminal attempt is conflict/attempt_state, the FIRST terminal is retained with terminalReason completed and a null resolution, the journal holds exactly one end op and one op per rung, and the task sits at review with acceptance none; an already-accepted task refuses both Host stops with conflict/task_state and stays accepted, and a mid-flight cancelAttempt is a visible stop — the attempt reaches the reconcile rung with resolution cancelled/attempt_cancelled and the task state cancelled, running back to 0', {
          duplicateEnd,
          duplicateEndOtherReason,
          cancelRace,
          after: { state: after.state, terminalReason: after.terminalReason, resolution: after.resolution },
          taskAfter: { state: taskAfter.state, acceptance: taskAfter.acceptance.state },
          endOps: endOps.map((op) => `${op.kind}:${op.outcome}`),
          endOpCount: endOps.length,
          ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
          cancelAccepted,
          failAccepted,
          acceptedStays: { state: acceptedWorld.coordinator.task(acceptedTask.taskId).state, acceptance: acceptedWorld.coordinator.task(acceptedTask.taskId).acceptance.state },
          cancelled: { state: cancelled.state, resolution: cancelled.resolution },
          cancelTaskState: cancelWorld.coordinator.task(cancelTask.taskId).state,
          cancelRunning: cancelWorld.coordinator.state().running,
        }, {
          duplicateEnd: { code: 'conflict', field: 'attempt_state' },
          duplicateEndOtherReason: { code: 'conflict', field: 'attempt_state' },
          cancelRace: { code: 'conflict', field: 'attempt_state' },
          after: { state: 'terminal', terminalReason: 'completed', resolution: null },
          taskAfter: { state: 'review', acceptance: 'none' },
          endOps: ['end:applied'],
          endOpCount: 1,
          ops: ['accept:applied', 'deliver:applied', 'end:applied'],
          cancelAccepted: { code: 'conflict', field: 'task_state' },
          failAccepted: { code: 'conflict', field: 'task_state' },
          acceptedStays: { state: 'accepted', acceptance: 'accepted' },
          cancelled: { state: 'reconcile', resolution: { kind: 'cancelled', code: 'cancelled', field: 'attempt_cancelled', reason: 'user stopped', at: T0 + 3 } },
          cancelTaskState: 'cancelled',
          cancelRunning: 0,
        });
      }

      // ── F6: owner-lease expiry must not auto-mark success ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'lease lapses', leaseTtl: 10 });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        await world.coordinator.send({ attemptId, at: T0 + 2 });
        world.coordinator.observeNativeEnd({ attemptId, reason: 'completed', at: T0 + 3 });
        const midFlight = world.coordinator.task(task.taskId);
        const registerAfterExpiry = captureSync(() => world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 50 }));
        const submitAfterExpiry = captureSync(() => world.coordinator.submitForReview({ taskId: task.taskId, reviewer: REVIEWER, at: T0 + 51 }));
        const acceptAfterExpiry = captureSync(() => world.acceptAll(task.taskId, T0 + 52));
        const after = world.coordinator.task(task.taskId);
        const expiredDispatch = await capture(() => world.coordinator.dispatch({ taskId: world.makeTask({ title: 'never dispatched', leaseTtl: 10 }).taskId, at: T0 + 100 }));
        check('an owner whose lease lapses is never auto-marked a success: after the native end the task sits at review with acceptance none and a lease whose expiresAt is already in the past relative to the later clock, and EVERY acceptance-side operation is then refused conflict/task_lease — registering a deliverable, submitting for review and accepting all alike — so the task stays at review with acceptance none and an empty deliverable list, and a dispatch whose lease has already expired is refused conflict/task_lease with nothing minted', {
          midFlight: { state: midFlight.state, acceptance: midFlight.acceptance.state, leaseExpiresAt: midFlight.lease.expiresAt },
          registerAfterExpiry,
          submitAfterExpiry,
          acceptAfterExpiry,
          after: { state: after.state, acceptance: after.acceptance.state, deliverables: after.deliverables.length },
          expiredDispatch,
          state: world.coordinator.state(),
        }, {
          midFlight: { state: 'review', acceptance: 'none', leaseExpiresAt: T0 + 10 },
          registerAfterExpiry: { code: 'conflict', field: 'task_lease' },
          submitAfterExpiry: { code: 'conflict', field: 'task_lease' },
          acceptAfterExpiry: { code: 'conflict', field: 'task_lease' },
          after: { state: 'review', acceptance: 'none', deliverables: 0 },
          expiredDispatch: { code: 'conflict', field: 'task_lease' },
          state: { teams: 1, tasks: 2, attempts: 1, dispatches: 1, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 0, closed: false },
        });
      }

      // ── F7: an ambiguous send is retained, never retried and never a success ──
      {
        let calls = 0;
        const world = makeWorld(async () => {
          calls += 1;
          return calls === 1 ? { ackId: 'ack-1' } : { ambiguous: true };
        });
        const first = world.makeTask({ title: 'first', ownerIndex: 0 });
        const second = world.makeTask({ title: 'second', ownerIndex: 1 });
        const firstDispatched = await world.coordinator.dispatch({ taskId: first.taskId, at: T0 + 1 });
        await world.coordinator.send({ attemptId: firstDispatched.attempt.attemptId, at: T0 + 2 });
        world.coordinator.observeNativeEnd({ attemptId: firstDispatched.attempt.attemptId, reason: 'completed', at: T0 + 3 });
        const secondDispatched = await world.coordinator.dispatch({ taskId: second.taskId, at: T0 + 4 });
        const ambiguous = await world.coordinator.send({ attemptId: secondDispatched.attempt.attemptId, at: T0 + 5 });
        const taskAfter = world.coordinator.task(second.taskId);
        check('an unreadable send outcome is a STOP at reconcile that is retained and never retried: the attempt reaches the reconcile rung with resolution reconcile_required/attempt_ambiguous, the task is visibly ambiguous while still dispatched, acceptance stays none and the state is never accepted, the delivery probe ran exactly twice across two dispatches (no blind retry), the reconcile counter steps once and the concurrency slot is released so the ambiguous attempt holds no budget', {
          attempt: { state: ambiguous.attempt.state, resolution: ambiguous.attempt.resolution },
          task: { state: taskAfter.state, ambiguous: taskAfter.ambiguous, acceptance: taskAfter.acceptance.state },
          deliverCalls: calls,
          state: world.coordinator.state(),
          running: world.coordinator.state().running,
        }, {
          attempt: { state: 'reconcile', resolution: { kind: 'reconcile', code: 'reconcile_required', field: 'attempt_ambiguous', reason: null, at: T0 + 5 } },
          task: { state: 'dispatched', ambiguous: true, acceptance: 'none' },
          deliverCalls: 2,
          state: { teams: 1, tasks: 2, attempts: 2, dispatches: 2, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 1, failures: 0, closed: false },
          running: 0,
        });
      }

      // ── F8: the two Host stops DO release the concurrency and Session-mutation slots ──
      {
        const world = makeWorld();
        const tasks = [0, 1, 2, 3, 4].map((index) => world.makeTask({ title: `slot ${index}`, ownerIndex: index }));
        const running = [];
        for (let index = 0; index < 4; index += 1) {
          const dispatched = await world.coordinator.dispatch({ taskId: tasks[index].taskId, at: T0 + 1 + index });
          running.push(dispatched.attempt.attemptId);
        }
        const before = { running: world.coordinator.state().running, used: world.coordinator.budgets().used };
        world.coordinator.cancelTask({ taskId: tasks[0].taskId, reason: 'stop', at: T0 + 20 });
        const afterCancel = {
          running: world.coordinator.state().running,
          used: world.coordinator.budgets().used,
          task0: world.coordinator.task(tasks[0].taskId).state,
          attempt0: world.coordinator.attempt(running[0]).state,
        };
        // The freed slot admits the queued fifth task IMMEDIATELY — no pause, no restart needed.
        const fifth = await world.coordinator.dispatch({ taskId: tasks[4].taskId, at: T0 + 21 });
        const afterFifth = { running: world.coordinator.state().running, fifth: { state: fifth.task.state, attempt: fifth.attempt?.state ?? null } };
        // failTask releases the same way, keyed off the reservation actually held.
        world.coordinator.failTask({ taskId: tasks[1].taskId, code: 'source_unavailable', field: 'attempt_send', at: T0 + 22 });
        const afterFail = {
          running: world.coordinator.state().running,
          used: world.coordinator.budgets().used,
          task1: world.coordinator.task(tasks[1].taskId).state,
          attempt1: world.coordinator.attempt(running[1]).state,
        };
        // restart() still re-derives every counter from the attempt records themselves and
        // retains every non-terminal attempt — the recovery pass is unchanged by the fix.
        const restart = world.coordinator.restart({ at: T0 + 23 });
        const afterRestart = { running: world.coordinator.state().running, used: world.coordinator.budgets().used, retained: restart.retained.length };
        const pumpAfterRestart = (await world.coordinator.pump({ at: T0 + 24 })).map((view) => view.title);
        // The contrast, in its own world: cancelAttempt releases the slot, unchanged.
        const contrast = makeWorld();
        const contrastTasks = [0, 1, 2, 3, 4].map((index) => contrast.makeTask({ title: `c${index}`, ownerIndex: index }));
        const contrastRunning = [];
        for (let index = 0; index < 4; index += 1) {
          const dispatched = await contrast.coordinator.dispatch({ taskId: contrastTasks[index].taskId, at: T0 + 1 + index });
          contrastRunning.push(dispatched.attempt.attemptId);
        }
        contrast.coordinator.cancelAttempt({ attemptId: contrastRunning[0], reason: 'stop', at: T0 + 20 });
        const contrastFifth = await contrast.coordinator.dispatch({ taskId: contrastTasks[4].taskId, at: T0 + 21 });
        check('RELEASED, NOT FORCED: cancelTask and failTask release the concurrency and Session-mutation slots their running attempts hold — the release keys off the reservation actually held BEFORE the stop rewrites the projected state, never off the post-stop projection — so with four attempts in flight a cancelTask drops running to 3 and the queued fifth task dispatches immediately at accepted, and a failTask drops it to 3 again over the three remaining sessions; restart() still re-derives every counter from the attempt records themselves (running back to 0, all five non-terminal attempts retained) and afterwards pump admits nothing because nothing is paused. The three stops now agree: the contrast world shows cancelAttempt releasing the same way, its fifth task dispatched immediately too', {
          before,
          afterCancel,
          afterFifth,
          afterFail,
          afterRestart,
          pumpAfterRestart,
          dispatches: world.coordinator.state().dispatches,
          contrast: {
            fifth: { state: contrastFifth.task.state, attempt: contrastFifth.attempt?.state ?? null },
            running: contrast.coordinator.state().running,
            task0: contrast.coordinator.task(contrastTasks[0].taskId).state,
          },
        }, {
          before: { running: 4, used: { concurrency: 4, sessionMutations: 4, depth: 1, children: 0, mailbox: 0 } },
          afterCancel: { running: 3, used: { concurrency: 3, sessionMutations: 3, depth: 1, children: 0, mailbox: 0 }, task0: 'cancelled', attempt0: 'reconcile' },
          afterFifth: { running: 4, fifth: { state: 'dispatched', attempt: 'accepted' } },
          afterFail: { running: 3, used: { concurrency: 3, sessionMutations: 3, depth: 1, children: 0, mailbox: 0 }, task1: 'failed', attempt1: 'reconcile' },
          afterRestart: { running: 0, used: { concurrency: 0, sessionMutations: 0, depth: 1, children: 0, mailbox: 0 }, retained: 5 },
          pumpAfterRestart: [],
          dispatches: 5,
          contrast: { fifth: { state: 'dispatched', attempt: 'accepted' }, running: 4, task0: 'cancelled' },
        });
      }

      // ── F9: the restart pass retains an ambiguous attempt and never auto-dispatches ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'in flight' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        await world.coordinator.send({ attemptId, at: T0 + 2 });
        const beforeRestart = { attempt: world.coordinator.attempt(attemptId).state, dispatches: world.coordinator.state().dispatches };
        const view = world.coordinator.restart({ at: T0 + 10 });
        const retained = world.coordinator.attempt(attemptId);
        const taskAfter = world.coordinator.task(task.taskId);
        const again = world.coordinator.restart({ at: T0 + 11 });
        // The disclosed crash branch: an attempt accepted but never delivered is retained too.
        const neverDelivered = makeWorld();
        const neverTask = neverDelivered.makeTask({ title: 'never delivered' });
        const neverDispatched = await neverDelivered.coordinator.dispatch({ taskId: neverTask.taskId, at: T0 + 1 });
        const neverView = neverDelivered.coordinator.restart({ at: T0 + 2 });
        // A terminal attempt is NOT retained.
        const terminal = makeWorld();
        const terminalTask = terminal.makeTask({ title: 'terminal then restart' });
        const terminalDispatched = await terminal.coordinator.dispatch({ taskId: terminalTask.taskId, at: T0 + 1 });
        await terminal.coordinator.send({ attemptId: terminalDispatched.attempt.attemptId, at: T0 + 2 });
        terminal.coordinator.observeNativeEnd({ attemptId: terminalDispatched.attempt.attemptId, reason: 'completed', at: T0 + 3 });
        const terminalView = terminal.coordinator.restart({ at: T0 + 4 });
        check('an ambiguous restart is RETAINED and never auto-dispatched: a delivered-but-never-ended attempt is reconciled and retained with resolution reconcile_required/collaboration_restart_ambiguous and the reason naming the rung it stopped at, the task is visibly ambiguous while still dispatched with acceptance none, RestartView.dispatched is empty BY CONSTRUCTION, the observed dispatch counter does not move, the concurrency slot is released, a second restart is idempotent, an attempt accepted but never delivered is retained the same way, and a terminal attempt is not retained at all', {
          beforeRestart,
          view: { rehydrated: view.rehydrated, retained: view.retained, dispatched: view.dispatched, paused: view.paused },
          retained: { state: retained.state, resolution: retained.resolution },
          taskAfter: { state: taskAfter.state, ambiguous: taskAfter.ambiguous, acceptance: taskAfter.acceptance.state },
          dispatchesAfter: world.coordinator.state().dispatches,
          running: world.coordinator.state().running,
          reconciles: world.coordinator.state().reconciles,
          attemptsAll: world.coordinator.attempts().length,
          ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
          again: { rehydrated: again.rehydrated, retained: again.retained, dispatched: again.dispatched },
          dispatchesAfterSecond: world.coordinator.state().dispatches,
          neverDelivered: {
            retained: neverView.retained.map((entry) => ({ state: entry.state })),
            dispatched: neverView.dispatched,
            reason: neverDelivered.coordinator.attempt(neverDispatched.attempt.attemptId).resolution.reason,
            task: { state: neverDelivered.coordinator.task(neverTask.taskId).state, ambiguous: neverDelivered.coordinator.task(neverTask.taskId).ambiguous },
            dispatches: neverDelivered.coordinator.state().dispatches,
          },
          terminal: {
            retained: terminalView.retained,
            dispatched: terminalView.dispatched,
            rehydrated: terminalView.rehydrated,
            taskState: terminal.coordinator.task(terminalTask.taskId).state,
            attempts: terminal.coordinator.attempts().length,
          },
        }, {
          beforeRestart: { attempt: 'sent', dispatches: 1 },
          view: {
            rehydrated: 2,
            retained: [{ taskId: task.taskId, attemptId, state: 'reconcile' }],
            dispatched: [],
            paused: [],
          },
          retained: { state: 'reconcile', resolution: { kind: 'reconcile', code: 'reconcile_required', field: 'collaboration_restart_ambiguous', reason: `attempt ${attemptId} stopped at sent before a native end`, at: T0 + 10 } },
          taskAfter: { state: 'dispatched', ambiguous: true, acceptance: 'none' },
          dispatchesAfter: 1,
          running: 0,
          reconciles: 1,
          attemptsAll: 1,
          ops: ['accept:applied', 'deliver:applied', 'reconcile:reconcile'],
          again: { rehydrated: 2, retained: [{ taskId: task.taskId, attemptId, state: 'reconcile' }], dispatched: [] },
          dispatchesAfterSecond: 1,
          neverDelivered: {
            retained: [{ state: 'reconcile' }],
            dispatched: [],
            reason: `attempt ${neverDispatched.attempt.attemptId} stopped at accepted before a native end`,
            task: { state: 'dispatched', ambiguous: true },
            dispatches: 1,
          },
          terminal: { retained: [], dispatched: [], rehydrated: 2, taskState: 'review', attempts: 1 },
        });
      }

      // ── F10: after close every entry point refuses with cancelled/coordinator_closed ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'close me' });
        world.coordinator.close();
        check('after close() every entry point refuses with cancelled/coordinator_closed — createTeam, team, teams, task, tasks, dispatch, attempt, mailbox and budgets alike — while state() still reports the frozen counters with closed true, so a closed coordinator can be inspected but never written', {
          createTeam: captureSync(() => world.coordinator.createTeam({ name: 'x', at: T0 })),
          team: captureSync(() => world.coordinator.team(world.teamId)),
          teams: captureSync(() => world.coordinator.teams()),
          task: captureSync(() => world.coordinator.task(task.taskId)),
          tasks: captureSync(() => world.coordinator.tasks()),
          dispatch: await capture(() => world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 })),
          attempt: captureSync(() => world.coordinator.attempt('22222222-2222-4222-8222-222222222222')),
          mailbox: captureSync(() => world.coordinator.mailbox(world.teamId)),
          budgets: captureSync(() => world.coordinator.budgets()),
          state: world.coordinator.state(),
        }, {
          createTeam: { code: 'cancelled', field: 'coordinator_closed' },
          team: { code: 'cancelled', field: 'coordinator_closed' },
          teams: { code: 'cancelled', field: 'coordinator_closed' },
          task: { code: 'cancelled', field: 'coordinator_closed' },
          tasks: { code: 'cancelled', field: 'coordinator_closed' },
          dispatch: { code: 'cancelled', field: 'coordinator_closed' },
          attempt: { code: 'cancelled', field: 'coordinator_closed' },
          mailbox: { code: 'cancelled', field: 'coordinator_closed' },
          budgets: { code: 'cancelled', field: 'coordinator_closed' },
          state: { teams: 1, tasks: 1, attempts: 0, dispatches: 0, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 0, closed: true },
        });
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: the multi-harness Task DAG, run complete → review → accept, a restart that
      // recovers an already-observed attempt, fair scheduling under the budgets, and each of the
      // five budgets enforced with observed numbers.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── H1: a multi-harness Task DAG ──
      {
        const world = makeWorld();
        const codex = world.makeTask({ title: 'codex root', ownerIndex: 0 });
        const acp = world.makeTask({ title: 'acp branch', ownerIndex: 1, dependsOn: [codex.taskId] });
        const kimi = world.makeTask({ title: 'kimi branch', ownerIndex: 2, dependsOn: [codex.taskId] });
        const dsh = world.makeTask({ title: 'dsh join', ownerIndex: 3, dependsOn: [acp.taskId, kimi.taskId] });
        const opencode = world.makeTask({ title: 'opencode leaf', ownerIndex: 4, parentId: dsh.taskId });
        check('a multi-harness Task DAG is observed whole: the team reports its task count 5 and every one of the five harness kinds carries its own native-session identity through the owner it was created with, the diamond is observed as its exact dependency edges (acp and kimi each depend on the codex root, dsh joins on both, the opencode leaf decomposes from dsh), depth is derived over BOTH edge kinds as [1, 2, 2, 3, 4] with the deepest rung exactly at the frozen depth budget of 4, children are recorded only for the decomposition edge (dsh holds the opencode leaf, the codex root holds none), every unaccepted dependency is DERIVED into blockedBy (the codex root blocks acp and kimi, and both transitively block dsh; the opencode leaf is blocked by nothing), and all five tasks sit at pending with no attempt, no pause and no review', {
          team: world.coordinator.team(world.teamId),
          allTaskCount: world.coordinator.tasks(world.teamId).length,
          harnessIdentity: world.coordinator.tasks(world.teamId).map((view) => ({
            title: view.title,
            harness: view.owner.session.nativeSessionId,
            harnessInstanceId: view.owner.session.harnessInstanceId,
            participantId: view.owner.participantId,
          })),
          edges: {
            codex: { dependsOn: world.coordinator.task(codex.taskId).dependsOn, children: world.coordinator.task(codex.taskId).children },
            acp: { dependsOn: world.coordinator.task(acp.taskId).dependsOn, children: world.coordinator.task(acp.taskId).children },
            kimi: { dependsOn: world.coordinator.task(kimi.taskId).dependsOn, children: world.coordinator.task(kimi.taskId).children },
            dsh: { dependsOn: world.coordinator.task(dsh.taskId).dependsOn, children: world.coordinator.task(dsh.taskId).children },
            opencode: { dependsOn: world.coordinator.task(opencode.taskId).dependsOn, parentId: world.coordinator.task(opencode.taskId).parentId, children: world.coordinator.task(opencode.taskId).children },
          },
          depths: world.coordinator.tasks(world.teamId).map((view) => view.depth),
          states: world.coordinator.tasks(world.teamId).map((view) => view.state),
          blockedBy: {
            codex: world.coordinator.task(codex.taskId).blockedBy,
            acp: world.coordinator.task(acp.taskId).blockedBy,
            kimi: world.coordinator.task(kimi.taskId).blockedBy,
            dsh: world.coordinator.task(dsh.taskId).blockedBy,
            opencode: world.coordinator.task(opencode.taskId).blockedBy,
          },
          attempts: world.coordinator.tasks(world.teamId).map((view) => view.attempts.length),
          paused: world.coordinator.tasks(world.teamId).map((view) => view.paused),
          budgets: world.coordinator.budgets(),
        }, {
          team: { teamId: world.teamId, name: 'runtime-migration', taskCount: 5, mailboxDepth: 0, createdAt: T0 },
          allTaskCount: 5,
          harnessIdentity: [
            { title: 'codex root', harness: 'native:codex-1', harnessInstanceId: H.codex, participantId: PARTICIPANT(1) },
            { title: 'acp branch', harness: 'native:acp-1', harnessInstanceId: H.acp, participantId: PARTICIPANT(2) },
            { title: 'kimi branch', harness: 'native:kimi-1', harnessInstanceId: H.kimi, participantId: PARTICIPANT(3) },
            { title: 'dsh join', harness: 'native:dsh-1', harnessInstanceId: H.dsh, participantId: PARTICIPANT(4) },
            { title: 'opencode leaf', harness: 'native:opencode-1', harnessInstanceId: H.opencode, participantId: PARTICIPANT(5) },
          ],
          edges: {
            codex: { dependsOn: [], children: [] },
            acp: { dependsOn: [codex.taskId], children: [] },
            kimi: { dependsOn: [codex.taskId], children: [] },
            dsh: { dependsOn: [acp.taskId, kimi.taskId], children: [opencode.taskId] },
            opencode: { dependsOn: [], parentId: dsh.taskId, children: [] },
          },
          depths: [1, 2, 2, 3, 4],
          states: ['pending', 'pending', 'pending', 'pending', 'pending'],
          blockedBy: {
            codex: [],
            acp: [codex.taskId],
            kimi: [codex.taskId],
            dsh: [acp.taskId, kimi.taskId],
            opencode: [],
          },
          attempts: [0, 0, 0, 0, 0],
          paused: [null, null, null, null, null],
          budgets: { limits: { maxConcurrency: 4, maxSessionMutations: 1, maxDepth: 4, maxChildren: 32, maxMailbox: 1000 }, used: { concurrency: 0, sessionMutations: 0, depth: 4, children: 1, mailbox: 0 } },
        });
      }

      // ── H2: run complete → review → accept, with all four preconditions driven ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'worker task' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        const sent = await world.coordinator.send({ attemptId, at: T0 + 2 });
        const observed = world.coordinator.observe({ attemptId, nativeEventId: 'evt-native-1', at: T0 + 3 });
        const ended = world.coordinator.observeNativeEnd({ attemptId, nativeEventId: 'evt-native-2', reason: 'completed', at: T0 + 4 });
        const afterEnd = world.coordinator.task(task.taskId);
        // Precondition 1: a registered deliverable.
        const noDeliverable = captureSync(() => world.acceptAll(task.taskId, T0 + 5));
        world.coordinator.registerDeliverable({ taskId: task.taskId, deliverable: DELIVERABLE, at: T0 + 6 });
        // Precondition 2: an approved review.
        const noReview = captureSync(() => world.acceptAll(task.taskId, T0 + 7));
        world.coordinator.submitForReview({ taskId: task.taskId, reviewer: REVIEWER, at: T0 + 8 });
        const afterSubmit = world.coordinator.task(task.taskId).review;
        world.coordinator.review({ taskId: task.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 9 });
        const afterReview = world.coordinator.task(task.taskId).review;
        // Precondition 3: every required criterion met.
        const unmetRequired = captureSync(() => world.coordinator.accept({
          taskId: task.taskId,
          deliverableId: DELIVERABLE.deliverableId,
          criteria: [{ id: 'build', met: true }, { id: 'tests', met: false }],
          acceptedBy: ACCEPTER,
          at: T0 + 10,
        }));
        const unknownCriterion = captureSync(() => world.coordinator.accept({
          taskId: task.taskId,
          deliverableId: DELIVERABLE.deliverableId,
          criteria: [{ id: 'nope', met: true }],
          acceptedBy: ACCEPTER,
          at: T0 + 11,
        }));
        // Precondition 4: a live owner lease — driven in its own world with a short TTL.
        const leaseWorld = makeWorld();
        const leaseTask = leaseWorld.makeTask({ title: 'lapsing lease', leaseTtl: 10 });
        const leaseDispatched = await leaseWorld.coordinator.dispatch({ taskId: leaseTask.taskId, at: T0 + 1 });
        await leaseWorld.coordinator.send({ attemptId: leaseDispatched.attempt.attemptId, at: T0 + 2 });
        leaseWorld.coordinator.observeNativeEnd({ attemptId: leaseDispatched.attempt.attemptId, reason: 'completed', at: T0 + 3 });
        leaseWorld.coordinator.registerDeliverable({ taskId: leaseTask.taskId, deliverable: DELIVERABLE, at: T0 + 4 });
        leaseWorld.coordinator.submitForReview({ taskId: leaseTask.taskId, reviewer: REVIEWER, at: T0 + 5 });
        leaseWorld.coordinator.review({ taskId: leaseTask.taskId, decision: 'approved', reviewer: REVIEWER, at: T0 + 6 });
        const lapsedLease = captureSync(() => leaseWorld.acceptAll(leaseTask.taskId, T0 + 100));
        // The POSITIVE CONTROL: the Host path is what marks success.
        const accepted = world.acceptAll(task.taskId, T0 + 12);
        check('run complete → review → accept walks the OBSERVED ladder and requires ALL FOUR preconditions: dispatch mints the attempt at accepted (accepted true, sent false), send reaches sent with sends 1, the native observation reaches observed, and the native end with reason completed reaches terminal with terminalReason completed while the TASK moves only to review with acceptance none and an empty deliverable list; acceptance is then refused once per missing precondition — no registered deliverable is invalid_request/acceptance_deliverable, no approved review is conflict/acceptance_review, an unmet REQUIRED criterion and an unknown criterion are conflict/acceptance_criteria and invalid_request/acceptance_criteria, and a lapsed owner lease is conflict/task_lease — and the POSITIVE CONTROL is that only the Host path (deliverable + submit + approve + all criteria met + live lease) marks the task accepted, with acceptance recording the deliverable, the accepter, the acceptedAt and the criterion ids', {
          dispatched: { state: dispatched.task.state, attempt: { state: dispatched.attempt.state, accepted: dispatched.attempt.accepted, sent: dispatched.attempt.sent, observed: dispatched.attempt.observed } },
          sent: { state: sent.attempt.state, sent: sent.attempt.sent, sends: sent.attempt.sends },
          observed: { state: observed.state, observed: observed.observed },
          ended: { state: ended.state, terminal: ended.terminal, terminalReason: ended.terminalReason, observed: ended.observed },
          afterEnd: { state: afterEnd.state, acceptance: afterEnd.acceptance.state, deliverables: afterEnd.deliverables.length, review: afterEnd.review.state },
          noDeliverable,
          afterRegister: { deliverables: world.coordinator.task(task.taskId).deliverables.length },
          noReview,
          afterSubmit: { ...afterSubmit },
          afterReview: { ...afterReview },
          unmetRequired,
          unknownCriterion,
          lapsedLease,
          afterLapsedLease: { state: leaseWorld.coordinator.task(leaseTask.taskId).state, acceptance: leaseWorld.coordinator.task(leaseTask.taskId).acceptance.state },
          accepted: { state: accepted.state, acceptance: accepted.acceptance, review: accepted.review },
          ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
          state: world.coordinator.state(),
        }, {
          dispatched: { state: 'dispatched', attempt: { state: 'accepted', accepted: true, sent: false, observed: false } },
          sent: { state: 'sent', sent: true, sends: 1 },
          observed: { state: 'observed', observed: true },
          ended: { state: 'terminal', terminal: true, terminalReason: 'completed', observed: true },
          afterEnd: { state: 'review', acceptance: 'none', deliverables: 0, review: 'none' },
          noDeliverable: { code: 'invalid_request', field: 'acceptance_deliverable' },
          afterRegister: { deliverables: 1 },
          noReview: { code: 'conflict', field: 'acceptance_review' },
          afterSubmit: { state: 'pending', reviewer: REVIEWER, reason: null, at: T0 + 8 },
          afterReview: { state: 'approved', reviewer: REVIEWER, reason: null, at: T0 + 9 },
          unmetRequired: { code: 'conflict', field: 'acceptance_criteria' },
          unknownCriterion: { code: 'invalid_request', field: 'acceptance_criteria' },
          lapsedLease: { code: 'conflict', field: 'task_lease' },
          afterLapsedLease: { state: 'review', acceptance: 'none' },
          accepted: {
            state: 'accepted',
            acceptance: { state: 'accepted', acceptedBy: ACCEPTER, acceptedAt: T0 + 12, deliverableId: 'deliverable-1', criteria: ['build', 'tests'] },
            review: { state: 'approved', reviewer: REVIEWER, reason: null, at: T0 + 9 },
          },
          ops: ['accept:applied', 'deliver:applied', 'observe:applied', 'end:applied'],
          state: { teams: 1, tasks: 1, attempts: 1, dispatches: 1, running: 0, sessionMutations: 0, mailbox: 0, reconciles: 0, failures: 0, closed: false },
        });
      }

      // ── H3: a restart recovering an already-observed attempt ──
      {
        const world = makeWorld();
        const task = world.makeTask({ title: 'in flight' });
        const dispatched = await world.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
        const attemptId = dispatched.attempt.attemptId;
        await world.coordinator.send({ attemptId, at: T0 + 2 });
        const observed = world.coordinator.observe({ attemptId, nativeEventId: 'evt-1', at: T0 + 3 });
        const beforeRestart = { attempt: observed.state, dispatches: world.coordinator.state().dispatches, running: world.coordinator.state().running };
        const view = world.coordinator.restart({ at: T0 + 10 });
        const recovered = world.coordinator.attempt(attemptId);
        const taskAfter = world.coordinator.task(task.taskId);
        const again = world.coordinator.restart({ at: T0 + 11 });
        check('a restart recovers an already-OBSERVED attempt without duplicating any dispatch: before the restart the attempt sits at the observed rung with running 1 and one dispatch, and the recovery pass reconciles and RETAINS it — RestartView.rehydrated counts the one task plus the one attempt, retained carries the SAME taskId and attemptId at the reconcile stop, dispatched is empty by construction, the observed dispatch counter does not move, the concurrency slot is released to 0, the recovered attempt keeps its observed observation with the resolution reconcile_required/collaboration_restart_ambiguous naming the rung it stopped at, the task stays visibly ambiguous at dispatched with acceptance none, a second restart is idempotent, and the journal shows the reconcile op appended after the three forward rungs', {
          beforeRestart,
          view: { rehydrated: view.rehydrated, retained: view.retained, dispatched: view.dispatched, paused: view.paused },
          recovered: { state: recovered.state, observed: recovered.observed, terminal: recovered.terminal, resolution: recovered.resolution },
          taskAfter: { state: taskAfter.state, ambiguous: taskAfter.ambiguous, acceptance: taskAfter.acceptance.state },
          dispatchesAfter: world.coordinator.state().dispatches,
          runningAfter: world.coordinator.state().running,
          reconciles: world.coordinator.state().reconciles,
          attemptsAll: world.coordinator.attempts().length,
          ops: world.coordinator.ops(attemptId).map((op) => `${op.kind}:${op.outcome}`),
          again: { rehydrated: again.rehydrated, retained: again.retained, dispatched: again.dispatched },
          dispatchesAfterSecond: world.coordinator.state().dispatches,
        }, {
          beforeRestart: { attempt: 'observed', dispatches: 1, running: 1 },
          view: { rehydrated: 2, retained: [{ taskId: task.taskId, attemptId, state: 'reconcile' }], dispatched: [], paused: [] },
          recovered: { state: 'reconcile', observed: true, terminal: false, resolution: { kind: 'reconcile', code: 'reconcile_required', field: 'collaboration_restart_ambiguous', reason: `attempt ${attemptId} stopped at observed before a native end`, at: T0 + 10 } },
          taskAfter: { state: 'dispatched', ambiguous: true, acceptance: 'none' },
          dispatchesAfter: 1,
          runningAfter: 0,
          reconciles: 1,
          attemptsAll: 1,
          ops: ['accept:applied', 'deliver:applied', 'observe:applied', 'reconcile:reconcile'],
          again: { rehydrated: 2, retained: [{ taskId: task.taskId, attemptId, state: 'reconcile' }], dispatched: [] },
          dispatchesAfterSecond: 1,
        });
      }

      // ── H4: fair scheduling under the budgets ──
      {
        const world = makeWorld();
        const tasks = [0, 1, 2, 3, 4, 5].map((index) => world.makeTask({ title: `slot ${index}`, ownerIndex: index }));
        const running = [];
        for (let index = 0; index < 4; index += 1) {
          const dispatched = await world.coordinator.dispatch({ taskId: tasks[index].taskId, at: T0 + 1 + index });
          running.push(dispatched.attempt.attemptId);
        }
        const pausedFourth = await world.coordinator.dispatch({ taskId: tasks[4].taskId, at: T0 + 20 });
        const pausedFifth = await world.coordinator.dispatch({ taskId: tasks[5].taskId, at: T0 + 21 });
        const pumpWhileFull = (await world.coordinator.pump({ at: T0 + 22 })).map((view) => view.title);
        await world.coordinator.send({ attemptId: running[0], at: T0 + 23 });
        world.coordinator.observeNativeEnd({ attemptId: running[0], reason: 'completed', at: T0 + 24 });
        const afterRelease = {
          running: world.coordinator.state().running,
          pausedTitles: world.coordinator.tasks().filter((view) => view.state === 'paused').map((view) => view.title),
        };
        const firstPump = (await world.coordinator.pump({ at: T0 + 25 })).map((view) => view.title);
        const secondPump = (await world.coordinator.pump({ at: T0 + 26 })).map((view) => view.title);
        await world.coordinator.send({ attemptId: running[1], at: T0 + 27 });
        world.coordinator.observeNativeEnd({ attemptId: running[1], reason: 'completed', at: T0 + 28 });
        const thirdPump = (await world.coordinator.pump({ at: T0 + 29 })).map((view) => view.title);
        check('fair scheduling under the concurrency budget is observed as dispatch order and as visible pause/resume transitions: the first four tasks dispatch in creation order and the fifth and sixth are VISIBLY paused with collaboration_concurrency and no attempt minted, pump admits NOTHING while the budget is exhausted, and after a native end releases one slot pump walks the paused tasks in CREATION order and admits exactly the first of them (slot 4), a second pump while the budget is full again admits nothing, and only after a second slot is released does pump admit slot 5 — leaving four running, six dispatches and the two completed tasks at review', {
          dispatchOrder: tasks.slice(0, 4).map((view) => view.title),
          pausedFourth: { state: pausedFourth.task.state, reasons: pausedFourth.task.paused?.reasons ?? null, attempt: pausedFourth.attempt },
          pausedFifth: { state: pausedFifth.task.state, reasons: pausedFifth.task.paused?.reasons ?? null, attempt: pausedFifth.attempt },
          pumpWhileFull,
          afterRelease,
          firstPump,
          secondPump,
          thirdPump,
          runningAfter: world.coordinator.state().running,
          dispatches: world.coordinator.state().dispatches,
          states: world.coordinator.tasks().map((view) => `${view.title}:${view.state}`),
          budgets: world.coordinator.budgets().used,
        }, {
          dispatchOrder: ['slot 0', 'slot 1', 'slot 2', 'slot 3'],
          pausedFourth: { state: 'paused', reasons: ['collaboration_concurrency'], attempt: null },
          pausedFifth: { state: 'paused', reasons: ['collaboration_concurrency'], attempt: null },
          pumpWhileFull: [],
          afterRelease: { running: 3, pausedTitles: ['slot 4', 'slot 5'] },
          firstPump: ['slot 4'],
          secondPump: [],
          thirdPump: ['slot 5'],
          runningAfter: 4,
          dispatches: 6,
          states: ['slot 0:review', 'slot 1:review', 'slot 2:dispatched', 'slot 3:dispatched', 'slot 4:dispatched', 'slot 5:dispatched'],
          budgets: { concurrency: 4, sessionMutations: 4, depth: 1, children: 0, mailbox: 0 },
        });
      }

      // ── H5: each of the five budgets enforced with observed numbers ──
      {
        // concurrency 4
        const concurrency = makeWorld();
        const concurrencyTasks = [0, 1, 2, 3, 4].map((index) => concurrency.makeTask({ title: `conc ${index}`, ownerIndex: index }));
        for (let index = 0; index < 4; index += 1) await concurrency.coordinator.dispatch({ taskId: concurrencyTasks[index].taskId, at: T0 + 1 + index });
        const concurrencyFifth = await concurrency.coordinator.dispatch({ taskId: concurrencyTasks[4].taskId, at: T0 + 20 });
        // Session mutation 1
        const session = makeWorld();
        const sessionFirst = session.makeTask({ title: 'first on session a', ownerIndex: 0 });
        const sessionSecond = session.makeTask({ title: 'second on session a', ownerIndex: 0 });
        await session.coordinator.dispatch({ taskId: sessionFirst.taskId, at: T0 + 1 });
        const sessionPaused = await session.coordinator.dispatch({ taskId: sessionSecond.taskId, at: T0 + 2 });
        // depth 4
        const depth = makeWorld();
        const chain = [];
        for (let level = 0; level < 4; level += 1) {
          chain.push(depth.makeTask({ title: `depth ${level + 1}`, ownerIndex: level, ...(level === 0 ? {} : { dependsOn: [chain[level - 1].taskId] }) }));
        }
        const tooDeep = depth.makeTask({ title: 'depth 5', ownerIndex: 4, dependsOn: [chain[3].taskId] });
        const depthPaused = await depth.coordinator.dispatch({ taskId: tooDeep.taskId, at: T0 + 30 });
        // children 32
        const children = makeWorld();
        const parent = children.makeTask({ title: 'fan-out parent' });
        const kids = [];
        for (let index = 0; index < 33; index += 1) kids.push(children.makeTask({ title: `child ${index}`, ownerIndex: index % 5, parentId: parent.taskId }));
        const thirtyThird = kids[32];
        const childrenPaused = await children.coordinator.dispatch({ taskId: thirtyThird.taskId, at: T0 + 40 });
        // mailbox 1000
        const mailbox = makeWorld();
        const mailboxTask = mailbox.makeTask({ title: 'mailbox task' });
        for (let index = 0; index < 1000; index += 1) {
          mailbox.coordinator.postMessage({ teamId: mailbox.teamId, from: 'lead', to: 'worker', text: `notice ${index}`, at: T0 + index });
        }
        const mailboxOverflow = captureSync(() => mailbox.coordinator.postMessage({ teamId: mailbox.teamId, from: 'lead', to: 'worker', text: 'notice 1000', at: T0 + 1000 }));
        const mailboxPaused = await mailbox.coordinator.dispatch({ taskId: mailboxTask.taskId, at: T0 + 1001 });
        check('each of the five budgets is enforced with its OBSERVED number and makes the overrun VISIBLY paused, never silently dropped and never silently run: concurrency 4 admits four and parks the fifth with collaboration_concurrency and no attempt while running and used.concurrency both read 4; Session mutation 1 admits one attempt on a native session and parks the second with collaboration_session_mutation while used.sessionMutations reads 1; depth 4 derives the chain as [1,2,3,4] and parks the fifth rung with collaboration_depth while used.depth reads 5; children 32 keeps the first 32 children pending and parks the thirty-third with collaboration_children while the parent really holds 33 children and used.children reads 33; mailbox 1000 holds exactly 1000 notices, REFUSES the 1001st post with conflict/collaboration_mailbox leaving the mailbox at 1000, and parks a dispatch that owes the team a notice with collaboration_mailbox while used.mailbox reads 1000', {
          concurrency: {
            running: concurrency.coordinator.state().running,
            dispatches: concurrency.coordinator.state().dispatches,
            fifth: { state: concurrencyFifth.task.state, reasons: concurrencyFifth.task.paused?.reasons ?? null, attempt: concurrencyFifth.attempt },
            attempts: concurrency.coordinator.attempts(concurrencyTasks[4].taskId).length,
            pausedCount: concurrency.coordinator.tasks().filter((view) => view.state === 'paused').length,
            used: concurrency.coordinator.budgets().used,
          },
          sessionMutation: {
            dispatches: session.coordinator.state().dispatches,
            sessionMutations: session.coordinator.state().sessionMutations,
            paused: { state: sessionPaused.task.state, reasons: sessionPaused.task.paused?.reasons ?? null },
            attempts: session.coordinator.attempts(sessionSecond.taskId).length,
            used: session.coordinator.budgets().used,
          },
          depth: {
            chainDepths: chain.map((view) => view.depth),
            tooDeep: { depth: tooDeep.depth, state: tooDeep.state, reasons: tooDeep.paused?.reasons ?? null },
            dispatched: { state: depthPaused.task.state, reasons: depthPaused.task.paused?.reasons ?? null },
            dispatches: depth.coordinator.state().dispatches,
            attempts: depth.coordinator.attempts(tooDeep.taskId).length,
            used: depth.coordinator.budgets().used,
          },
          children: {
            firstThirtyTwoPending: kids.slice(0, 32).every((view) => view.state === 'pending'),
            thirtyThird: { state: thirtyThird.state, reasons: thirtyThird.paused?.reasons ?? null, depth: thirtyThird.depth },
            parentChildren: children.coordinator.task(parent.taskId).children.length,
            dispatched: { state: childrenPaused.task.state, reasons: childrenPaused.task.paused?.reasons ?? null },
            attempts: children.coordinator.attempts(thirtyThird.taskId).length,
            used: children.coordinator.budgets().used,
          },
          mailbox: {
            depth: mailbox.coordinator.mailbox(mailbox.teamId).length,
            first: mailbox.coordinator.mailbox(mailbox.teamId)[0],
            last: mailbox.coordinator.mailbox(mailbox.teamId)[999],
            overflow: mailboxOverflow,
            depthAfterOverflow: mailbox.coordinator.mailbox(mailbox.teamId).length,
            dispatched: { state: mailboxPaused.task.state, reasons: mailboxPaused.task.paused?.reasons ?? null },
            dispatches: mailbox.coordinator.state().dispatches,
            attempts: mailbox.coordinator.attempts(mailboxTask.taskId).length,
            messages: mailbox.coordinator.state().mailbox,
            used: mailbox.coordinator.budgets().used,
          },
        }, {
          concurrency: {
            running: 4,
            dispatches: 4,
            fifth: { state: 'paused', reasons: ['collaboration_concurrency'], attempt: null },
            attempts: 0,
            pausedCount: 1,
            used: { concurrency: 4, sessionMutations: 4, depth: 1, children: 0, mailbox: 0 },
          },
          sessionMutation: {
            dispatches: 1,
            sessionMutations: 1,
            paused: { state: 'paused', reasons: ['collaboration_session_mutation'] },
            attempts: 0,
            used: { concurrency: 1, sessionMutations: 1, depth: 1, children: 0, mailbox: 0 },
          },
          depth: {
            chainDepths: [1, 2, 3, 4],
            tooDeep: { depth: 5, state: 'paused', reasons: ['collaboration_depth'] },
            dispatched: { state: 'paused', reasons: ['collaboration_depth'] },
            dispatches: 0,
            attempts: 0,
            used: { concurrency: 0, sessionMutations: 0, depth: 5, children: 0, mailbox: 0 },
          },
          children: {
            firstThirtyTwoPending: true,
            thirtyThird: { state: 'paused', reasons: ['collaboration_children'], depth: 2 },
            parentChildren: 33,
            dispatched: { state: 'paused', reasons: ['collaboration_children'] },
            attempts: 0,
            used: { concurrency: 0, sessionMutations: 0, depth: 2, children: 33, mailbox: 0 },
          },
          mailbox: {
            depth: 1000,
            first: { messageId: mailbox.coordinator.mailbox(mailbox.teamId)[0].messageId, teamId: mailbox.teamId, from: 'lead', to: 'worker', text: 'notice 0', at: T0 },
            last: { messageId: mailbox.coordinator.mailbox(mailbox.teamId)[999].messageId, teamId: mailbox.teamId, from: 'lead', to: 'worker', text: 'notice 999', at: T0 + 999 },
            overflow: { code: 'conflict', field: 'collaboration_mailbox' },
            depthAfterOverflow: 1000,
            dispatched: { state: 'paused', reasons: ['collaboration_mailbox'] },
            dispatches: 0,
            attempts: 0,
            messages: 1000,
            used: { concurrency: 0, sessionMutations: 0, depth: 1, children: 0, mailbox: 1000 },
          },
        });
      }
    }

    // ── every rejection code the product emitted belongs to the frozen canonical table ──
    const codes = [...observedCodes].sort();
    const browserMembership = await evaluate((list) => window.task37.codeMembership(list), codes);
    protocol.browser.codeMembership = browserMembership;
    record('codeMembership', { codes, browserMembership });
    check('every rejection code the product actually emitted across this case belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the worker collected — no collaboration rejection ever carries a code outside the protocol vocabulary', {
      observedCodes: codes,
      workerAllInTable: codes.every((code) => ERROR_CODES.includes(code)),
      browser: browserMembership,
    }, {
      observedCodes: codes,
      workerAllInTable: true,
      browser: { observedCount: codes.length, missing: [], allObservedCodesInTable: true, distinctObserved: new Set(codes).size },
    });

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task37.errors());
    check('the browser entry logged no error while recomputing the frozen collaboration contract in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa37-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa37-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task37.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapPeak: peakHeap, heapEnd, heapGrowthBytes });
    // The load-bearing boundedness evidence is the COORDINATOR'S OWN counters, exactly as task 36
    // used the engine's usage() counters. The heap numbers are recorded as a GC-TIMING ARTEFACT
    // (heapUsed measures allocated-and-not-yet-collected, which a forced collection collapses), not
    // a retention proof, and they decide nothing.
    check('the case stays bounded in the COORDINATOR OWN counters, not in a raw heap delta: a budget overrun is a visible pause by construction so the frozen limits are never exceeded by a run, the case exercised a fixed set of owned resources with zero borrowed spawns, and the observed heap numbers are RECORDED as a GC-timing artefact (heapUsed measures allocated-and-not-yet-collected, which a forced collection collapses) rather than a retention proof', {
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
    }, {
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
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
    // sourceHashes is mechanical for the independent gate, because every path below is in sourceFiles.
    const productHashesAfter = productHashes(context.root);
    record('sourceBinding', { before: productHashesBefore, after: productHashesAfter });
    check('the evidence binds to the current bytes: the sha256 of all seven pinned product files is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product byte moved under the case — the seven hashes are recorded for the independent gate to compare against the artifact sourceHashes', {
      pinnedProductFileCount: PRODUCT_FILES.length,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    }, {
      pinnedProductFileCount: 7,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: true,
      allSha256Shaped: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task37Errors ?? [], task37: Boolean(window.task37) })).catch((value) => ({ unavailable: String(value) }));
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

  return {
    scenarios,
    artifacts,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'team-task-attempt-coordination-and-budgets', schema: 'runtime-collaboration-coordination/v1' },
    cleanup: proof.cleanup,
    defects: {
      hostStopsDoNotReleaseTheConcurrencySlot: {
        severity: 'fixed',
        wasObservedAs: 'cancelTask and failTask did NOT release the concurrency or Session-mutation slot the attempt they stopped consumed: releaseTaskAttempts re-read the attempt state AFTER the stop had already written the resolution, so RUNNING_ATTEMPT_STATES no longer matched and markRunning was skipped — with four attempts in flight a cancelTask left running at 4, pump admitted nothing, and the next task stayed VISIBLY paused with collaboration_concurrency until restart() re-derived the counters',
        whyItMattered: 'it bore directly on the plan happy criterion of fair scheduling under the budgets: after a cancelTask or failTask the concurrency budget was not actually free, so a task that SHOULD have been admissible stayed paused, and repeated cancels or failures could exhaust every slot with no normal recovery',
        fixedBy: 'the release now keys off the reservation actually held: markRunning releases only an attemptId present in the running set (so a duplicate cancel, fail or end is a no-op and can never spend another attempt’s session share), and failTask/cancelTask release BEFORE the stop rewrites the projected state instead of re-reading it afterwards',
        assertedAs: 'F8 now asserts the release directly — running 3 after cancelTask with the queued fifth task dispatched immediately at accepted, running 3 after failTask over the three remaining sessions, and restart() still re-deriving to running 0 with all five non-terminal attempts retained; F3 asserts hostState running 0 / sessionMutations 0 after failTask on a sent attempt; the app regression suite adds the duplicate-cancel, duplicate in-flight send, cancelTask/failTask release and pump-after-unrelated-create cases',
        contrastStillProvenByThisCase: 'cancelAttempt and the send error path always released explicitly; with the fix all three stops agree, and the contrast world in F8 still asserts its fifth task dispatches immediately after a cancelAttempt',
      },
      dispatchAfterReviewIsNotRefused: {
        severity: 'fixed',
        wasObservedAs: 'dispatch() refused only the dispatched, accepted, failed and cancelled host states; a task sitting at review was NOT in that set, so a second dispatch minted a SECOND attempt on the same task while the first round’s review approval and deliverable stayed live',
        whyItMattered: 'a task in review has already produced a native end, so a second dispatch re-ran work the acceptance path was about to judge — and the retained approval let a running retry be accepted, after which a late native end overwrote the accepted task with failed',
        fixedBy: 'dispatch now also refuses the review host state with conflict/task_state, so no implicit review → dispatch retry can inherit a stale approval; acceptance additionally requires the live review lifecycle (host state review), so a task in flight, failed or cancelled can never be accepted however approved a retained review reads',
        assertedAs: 'the app regression suite asserts the refused retry (conflict/task_state, still exactly one attempt, the retained approval intact), the successful single acceptance, and the refusal of an acceptance outside the review lifecycle (conflict/task_state); the three states that were already refused (accepted, failed, cancelled) remain asserted in F1 and F3',
      },
      durableStoreNotWired: {
        severity: 'acceptance-criterion-gap',
        observed: 'the restart recovery pass re-derives its counters and reconciles its ambiguous attempts IN-PROCESS, exactly the posture task 34 disclosed for its in-memory journal: the single-writer durable store the journal would compose with is design intent, not executed proof',
        contradictsPlanCriterion: 'nothing in this task listed criteria — the plan claims restart recovery, not crash durability',
        coveredInstead: 'the reachable restart states are proven over the real service in H3 and F9: an already-observed attempt, a delivered-but-never-ended attempt, an accepted-but-never-delivered attempt, a terminal attempt (not retained) and a second idempotent restart. No durability across a real process death is claimed, and the five budgets are claimed inside ONE coordinator instance only',
      },
      liveHarnessNotExercised: {
        severity: 'out-of-scope',
        observed: 'the five harness kinds appear only as native-session identities inside the task owner; no live opencode, codex, kimi-web, dsh or acp backend is contacted',
        carriedAs: 'task 46 owns end-to-end live verification; the case performs no SSH and no Slurm work and its header and evidenceBoundary say so',
      },
      collaborationUiNotExercised: {
        severity: 'out-of-scope',
        observed: 'the browser realm recomputes the frozen shared contract and never renders a collaboration surface',
        carriedAs: 'task 42 owns the collaboration UI; no UI rendering is claimed',
      },
    },
    evidenceBoundary: 'The real landed bridge modules bridge/runtime/collaboration/coordinator.js, taskGraph.js, attemptService.js and acceptanceService.js run in the Node worker composed exactly as the product composes them, over the frozen shared/runtime/collaboration.js contract. The ONLY case-owned seam is the coordinator own declared deliver prompt port (coordinator.js:70-76), backed by a counting, recording fake, so exactly one prompt was ever sent, the typed source error is carried verbatim and an unreadable outcome is never retried are OBSERVED. The sink constructors (createNativeSink / createDeliverySink / createHostSink / createAcceptanceSink) are the product own exported boundary constructors, so the structural guarantee — no native terminal event can reach a task review/acceptance/deliverable scope — is driven through the real code. The pure shared contract (the five budgets, every state table, the ceilings, the canonical session keys, the id parsers and the frozen error-code table) also runs in a real headless Chromium served by a case-owned Vite server, proving the contract is engine-independent and equal to the values the worker computes. The stateful coordinator cannot cross into the browser realm at all (coordinator.js:1, taskGraph.js:1 and attemptService.js:1 import node:crypto), so its lifecycle is proven in the worker only and that split is stated rather than papered over. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 42 owns the collaboration UI), claims NO durability across a real process death, and authors no PASS verdict.',
  };
}
