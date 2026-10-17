// Task 38 registered QA case — the partial-failure-recoverable fan-out: ONE prompt delivered to a
// FROZEN target list, where every recipient runs its OWN child operation, an individual cancel
// touches exactly one recipient, duplicate participants are de-duplicated once at creation, and the
// overall operation is DERIVED from each recipient's real outcome.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/collaboration/fanoutService.js
//     and fanoutRecovery.js, composed exactly as the product composes them over the frozen
//     shared/runtime/collaboration.js + identity.js contract. Nothing is stubbed: the ONLY
//     case-owned seam is the `deliver` prompt port the service's own signature declares as an
//     injection point (fanoutService.js:173-177), and it is backed by a counting, recording fake so
//     "each recipient got its OWN attachment path", "exactly one prompt per participant+session was
//     ever sent", "the typed source error is carried verbatim" and "an ambiguous recipient is never
//     re-sent" are OBSERVED at the sink boundary, not argued.
//   * In a real headless Chromium: the frozen shared contract — the frozen ten-entry ERROR_CODES
//     table, the CollaborationError shape, the explicit-`at` contract and the canonical
//     native-session keys for the five harness kinds — recomputed in a second JS realm from the
//     same pure modules, PLUS the REAL recovery planner planFanoutRetry
//     (bridge/runtime/collaboration/fanoutRecovery.js) driven over an OBSERVED fan-out read model
//     the worker passes in. The case asserts the browser values EQUAL the values the worker
//     computes, so the contract the bridge enforces is provably the contract the app sees.
//
// The controlled boundaries are stated rather than papered over:
//   * the stateful service cannot cross into the browser at all — fanoutService.js:1 imports
//     node:crypto (randomUUID) — so create / dispatch / cancel / reconcile / retry, the frozen
//     FANOUT_LIMITS / FANOUT_STATES / RECIPIENT_OUTCOMES tables and the derived overall state are
//     proven in the worker only. The split is exactly the posture task 37 disclosed for its
//     coordinator. The recovery planner is pure ESM (its only import is
//     shared/runtime/collaboration.js), so it DOES run in the browser and its output is asserted
//     equal to the worker's over real product bytes.
//   * no browser shim is needed: the browser closure is fanoutRecovery.js ->
//     shared/runtime/collaboration.js -> capabilities.js + identity.js, pure ESM with no node:*
//     builtin and no bare or aliased specifier, so Vite resolves every import natively. task-30
//     needed a shim only because the real Icon component fetches from the Iconify API at runtime.
//   * "the UI lists each recipient's real state" is satisfied by driving the product's OWN read
//     model — the frozen per-recipient view (outcome, resolution, ackId, retryable) and the
//     product's OWN recovery planner over it — never by claiming a rendered component; task 42 owns
//     the collaboration UI.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// claims no UI rendering (task 42 owns the collaboration UI), authors no PASS verdict, edits no
// product or test file, and performs no git operation. It claims no durability across a real
// process death: reconcile re-marks in-flight recipients ambiguous IN-PROCESS, because the
// single-writer durable store is task 8's surface and is not exercised here — the same in-process
// disclosure tasks 34 and 37 made.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-38-fixture.mjs';

import {
  FANOUT_LIMITS,
  FANOUT_STATES,
  RECIPIENT_OUTCOMES,
  createFanoutService,
  deriveFanoutState,
} from '../../../bridge/runtime/collaboration/fanoutService.js';
import { planFanoutRetry } from '../../../bridge/runtime/collaboration/fanoutRecovery.js';
import { CollaborationError, parseAt } from '../../../shared/runtime/collaboration.js';
import {
  decodeSessionKey,
  encodeSessionKey,
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../../../shared/runtime/identity.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

// The five harness kinds of this plan: opencode, codex, kimi-web, dsh, acp. Each recipient of a
// fan-out is a participant working in a DISTINCT native session, so the same prompt fans out to
// five different harness identities at most.
const ENV_A = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const H = {
  codex: parseHarnessInstanceId('aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa'),
  acp: parseHarnessInstanceId('bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb'),
  kimi: parseHarnessInstanceId('cccccccc-cccc-4ccc-8ccc-cccccccccccc'),
  dsh: parseHarnessInstanceId('dddddddd-dddd-4ddd-8ddd-dddddddddddd'),
  opencode: parseHarnessInstanceId('eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee'),
};
const SESSIONS = {
  codex: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' }),
  acp: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.acp, nativeSessionId: 'native:acp-1' }),
  kimi: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.kimi, nativeSessionId: 'native:kimi-1' }),
  dsh: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.dsh, nativeSessionId: 'native:dsh-1' }),
  opencode: parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.opencode, nativeSessionId: 'native:opencode-1' }),
};
const PARTICIPANT = (index) => `15151515-1515-4515-8515-1515151515${index.toString(16).padStart(2, '0')}`;
const P1 = PARTICIPANT(1);
const P2 = PARTICIPANT(2);
const P3 = PARTICIPANT(3);
const P4 = PARTICIPANT(4);
const P5 = PARTICIPANT(5);
const MIXED_CASE_PARTICIPANT = 'aabbccdd-aabb-4abb-8abb-aabbccddaabb';
// A distinct harness instance per index, for the 32-target quota boundary.
const QUOTA_SESSION = (index) => parseSessionRef({
  environmentId: ENV_A,
  harnessInstanceId: parseHarnessInstanceId(`a${index.toString(16).padStart(7, '0')}-aaaa-4aaa-8aaa-aaaaaaaaaaaa`),
  nativeSessionId: `native:quota-${index}`,
});

const T0 = 1700000000000;
const PROMPT = 'review the repository and report findings';
const ATTACHMENT_ALPHA = '/repo/alpha.txt';
const ATTACHMENT_BETA = '/repo/beta.txt';
const ATTACHMENT_GAMMA = '/repo/gamma.txt';
const ATTACHMENT_PATH_MAX = `/repo/${'a'.repeat(1018)}`; // exactly 1024 chars
const ATTACHMENT_PATH_OVER = `/repo/${'a'.repeat(1019)}`; // 1025 chars

/**
 * The typed capture envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously. `dispatch` and `retry` are
 * `async function`s — they RETURN A PROMISE and reject instead of throwing, so a synchronous
 * try/catch cannot observe their rejection: use capture (which awaits) for those, or the error
 * escapes as an unhandled rejection and the worker dies. `createFanout`, `fanout`, `fanouts`,
 * `cancelRecipient`, `reconcile` and `state` are synchronous.
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

/** One target: a participant, the native session it works in, and its OWN optional attachment. */
const target = (participantId, session, attachmentPath) => (
  attachmentPath === undefined ? { participantId, session } : { participantId, session, attachmentPath }
);
/** The default acking deliver port, used wherever a scenario does not inject a faulty one. */
const ackAll = async (input) => ({ ackId: `ack-${input.recipientId}` });

/**
 * Every service this case builds goes through this wrapper, so the boundedness check at the end
 * can name the largest fan-out the case actually created (the product's own read model) rather
 * than a raw heap number. The service is an object of closures — none reads `this` — so spreading
 * it and wrapping only createFanout preserves every other entry point byte-for-byte.
 */
function makeService(options, fanoutTotals) {
  const service = createFanoutService(options);
  return {
    ...service,
    createFanout: (input = {}) => {
      const view = service.createFanout(input);
      fanoutTotals.push(view.stats.total);
      return view;
    },
  };
}

/** The worker mirror of the browser entry's frozen-contract table. */
function workerTables() {
  return {
    errorCodes: [...ERROR_CODES],
    errorCodeCount: ERROR_CODES.length,
    errorCodesFrozen: Object.isFrozen(ERROR_CODES),
    collaborationErrorShape: (() => {
      const error = new CollaborationError('conflict', 'fanout_target', { x: 1 });
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
    atExplicit: parseAt(T0),
    atZero: captureSync(() => parseAt(0)),
    atFractional: captureSync(() => parseAt(1.5)),
  };
}

/**
 * The worker mirror of the browser entry's canonical-session-key table. The five keys are read
 * back from a REAL fan-out's frozen recipient views — the values the product itself wrote — so the
 * cross-realm equality binds the browser's computation to the product's own records.
 */
function workerSessionKeys() {
  const service = createFanoutService({ deliver: ackAll });
  const view = service.createFanout({
    prompt: PROMPT,
    at: T0,
    targets: [
      target(P1, SESSIONS.codex),
      target(P2, SESSIONS.acp),
      target(P3, SESSIONS.kimi),
      target(P4, SESSIONS.dsh),
      target(P5, SESSIONS.opencode),
    ],
  });
  const byNative = (nativeSessionId) => view.targets.find((entry) => entry.session.nativeSessionId === nativeSessionId);
  const decoded = decodeSessionKey(byNative('native:kimi-1').sessionKey);
  return {
    codex: byNative('native:codex-1').sessionKey,
    acp: byNative('native:acp-1').sessionKey,
    kimi: byNative('native:kimi-1').sessionKey,
    dsh: byNative('native:dsh-1').sessionKey,
    opencode: byNative('native:opencode-1').sessionKey,
    codexDuplicate: encodeSessionKey(parseSessionRef({ environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' })),
    decoded: { environmentId: decoded.environmentId, harnessInstanceId: decoded.harnessInstanceId, nativeSessionId: decoded.nativeSessionId },
  };
}

export const sourceFiles = [...new Set([
  // the two product modules this task owns
  'bridge/runtime/collaboration/fanoutService.js',
  'bridge/runtime/collaboration/fanoutRecovery.js',
  // the product's own regression suite, unchanged
  'app/runtime/fanout.test.ts',
  // the frozen shared contract they all agree on
  'shared/runtime/collaboration.js', 'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task38.ts',
  'scripts/qa/runtime-v090-cases/task-38.mjs',
  'scripts/qa/runtime-v090-cases/task-38-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

/**
 * The nine product files whose bytes the evidence must bind to. Every one of them is in
 * sourceFiles, so the independent gate can compare the recorded digests against the artifact's own
 * sourceHashes mechanically.
 */
const PRODUCT_FILES = [
  'bridge/runtime/collaboration/fanoutService.js',
  'bridge/runtime/collaboration/fanoutRecovery.js',
  'app/runtime/fanout.test.ts',
  'shared/runtime/collaboration.js',
  'shared/runtime/collaboration.d.ts',
  'shared/runtime/capabilities.js',
  'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js',
  'shared/runtime/identity.d.ts',
];

function productHashes(root) {
  return Object.fromEntries(PRODUCT_FILES.map((file) => [
    file,
    createHash('sha256').update(readFileSync(path.resolve(root, file))).digest('hex'),
  ]));
}

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 38 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task38Errors=[];window.addEventListener('error',(e)=>window.__task38Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task38Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task38.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-38/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
  const proof = { case: context.case, runDir, checks, observations, protocol };
  const fanoutTotals = [];
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
      surface: 'the real landed bridge fan-out service fanoutService.js composed over the frozen shared/runtime/collaboration.js + identity.js contract in the Node worker, with the service own declared deliver prompt port backed by a counting recording fake, plus the frozen shared contract and the real fanoutRecovery.js planner recomputed in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-38.mjs',
    'scripts/qa/runtime-v090-cases/task-38-fixture.mjs',
    'app/dev/runtime-v090/task38.ts',
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
    // Real headless Chromium over the frozen shared contract and the real recovery planner
    // (no shim: no node:* builtin anywhere in the closure)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa38', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa38/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task38 && window.task38.ready)), 'task38 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the frozen contract is identical in both realms ──
    await crossRealm('the frozen shared contract every fan-out rejection travels through — the frozen ten-entry ERROR_CODES table, the CollaborationError shape (name, code, field, reason, message, frozen detail, ProtocolError and TypeError lineage) and the explicit-`at` contract with zero and a fractional reading refused — is byte-identical in the browser realm and the bridge worker, and every code the fan-out service or planner can emit (invalid_request, conflict, cancelled, source_unavailable, reconcile_required) is a member, so the app and the bridge cannot disagree about a rejection', workerTables(), await evaluate(() => window.task38.tables()), {
      errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
      errorCodeCount: 10,
      errorCodesFrozen: true,
      collaborationErrorShape: { name: 'CollaborationError', code: 'conflict', field: 'fanout_target', reason: 'fanout_target', message: 'conflict: collaboration.fanout_target', detail: { x: 1 }, isProtocolError: true, isTypeError: true },
      coordinationCodesInTable: true,
      atExplicit: T0,
      atZero: { code: 'invalid_request', field: 'collaboration_time' },
      atFractional: { code: 'invalid_request', field: 'collaboration_time' },
    });

    // ── C2: the canonical session keys are engine-independent and tie to the real records ──
    await crossRealm('the canonical native-session key each of the five harness kinds produces is identical in both realms — the worker side reading the sessionKey values the REAL createFanout wrote into a real fan-out frozen recipient views — is the SAME key for the same session under a second spelling, and round-trips through decodeSessionKey back to the exact referenced native session, so a browser window and the bridge worker provably agree on the identity each recipient carries', workerSessionKeys(), await evaluate(() => window.task38.sessionKeys()), {
      codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
      kimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
      dsh: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJkZGRkZGRkZC1kZGRkLTRkZGQtOGRkZC1kZGRkZGRkZGRkZGQiLCJuYXRpdmU6ZHNoLTEiXQ',
      opencode: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJlZWVlZWVlZS1lZWVlLTRlZWUtOGVlZS1lZWVlZWVlZWVlZWUiLCJuYXRpdmU6b3BlbmNvZGUtMSJd',
      codexDuplicate: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      decoded: { environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc', nativeSessionId: 'native:kimi-1' },
    });

    // ── C3: the frozen fan-out tables, the frozen read models and the typed rejections ──
    {
      const service = makeService({ deliver: ackAll }, fanoutTotals);
      const created = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex)] });
      // The default deliver port (no injection) acks with the product's own ack-<uuid> shape.
      const defaultPort = createFanoutService();
      const defaultView = defaultPort.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex)] });
      const defaultDispatched = await defaultPort.dispatch({ fanoutId: defaultView.fanoutId, at: T0 + 1 });
      const dispatchNonArray = await capture(() => service.dispatch({ fanoutId: created.fanoutId, recipientIds: 42, at: T0 }));
      const retryNonArray = await capture(() => service.retry({ fanoutId: created.fanoutId, recipientIds: 'nope', at: T0 }));
      const dispatchMalformedId = await capture(() => service.dispatch({ fanoutId: created.fanoutId, recipientIds: ['nope'], at: T0 }));
      const sendsBeforeUnknownId = service.state().sends;
      const unknownIdView = await service.dispatch({ fanoutId: created.fanoutId, recipientIds: ['22222222-2222-4222-8222-222222222222'], at: T0 });
      check('the one frozen limits object and the two frozen tables are reported verbatim by the product (maxTargets 32, maxPromptChars 65536, maxAttachmentPathChars 1024; the seven overall states; the five recipient outcomes), every accessor returns a FROZEN read model down to the session ref, the omitted deliver port defaults to the product own acking port, and every rejection carries an explicit code plus the plain rejection field — a non-function deliver port is invalid_request/fanout_deliver, an unknown fan-out id is invalid_request/fanout_unknown, a non-UUID fan-out id is invalid_request/fanout_id, an unknown recipient is invalid_request/fanout_recipient_unknown, a non-UUID recipient id is invalid_request/fanout_recipient, a non-array recipient list is invalid_request/fanout_recipients on both dispatch and retry, and a well-formed but UNKNOWN recipient id is silently selected out — no rejection and no send', {
        limits: { ...FANOUT_LIMITS },
        limitsFrozen: Object.isFrozen(FANOUT_LIMITS),
        states: [...FANOUT_STATES],
        statesFrozen: Object.isFrozen(FANOUT_STATES),
        outcomes: [...RECIPIENT_OUTCOMES],
        outcomesFrozen: Object.isFrozen(RECIPIENT_OUTCOMES),
        frozenReadModels: {
          fanout: Object.isFrozen(created),
          targets: Object.isFrozen(created.targets),
          target: Object.isFrozen(created.targets[0]),
          session: Object.isFrozen(created.targets[0].session),
          stats: Object.isFrozen(created.stats),
          fanoutRead: Object.isFrozen(service.fanout(created.fanoutId)),
          fanoutsList: Object.isFrozen(service.fanouts()),
          stateRead: Object.isFrozen(service.state()),
        },
        defaultDeliverPort: { outcome: defaultDispatched.targets[0].outcome, ackIdPrefix: defaultDispatched.targets[0].ackId.slice(0, 4), ackIdIsUuidShaped: UUID.test(defaultDispatched.targets[0].ackId.slice(4)) },
        badDeliverPort: captureSync(() => createFanoutService({ deliver: 'nope' })),
        unknownFanout: captureSync(() => service.fanout('22222222-2222-4222-8222-222222222222')),
        malformedFanoutId: captureSync(() => service.fanout('nope')),
        unknownRecipient: captureSync(() => service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: '22222222-2222-4222-8222-222222222222', at: T0 })),
        malformedRecipientId: captureSync(() => service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: 'nope', at: T0 })),
        dispatchNonArray,
        retryNonArray,
        dispatchMalformedId,
        unknownRecipientIdFiltered: { rejected: null, sendsDelta: service.state().sends - sendsBeforeUnknownId, state: unknownIdView.state },
      }, {
        limits: { maxTargets: 32, maxPromptChars: 65536, maxAttachmentPathChars: 1024 },
        limitsFrozen: true,
        states: ['pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled', 'ambiguous'],
        statesFrozen: true,
        outcomes: ['pending', 'sent', 'failed', 'ambiguous', 'cancelled'],
        outcomesFrozen: true,
        frozenReadModels: { fanout: true, targets: true, target: true, session: true, stats: true, fanoutRead: true, fanoutsList: true, stateRead: true },
        defaultDeliverPort: { outcome: 'sent', ackIdPrefix: 'ack-', ackIdIsUuidShaped: true },
        badDeliverPort: { code: 'invalid_request', field: 'fanout_deliver' },
        unknownFanout: { code: 'invalid_request', field: 'fanout_unknown' },
        malformedFanoutId: { code: 'invalid_request', field: 'fanout_id' },
        unknownRecipient: { code: 'invalid_request', field: 'fanout_recipient_unknown' },
        malformedRecipientId: { code: 'invalid_request', field: 'fanout_recipient' },
        dispatchNonArray: { code: 'invalid_request', field: 'fanout_recipients' },
        retryNonArray: { code: 'invalid_request', field: 'fanout_recipients' },
        dispatchMalformedId: { code: 'invalid_request', field: 'fanout_recipient' },
        unknownRecipientIdFiltered: { rejected: null, sendsDelta: 0, state: 'pending' },
      });
    }
    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: a second send failing without revoking the running ones, a manager kill
      // mid-batch, an attachment upload error, a duplicate participant, the quota refusals, the
      // per-recipient REAL state read model and the closed service.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: the second send failing does NOT revoke the already-running recipients ──
      {
        const failure = makeService({
          deliver: async (input) => {
            if (input.participantId === P2) throw new CollaborationError('source_unavailable', 'fanout_send');
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const control = makeService({ deliver: ackAll }, fanoutTotals);
        const targets = () => [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh)];
        const failureCreated = failure.createFanout({ prompt: PROMPT, at: T0, targets: targets() });
        const controlCreated = control.createFanout({ prompt: PROMPT, at: T0, targets: targets() });
        const failureIds = failureCreated.targets.map((entry) => entry.recipientId);
        const failureAfter = await failure.dispatch({ fanoutId: failureCreated.fanoutId, at: T0 + 1 });
        const controlAfter = await control.dispatch({ fanoutId: controlCreated.fanoutId, at: T0 + 1 });
        // The id-independent survivor shape: outcome, dispatched, sendCount, resolution, retryable.
        // The ackId cannot match across two services (each mints its own recipient ids), so it is
        // asserted separately against the recipient's OWN id.
        const shape = (entry) => ({ outcome: entry.outcome, dispatched: entry.dispatched, sendCount: entry.sendCount, resolution: entry.resolution, retryable: entry.retryable });
        check('a failure of the SECOND send never revokes an already-running recipient: the second recipient settles failed with the typed resolution source_unavailable/fanout_send and a null ackId, while the first and third recipients are observed byte-identical to the same recipients in a control run where nothing failed — still sent, still dispatched, still exactly one send each, never cancelled and never re-sent — each survivor ackId is its OWN recipient ack, all three sends were attempted, the overall state is the honest derivation of the observed mix (2 sent, 1 failed) and the failure counter stepped exactly once', {
          failedRecipient: {
            participantId: failureAfter.targets[1].participantId,
            outcome: failureAfter.targets[1].outcome,
            resolution: failureAfter.targets[1].resolution,
            ackId: failureAfter.targets[1].ackId,
            dispatched: failureAfter.targets[1].dispatched,
            sendCount: failureAfter.targets[1].sendCount,
            retryable: failureAfter.targets[1].retryable,
          },
          survivorShapes: { first: shape(failureAfter.targets[0]), third: shape(failureAfter.targets[2]) },
          controlShapes: { first: shape(controlAfter.targets[0]), third: shape(controlAfter.targets[2]) },
          survivorsMatchControl: {
            first: JSON.stringify(shape(failureAfter.targets[0])) === JSON.stringify(shape(controlAfter.targets[0])),
            third: JSON.stringify(shape(failureAfter.targets[2])) === JSON.stringify(shape(controlAfter.targets[2])),
          },
          survivorAckIdsAreOwn: [
            failureAfter.targets[0].ackId === `ack-${failureIds[0]}`,
            failureAfter.targets[2].ackId === `ack-${failureIds[2]}`,
          ],
          outcomes: failureAfter.targets.map((entry) => entry.outcome),
          state: failureAfter.state,
          stats: failureAfter.stats,
          counters: failure.state(),
          derivedEqualsObserved: failureAfter.state === deriveFanoutState(failureAfter.targets),
        }, {
          failedRecipient: {
            participantId: P2,
            outcome: 'failed',
            resolution: { code: 'source_unavailable', field: 'fanout_send' },
            ackId: null,
            dispatched: true,
            sendCount: 1,
            retryable: false,
          },
          survivorShapes: {
            first: { outcome: 'sent', dispatched: true, sendCount: 1, resolution: null, retryable: false },
            third: { outcome: 'sent', dispatched: true, sendCount: 1, resolution: null, retryable: false },
          },
          controlShapes: {
            first: { outcome: 'sent', dispatched: true, sendCount: 1, resolution: null, retryable: false },
            third: { outcome: 'sent', dispatched: true, sendCount: 1, resolution: null, retryable: false },
          },
          survivorsMatchControl: { first: true, third: true },
          survivorAckIdsAreOwn: [true, true],
          outcomes: ['sent', 'failed', 'sent'],
          state: 'partial',
          stats: { total: 3, sent: 2, failed: 1, ambiguous: 0, cancelled: 0, pending: 0 },
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 1, sends: 3, failures: 1, reconciles: 0, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── F1b: a NON-CollaborationError rejection is classified, never leaked ──
      {
        const service = makeService({
          deliver: async (input) => {
            if (input.participantId === P2) throw new Error('socket hangup');
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh)] });
        const after = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        check('a deliver port that rejects with a PLAIN Error (not a CollaborationError) is classified to the fallback source_unavailable/fanout_send and the raw message is never leaked into the resolution, the two healthy recipients still settle sent, and the overall state is the honest derivation of the observed mix', {
          failedRecipient: {
            outcome: after.targets[1].outcome,
            resolution: after.targets[1].resolution,
            rawMessageLeaked: JSON.stringify(after.targets[1].resolution).includes('socket hangup'),
          },
          survivors: [after.targets[0].outcome, after.targets[2].outcome],
          state: after.state,
          stats: after.stats,
          counters: service.state(),
          derivedEqualsObserved: after.state === deriveFanoutState(after.targets),
        }, {
          failedRecipient: {
            outcome: 'failed',
            resolution: { code: 'source_unavailable', field: 'fanout_send' },
            rawMessageLeaked: false,
          },
          survivors: ['sent', 'sent'],
          state: 'partial',
          stats: { total: 3, sent: 2, failed: 1, ambiguous: 0, cancelled: 0, pending: 0 },
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 1, sends: 3, failures: 1, reconciles: 0, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── F2: a manager kill mid-batch marks the in-flight recipient ambiguous, forever ──
      {
        let release;
        const calls = [];
        const service = makeService({
          deliver: (input) => {
            calls.push(input.recipientId);
            if (input.participantId === P1) {
              return new Promise((resolve) => { release = () => resolve({ ackId: 'ack-late-1' }); });
            }
            return Promise.resolve({ ackId: `ack-${input.recipientId}` });
          },
        }, fanoutTotals);
        const created = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi)] });
        const ids = created.targets.map((entry) => entry.recipientId);
        // The second recipient settles first (terminal 'sent').
        await service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[1]], at: T0 + 1 });
        // The first recipient's send hangs in flight.
        const inFlight = service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[0]], at: T0 + 2 });
        // A second dispatch while the first is still in flight reaches NOTHING: isSendable is
        // dispatched === false, and the in-flight recipient is already dispatched.
        const callsBeforeSecondDispatch = calls.length;
        const secondDispatch = await service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[0]], at: T0 + 3 });
        // The manager is killed mid-batch: reconcile marks the in-flight recipient ambiguous.
        const killed = service.reconcile({ fanoutId: created.fanoutId, at: T0 + 4 });
        // The hung send finally resolves — the late ack is ignored, the recipient stays ambiguous.
        release();
        await inFlight;
        const afterLate = service.fanout(created.fanoutId);
        const plan = planFanoutRetry(afterLate);
        const callsBeforeRetry = calls.length;
        // The caller IGNORES the plan and names the ambiguous recipient's id anyway.
        const retried = await service.retry({ fanoutId: created.fanoutId, recipientIds: [ids[0]], at: T0 + 5 });
        check('a manager kill mid-batch is visible and permanent: while the first send hangs in flight a second dispatch of that same recipient reaches NOTHING (isSendable is dispatched === false, so an in-flight recipient is unreachable and the deliver port saw no extra call), reconcile marks it ambiguous with reconcile_required/fanout_ambiguous while the already-settled sibling is untouched, the late ack that eventually arrives is IGNORED (outcome stays ambiguous, sendCount stays 1, ackId stays null), the recovery planner retains it with reason fanout_ambiguous and an EMPTY retryable set, and a retry that explicitly names the ambiguous id is refused by the dispatch layer re-checking the same predicate — zero re-sends in both gates', {
          whileInFlight: {
            state: secondDispatch.state,
            inFlightRecipient: { outcome: secondDispatch.targets[0].outcome, dispatched: secondDispatch.targets[0].dispatched, sendCount: secondDispatch.targets[0].sendCount, retryable: secondDispatch.targets[0].retryable },
            settledRecipientOutcome: secondDispatch.targets[1].outcome,
            deliverCallsDuringSecondDispatch: calls.length - callsBeforeSecondDispatch,
          },
          killed: {
            state: killed.state,
            killedRecipient: { outcome: killed.targets[0].outcome, resolution: killed.targets[0].resolution, sendCount: killed.targets[0].sendCount, ackId: killed.targets[0].ackId, retryable: killed.targets[0].retryable, updatedAt: killed.targets[0].updatedAt },
            survivor: { outcome: killed.targets[1].outcome, sendCount: killed.targets[1].sendCount, resolution: killed.targets[1].resolution },
            stats: killed.stats,
            reconciles: service.state().reconciles,
          },
          afterLateAck: {
            state: afterLate.state,
            killedRecipient: { outcome: afterLate.targets[0].outcome, resolution: afterLate.targets[0].resolution, ackId: afterLate.targets[0].ackId, sendCount: afterLate.targets[0].sendCount },
          },
          plan: {
            retryableIds: plan.retryable.map((spec) => spec.recipientId),
            retained: plan.retained.map((entry) => ({ recipientId: entry.recipientId, outcome: entry.outcome, reason: entry.reason })),
          },
          retryOfAmbiguousId: {
            state: retried.state,
            ambiguousRecipient: { outcome: retried.targets[0].outcome, sendCount: retried.targets[0].sendCount },
            deliverCallsDuringRetry: calls.length - callsBeforeRetry,
          },
          deliverCalls: calls,
          counters: service.state(),
          derivedEqualsObserved: afterLate.state === deriveFanoutState(afterLate.targets),
        }, {
          whileInFlight: {
            state: 'running',
            inFlightRecipient: { outcome: 'pending', dispatched: true, sendCount: 1, retryable: false },
            settledRecipientOutcome: 'sent',
            deliverCallsDuringSecondDispatch: 0,
          },
          killed: {
            state: 'ambiguous',
            killedRecipient: { outcome: 'ambiguous', resolution: { code: 'reconcile_required', field: 'fanout_ambiguous' }, sendCount: 1, ackId: null, retryable: false, updatedAt: T0 + 4 },
            survivor: { outcome: 'sent', sendCount: 1, resolution: null },
            stats: { total: 2, sent: 1, failed: 0, ambiguous: 1, cancelled: 0, pending: 0 },
            reconciles: 1,
          },
          afterLateAck: {
            state: 'ambiguous',
            killedRecipient: { outcome: 'ambiguous', resolution: { code: 'reconcile_required', field: 'fanout_ambiguous' }, ackId: null, sendCount: 1 },
          },
          plan: {
            retryableIds: [],
            retained: [
              { recipientId: ids[0], outcome: 'ambiguous', reason: 'fanout_ambiguous' },
              { recipientId: ids[1], outcome: 'sent', reason: 'fanout_already_dispatched' },
            ],
          },
          retryOfAmbiguousId: {
            state: 'ambiguous',
            ambiguousRecipient: { outcome: 'ambiguous', sendCount: 1 },
            deliverCallsDuringRetry: 0,
          },
          deliverCalls: [ids[1], ids[0]],
          counters: { fanouts: 1, recipients: 2, deduped: 0, dispatches: 2, sends: 2, failures: 0, reconciles: 1, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
        });
      }
      // ── F3: an attachment upload error is carried verbatim and no target borrows a path ──
      {
        const seen = [];
        const service = makeService({
          deliver: async (input) => {
            seen.push({ recipientId: input.recipientId, attachmentPath: input.attachmentPath });
            if (input.attachmentPath === ATTACHMENT_BETA) throw new CollaborationError('source_unavailable', 'fanout_attachment_upload');
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [
            target(P1, SESSIONS.codex, ATTACHMENT_ALPHA),
            target(P2, SESSIONS.kimi, ATTACHMENT_BETA),
            target(P3, SESSIONS.dsh),
          ],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        const after = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        check('an attachment upload error is carried VERBATIM out of the recipient that owns the failing path — failed with resolution source_unavailable/fanout_attachment_upload and a null ackId — while the other two recipients settle sent, and the structural isolation holds at the sink: each recipient deliver payload was built from ITS OWN record.attachmentPath (alpha, beta, null in recipient order), no recipient ever received another target path, the third recipient with no attachment received null and never any path, the frozen read model reports the same three paths, and the attachment target itself is validated — a parent-directory segment in either separator, a NUL byte, an empty value and a 1025th character are each refused invalid_request/fanout_attachment while exactly 1024 characters is accepted', {
          failedRecipient: {
            participantId: after.targets[1].participantId,
            attachmentPath: after.targets[1].attachmentPath,
            outcome: after.targets[1].outcome,
            resolution: after.targets[1].resolution,
            ackId: after.targets[1].ackId,
          },
          survivors: [
            { outcome: after.targets[0].outcome, ackId: after.targets[0].ackId },
            { outcome: after.targets[2].outcome, ackId: after.targets[2].ackId },
          ],
          sinkPathsInRecipientOrder: seen.map((entry) => entry.attachmentPath),
          sinkPathsPerRecipient: ids.map((id) => seen.filter((entry) => entry.recipientId === id).map((entry) => entry.attachmentPath)),
          crossUse: {
            alphaRecipientSawBeta: seen.some((entry) => entry.recipientId === ids[0] && entry.attachmentPath === ATTACHMENT_BETA),
            betaRecipientSawAlpha: seen.some((entry) => entry.recipientId === ids[1] && entry.attachmentPath === ATTACHMENT_ALPHA),
            attachmentlessRecipientSawAnyPath: seen.some((entry) => entry.recipientId === ids[2] && entry.attachmentPath !== null),
          },
          viewPaths: after.targets.map((entry) => entry.attachmentPath),
          state: after.state,
          stats: after.stats,
          counters: service.state(),
          derivedEqualsObserved: after.state === deriveFanoutState(after.targets),
          attachmentValidation: {
            traversal: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, '/repo/../etc/passwd')], at: T0 })),
            backslashTraversal: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, 'C:\\repo\\..\\etc')], at: T0 })),
            nulByte: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, '/repo/a\u0000b')], at: T0 })),
            empty: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, '')], at: T0 })),
            overMax: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, ATTACHMENT_PATH_OVER)], at: T0 })),
            exactMaxAccepted: (() => {
              const view = service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex, ATTACHMENT_PATH_MAX)], at: T0 });
              return { attachmentPathLength: view.targets[0].attachmentPath.length };
            })(),
          },
        }, {
          failedRecipient: {
            participantId: P2,
            attachmentPath: ATTACHMENT_BETA,
            outcome: 'failed',
            resolution: { code: 'source_unavailable', field: 'fanout_attachment_upload' },
            ackId: null,
          },
          survivors: [
            { outcome: 'sent', ackId: `ack-${ids[0]}` },
            { outcome: 'sent', ackId: `ack-${ids[2]}` },
          ],
          sinkPathsInRecipientOrder: [ATTACHMENT_ALPHA, ATTACHMENT_BETA, null],
          sinkPathsPerRecipient: [[ATTACHMENT_ALPHA], [ATTACHMENT_BETA], [null]],
          crossUse: { alphaRecipientSawBeta: false, betaRecipientSawAlpha: false, attachmentlessRecipientSawAnyPath: false },
          viewPaths: [ATTACHMENT_ALPHA, ATTACHMENT_BETA, null],
          state: 'partial',
          stats: { total: 3, sent: 2, failed: 1, ambiguous: 0, cancelled: 0, pending: 0 },
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 1, sends: 3, failures: 1, reconciles: 0, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
          attachmentValidation: {
            traversal: { code: 'invalid_request', field: 'fanout_attachment' },
            backslashTraversal: { code: 'invalid_request', field: 'fanout_attachment' },
            nulByte: { code: 'invalid_request', field: 'fanout_attachment' },
            empty: { code: 'invalid_request', field: 'fanout_attachment' },
            overMax: { code: 'invalid_request', field: 'fanout_attachment' },
            exactMaxAccepted: { attachmentPathLength: 1024 },
          },
        });
      }

      // ── F4: a duplicate participant is de-duplicated ONCE, at creation ──
      {
        const calls = [];
        const service = makeService({
          deliver: async (input) => {
            calls.push({ recipientId: input.recipientId, participantId: input.participantId });
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P1, SESSIONS.codex)],
        });
        const after = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        const sameParticipantOtherSession = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex), target(P1, SESSIONS.kimi)] });
        check('a duplicate participant joining the SAME session is de-duplicated once, at creation, against the canonical session key: the fan-out holds 2 recipients with deduped 1 and the first-seen order, the deliver port received exactly ONE prompt for that participant (two calls total, one per distinct recipient) so a duplicate can never be double-sent, and the contrast proves the key is participant+session rather than participant alone — the same participant in a DIFFERENT session is a distinct recipient with a distinct session key', {
          created: {
            recipientCount: created.targets.length,
            deduped: created.deduped,
            participants: created.targets.map((entry) => entry.participantId),
          },
          afterDispatch: {
            state: after.state,
            stats: after.stats,
            deliverCalls: calls.length,
            deliverParticipants: calls.map((entry) => entry.participantId),
            duplicateParticipantCallCount: calls.filter((entry) => entry.participantId === P1).length,
          },
          sameParticipantOtherSession: {
            recipientCount: sameParticipantOtherSession.targets.length,
            deduped: sameParticipantOtherSession.deduped,
            distinctSessionKeys: new Set(sameParticipantOtherSession.targets.map((entry) => entry.sessionKey)).size,
          },
          counters: service.state(),
        }, {
          created: { recipientCount: 2, deduped: 1, participants: [P1, P2] },
          afterDispatch: {
            state: 'succeeded',
            stats: { total: 2, sent: 2, failed: 0, ambiguous: 0, cancelled: 0, pending: 0 },
            deliverCalls: 2,
            deliverParticipants: [P1, P2],
            duplicateParticipantCallCount: 1,
          },
          sameParticipantOtherSession: { recipientCount: 2, deduped: 0, distinctSessionKeys: 2 },
          counters: { fanouts: 2, recipients: 4, deduped: 1, dispatches: 1, sends: 2, failures: 0, reconciles: 0, cancellations: 0, closed: false },
        });
      }

      // ── F5: every quota is refused with an explicit code, never silently dropped ──
      {
        const service = makeService({ deliver: ackAll }, fanoutTotals);
        const many = (count) => Array.from({ length: count }, (_, index) => target(PARTICIPANT(index), QUOTA_SESSION(index)));
        const at32 = service.createFanout({ prompt: PROMPT, at: T0, targets: many(32) });
        check('every frozen quota is enforced at its exact boundary with an explicit typed rejection — 32 targets is ACCEPTED as the inclusive maxTargets while the 33rd is refused invalid_request/fanout_targets, an empty or non-array target list is the same refusal, a 65536-char prompt is accepted while the 65537th, the empty prompt and a non-string prompt are invalid_request/fanout_prompt, a malformed participant id, a missing participant and a malformed session are each invalid_request/fanout_target, a non-positive `at` is invalid_request/collaboration_time, and a mixed-case participant id is normalised to lower case rather than refused', {
          targets: {
            at32Accepted: { recipientCount: at32.targets.length, statsTotal: at32.stats.total, deduped: at32.deduped, state: at32.state },
            over32: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: many(33) })),
            emptyList: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: [] })),
            notAnArray: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: 'nope' })),
          },
          prompt: {
            empty: captureSync(() => service.createFanout({ prompt: '', at: T0, targets: [target(P1, SESSIONS.codex)] })),
            notAString: captureSync(() => service.createFanout({ prompt: 42, at: T0, targets: [target(P1, SESSIONS.codex)] })),
            exactMaxAccepted: (() => {
              const view = service.createFanout({ prompt: 'x'.repeat(65536), at: T0, targets: [target(P1, SESSIONS.codex)] });
              return { promptLength: view.prompt.length };
            })(),
            overMax: captureSync(() => service.createFanout({ prompt: 'x'.repeat(65537), at: T0, targets: [target(P1, SESSIONS.codex)] })),
          },
          targetShape: {
            missingParticipant: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: [{ session: SESSIONS.codex }] })),
            malformedParticipant: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: [{ participantId: 'nope', session: SESSIONS.codex }] })),
            malformedSession: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: [{ participantId: P1, session: { environmentId: 'nope' } }] })),
            malformedAt: captureSync(() => service.createFanout({ prompt: PROMPT, targets: [target(P1, SESSIONS.codex)], at: 0 })),
            mixedCaseParticipantNormalised: (() => {
              const view = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(MIXED_CASE_PARTICIPANT.toUpperCase(), SESSIONS.codex)] });
              return { participantId: view.targets[0].participantId };
            })(),
          },
        }, {
          targets: {
            at32Accepted: { recipientCount: 32, statsTotal: 32, deduped: 0, state: 'pending' },
            over32: { code: 'invalid_request', field: 'fanout_targets' },
            emptyList: { code: 'invalid_request', field: 'fanout_targets' },
            notAnArray: { code: 'invalid_request', field: 'fanout_targets' },
          },
          prompt: {
            empty: { code: 'invalid_request', field: 'fanout_prompt' },
            notAString: { code: 'invalid_request', field: 'fanout_prompt' },
            exactMaxAccepted: { promptLength: 65536 },
            overMax: { code: 'invalid_request', field: 'fanout_prompt' },
          },
          targetShape: {
            missingParticipant: { code: 'invalid_request', field: 'fanout_target' },
            malformedParticipant: { code: 'invalid_request', field: 'fanout_target' },
            malformedSession: { code: 'invalid_request', field: 'fanout_target' },
            malformedAt: { code: 'invalid_request', field: 'collaboration_time' },
            mixedCaseParticipantNormalised: { participantId: MIXED_CASE_PARTICIPANT },
          },
        });
      }

      // ── F6: the read model lists each recipient REAL state — and the planner agrees cross-realm ──
      {
        const calls = [];
        const service = makeService({
          deliver: async (input) => {
            calls.push(input.recipientId);
            if (input.participantId === P2) throw new CollaborationError('source_unavailable', 'fanout_send');
            if (input.participantId === P3) return {}; // a result with no ackId -> ambiguous
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [
            target(P1, SESSIONS.codex),
            target(P2, SESSIONS.kimi),
            target(P3, SESSIONS.dsh),
            target(P4, SESSIONS.acp),
            target(P5, SESSIONS.opencode),
          ],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        // Three of the five settle through a real dispatch: failed, ambiguous, sent.
        await service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[1], ids[2], ids[3]], at: T0 + 1 });
        // The fifth is cancelled from pending; the first is never dispatched and stays pending.
        const view = service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: ids[4], at: T0 + 2 });
        const workerPlan = planFanoutRetry(view);
        // The SAME observed read model is driven through the REAL planner in the browser realm.
        const browserPlan = await evaluate((passed) => window.task38.plan(passed), scrub(view));
        check('the product OWN read model lists each recipient REAL state — never a synthetic aggregate: one fan-out is driven so its five recipients settle into ALL FIVE outcomes at once (pending never-dispatched, failed with source_unavailable/fanout_send, ambiguous with reconcile_required/fanout_ambiguous, sent with its own ack, cancelled from pending with cancelled/fanout_cancelled), every recipient carries its own dispatched flag, sendCount, ackId, resolution and retryable flag (retryable true for exactly the never-dispatched one), the stats block counts each outcome separately, the overall state is the honest derivation (any ambiguous wins), and the recovery planner — run over the SAME observed bytes in BOTH realms with byte-identical output — retains the four non-retryable recipients each under its OBSERVED outcome and the matching reason while retrying only the never-dispatched one. This drives the product read model and the product planner; no rendered component is claimed (task 42 owns the collaboration UI)', {
          perRecipientRealStates: view.targets.map((entry) => ({
            participantId: entry.participantId,
            outcome: entry.outcome,
            resolution: entry.resolution,
            ackId: entry.ackId,
            dispatched: entry.dispatched,
            sendCount: entry.sendCount,
            retryable: entry.retryable,
          })),
          outcomes: view.targets.map((entry) => entry.outcome),
          stats: view.stats,
          state: view.state,
          workerPlan: {
            retryable: workerPlan.retryable.map((spec) => ({ recipientId: spec.recipientId, participantId: spec.participantId, session: { ...spec.session }, attachmentPath: spec.attachmentPath })),
            retained: workerPlan.retained.map((entry) => ({ recipientId: entry.recipientId, outcome: entry.outcome, reason: entry.reason })),
          },
          browserPlan: { retryable: browserPlan.retryable, retained: browserPlan.retained },
          browserPlanFrozen: browserPlan.frozen,
          plansIdentical: JSON.stringify({ retryable: scrub(workerPlan.retryable), retained: scrub(workerPlan.retained) })
            === JSON.stringify({ retryable: browserPlan.retryable, retained: browserPlan.retained }),
          deliverCalls: calls,
          counters: service.state(),
          derivedEqualsObserved: view.state === deriveFanoutState(view.targets),
        }, {
          perRecipientRealStates: [
            { participantId: P1, outcome: 'pending', resolution: null, ackId: null, dispatched: false, sendCount: 0, retryable: true },
            { participantId: P2, outcome: 'failed', resolution: { code: 'source_unavailable', field: 'fanout_send' }, ackId: null, dispatched: true, sendCount: 1, retryable: false },
            { participantId: P3, outcome: 'ambiguous', resolution: { code: 'reconcile_required', field: 'fanout_ambiguous' }, ackId: null, dispatched: true, sendCount: 1, retryable: false },
            { participantId: P4, outcome: 'sent', resolution: null, ackId: `ack-${ids[3]}`, dispatched: true, sendCount: 1, retryable: false },
            { participantId: P5, outcome: 'cancelled', resolution: { code: 'cancelled', field: 'fanout_cancelled' }, ackId: null, dispatched: false, sendCount: 0, retryable: false },
          ],
          outcomes: ['pending', 'failed', 'ambiguous', 'sent', 'cancelled'],
          stats: { total: 5, sent: 1, failed: 1, ambiguous: 1, cancelled: 1, pending: 1 },
          state: 'ambiguous',
          workerPlan: {
            retryable: [{
              recipientId: ids[0],
              participantId: P1,
              session: { environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' },
              attachmentPath: null,
            }],
            retained: [
              { recipientId: ids[1], outcome: 'failed', reason: 'fanout_already_dispatched' },
              { recipientId: ids[2], outcome: 'ambiguous', reason: 'fanout_ambiguous' },
              { recipientId: ids[3], outcome: 'sent', reason: 'fanout_already_dispatched' },
              { recipientId: ids[4], outcome: 'cancelled', reason: 'fanout_cancelled' },
            ],
          },
          browserPlan: {
            retryable: [{
              recipientId: ids[0],
              participantId: P1,
              session: { environmentId: ENV_A, harnessInstanceId: H.codex, nativeSessionId: 'native:codex-1' },
              attachmentPath: null,
            }],
            retained: [
              { recipientId: ids[1], outcome: 'failed', reason: 'fanout_already_dispatched' },
              { recipientId: ids[2], outcome: 'ambiguous', reason: 'fanout_ambiguous' },
              { recipientId: ids[3], outcome: 'sent', reason: 'fanout_already_dispatched' },
              { recipientId: ids[4], outcome: 'cancelled', reason: 'fanout_cancelled' },
            ],
          },
          browserPlanFrozen: { plan: true, retryable: true, firstSpec: true, retained: true },
          plansIdentical: true,
          deliverCalls: [ids[1], ids[2], ids[3]],
          counters: { fanouts: 1, recipients: 5, deduped: 0, dispatches: 1, sends: 3, failures: 1, reconciles: 1, cancellations: 1, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── F7: after close every entry point refuses with cancelled/fanout_service_closed ──
      {
        const service = makeService({ deliver: ackAll }, fanoutTotals);
        const created = service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi)] });
        service.close();
        const dispatchClosed = await capture(() => service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 }));
        const retryClosed = await capture(() => service.retry({ fanoutId: created.fanoutId, recipientIds: [], at: T0 + 1 }));
        check('after close() every entry point refuses with cancelled/fanout_service_closed — createFanout, fanout, fanouts, dispatch, cancelRecipient, reconcile and retry alike — while state() still reports the frozen counters with closed true, so a closed service can be inspected but never written', {
          createFanout: captureSync(() => service.createFanout({ prompt: PROMPT, at: T0, targets: [target(P1, SESSIONS.codex)] })),
          fanout: captureSync(() => service.fanout(created.fanoutId)),
          fanouts: captureSync(() => service.fanouts()),
          dispatch: dispatchClosed,
          cancelRecipient: captureSync(() => service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: created.targets[0].recipientId, at: T0 + 1 })),
          reconcile: captureSync(() => service.reconcile({ fanoutId: created.fanoutId, at: T0 + 1 })),
          retry: retryClosed,
          state: service.state(),
        }, {
          createFanout: { code: 'cancelled', field: 'fanout_service_closed' },
          fanout: { code: 'cancelled', field: 'fanout_service_closed' },
          fanouts: { code: 'cancelled', field: 'fanout_service_closed' },
          dispatch: { code: 'cancelled', field: 'fanout_service_closed' },
          cancelRecipient: { code: 'cancelled', field: 'fanout_service_closed' },
          reconcile: { code: 'cancelled', field: 'fanout_service_closed' },
          retry: { code: 'cancelled', field: 'fanout_service_closed' },
          state: { fanouts: 1, recipients: 2, deduped: 0, dispatches: 0, sends: 0, failures: 0, reconciles: 0, cancellations: 0, closed: true },
        });
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: three harnesses concurrently reviewing the same repo, each recipient with its
      // own timeline/evidence, an individual cancel of exactly one recipient, duplicate
      // participants de-duplicated, the recovery retry of the never-sent recipient, and the whole
      // command surface actually STARTED or CHECKED.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── H1: three harnesses concurrently reviewing the same repo ──
      {
        const started = [];
        const finished = [];
        let inFlight = 0;
        let maxInFlight = 0;
        const sink = [];
        const service = makeService({
          deliver: async (input) => {
            started.push(input.recipientId);
            sink.push({ recipientId: input.recipientId, participantId: input.participantId, attachmentPath: input.attachmentPath, prompt: input.prompt });
            inFlight += 1;
            maxInFlight = Math.max(maxInFlight, inFlight);
            await new Promise((resolve) => setTimeout(resolve, 15));
            inFlight -= 1;
            finished.push(input.recipientId);
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        // "The same repo": ONE shared prompt and one shared attachment root /repo/. A SessionRef
        // carries environmentId + harnessInstanceId + nativeSessionId (identity.js parseSessionRef)
        // and no repo field, so the shared repo is expressed by the shared prompt and root, and the
        // three harness identities are the three distinct native sessions.
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [
            target(P1, SESSIONS.codex, ATTACHMENT_ALPHA),
            target(P2, SESSIONS.kimi, ATTACHMENT_BETA),
            target(P3, SESSIONS.dsh, ATTACHMENT_GAMMA),
          ],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        const after = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        check('three harnesses review the same repo concurrently over ONE prompt: the fan-out is created with exactly three recipients (total 3, deduped 0) sitting at pending with every recipient retryable and nothing dispatched, and after the dispatch the OBSERVED read model carries each recipient own harness identity (codex, kimi-web and dsh native sessions, each participant id as created, each sessionKey the canonical encodeSessionKey of its own session), each recipient deliver payload carried ITS OWN attachment path under the shared /repo root (alpha, beta, gamma — never another target path) with the one shared prompt, all three sends were OBSERVED in flight at the same time (maxInFlight 3 with three starts before any finish), every recipient settled sent with exactly one send, and the overall state succeeded is the honest derivation of the observed per-recipient outcomes', {
          recipientCount: after.targets.length,
          statsTotal: after.stats.total,
          deduped: after.deduped,
          stateBeforeDispatch: created.state,
          stateAfterDispatch: after.state,
          perRecipient: after.targets.map((entry) => ({
            participantId: entry.participantId,
            harnessInstanceId: entry.session.harnessInstanceId,
            nativeSessionId: entry.session.nativeSessionId,
            sessionKey: entry.sessionKey,
            attachmentPath: entry.attachmentPath,
            outcome: entry.outcome,
            dispatched: entry.dispatched,
            sendCount: entry.sendCount,
            ackId: entry.ackId,
            resolution: entry.resolution,
            retryable: entry.retryable,
            createdAt: entry.createdAt,
            updatedAt: entry.updatedAt,
          })),
          sessionKeysAreCanonical: after.targets.every((entry) => entry.sessionKey === encodeSessionKey(entry.session)),
          sinkAttachmentPaths: sink.map((entry) => entry.attachmentPath),
          sinkPrompts: [...new Set(sink.map((entry) => entry.prompt))],
          sinkPathsShareRepoRoot: sink.every((entry) => entry.attachmentPath === null || entry.attachmentPath.startsWith('/repo/')),
          startedCount: started.length,
          finishedCount: finished.length,
          maxInFlight,
          state: after.state,
          stats: after.stats,
          counters: service.state(),
          derivedEqualsObserved: after.state === deriveFanoutState(after.targets),
        }, {
          recipientCount: 3,
          statsTotal: 3,
          deduped: 0,
          stateBeforeDispatch: 'pending',
          stateAfterDispatch: 'succeeded',
          perRecipient: [
            {
              participantId: P1,
              harnessInstanceId: H.codex,
              nativeSessionId: 'native:codex-1',
              sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
              attachmentPath: ATTACHMENT_ALPHA,
              outcome: 'sent',
              dispatched: true,
              sendCount: 1,
              ackId: `ack-${ids[0]}`,
              resolution: null,
              retryable: false,
              createdAt: T0,
              updatedAt: T0 + 1,
            },
            {
              participantId: P2,
              harnessInstanceId: H.kimi,
              nativeSessionId: 'native:kimi-1',
              sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
              attachmentPath: ATTACHMENT_BETA,
              outcome: 'sent',
              dispatched: true,
              sendCount: 1,
              ackId: `ack-${ids[1]}`,
              resolution: null,
              retryable: false,
              createdAt: T0,
              updatedAt: T0 + 1,
            },
            {
              participantId: P3,
              harnessInstanceId: H.dsh,
              nativeSessionId: 'native:dsh-1',
              sessionKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJkZGRkZGRkZC1kZGRkLTRkZGQtOGRkZC1kZGRkZGRkZGRkZGQiLCJuYXRpdmU6ZHNoLTEiXQ',
              attachmentPath: ATTACHMENT_GAMMA,
              outcome: 'sent',
              dispatched: true,
              sendCount: 1,
              ackId: `ack-${ids[2]}`,
              resolution: null,
              retryable: false,
              createdAt: T0,
              updatedAt: T0 + 1,
            },
          ],
          sessionKeysAreCanonical: true,
          sinkAttachmentPaths: [ATTACHMENT_ALPHA, ATTACHMENT_BETA, ATTACHMENT_GAMMA],
          sinkPrompts: [PROMPT],
          sinkPathsShareRepoRoot: true,
          startedCount: 3,
          finishedCount: 3,
          maxInFlight: 3,
          state: 'succeeded',
          stats: { total: 3, sent: 3, failed: 0, ambiguous: 0, cancelled: 0, pending: 0 },
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 1, sends: 3, failures: 0, reconciles: 0, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── H2: each recipient has its OWN timeline and evidence — distinct child operations ──
      {
        const calls = [];
        const service = makeService({
          deliver: async (input) => {
            calls.push(input.recipientId);
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh)],
        });
        const after = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        check('each recipient runs its OWN child operation with its OWN timeline and evidence, and no two share an identity: the three recipient ids are distinct, the three child-operation ack ids are distinct and each equals the ack of ITS OWN recipient (never a sibling), the deliver port was called exactly once per recipient, every recipient carries sendCount 1 with its own createdAt at the fan-out creation instant and its own updatedAt at the dispatch instant, and the overall state succeeded is the derivation of those three independent sent outcomes', {
          recipientIds: after.targets.map((entry) => entry.recipientId),
          recipientIdsDistinct: new Set(after.targets.map((entry) => entry.recipientId)).size,
          childOperationAckIds: after.targets.map((entry) => entry.ackId),
          childOperationAckIdsDistinct: new Set(after.targets.map((entry) => entry.ackId)).size,
          eachAckIsItsOwn: after.targets.map((entry) => entry.ackId === `ack-${entry.recipientId}`),
          deliverCallsPerRecipient: after.targets.map((entry) => calls.filter((call) => call === entry.recipientId).length),
          deliverCallsTotal: calls.length,
          perRecipientTimelines: after.targets.map((entry) => ({ recipientId: entry.recipientId, createdAt: entry.createdAt, updatedAt: entry.updatedAt, sendCount: entry.sendCount })),
          state: after.state,
          stats: after.stats,
          derivedEqualsObserved: after.state === deriveFanoutState(after.targets),
        }, {
          recipientIds: after.targets.map((entry) => entry.recipientId),
          recipientIdsDistinct: 3,
          childOperationAckIds: after.targets.map((entry) => entry.ackId),
          childOperationAckIdsDistinct: 3,
          eachAckIsItsOwn: [true, true, true],
          deliverCallsPerRecipient: [1, 1, 1],
          deliverCallsTotal: 3,
          perRecipientTimelines: after.targets.map((entry) => ({ recipientId: entry.recipientId, createdAt: T0, updatedAt: T0 + 1, sendCount: 1 })),
          state: 'succeeded',
          stats: { total: 3, sent: 3, failed: 0, ambiguous: 0, cancelled: 0, pending: 0 },
          derivedEqualsObserved: true,
        });
      }

      // ── H3: cancel ONLY ONE recipient — the other two are unaffected ──
      {
        const service = makeService({ deliver: ackAll }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh)],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        const dispatched = await service.dispatch({ fanoutId: created.fanoutId, at: T0 + 1 });
        const afterCancel = service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: ids[1], at: T0 + 2 });
        // A second cancel of the SAME (already cancelled) recipient is a no-op: the counter does
        // not move and the resolution is not rewritten.
        const secondCancel = service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: ids[1], at: T0 + 3 });
        check('an individual cancel touches EXACTLY ONE recipient: the cancelled recipient is observed at cancelled with resolution cancelled/fanout_cancelled and its own updatedAt moved to the cancel instant while still dispatched with its one send and its ack retained, the other two recipients are observed UNCHANGED — still sent with their own acks, sendCount 1, null resolutions and their dispatch-instant updatedAt — the overall state re-derives to partial from the observed mix, a second cancel of the same recipient is a no-op that moves no counter, and OBSERVED AND RECORDED: the fan-out level updatedAt is written only by dispatch and reconcile, so an individual cancel moves the recipient own updatedAt and leaves the fan-out level one at the dispatch instant', {
          beforeCancel: { state: dispatched.state, outcomes: dispatched.targets.map((entry) => entry.outcome) },
          cancelledRecipient: {
            outcome: afterCancel.targets[1].outcome,
            resolution: afterCancel.targets[1].resolution,
            dispatched: afterCancel.targets[1].dispatched,
            sendCount: afterCancel.targets[1].sendCount,
            ackId: afterCancel.targets[1].ackId,
            retryable: afterCancel.targets[1].retryable,
            updatedAt: afterCancel.targets[1].updatedAt,
          },
          survivors: [0, 2].map((index) => ({
            outcome: afterCancel.targets[index].outcome,
            ackId: afterCancel.targets[index].ackId,
            sendCount: afterCancel.targets[index].sendCount,
            resolution: afterCancel.targets[index].resolution,
            retryable: afterCancel.targets[index].retryable,
            updatedAt: afterCancel.targets[index].updatedAt,
          })),
          outcomes: afterCancel.targets.map((entry) => entry.outcome),
          state: afterCancel.state,
          stats: afterCancel.stats,
          fanoutUpdatedAtAfterCancel: afterCancel.updatedAt,
          secondCancel: {
            outcome: secondCancel.targets[1].outcome,
            resolution: secondCancel.targets[1].resolution,
            cancellations: service.state().cancellations,
            state: secondCancel.state,
          },
          counters: service.state(),
          derivedEqualsObserved: afterCancel.state === deriveFanoutState(afterCancel.targets),
        }, {
          beforeCancel: { state: 'succeeded', outcomes: ['sent', 'sent', 'sent'] },
          cancelledRecipient: {
            outcome: 'cancelled',
            resolution: { code: 'cancelled', field: 'fanout_cancelled' },
            dispatched: true,
            sendCount: 1,
            ackId: `ack-${ids[1]}`,
            retryable: false,
            updatedAt: T0 + 2,
          },
          survivors: [
            { outcome: 'sent', ackId: `ack-${ids[0]}`, sendCount: 1, resolution: null, retryable: false, updatedAt: T0 + 1 },
            { outcome: 'sent', ackId: `ack-${ids[2]}`, sendCount: 1, resolution: null, retryable: false, updatedAt: T0 + 1 },
          ],
          outcomes: ['sent', 'cancelled', 'sent'],
          state: 'partial',
          stats: { total: 3, sent: 2, failed: 0, ambiguous: 0, cancelled: 1, pending: 0 },
          fanoutUpdatedAtAfterCancel: T0 + 1,
          secondCancel: {
            outcome: 'cancelled',
            resolution: { code: 'cancelled', field: 'fanout_cancelled' },
            cancellations: 1,
            state: 'partial',
          },
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 1, sends: 3, failures: 0, reconciles: 0, cancellations: 1, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── H4: duplicate participants to the same session are de-duplicated ──
      {
        const service = makeService({ deliver: ackAll }, fanoutTotals);
        const beforeJoin = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi)],
        });
        const afterJoin = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [
            target(P1, SESSIONS.codex),
            target(P2, SESSIONS.kimi),
            target(P1, SESSIONS.codex), // the duplicate join: same participant, same session
            target(P1, SESSIONS.acp), // the contrast: same participant, DIFFERENT session
          ],
        });
        check('duplicate participants to the same session are de-duplicated once, at creation, and the OBSERVED recipient count is asserted before and after the duplicate join: the two-distinct-target fan-out holds 2 recipients with deduped 0, and the fan-out that adds an exact duplicate of the first target still holds only 3 recipients (deduped 1) in first-seen order — the duplicate never receives its own recipient id — while the same participant in a DIFFERENT session survives as a distinct recipient with its own canonical session key, so the de-duplication key is participant+session and not the participant alone', {
          beforeJoin: {
            recipientCount: beforeJoin.targets.length,
            statsTotal: beforeJoin.stats.total,
            deduped: beforeJoin.deduped,
            participants: beforeJoin.targets.map((entry) => entry.participantId),
            sessionKeys: beforeJoin.targets.map((entry) => entry.sessionKey),
          },
          afterJoin: {
            recipientCount: afterJoin.targets.length,
            statsTotal: afterJoin.stats.total,
            deduped: afterJoin.deduped,
            participants: afterJoin.targets.map((entry) => entry.participantId),
            sessionKeys: afterJoin.targets.map((entry) => entry.sessionKey),
            distinctSessionKeys: new Set(afterJoin.targets.map((entry) => entry.sessionKey)).size,
          },
          counters: service.state(),
        }, {
          beforeJoin: {
            recipientCount: 2,
            statsTotal: 2,
            deduped: 0,
            participants: [P1, P2],
            sessionKeys: [
              'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
              'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
            ],
          },
          afterJoin: {
            recipientCount: 3,
            statsTotal: 3,
            deduped: 1,
            participants: [P1, P2, P1],
            sessionKeys: [
              'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
              'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
              'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
            ],
            distinctSessionKeys: 3,
          },
          counters: { fanouts: 2, recipients: 5, deduped: 1, dispatches: 0, sends: 0, failures: 0, reconciles: 0, cancellations: 0, closed: false },
        });
      }

      // ── H5: the recovery retry sends ONLY the explicitly-safe never-dispatched recipient ──
      {
        const calls = [];
        const service = makeService({
          deliver: async (input) => {
            calls.push(input.recipientId);
            return { ackId: `ack-${input.recipientId}` };
          },
        }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh)],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        // A partial dispatch: two of three settle, the third is never dispatched.
        const partial = await service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[0], ids[1]], at: T0 + 1 });
        const plan = planFanoutRetry(partial);
        const callsBeforeRetry = calls.length;
        // A reconcile with nothing in flight changes nothing.
        const reconciled = service.reconcile({ fanoutId: created.fanoutId, at: T0 + 2 });
        // The retry drives exactly the planner's retryable set.
        const retried = await service.retry({ fanoutId: created.fanoutId, recipientIds: plan.retryable.map((spec) => spec.recipientId), at: T0 + 3 });
        check('the recovery path is safe by TWO independent layers, both observed: after a partial dispatch the overall state is running (two sent, one never-dispatched pending with retryable true and sendCount 0), the planner retryable set holds exactly that never-dispatched recipient and retains the two already-dispatched ones under reason fanout_already_dispatched with the whole plan frozen, a reconcile with nothing in flight moves no recipient and no counter, and the retry sends ONLY the planner recipient — the deliver port observed exactly that one call, the two already-sent recipients keep sendCount 1 and their acks, the retried recipient settles sent with its own ack, the overall state re-derives to succeeded, and the dispatch counter moved for both real dispatches', {
          partial: {
            state: partial.state,
            outcomes: partial.targets.map((entry) => entry.outcome),
            neverDispatchedRecipient: {
              outcome: partial.targets[2].outcome,
              dispatched: partial.targets[2].dispatched,
              sendCount: partial.targets[2].sendCount,
              retryable: partial.targets[2].retryable,
            },
          },
          plan: {
            retryableIds: plan.retryable.map((spec) => spec.recipientId),
            retained: plan.retained.map((entry) => ({ recipientId: entry.recipientId, outcome: entry.outcome, reason: entry.reason })),
            frozen: [Object.isFrozen(plan), Object.isFrozen(plan.retryable), Object.isFrozen(plan.retryable[0]), Object.isFrozen(plan.retained)],
          },
          reconciled: {
            state: reconciled.state,
            reconciles: service.state().reconciles,
            recipientsUnchanged: JSON.stringify(scrub(reconciled.targets)) === JSON.stringify(scrub(partial.targets)),
          },
          retried: {
            state: retried.state,
            outcomes: retried.targets.map((entry) => entry.outcome),
            retriedRecipient: { sendCount: retried.targets[2].sendCount, ackId: retried.targets[2].ackId },
            alreadySentSendCounts: [retried.targets[0].sendCount, retried.targets[1].sendCount],
            alreadySentAckIds: [retried.targets[0].ackId, retried.targets[1].ackId],
          },
          retryCalls: calls.slice(callsBeforeRetry),
          counters: service.state(),
          derivedEqualsObserved: retried.state === deriveFanoutState(retried.targets),
        }, {
          partial: {
            state: 'running',
            outcomes: ['sent', 'sent', 'pending'],
            neverDispatchedRecipient: { outcome: 'pending', dispatched: false, sendCount: 0, retryable: true },
          },
          plan: {
            retryableIds: [ids[2]],
            retained: [
              { recipientId: ids[0], outcome: 'sent', reason: 'fanout_already_dispatched' },
              { recipientId: ids[1], outcome: 'sent', reason: 'fanout_already_dispatched' },
            ],
            frozen: [true, true, true, true],
          },
          reconciled: { state: 'running', reconciles: 0, recipientsUnchanged: true },
          retried: {
            state: 'succeeded',
            outcomes: ['sent', 'sent', 'sent'],
            retriedRecipient: { sendCount: 1, ackId: `ack-${ids[2]}` },
            alreadySentSendCounts: [1, 1],
            alreadySentAckIds: [`ack-${ids[0]}`, `ack-${ids[1]}`],
          },
          retryCalls: [ids[2]],
          counters: { fanouts: 1, recipients: 3, deduped: 0, dispatches: 2, sends: 3, failures: 0, reconciles: 0, cancellations: 0, closed: false },
          derivedEqualsObserved: true,
        });
      }

      // ── H6: every command the case lists is actually STARTED or CHECKED ──
      {
        const service = makeService({ deliver: ackAll }, fanoutTotals);
        const created = service.createFanout({
          prompt: PROMPT,
          at: T0,
          targets: [target(P1, SESSIONS.codex), target(P2, SESSIONS.kimi), target(P3, SESSIONS.dsh), target(P4, SESSIONS.acp)],
        });
        const ids = created.targets.map((entry) => entry.recipientId);
        const readBack = service.fanout(created.fanoutId);
        const dispatched = await service.dispatch({ fanoutId: created.fanoutId, recipientIds: [ids[0], ids[1], ids[2]], at: T0 + 1 });
        const cancelled = service.cancelRecipient({ fanoutId: created.fanoutId, recipientId: ids[3], at: T0 + 2 });
        const reconciled = service.reconcile({ fanoutId: created.fanoutId, at: T0 + 3 });
        const retriedEmpty = await service.retry({ fanoutId: created.fanoutId, recipientIds: [], at: T0 + 4 });
        const listed = service.fanouts();
        const counters = service.state();
        check('every command of the fan-out surface is actually STARTED and its effect CHECKED, in one chronological trace over one world: createFanout mints 4 pending recipients, fanout(id) reads back a byte-identical frozen model, dispatch of three settles them sent leaving the fourth pending (running), cancelRecipient of the never-dispatched fourth marks it cancelled from pending with sendCount 0 (partial), reconcile with nothing in flight changes no recipient, a retry with an EMPTY recipient list is a no-op that moves neither the dispatch counter nor any send, fanouts() lists exactly this one fan-out frozen, and state() reports the observed counters with closed false — so no command is merely enumerated', {
          trace: [
            { command: 'createFanout', state: created.state, stats: created.stats },
            { command: 'fanout', readBackEqualsCreated: JSON.stringify(scrub(readBack)) === JSON.stringify(scrub(created)), state: readBack.state },
            { command: 'dispatch', state: dispatched.state, stats: dispatched.stats },
            { command: 'cancelRecipient', state: cancelled.state, stats: cancelled.stats },
            { command: 'reconcile', state: reconciled.state, stats: reconciled.stats },
            { command: 'retry(empty)', state: retriedEmpty.state, dispatches: counters.dispatches, sends: counters.sends },
            { command: 'fanouts', count: listed.length },
            { command: 'state', closed: counters.closed },
          ],
          cancelledFromPending: {
            outcome: cancelled.targets[3].outcome,
            dispatched: cancelled.targets[3].dispatched,
            sendCount: cancelled.targets[3].sendCount,
            resolution: cancelled.targets[3].resolution,
            retryable: cancelled.targets[3].retryable,
          },
          frozenReads: {
            fanout: Object.isFrozen(created),
            fanoutRead: Object.isFrozen(readBack),
            fanoutsList: Object.isFrozen(listed),
            stateRead: Object.isFrozen(counters),
          },
          counters,
        }, {
          trace: [
            { command: 'createFanout', state: 'pending', stats: { total: 4, sent: 0, failed: 0, ambiguous: 0, cancelled: 0, pending: 4 } },
            { command: 'fanout', readBackEqualsCreated: true, state: 'pending' },
            { command: 'dispatch', state: 'running', stats: { total: 4, sent: 3, failed: 0, ambiguous: 0, cancelled: 0, pending: 1 } },
            { command: 'cancelRecipient', state: 'partial', stats: { total: 4, sent: 3, failed: 0, ambiguous: 0, cancelled: 1, pending: 0 } },
            { command: 'reconcile', state: 'partial', stats: { total: 4, sent: 3, failed: 0, ambiguous: 0, cancelled: 1, pending: 0 } },
            { command: 'retry(empty)', state: 'partial', dispatches: 1, sends: 3 },
            { command: 'fanouts', count: 1 },
            { command: 'state', closed: false },
          ],
          cancelledFromPending: {
            outcome: 'cancelled',
            dispatched: false,
            sendCount: 0,
            resolution: { code: 'cancelled', field: 'fanout_cancelled' },
            retryable: false,
          },
          frozenReads: { fanout: true, fanoutRead: true, fanoutsList: true, stateRead: true },
          counters: { fanouts: 1, recipients: 4, deduped: 0, dispatches: 1, sends: 3, failures: 0, reconciles: 0, cancellations: 1, closed: false },
        });
      }
    }

    // ── every rejection code the product emitted belongs to the frozen canonical table ──
    const codes = [...observedCodes].sort();
    const browserMembership = await evaluate((list) => window.task38.codeMembership(list), codes);
    protocol.browser.codeMembership = browserMembership;
    record('codeMembership', { codes, browserMembership });
    check('every rejection code the product actually emitted across this case belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the worker collected — no fan-out rejection ever carries a code outside the protocol vocabulary', {
      observedCodes: codes,
      workerAllInTable: codes.every((code) => ERROR_CODES.includes(code)),
      browser: browserMembership,
    }, {
      observedCodes: codes,
      workerAllInTable: true,
      browser: { observedCount: codes.length, missing: [], allObservedCodesInTable: true, distinctObserved: new Set(codes).size },
    });

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task38.errors());
    check('the browser entry logged no error while recomputing the frozen shared contract and driving the real recovery planner over a real read model in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa38-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa38-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task38.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapPeak: peakHeap, heapEnd, heapGrowthBytes });
    // The load-bearing boundedness evidence is the FAN-OUT SERVICE'S OWN counters and read models,
    // exactly as task 36 used the engine's usage() counters and task 37 used the coordinator's
    // budgets: no fan-out this case created can exceed the frozen maxTargets, because createFanout
    // refuses a 33rd target (asserted in the failure lane's F5 and structurally here). The heap
    // numbers are recorded as a GC-TIMING ARTEFACT (heapUsed measures allocated-and-not-yet-
    // collected, which a forced collection collapses), not a retention proof, and they decide
    // nothing.
    const largestFanout = Math.max(...fanoutTotals);
    check('the case stays bounded in the FAN-OUT SERVICE OWN read models, not in a raw heap delta: every fan-out this case created is counted from the product own frozen stats, the largest observed fan-out holds at most the frozen maxTargets of 32 recipients so the quota is never exceeded by a run, the case exercised a fixed set of owned resources with zero borrowed spawns, and the observed heap numbers are RECORDED as a GC-timing artefact rather than a retention proof', {
      fanoutsCreated: fanoutTotals.length,
      largestFanoutRecipients: largestFanout,
      largestWithinFrozenLimit: largestFanout <= FANOUT_LIMITS.maxTargets,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
      heapGrowthBytes,
      heapPeakGrowthBytes: peakHeap - heapStart,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
    }, {
      fanoutsCreated: fanoutTotals.length,
      largestFanoutRecipients: largestFanout,
      largestWithinFrozenLimit: true,
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
    check('the evidence binds to the current bytes: the sha256 of all nine pinned product files is independently recomputed at the END of the run and equals the values recomputed before any scenario ran, so no product byte moved under the case — the nine hashes are recorded for the independent gate to compare against the artifact sourceHashes', {
      pinnedProductFileCount: PRODUCT_FILES.length,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: JSON.stringify(productHashesBefore) === JSON.stringify(productHashesAfter),
      allSha256Shaped: Object.values(productHashesAfter).every((hash) => /^[a-f0-9]{64}$/.test(hash)),
    }, {
      pinnedProductFileCount: 9,
      hashesBefore: productHashesBefore,
      hashesAfter: productHashesAfter,
      unchanged: true,
      allSha256Shaped: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task38Errors ?? [], task38: Boolean(window.task38) })).catch((value) => ({ unavailable: String(value) }));
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'partial-failure-recoverable-fanout', schema: 'runtime-collaboration-fanout/v1' },
    cleanup: proof.cleanup,
    defects: {
      cancelRecipientDoesNotMoveTheFanoutLevelUpdatedAt: {
        severity: 'observation',
        observed: 'cancelRecipient (fanoutService.js:319-331) writes only the recipient own updatedAt; the fan-out level record.updatedAt is written by dispatch (fanoutService.js:314) and reconcile (fanoutService.js:349) only, so after an individual cancel the fan-out level updatedAt still reads the dispatch instant while the cancelled recipient own updatedAt reads the cancel instant',
        assertedAs: 'asserted verbatim as OBSERVED in H3 (fanoutUpdatedAtAfterCancel T0+1 against the recipient updatedAt T0+2). Nothing is forced: if the product is changed to also stamp the record, H3 goes red on that field and the change is visible',
        relevance: 'a reader diffing fan-out level updatedAt to detect any activity would miss an individual cancel; the per-recipient updatedAt is the honest signal',
      },
      cancelledRecipientRetainsItsAckId: {
        severity: 'observation',
        observed: 'a cancel of an already-sent recipient writes outcome cancelled and the resolution but never clears ackId (fanoutService.js:324-329), so the read model still shows which child operation had acknowledged before the cancel',
        assertedAs: 'asserted verbatim in H3 (the cancelled recipient keeps ack-<its own id> alongside outcome cancelled), and the mirror case in H6 where a cancel from PENDING leaves ackId null with sendCount 0',
      },
      unknownRecipientIdIsSilentlySelectedOut: {
        severity: 'observation',
        observed: 'dispatch and retry filter a well-formed but unknown recipient id out of the selection (fanoutService.js:310) — no rejection, no send, no counter movement — while a non-UUID id is refused invalid_request/fanout_recipient and a non-array list invalid_request/fanout_recipients',
        assertedAs: 'asserted in C3 (unknownRecipientIdFiltered sendsDelta 0, state pending) with the two typed refusals beside it, so the silent path cannot be mistaken for the refused one',
      },
      emptyRetryIsANoOp: {
        severity: 'observation',
        observed: 'the dispatch counter steps only when the selection is non-empty (fanoutService.js:312), so a retry whose recipient list selects nothing moves no counter and sends nothing',
        assertedAs: 'asserted in H6 command trace (retry(empty) leaves dispatches 1 and sends 3)',
      },
      statefulServiceCannotEnterTheBrowserRealm: {
        severity: 'acceptance-criterion-gap',
        observed: 'fanoutService.js:1 imports node:crypto (randomUUID), so the service itself — create, dispatch, cancelRecipient, reconcile, retry, the frozen FANOUT_LIMITS / FANOUT_STATES / RECIPIENT_OUTCOMES tables and the derived overall state — cannot run in a browser realm; the same split task 37 disclosed for its coordinator',
        coveredInstead: 'the stateful surface is proven in the Node worker over the real modules; what crosses the boundary is proven in a real headless Chromium instead: the frozen shared contract, the canonical session keys, and the REAL planFanoutRetry from fanoutRecovery.js (pure ESM) over an OBSERVED read model, asserted byte-identical to the worker computation in F6',
      },
      durabilityAcrossProcessDeathNotClaimed: {
        severity: 'acceptance-criterion-gap',
        observed: 'reconcile re-marks in-flight recipients ambiguous IN-PROCESS, exactly the posture tasks 34 and 37 disclosed for their in-memory journals: the single-writer durable store the fan-out would compose with is design intent, not executed proof',
        contradictsPlanCriterion: 'nothing in this task listed crash durability; the plan claims partial-failure recoverability, which is proven in-process',
        coveredInstead: 'the reachable recovery states are proven over the real service: a never-dispatched recipient retried (H5), an in-flight recipient marked ambiguous by a manager kill whose late ack is then ignored (F2), and an ambiguous recipient refused by both the planner and the dispatcher (F2, F6)',
      },
      liveHarnessNotExercised: {
        severity: 'out-of-scope',
        observed: 'the five harness kinds appear only as native-session identities inside the recipient records; no live opencode, codex, kimi-web, dsh or acp backend is contacted',
        carriedAs: 'task 46 owns end-to-end live verification; the case performs no SSH and no Slurm work and its header and evidenceBoundary say so',
      },
      collaborationUiNotExercised: {
        severity: 'out-of-scope',
        observed: 'the browser realm recomputes the frozen shared contract and drives the real recovery planner over an observed read model; it renders no collaboration surface and claims none',
        carriedAs: 'task 42 owns the collaboration UI; the plan criterion "the UI lists each recipient real state" is satisfied by driving the product OWN read model (the frozen per-recipient view plus the product own planner output in F6), never by claiming a rendered component',
      },
      sameRepoIsExpressedAsSharedPromptAndAttachmentRoot: {
        severity: 'disclosure',
        observed: 'a SessionRef carries environmentId, harnessInstanceId and nativeSessionId (identity.js parseSessionRef) and no repository field, so "three harnesses reviewing the same repo" is expressed the only way the product can express it: ONE shared prompt and one shared /repo attachment root across three distinct harness sessions',
        assertedAs: 'asserted in H1 (sinkPrompts holds exactly the one prompt, every sink attachment path starts with /repo/, the three harness identities are distinct)',
      },
    },
    evidenceBoundary: 'The real landed bridge modules bridge/runtime/collaboration/fanoutService.js and fanoutRecovery.js run in the Node worker composed exactly as the product composes them, over the frozen shared/runtime/collaboration.js + identity.js contract. The ONLY case-owned seam is the service own declared deliver prompt port (fanoutService.js:173-177), backed by a counting, recording fake, so each recipient got its OWN attachment path, exactly one prompt per participant+session was ever sent, the typed source error is carried verbatim and an ambiguous recipient is never re-sent are OBSERVED at the sink boundary. The frozen shared contract (the ten-entry ERROR_CODES table, the CollaborationError shape, the explicit-at contract, the canonical native-session keys of the five harness kinds) and the REAL recovery planner planFanoutRetry (fanoutRecovery.js, pure ESM) also run in a real headless Chromium served by a case-owned Vite server, the planner over an OBSERVED read model the worker passes in, proving the contract is engine-independent and equal to the values the worker computes. The stateful service cannot cross into the browser realm at all (fanoutService.js:1 imports node:crypto), so its lifecycle is proven in the worker only and that split is stated rather than papered over. The plan criterion "the UI lists each recipient real state" is satisfied by driving the product OWN read model and the product own recovery planner, never by claiming a rendered component. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 42 owns the collaboration UI), claims NO durability across a real process death, and authors no PASS verdict.',
  };
}
