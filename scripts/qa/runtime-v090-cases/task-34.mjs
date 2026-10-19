// Task 34 registered QA case — the observable, recoverable cross-harness handoff.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge services bridge/runtime/threads/handoffService.js and
//     handoffRecovery.js, composed with task 31's REAL createThreadService (plus its
//     participantService) and task 33's REAL createCheckpointService. Nothing is stubbed: the
//     handoff service takes the two services as constructor arguments exactly as the product
//     declares, and the case-owned seams are the four the product's own signature declares as
//     injection points (openTarget / sendPrompt / cancelSource / isSourceBusy) — each one counts
//     and records its inputs, so "no second send", "binds the target's own session" and "no
//     migration was attempted" are OBSERVED, not argued. The A→B→A round trip backs its two
//     native sessions with REAL JSON files under the private root, read back with node:fs, so
//     "the native sessions are preserved" is a digest fact and not a prose claim.
//   * In a real headless Chromium: the pure shared contract modules (thread.js / identity.js /
//     capabilities.js) compute the canonical binding keys, parse the receiver-side binding,
//     normalize the ids and expose the frozen error-code table in a second JS realm, and the case
//     asserts the browser keys EQUAL the keys computed from the REAL handoff records the worker
//     drives. The handoff's identity layer must be engine-independent or "the same native session"
//     cannot hold across windows.
//
// The controlled boundaries are:
//   * the stateful handoff service cannot cross into the browser at all — handoffService.js:1
//     imports createHash/randomUUID from node:crypto — so its lifecycle (the ladder, the journal,
//     the sinks, the recovery table) is proven in the worker only, and that split is stated
//     rather than papered over;
//   * the harness session index (resolveSession) is the Thread service's own injected port: an
//     in-memory counting catalog for the ladder scenarios and REAL files under the private root
//     for the round-trip preservation proof;
//   * no browser shim is needed because thread.js -> capabilities.js -> identity.js is pure ESM
//     with no node:* builtin and no bare or aliased specifier.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// claims no UI rendering (task 35 owns the Thread/handoff UI), authors no PASS verdict, edits no
// product or test file, and performs no git operation.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, writeFile } from 'node:fs/promises';
import { readFile, stat } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-34-fixture.mjs';

import { createThreadService } from '../../../bridge/runtime/threads/threadService.js';
import { createCheckpointService } from '../../../bridge/runtime/threads/checkpointService.js';
import {
  HANDOFF_LADDER,
  HANDOFF_RESOLUTIONS,
  HANDOFF_STATES,
  MAX_HANDOFF_PROMPT_CHARS,
  HandoffError,
  createAckSink,
  createHostSink,
  createObserveSink,
  createHandoffService,
  projectHandoffState,
} from '../../../bridge/runtime/threads/handoffService.js';
import {
  classifyHandoffFailure,
  handoffRecoveryDecision,
  recoverHandoff,
  restoreOriginalSelection,
} from '../../../bridge/runtime/threads/handoffRecovery.js';
import {
  parseParticipantId,
  parseThreadId,
  threadBindingKey,
} from '../../../shared/runtime/thread.js';
import { ERROR_CODES, ProtocolError } from '../../../shared/runtime/capabilities.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;
const UUID = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;
const HEX64 = /^[a-f0-9]{64}$/;

// Canonical UUIDs (version-4 shape, lowercase) — the shared parsers lowercase, so these are canonical.
const ENV_A = '11111111-1111-4111-8111-111111111111';
const H_CODEX = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
const H_ACP = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
const H_KIMI = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
// An explicit carried checkpoint id: a KNOWN id is carried forward as the very same checkpoint,
// so the A→B→A round trip proves the context hash is preserved rather than rebuilt.
const CKPT = 'cccccccc-cccc-4ccc-8ccc-cccccccccccc';
const MISSING = '99999999-9999-4999-8999-999999999999';

const REPO = { environmentId: ENV_A, canonicalCommonDir: '/srv/repo', pathPolicy: { platform: 'posix', volumeId: 'vol-1', caseSensitive: true } };
const SESSION_CODEX = { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:codex-1' };
const SESSION_ACP = { environmentId: ENV_A, harnessInstanceId: H_ACP, nativeSessionId: 'native:acp-1' };
const SESSION_KIMI = { environmentId: ENV_A, harnessInstanceId: H_KIMI, nativeSessionId: 'native:kimi-1' };
const SESSION_CODEX_2 = { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:codex-2' };
const SESSION_ACP_2 = { environmentId: ENV_A, harnessInstanceId: H_ACP, nativeSessionId: 'native:acp-2' };

// Task 33's real bounded checkpoint: two admitted entries of the fixed classes.
const ENTRIES = Object.freeze([
  { class: 'goal', origin: { kind: 'host', commandId: 'handoff-qa' }, text: 'continue the runtime migration across harnesses' },
  { class: 'decision', origin: { kind: 'host', commandId: 'handoff-qa' }, text: 'keep each native session binding intact' },
]);
const PROMPT = 'continue the migration on the target harness';
const RETURN_PROMPT = 'return to codex';
// fingerprintOf({prompt}) = sha256 over the CANONICAL {prompt} object — derived, not assumed.
const PROMPT_FINGERPRINT = createHash('sha256').update(JSON.stringify({ prompt: PROMPT })).digest('hex');
const RETURN_PROMPT_FINGERPRINT = createHash('sha256').update(JSON.stringify({ prompt: RETURN_PROMPT })).digest('hex');
// The fixed native-session files the round trip must not disturb (content is written by the case).
const FILE_CODEX = { digest: 'e565aa0111b5018c548728285335371c99b615f0e6ab7caf7fc592a67a9c1a55', bytes: 235 };
const FILE_ACP = { digest: '23a3a4017ff82c312abfc3ad20f4833d518b190bfbfd597a6e79cb85495d7063', bytes: 231 };
// The fixed ladder timestamps, so every view's createdAt/updatedAt/deliveredAt/observedAt is pinned.
const AT = { begin: 1000, attach: 2000, prepare: 3000, deliver: 4000, observe: 5000 };

/**
 * The typed capture envelope. BOTH realms emit the SAME shape on EVERY path, success included
 * (the task-32/33 lesson): { code, field } with nulls on success. Every observed code is also
 * collected so the final check can prove every rejection code the product emitted belongs to the
 * frozen canonical ERROR_CODES table, in both realms.
 *
 * captureSync may ONLY wrap a callee that THROWS synchronously (the handoff service's
 * constructor validation, its sync accessors handoff/handoffs/ops/resolve/close, and the shared
 * id parsers). An `async function` — the ladder methods begin/attach/prepare/deliver/observe/
 * cancel — RETURNS A PROMISE and rejects instead of throwing, so a synchronous try/catch cannot
 * observe its rejection: use capture (which awaits) for those, or the error escapes as an
 * unhandled rejection and the worker dies.
 */
const observedCodes = new Set();
const captureSync = (run) => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
};
const capture = async (run) => {
  try { await run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && typeof error.code === 'string' && typeof error.field === 'string') {
      observedCodes.add(error.code);
      return { code: error.code, field: error.field };
    }
    return { code: 'not-a-ProtocolError', field: String(error) };
  }
};

/**
 * The case world: the REAL Thread service over an injected session index (the product's own
 * declared port) and the REAL Checkpoint service, with the handoff service's four declared
 * seams backed by counting, recording fakes. `openTarget` defaults to binding the target's OWN
 * native session, exactly as a correct driver must.
 */
function makeWorld({ sessions = [SESSION_CODEX, SESSION_ACP], sourceBusy, openTarget, sendPrompt, cancelSource, isSourceBusy } = {}) {
  const catalog = new Map(sessions.map((session) => [`${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`, { session, archived: false, parentSession: null }]));
  let resolutions = 0;
  const resolveSession = async (session) => {
    resolutions += 1;
    return catalog.get(`${session.environmentId}|${session.harnessInstanceId}|${session.nativeSessionId}`) ?? null;
  };
  const threads = createThreadService({ resolveSession });
  const counters = { openTarget: 0, sendPrompt: 0, cancelSource: 0 };
  const openCalls = [];
  const sendCalls = [];
  const cancelCalls = [];
  const busyProbeCalls = [];
  const busyProbe = isSourceBusy ?? ((input) => { busyProbeCalls.push(input); return sourceBusy === true; });
  const checkpoints = createCheckpointService();
  const service = createHandoffService({
    threads,
    checkpoints,
    openTarget: async (input) => {
      counters.openTarget += 1;
      openCalls.push(input);
      return openTarget ? openTarget(input) : { nativeSessionId: input.target.session.nativeSessionId };
    },
    sendPrompt: async (input) => {
      counters.sendPrompt += 1;
      sendCalls.push(input);
      return sendPrompt ? sendPrompt(input) : { ackId: `ack-${counters.sendPrompt}` };
    },
    cancelSource: async (input) => {
      counters.cancelSource += 1;
      cancelCalls.push(input);
      if (cancelSource) return cancelSource(input);
    },
    isSourceBusy: busyProbe,
  });
  return { threads, service, checkpoints, counters, openCalls, sendCalls, cancelCalls, busyProbeCalls, resolutions: () => resolutions, catalog };
}

/** Binds a thread with an owner plus every extra session, returning the owner's participant id. */
async function bindThread(world, ownerSession, extraSessions = []) {
  const thread = await world.threads.bind({ session: ownerSession, repo: REPO });
  const owner = thread.participants[0].participantId;
  const joined = [];
  for (const session of extraSessions) joined.push(await world.threads.join({ threadId: thread.threadId, session, repo: REPO }));
  return { thread, owner, joined };
}

/** Drives the full forward ladder with the fixed timestamps; returns every observed view.
 * `afterDeliver` runs BETWEEN deliver and observe, so a caller can snapshot live state at the
 * moment of observation: a value read after `observe` has run yields the MUTATED value (the
 * task-24/25 live-record lesson), which is exactly what made "revision after deliver" read 3. */
async function driveLadder(world, threadId, sourceId, targetId, { prompt = PROMPT, checkpointId, entries = ENTRIES, observeEvent = 'evt-acp-1', beginAt = AT.begin, afterDeliver } = {}) {
  const begun = await world.service.begin({ threadId: threadId, sourceParticipantId: sourceId, targetParticipantId: targetId, entries, ...(checkpointId === undefined ? {} : { checkpointId }), at: beginAt });
  const attached = await world.service.attach({ handoffId: begun.handoffId, at: AT.attach });
  const prepared = await world.service.prepare({ handoffId: begun.handoffId, prompt, at: AT.prepare });
  const delivered = await world.service.deliver({ handoffId: begun.handoffId, at: AT.deliver });
  const afterDeliverSnapshot = afterDeliver === undefined ? null : afterDeliver();
  const observed = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: observeEvent, at: AT.observe });
  return { begun, attached, prepared, delivered, observed, afterDeliverSnapshot };
}

/** A REAL file-backed native-session store: the round trip must leave both records byte-identical. */
function createNativeStore(dir) {
  const fileOf = (session) => path.join(dir, `${session.harnessInstanceId}__${session.nativeSessionId}.json`);
  return {
    dir,
    fileOf,
    async open() { await mkdir(dir, { recursive: true }); },
    async write(session) {
      await writeFile(fileOf(session), `${JSON.stringify({ session, transcript: `history for ${session.nativeSessionId}` }, null, 2)}\n`, 'utf8');
    },
    async resolve(session) {
      try {
        const record = JSON.parse(await readFile(fileOf(session), 'utf8'));
        return { session: record.session, archived: false, parentSession: null };
      } catch (error) {
        if (error.code === 'ENOENT') return null;
        throw error;
      }
    },
    async fingerprint(session) {
      return { digest: createHash('sha256').update(await readFile(fileOf(session))).digest('hex'), bytes: (await stat(fileOf(session))).size };
    },
  };
}

export const sourceFiles = [...new Set([
  // the two product paths this unit owns
  'bridge/runtime/threads/handoffService.js',
  'bridge/runtime/threads/handoffRecovery.js',
  // the task 31 / task 33 modules the product consumes, unchanged
  'bridge/runtime/threads/threadService.js', 'bridge/runtime/threads/threadService.d.ts',
  'bridge/runtime/threads/participantService.js', 'bridge/runtime/threads/participantService.d.ts',
  'bridge/runtime/threads/checkpointService.js',
  'shared/runtime/context.js', 'shared/runtime/context.d.ts',
  'app/runtime/handoff.test.ts',
  // the shared modules the product pulls in
  'shared/runtime/thread.js', 'shared/runtime/thread.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task34.ts',
  'scripts/qa/runtime-v090-cases/task-34.mjs',
  'scripts/qa/runtime-v090-cases/task-34-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 34 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task34Errors=[];window.addEventListener('error',(e)=>window.__task34Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task34Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task34.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-34/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { node: {}, browser: {} };
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
      surface: 'real landed bridge handoff service handoffService.js + handoffRecovery.js composed with the real Thread service and the real Checkpoint service in the Node worker over the four declared seams, plus the pure shared Thread/identity/capabilities contract in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-34.mjs',
    'scripts/qa/runtime-v090-cases/task-34-fixture.mjs',
    'app/dev/runtime-v090/task34.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the PURE shared identity contract (no shim: no node:* builtin)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa34', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa34/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task34 && window.task34.ready)), 'task34 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── C1: the fixed tables, the sink boundary and the state derivation ──
    const workerTables = {
      ladder: [...HANDOFF_LADDER],
      resolutions: [...HANDOFF_RESOLUTIONS],
      states: [...HANDOFF_STATES],
      maxPromptChars: MAX_HANDOFF_PROMPT_CHARS,
      ladderFrozen: Object.isFrozen(HANDOFF_LADDER),
      resolutionsFrozen: Object.isFrozen(HANDOFF_RESOLUTIONS),
      statesFrozen: Object.isFrozen(HANDOFF_STATES),
      ackSinkKeys: Object.keys(createAckSink({ delivery: {} })),
      observeSinkKeys: Object.keys(createObserveSink({ observation: {} })),
      hostSinkKeys: Object.keys(createHostSink({ host: {}, resolution: {} })),
      sinksFrozen: [Object.isFrozen(createAckSink({ delivery: {} })), Object.isFrozen(createObserveSink({ observation: {} })), Object.isFrozen(createHostSink({ host: {}, resolution: {} }))],
      // The structural guarantee: the ack sink has NO member that reaches observed/active, the
      // observe sink has NO member that reaches delivered, and the host sink has NEITHER.
      ackSinkHasNoObserve: typeof createAckSink({ delivery: {} }).observe === 'undefined',
      ackSinkHasNoHostMembers: ['checkpoint', 'attach', 'prepare', 'cancel', 'fail', 'reconcile'].every((key) => typeof createAckSink({ delivery: {} })[key] === 'undefined'),
      observeSinkHasNoDeliver: typeof createObserveSink({ observation: {} }).deliver === 'undefined',
      hostSinkHasNoNativeMembers: ['deliver', 'observe'].every((key) => typeof createHostSink({ host: {}, resolution: {} })[key] === 'undefined'),
      // projectHandoffState: the resolution wins first, `active` is DERIVED from observation
      // (the ladder's `observed` rung is never a projected state), and every other rung follows.
      projection: {
        checkpoint: projectHandoffState({ resolution: { value: null }, observation: { observed: false }, delivery: { delivered: false }, host: { preparedAt: null, attachedAt: null } }),
        attached: projectHandoffState({ resolution: { value: null }, observation: { observed: false }, delivery: { delivered: false }, host: { preparedAt: null, attachedAt: 5 } }),
        prepared: projectHandoffState({ resolution: { value: null }, observation: { observed: false }, delivery: { delivered: false }, host: { preparedAt: 5, attachedAt: 5 } }),
        delivered: projectHandoffState({ resolution: { value: null }, observation: { observed: false }, delivery: { delivered: true }, host: { preparedAt: 5, attachedAt: 5 } }),
        observedProjectsActive: projectHandoffState({ resolution: { value: null }, observation: { observed: true }, delivery: { delivered: true }, host: { preparedAt: 5, attachedAt: 5 } }),
        resolutionWinsOverObservation: projectHandoffState({ resolution: { value: { resolution: 'reconcile' } }, observation: { observed: true }, delivery: { delivered: true }, host: { preparedAt: 5, attachedAt: 5 } }),
        failedWins: projectHandoffState({ resolution: { value: { resolution: 'failed' } }, observation: { observed: false }, delivery: { delivered: false }, host: { preparedAt: null, attachedAt: null } }),
        cancelledWins: projectHandoffState({ resolution: { value: { resolution: 'cancelled' } }, observation: { observed: false }, delivery: { delivered: false }, host: { preparedAt: null, attachedAt: null } }),
      },
      // The sink-level idempotency: the second deliver/observe on the same slice is a detected
      // duplicate that re-runs nothing, and the slice keeps its FIRST writer.
      sinkIdempotency: (() => {
        const delivery = { delivered: false, deliveredAt: null, deliveredBy: null };
        const ack = createAckSink({ delivery });
        const ackFirst = ack.deliver({ ackId: 'ack-1', at: 7 });
        const ackSecond = ack.deliver({ ackId: 'ack-2', at: 8 });
        const observation = { observed: false, observedAt: null, observedBy: null };
        const observe = createObserveSink({ observation });
        const observeFirst = observe.observe({ nativeEventId: 'evt-1', at: 9 });
        const observeSecond = observe.observe({ nativeEventId: 'evt-2', at: 10 });
        return {
          ackFirst, ackSecond, deliveryAfter: { ...delivery },
          observeFirst, observeSecond, observationAfter: { ...observation },
        };
      })(),
    };
    const browserTables = await evaluate(() => window.task34.tables());
    protocol.browser.tables = browserTables;
    record('tables', { worker: workerTables, browser: browserTables });
    check('the fixed ladder/resolution/state tables, the 65536-char prompt ceiling and the three-sink boundary are the product\'s own: the ack sink exposes ONLY deliver, the observe sink ONLY observe and the host sink the six Host commands, each frozen, and projectHandoffState derives the resolution first, `active` only from a real observation (the `observed` rung is never projected) and every other rung from its own slice; the sink-level idempotency is observed as {applied,duplicate} per call with the first writer retained; the frozen ERROR_CODES table and the ProtocolError shape are identical in the browser realm and the bridge worker', {
      worker: workerTables,
      browser: browserTables,
      errorCodesEqual: JSON.stringify([...ERROR_CODES]) === JSON.stringify(browserTables.errorCodes),
    }, {
      worker: {
        ladder: ['checkpoint', 'attached', 'prepared', 'delivered', 'observed', 'active'],
        resolutions: ['reconcile', 'failed', 'cancelled'],
        states: ['checkpoint', 'attached', 'prepared', 'delivered', 'observed', 'active', 'reconcile', 'failed', 'cancelled'],
        maxPromptChars: 65536,
        ladderFrozen: true,
        resolutionsFrozen: true,
        statesFrozen: true,
        ackSinkKeys: ['deliver'],
        observeSinkKeys: ['observe'],
        hostSinkKeys: ['checkpoint', 'attach', 'prepare', 'cancel', 'fail', 'reconcile'],
        sinksFrozen: [true, true, true],
        ackSinkHasNoObserve: true,
        ackSinkHasNoHostMembers: true,
        observeSinkHasNoDeliver: true,
        hostSinkHasNoNativeMembers: true,
        projection: {
          checkpoint: 'checkpoint',
          attached: 'attached',
          prepared: 'prepared',
          delivered: 'delivered',
          observedProjectsActive: 'active',
          resolutionWinsOverObservation: 'reconcile',
          failedWins: 'failed',
          cancelledWins: 'cancelled',
        },
        sinkIdempotency: {
          ackFirst: { applied: true, duplicate: false },
          ackSecond: { applied: false, duplicate: true },
          deliveryAfter: { delivered: true, deliveredAt: 7, deliveredBy: 'ack-1' },
          observeFirst: { applied: true, duplicate: false },
          observeSecond: { applied: false, duplicate: true },
          observationAfter: { observed: true, observedAt: 9, observedBy: 'evt-1' },
        },
      },
      browser: {
        errorCodes: ['invalid_request', 'unsupported', 'version_mismatch', 'unauthorized', 'conflict', 'cancelled', 'timeout', 'source_unavailable', 'reconcile_required', 'replay_required'],
        errorCodeCount: 10,
        errorCodesFrozen: true,
        handoffCodesInTable: true,
        protocolErrorShape: { name: 'ProtocolError', code: 'conflict', field: 'handoff_state', message: 'conflict: handoff_state', isTypeError: true },
      },
      errorCodesEqual: true,
    });

    // ── C2: the canonical identity contract is engine-independent, and it ties to the REAL records ──
    const browserKeys = await evaluate(() => window.task34.bindingKeys());
    const browserDecodeCodex = await evaluate((key) => window.task34.decode(key), browserKeys.codex);
    const browserDecodeAcp = await evaluate((key) => window.task34.decode(key), browserKeys.acp);
    const browserBinding = await evaluate(() => window.task34.binding());
    const browserIdentity = await evaluate(() => window.task34.identity());
    protocol.browser.keys = browserKeys;
    protocol.browser.decode = { codex: browserDecodeCodex, acp: browserDecodeAcp };
    protocol.browser.binding = browserBinding;
    protocol.browser.identity = browserIdentity;
    record('crossRealmIdentity', { browserKeys, browserDecodeCodex, browserDecodeAcp, browserBinding, browserIdentity });
    check('the canonical native-session binding key, the key round trip, the receiver-side binding parse, the canonical id normalization and the id rejections are identical in the browser realm and the bridge worker, and the keys the browser computes are the keys the REAL handoff records carry: the same SessionRef provably resolves to the same wrapper in both realms', {
      browserKeys,
      browserKeyIsBase64Url: /^[\w-]+$/u.test(browserKeys.codex),
      codexKeyDiffersFromAcp: browserKeys.codex !== browserKeys.acp,
      codexKeyDiffersFromKimi: browserKeys.codex !== browserKeys.kimi,
      codexKeyStableForDuplicate: browserKeys.codex === browserKeys.codexDuplicate,
      sessionKeyEqualsBindingKey: browserKeys.codex === browserKeys.sessionKeyCodex && browserKeys.acp === browserKeys.sessionKeyAcp && browserKeys.kimi === browserKeys.sessionKeyKimi,
      browserDecodeCodex,
      browserDecodeAcp,
      browserBinding,
      browserIdentity,
      workerKeyCodex: threadBindingKey(SESSION_CODEX),
      workerKeyAcp: threadBindingKey(SESSION_ACP),
      workerKeyKimi: threadBindingKey(SESSION_KIMI),
      workerKeysMatchBrowser: threadBindingKey(SESSION_CODEX) === browserKeys.codex
        && threadBindingKey(SESSION_ACP) === browserKeys.acp
        && threadBindingKey(SESSION_KIMI) === browserKeys.kimi,
    }, {
      browserKeys: {
        codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
        acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
        kimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
        codexDuplicate: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
        sessionKeyCodex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
        sessionKeyAcp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
        sessionKeyKimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
      },
      browserKeyIsBase64Url: true,
      codexKeyDiffersFromAcp: true,
      codexKeyDiffersFromKimi: true,
      codexKeyStableForDuplicate: true,
      sessionKeyEqualsBindingKey: true,
      browserDecodeCodex: { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:codex-1' },
      browserDecodeAcp: { environmentId: ENV_A, harnessInstanceId: H_ACP, nativeSessionId: 'native:acp-1' },
      browserBinding: {
        role: 'participant',
        session: { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:codex-1' },
        nativeParent: { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:parent' },
        ownerNativeParent: null,
        sessionFrozen: true,
        bindingFrozen: true,
        malformed: { code: 'invalid_request', field: 'thread_binding' },
      },
      browserIdentity: {
        sessions: {
          codex: { environmentId: ENV_A, harnessInstanceId: H_CODEX, nativeSessionId: 'native:codex-1' },
          acp: { environmentId: ENV_A, harnessInstanceId: H_ACP, nativeSessionId: 'native:acp-1' },
          kimi: { environmentId: ENV_A, harnessInstanceId: H_KIMI, nativeSessionId: 'native:kimi-1' },
        },
        sessionsFrozen: [true, true, true],
        threadId: 'ab123456-1234-4123-8123-123456789abc',
        participantId: 'cd123456-1234-4123-8123-123456789abc',
        badThreadId: { code: 'invalid_request', field: 'thread_id' },
        badParticipantId: { code: 'invalid_request', field: 'participant_id' },
      },
      workerKeyCodex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
      workerKeyAcp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
      workerKeyKimi: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJjY2NjY2NjYy1jY2NjLTRjY2MtOGNjYy1jY2NjY2NjY2NjY2MiLCJuYXRpdmU6a2ltaS0xIl0',
      workerKeysMatchBrowser: true,
    });

    // ── C3: the constructor refuses every missing or ill-typed seam with its own code ──
    {
      const threads = createThreadService({ resolveSession: async () => null });
      const checkpoints = createCheckpointService();
      const ok = { openTarget: async () => ({}), sendPrompt: async () => ({}) };
      check('the handoff service constructor refuses every missing or ill-typed seam with its own explicit code: the threads service (activate/active/get), the checkpoints service (create/get), openTarget, sendPrompt, cancelSource when provided and the isSourceBusy probe when provided', {
        noThreads: captureSync(() => createHandoffService({ ...ok, checkpoints })),
        badThreads: captureSync(() => createHandoffService({ threads: {}, ...ok, checkpoints })),
        noCheckpoints: captureSync(() => createHandoffService({ threads, ...ok })),
        badCheckpoints: captureSync(() => createHandoffService({ threads, ...ok, checkpoints: {} })),
        noOpenTarget: captureSync(() => createHandoffService({ threads, checkpoints, sendPrompt: async () => ({}) })),
        noSend: captureSync(() => createHandoffService({ threads, checkpoints, openTarget: async () => ({}) })),
        badCancelSource: captureSync(() => createHandoffService({ threads, checkpoints, ...ok, cancelSource: 'nope' })),
        badBusyProbe: captureSync(() => createHandoffService({ threads, checkpoints, ...ok, isSourceBusy: 'nope' })),
      }, {
        noThreads: { code: 'invalid_request', field: 'handoff_threads' },
        badThreads: { code: 'invalid_request', field: 'handoff_threads' },
        noCheckpoints: { code: 'invalid_request', field: 'handoff_checkpoints' },
        badCheckpoints: { code: 'invalid_request', field: 'handoff_checkpoints' },
        noOpenTarget: { code: 'invalid_request', field: 'handoff_open_target' },
        noSend: { code: 'invalid_request', field: 'handoff_send' },
        badCancelSource: { code: 'invalid_request', field: 'handoff_cancel_source' },
        badBusyProbe: { code: 'invalid_request', field: 'handoff_source_busy_probe' },
      });
    }

    // ── C4: every rejection carries an explicit code and field; the ladder order is enforced ──
    {
      const world = makeWorld();
      const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
      const target = world.threads.get(thread.threadId).participants[1].participantId;
      const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
      const fresh = makeWorld();
      const freshThread = await bindThread(fresh, SESSION_CODEX, [SESSION_ACP]);
      const freshBegun = await fresh.service.begin({ threadId: freshThread.thread.threadId, sourceParticipantId: freshThread.owner, targetParticipantId: freshThread.joined[0].participantId, entries: ENTRIES, at: 1 });
      check('every rejection carries an explicit protocol code plus the plain rejection field, the ladder order is enforced as a conflict rather than a skip, an empty or illegal prompt and an illegal timestamp are refused, and after close every entry point is fenced', {
        unknownHandoff: await capture(() => world.service.handoff(MISSING)),
        unknownOps: await capture(() => world.service.ops(MISSING)),
        selfTarget: await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: owner, entries: ENTRIES })),
        unknownTarget: await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: MISSING, entries: ENTRIES })),
        unknownThread: await capture(() => world.service.begin({ threadId: MISSING, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES })),
        emptyEntries: await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: [] })),
        prepareBeforeAttach: await capture(() => world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT })),
        observeBeforeDeliver: await capture(() => world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-early' })),
        emptyPrompt: await capture(() => world.service.prepare({ handoffId: begun.handoffId, prompt: '' })),
        badAtZero: await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 0 })),
        badAtFraction: await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1.5 })),
        badHandoffId: await capture(() => world.service.handoff('not-a-uuid')),
        deliverBeforePrepare: await capture(() => fresh.service.deliver({ handoffId: freshBegun.handoffId })),
        attachThenPrepareThenDeliver: [
          (await world.service.attach({ handoffId: begun.handoffId, at: 2 })).state,
          (await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 3 })).state,
        ],
        // attach and begin are ASYNC methods (handoffService.js:427,507): after close their
        // assertOpen guard REJECTS the returned Promise instead of throwing, so they must be
        // captured through the async helper — a synchronous try/catch cannot observe a Promise
        // rejection and the HandoffError would escape as an unhandled rejection. handoff /
        // handoffs / ops are SYNC methods (handoffService.js:681,686,691) that throw
        // synchronously, so they keep the sync capture.
        afterClose: await (async () => {
          fresh.service.close();
          return {
            closed: fresh.service.state.closed,
            attach: await capture(() => fresh.service.attach({ handoffId: freshBegun.handoffId })),
            begin: await capture(() => fresh.service.begin({ threadId: freshThread.thread.threadId, sourceParticipantId: freshThread.owner, targetParticipantId: freshThread.joined[0].participantId, entries: ENTRIES })),
            handoff: captureSync(() => fresh.service.handoff(freshBegun.handoffId)),
            handoffs: captureSync(() => fresh.service.handoffs()),
            ops: captureSync(() => fresh.service.ops(freshBegun.handoffId)),
          };
        })(),
      }, {
        unknownHandoff: { code: 'invalid_request', field: 'handoff_unknown' },
        unknownOps: { code: 'invalid_request', field: 'handoff_unknown' },
        selfTarget: { code: 'invalid_request', field: 'handoff_target' },
        unknownTarget: { code: 'invalid_request', field: 'handoff_participant' },
        unknownThread: { code: 'invalid_request', field: 'thread_unknown' },
        emptyEntries: { code: 'invalid_request', field: 'handoff_entries' },
        prepareBeforeAttach: { code: 'conflict', field: 'handoff_state' },
        observeBeforeDeliver: { code: 'conflict', field: 'handoff_state' },
        emptyPrompt: { code: 'invalid_request', field: 'handoff_prompt' },
        badAtZero: { code: 'invalid_request', field: 'handoff_time' },
        badAtFraction: { code: 'invalid_request', field: 'handoff_time' },
        badHandoffId: { code: 'invalid_request', field: 'handoff_id' },
        deliverBeforePrepare: { code: 'conflict', field: 'handoff_state' },
        attachThenPrepareThenDeliver: ['attached', 'prepared'],
        afterClose: {
          closed: true,
          attach: { code: 'cancelled', field: 'handoff_closed' },
          begin: { code: 'cancelled', field: 'handoff_closed' },
          handoff: { code: 'cancelled', field: 'handoff_closed' },
          handoffs: { code: 'cancelled', field: 'handoff_closed' },
          ops: { code: 'cancelled', field: 'handoff_closed' },
        },
      });
    }

    // ── C5: the prompt ceiling — the exact 65536 chars are delivered verbatim, one more is refused ──
    {
      const atCeiling = 'q'.repeat(MAX_HANDOFF_PROMPT_CHARS);
      const overCeiling = 'q'.repeat(MAX_HANDOFF_PROMPT_CHARS + 1);
      const world = makeWorld();
      const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
      const target = world.threads.get(thread.threadId).participants[1].participantId;
      const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
      await world.service.attach({ handoffId: begun.handoffId, at: 2 });
      const prepared = await world.service.prepare({ handoffId: begun.handoffId, prompt: atCeiling, at: 3 });
      await world.service.deliver({ handoffId: begun.handoffId, at: 4 });
      const sent = world.sendCalls[0];
      const overRefusal = await capture(() => world.service.prepare({ handoffId: begun.handoffId, prompt: overCeiling, at: 5 }));
      check('the serialized prompt ceiling is a REAL boundary, not prose: a prompt of exactly 65536 characters is prepared, delivered and handed to the target VERBATIM (observed length 65536, byte-identical, with the prompt fingerprint equal to sha256 over the canonical {prompt} object), and 65537 characters is refused with invalid_request/handoff_prompt rather than truncated', {
        ceilingChars: atCeiling.length,
        preparedState: prepared.state,
        promptFingerprint: prepared.promptFingerprint,
        promptFingerprintIsSha256OfCanonicalPrompt: prepared.promptFingerprint === createHash('sha256').update(JSON.stringify({ prompt: atCeiling })).digest('hex'),
        sentPromptLength: sent.prompt.length,
        sentPromptIsVerbatim: sent.prompt === atCeiling,
        sentPromptFingerprint: sent.promptFingerprint,
        overCeilingChars: overCeiling.length,
        overRefusal,
        sends: world.service.handoff(begun.handoffId).sends,
      }, {
        ceilingChars: 65536,
        preparedState: 'prepared',
        promptFingerprint: createHash('sha256').update(JSON.stringify({ prompt: atCeiling })).digest('hex'),
        promptFingerprintIsSha256OfCanonicalPrompt: true,
        sentPromptLength: 65536,
        sentPromptIsVerbatim: true,
        sentPromptFingerprint: createHash('sha256').update(JSON.stringify({ prompt: atCeiling })).digest('hex'),
        overCeilingChars: 65537,
        overRefusal: { code: 'invalid_request', field: 'handoff_prompt' },
        sends: 1,
      });
    }
    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: an error after the send ack with no observation, restart mid-handoff, a
      // target auth failure, a busy source, an ambiguous send, a fingerprint-differing replay, a
      // failed open or send, and a carried context hash that may not be rewritten.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // ── F1: an error after the send ack, no observation — never successful, never retried ──
      {
        const world = makeWorld();
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
        await world.service.attach({ handoffId: begun.handoffId, at: 2 });
        await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 3 });
        await world.service.deliver({ handoffId: begun.handoffId, at: 4 });
        const afterAck = world.service.handoff(begun.handoffId);
        // An error AFTER the ack: a malformed observation attempt. No observation ever arrives.
        const emptyNativeEventId = await capture(() => world.service.observe({ handoffId: begun.handoffId, nativeEventId: '', at: 5 }));
        const missingNativeEventId = await capture(() => world.service.observe({ handoffId: begun.handoffId, at: 6 }));
        // No blind retry: the deliver replay re-runs nothing, a differing prepare is a conflict.
        const replayedDeliver = await world.service.deliver({ handoffId: begun.handoffId, at: 7 });
        const differingPrepare = await capture(() => world.service.prepare({ handoffId: begun.handoffId, prompt: 'a different prompt', at: 8 }));
        const sendsBeforeRecovery = world.service.handoff(begun.handoffId).sends;
        const sendCallsBeforeRecovery = world.counters.sendPrompt;
        const recovery = recoverHandoff({ service: world.service, threads: world.threads, handoffId: begun.handoffId });
        const resolved = world.service.handoff(begun.handoffId);
        check('an error after the send ack with NO observation arriving is neither marked successful nor blindly retried: the handoff sits at delivered with observed/active false and a null resolution, the malformed observation is refused with invalid_request/handoff_native_event_id, the deliver replay is a duplicate and a differing prepare a conflict, exactly one prompt was ever sent, and recovery fails CLOSED to reconcile (action reconcile, reason handoff_ack_without_observation, sendAttempted true) with the resolution reconcile_required/handoff_ambiguous — never a success marker — and the original participant selection restored', {
          afterAck: { state: afterAck.state, delivered: afterAck.delivered, observed: afterAck.observed, active: afterAck.active, sends: afterAck.sends, resolution: afterAck.resolution, deliveredBy: afterAck.deliveredBy, deliveredAt: afterAck.deliveredAt },
          emptyNativeEventId,
          missingNativeEventId,
          replayedDeliverState: replayedDeliver.state,
          differingPrepare,
          sendsBeforeRecovery,
          sendCallsBeforeRecovery,
          recovery: { action: recovery.action, reason: recovery.reason, state: recovery.state, restoredParticipantId: recovery.restoredParticipantId, sendAttempted: recovery.sendAttempted, observed: recovery.observed, handoffId: recovery.handoffId },
          stateAfterRecovery: resolved.state,
          resolutionAfterRecovery: resolved.resolution === null ? null : { resolution: resolved.resolution.resolution, code: resolved.resolution.code, field: resolved.resolution.field, reason: resolved.resolution.reason, atIsPositiveInteger: Number.isSafeInteger(resolved.resolution.at) && resolved.resolution.at > 0 },
          activeAfterRecovery: resolved.active,
          sendCallsAfterRecovery: world.counters.sendPrompt,
          threadActive: world.threads.active(thread.threadId)?.participantId,
          serviceState: { ...world.service.state },
          deliverOpOutcome: world.service.ops(begun.handoffId).find((op) => op.kind === 'deliver').outcome,
        }, {
          afterAck: { state: 'delivered', delivered: true, observed: false, active: false, sends: 1, resolution: null, deliveredBy: 'ack-1', deliveredAt: 4 },
          emptyNativeEventId: { code: 'invalid_request', field: 'handoff_native_event_id' },
          missingNativeEventId: { code: 'invalid_request', field: 'handoff_native_event_id' },
          replayedDeliverState: 'delivered',
          differingPrepare: { code: 'conflict', field: 'handoff_prompt' },
          sendsBeforeRecovery: 1,
          sendCallsBeforeRecovery: 1,
          recovery: { action: 'reconcile', reason: 'handoff_ack_without_observation', state: 'reconcile', restoredParticipantId: owner, sendAttempted: true, observed: false, handoffId: begun.handoffId },
          stateAfterRecovery: 'reconcile',
          resolutionAfterRecovery: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: 'handoff_ack_without_observation', atIsPositiveInteger: true },
          activeAfterRecovery: false,
          sendCallsAfterRecovery: 1,
          threadActive: owner,
          serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 1, sends: 1, reconciles: 1, failures: 0, closed: false },
          deliverOpOutcome: 'applied',
        });
      }

      // ── F2: a restart mid-handoff fails closed to reconcile and never duplicates the prompt ──
      {
        // (a) the process dies between prepare and deliver: nothing was ever sent.
        const gap = makeWorld();
        const gapBound = await bindThread(gap, SESSION_CODEX, [SESSION_ACP]);
        const gapTarget = gap.threads.get(gapBound.thread.threadId).participants[1].participantId;
        const gapBegun = await gap.service.begin({ threadId: gapBound.thread.threadId, sourceParticipantId: gapBound.owner, targetParticipantId: gapTarget, entries: ENTRIES, at: 1 });
        await gap.service.attach({ handoffId: gapBegun.handoffId, at: 2 });
        await gap.service.prepare({ handoffId: gapBegun.handoffId, prompt: PROMPT, at: 3 });
        const gapRecovery = recoverHandoff({ service: gap.service, threads: gap.threads, handoffId: gapBegun.handoffId });
        const gapView = gap.service.handoff(gapBegun.handoffId);
        // (b) the process dies after the native ack but before any observation.
        const ack = makeWorld();
        const ackBound = await bindThread(ack, SESSION_CODEX, [SESSION_ACP]);
        const ackTarget = ack.threads.get(ackBound.thread.threadId).participants[1].participantId;
        const ackBegun = await ack.service.begin({ threadId: ackBound.thread.threadId, sourceParticipantId: ackBound.owner, targetParticipantId: ackTarget, entries: ENTRIES, at: 1 });
        await ack.service.attach({ handoffId: ackBegun.handoffId, at: 2 });
        await ack.service.prepare({ handoffId: ackBegun.handoffId, prompt: PROMPT, at: 3 });
        await ack.service.deliver({ handoffId: ackBegun.handoffId, at: 4 });
        const ackRecovery = recoverHandoff({ service: ack.service, threads: ack.threads, handoffId: ackBegun.handoffId });
        const ackView = ack.service.handoff(ackBegun.handoffId);
        check('a restart mid-handoff fails CLOSED to reconcile and never duplicates the prompt: a restart between prepare and deliver (no send ever attempted) recovers as reconcile/handoff_interrupted_before_ack with sendAttempted false, zero sends and zero sendPrompt calls, and a restart after the native ack but before any observation recovers as reconcile/handoff_ack_without_observation with sendAttempted true while the prompt send count stays EXACTLY 1 — recovery itself never dispatches the prompt — both restoring the original participant selection and leaving the handoff not active', {
          gapRecovery: { action: gapRecovery.action, reason: gapRecovery.reason, state: gapRecovery.state, restoredParticipantId: gapRecovery.restoredParticipantId, sendAttempted: gapRecovery.sendAttempted, observed: gapRecovery.observed },
          gapState: gapView.state,
          gapResolution: { resolution: gapView.resolution.resolution, code: gapView.resolution.code, field: gapView.resolution.field, reason: gapView.resolution.reason, atIsPositiveInteger: Number.isSafeInteger(gapView.resolution.at) && gapView.resolution.at > 0 },
          gapActive: gapView.active,
          gapSends: gapView.sends,
          gapSendPromptCalls: gap.counters.sendPrompt,
          gapOps: gap.service.ops(gapBegun.handoffId).map((op) => op.kind),
          gapThreadActive: gap.threads.active(gapBound.thread.threadId)?.participantId,
          ackRecovery: { action: ackRecovery.action, reason: ackRecovery.reason, state: ackRecovery.state, restoredParticipantId: ackRecovery.restoredParticipantId, sendAttempted: ackRecovery.sendAttempted, observed: ackRecovery.observed },
          ackState: ackView.state,
          ackActive: ackView.active,
          ackSends: ackView.sends,
          ackSendPromptCalls: ack.counters.sendPrompt,
          ackThreadActive: ack.threads.active(ackBound.thread.threadId)?.participantId,
          gapServiceState: { ...gap.service.state },
          ackServiceState: { ...ack.service.state },
        }, {
          gapRecovery: { action: 'reconcile', reason: 'handoff_interrupted_before_ack', state: 'reconcile', restoredParticipantId: gapBound.owner, sendAttempted: false, observed: false },
          gapState: 'reconcile',
          gapResolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: 'handoff_interrupted_before_ack', atIsPositiveInteger: true },
          gapActive: false,
          gapSends: 0,
          gapSendPromptCalls: 0,
          gapOps: ['checkpoint', 'attach', 'prepare'],
          gapThreadActive: gapBound.owner,
          ackRecovery: { action: 'reconcile', reason: 'handoff_ack_without_observation', state: 'reconcile', restoredParticipantId: ackBound.owner, sendAttempted: true, observed: false },
          ackState: 'reconcile',
          ackActive: false,
          ackSends: 1,
          ackSendPromptCalls: 1,
          ackThreadActive: ackBound.owner,
          gapServiceState: { handoffs: 1, ops: 3, applied: 3, duplicates: 0, sends: 0, reconciles: 1, failures: 0, closed: false },
          ackServiceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
        });
      }

      // ── F3: the restart decision table over the REAL service at every reachable state ──
      {
        // attached → resumable
        const resumable = makeWorld();
        const resumableBound = await bindThread(resumable, SESSION_CODEX, [SESSION_ACP]);
        const resumableTarget = resumable.threads.get(resumableBound.thread.threadId).participants[1].participantId;
        const resumableBegun = await resumable.service.begin({ threadId: resumableBound.thread.threadId, sourceParticipantId: resumableBound.owner, targetParticipantId: resumableTarget, entries: ENTRIES, at: 1 });
        await resumable.service.attach({ handoffId: resumableBegun.handoffId, at: 2 });
        const resumableOutcome = recoverHandoff({ service: resumable.service, threads: resumable.threads, handoffId: resumableBegun.handoffId });
        const resumableView = resumable.service.handoff(resumableBegun.handoffId);
        // active → complete
        const complete = makeWorld();
        const completeBound = await bindThread(complete, SESSION_CODEX, [SESSION_ACP]);
        const completeTarget = complete.threads.get(completeBound.thread.threadId).participants[1].participantId;
        const completeBegun = await complete.service.begin({ threadId: completeBound.thread.threadId, sourceParticipantId: completeBound.owner, targetParticipantId: completeTarget, entries: ENTRIES, at: 1 });
        await complete.service.attach({ handoffId: completeBegun.handoffId, at: 2 });
        await complete.service.prepare({ handoffId: completeBegun.handoffId, prompt: PROMPT, at: 3 });
        await complete.service.deliver({ handoffId: completeBegun.handoffId, at: 4 });
        await complete.service.observe({ handoffId: completeBegun.handoffId, nativeEventId: 'evt-1', at: 5 });
        const completeOutcome = recoverHandoff({ service: complete.service, threads: complete.threads, handoffId: completeBegun.handoffId });
        // failed → rollback, idempotent
        const rollback = makeWorld({ sendPrompt: async () => { throw new ProtocolError('unauthorized', 'handoff_target_auth'); } });
        const rollbackBound = await bindThread(rollback, SESSION_CODEX, [SESSION_ACP]);
        const rollbackTarget = rollback.threads.get(rollbackBound.thread.threadId).participants[1].participantId;
        const rollbackBegun = await rollback.service.begin({ threadId: rollbackBound.thread.threadId, sourceParticipantId: rollbackBound.owner, targetParticipantId: rollbackTarget, entries: ENTRIES, at: 1 });
        await rollback.service.attach({ handoffId: rollbackBegun.handoffId, at: 2 });
        await rollback.service.prepare({ handoffId: rollbackBegun.handoffId, prompt: PROMPT, at: 3 });
        await capture(() => rollback.service.deliver({ handoffId: rollbackBegun.handoffId, at: 4 }));
        const rollbackFirst = recoverHandoff({ service: rollback.service, threads: rollback.threads, handoffId: rollbackBegun.handoffId });
        const revisionAfterFirst = rollback.threads.get(rollbackBound.thread.threadId).revision;
        const rollbackSecond = recoverHandoff({ service: rollback.service, threads: rollback.threads, handoffId: rollbackBegun.handoffId });
        const revisionAfterSecond = rollback.threads.get(rollbackBound.thread.threadId).revision;
        // cancelled → cancelled
        const cancelled = makeWorld();
        const cancelledBound = await bindThread(cancelled, SESSION_CODEX, [SESSION_ACP]);
        const cancelledTarget = cancelled.threads.get(cancelledBound.thread.threadId).participants[1].participantId;
        const cancelledBegun = await cancelled.service.begin({ threadId: cancelledBound.thread.threadId, sourceParticipantId: cancelledBound.owner, targetParticipantId: cancelledTarget, entries: ENTRIES, at: 1 });
        await cancelled.service.attach({ handoffId: cancelledBegun.handoffId, at: 2 });
        const cancelledView = await cancelled.service.cancel({ handoffId: cancelledBegun.handoffId, reason: 'user cancelled', at: 3 });
        const cancelledOutcome = recoverHandoff({ service: cancelled.service, threads: cancelled.threads, handoffId: cancelledBegun.handoffId });
        check('the restart decision table answers what a recovering process may do — and the answer is never resend: an attached handoff is resumable/handoff_not_sent with nothing resolved and no send, an active handoff is complete/handoff_observed with the selection left on the observed target (restoredParticipantId null), a failed handoff rolls back to the original selection idempotently (a second rollback bumps neither the revision nor the send count), and a cancelled handoff reports cancelled with its reason — every non-complete decision returning the thread to the ORIGINAL participant selection', {
          resumable: { action: resumableOutcome.action, reason: resumableOutcome.reason, state: resumableOutcome.state, restoredParticipantId: resumableOutcome.restoredParticipantId, sendAttempted: resumableOutcome.sendAttempted, observed: resumableOutcome.observed, viewState: resumableView.state, resolution: resumableView.resolution, sendCalls: resumable.counters.sendPrompt, ops: resumable.service.ops(resumableBegun.handoffId).map((op) => op.kind), threadActive: resumable.threads.active(resumableBound.thread.threadId)?.participantId },
          complete: { action: completeOutcome.action, reason: completeOutcome.reason, state: completeOutcome.state, restoredParticipantId: completeOutcome.restoredParticipantId, observed: completeOutcome.observed, viewState: complete.service.handoff(completeBegun.handoffId).state, threadActive: complete.threads.active(completeBound.thread.threadId)?.participantId, targetId: completeTarget },
          rollback: { firstAction: rollbackFirst.action, firstReason: rollbackFirst.reason, firstState: rollbackFirst.state, restoredParticipantId: rollbackFirst.restoredParticipantId, sendAttempted: rollbackFirst.sendAttempted, revisionAfterFirst, secondAction: rollbackSecond.action, revisionAfterSecond, idempotentNoRevisionBump: revisionAfterFirst === revisionAfterSecond, viewState: rollback.service.handoff(rollbackBegun.handoffId).state, viewResolution: { resolution: rollback.service.handoff(rollbackBegun.handoffId).resolution.resolution, code: rollback.service.handoff(rollbackBegun.handoffId).resolution.code, field: rollback.service.handoff(rollbackBegun.handoffId).resolution.field }, sendCalls: rollback.counters.sendPrompt, threadActive: rollback.threads.active(rollbackBound.thread.threadId)?.participantId },
          cancelled: { cancelState: cancelledView.state, cancelResolution: { resolution: cancelledView.resolution.resolution, code: cancelledView.resolution.code, field: cancelledView.resolution.field, reason: cancelledView.resolution.reason }, action: cancelledOutcome.action, reason: cancelledOutcome.reason, state: cancelledOutcome.state, restoredParticipantId: cancelledOutcome.restoredParticipantId, sendAttempted: cancelledOutcome.sendAttempted, sendCalls: cancelled.counters.sendPrompt, threadActive: cancelled.threads.active(cancelledBound.thread.threadId)?.participantId },
        }, {
          resumable: { action: 'resumable', reason: 'handoff_not_sent', state: 'attached', restoredParticipantId: resumableBound.owner, sendAttempted: false, observed: false, viewState: 'attached', resolution: null, sendCalls: 0, ops: ['checkpoint', 'attach'], threadActive: resumableBound.owner },
          complete: { action: 'complete', reason: 'handoff_observed', state: 'active', restoredParticipantId: null, observed: true, viewState: 'active', threadActive: completeTarget, targetId: completeTarget },
          rollback: { firstAction: 'rollback', firstReason: null, firstState: 'failed', restoredParticipantId: rollbackBound.owner, sendAttempted: true, revisionAfterFirst: 2, secondAction: 'rollback', revisionAfterSecond: 2, idempotentNoRevisionBump: true, viewState: 'failed', viewResolution: { resolution: 'failed', code: 'unauthorized', field: 'handoff_target_auth' }, sendCalls: 1, threadActive: rollbackBound.owner },
          cancelled: { cancelState: 'cancelled', cancelResolution: { resolution: 'cancelled', code: 'cancelled', field: 'handoff_cancelled', reason: 'user cancelled' }, action: 'cancelled', reason: 'user cancelled', state: 'cancelled', restoredParticipantId: cancelledBound.owner, sendAttempted: false, sendCalls: 0, threadActive: cancelledBound.owner },
        });
      }

      // ── F4: the decision table over the pure policy, including the disclosed crash branch ──
      {
        const pure = {
          active: handoffRecoveryDecision({ record: { state: 'active', resolution: null, observed: true }, ops: [{ kind: 'deliver' }] }),
          cancelled: handoffRecoveryDecision({ record: { state: 'cancelled', resolution: { resolution: 'cancelled', reason: null } }, ops: [] }),
          cancelledWithReason: handoffRecoveryDecision({ record: { state: 'cancelled', resolution: { resolution: 'cancelled', reason: 'user cancelled' } }, ops: [] }),
          failed: handoffRecoveryDecision({ record: { state: 'failed', resolution: { resolution: 'failed', reason: null, code: 'unauthorized', field: 'handoff_target_auth' } }, ops: [{ kind: 'deliver' }] }),
          reconcile: handoffRecoveryDecision({ record: { state: 'reconcile', resolution: { resolution: 'reconcile', reason: null } }, ops: [{ kind: 'deliver' }] }),
          reconcileWithReason: handoffRecoveryDecision({ record: { state: 'reconcile', resolution: { resolution: 'reconcile', reason: 'handoff_ack_without_observation' } }, ops: [{ kind: 'deliver' }] }),
          preparedNoDeliverOp: handoffRecoveryDecision({ record: { state: 'prepared', resolution: null }, ops: [{ kind: 'checkpoint' }, { kind: 'attach' }, { kind: 'prepare' }] }),
          // The DISCLOSED branch: a crash between the committed send intent and any ack leaves a
          // prepared record WITH a journaled deliver op. The single-writer durable store is not
          // wired in this build, so this exact shape is unreachable in-process; the policy is
          // driven directly instead, and it fails closed.
          preparedWithDeliverOp: handoffRecoveryDecision({ record: { state: 'prepared', resolution: null, observed: false }, ops: [{ kind: 'checkpoint' }, { kind: 'attach' }, { kind: 'prepare' }, { kind: 'deliver', outcome: 'pending' }] }),
          delivered: handoffRecoveryDecision({ record: { state: 'delivered', resolution: null, observed: false }, ops: [{ kind: 'deliver' }] }),
          attached: handoffRecoveryDecision({ record: { state: 'attached', resolution: null }, ops: [{ kind: 'checkpoint' }, { kind: 'attach' }] }),
          checkpoint: handoffRecoveryDecision({ record: { state: 'checkpoint', resolution: null }, ops: [{ kind: 'checkpoint' }] }),
        };
        const classify = {
          typed: classifyHandoffFailure(new ProtocolError('unauthorized', 'target_auth'), { code: 'source_unavailable', field: 'handoff_send' }),
          plainError: classifyHandoffFailure(new Error('socket hung up'), { code: 'source_unavailable', field: 'handoff_send' }),
          string: classifyHandoffFailure('boom', { code: 'source_unavailable', field: 'handoff_send' }),
          undefinedError: classifyHandoffFailure(undefined, { code: 'source_unavailable', field: 'handoff_send' }),
          frozen: Object.isFrozen(classifyHandoffFailure(new Error('x'), { code: 'c', field: 'f' })),
        };
        // restoreOriginalSelection driven on a real thread after a COMPLETED handoff: the rollback
        // moves the selection back and a repeated rollback neither moves it nor bumps the revision.
        const restore = makeWorld();
        const restoreBound = await bindThread(restore, SESSION_CODEX, [SESSION_ACP]);
        const restoreTarget = restore.threads.get(restoreBound.thread.threadId).participants[1].participantId;
        const restoreBegun = await restore.service.begin({ threadId: restoreBound.thread.threadId, sourceParticipantId: restoreBound.owner, targetParticipantId: restoreTarget, entries: ENTRIES, at: 1 });
        await restore.service.attach({ handoffId: restoreBegun.handoffId, at: 2 });
        await restore.service.prepare({ handoffId: restoreBegun.handoffId, prompt: PROMPT, at: 3 });
        await restore.service.deliver({ handoffId: restoreBegun.handoffId, at: 4 });
        await restore.service.observe({ handoffId: restoreBegun.handoffId, nativeEventId: 'evt-1', at: 5 });
        const revisionAfterObserve = restore.threads.get(restoreBound.thread.threadId).revision;
        const restoredFirst = restoreOriginalSelection({ threads: restore.threads, threadId: restoreBound.thread.threadId, participantId: restoreBound.owner });
        const revisionAfterFirst = restore.threads.get(restoreBound.thread.threadId).revision;
        const restoredSecond = restoreOriginalSelection({ threads: restore.threads, threadId: restoreBound.thread.threadId, participantId: restoreBound.owner });
        const revisionAfterSecond = restore.threads.get(restoreBound.thread.threadId).revision;
        check('the restart decision table is a total function over every state a handoff read model can report, and it never answers resend: active→complete/handoff_observed, cancelled→cancelled (the resolution reason, else handoff_cancelled), failed→rollback, reconcile→reconcile (the reason, else handoff_already_reconciling), prepared→reconcile/handoff_interrupted_before_ack, delivered→reconcile/handoff_ack_without_observation, checkpoint/attached→resumable/handoff_not_sent — with sendAttempted true exactly when a deliver op exists, including the disclosed prepared-WITH-deliver-op crash shape, which also fails closed to reconcile; the failure classifier passes a typed protocol error through untouched and wraps a plain Error, a string and undefined into the caller fallback so no failure is ever a bare throw; restoreOriginalSelection returns the frozen {participantId, session, revision} of the ORIGINAL participant and is safe to run twice (the selection moves back once, revision 3→4, and the second rollback leaves it at 4); and the canonical id parses lowercase and reject a non-UUID with their own field', {
          pure,
          classify,
          restoreOriginalSelection: {
            keys: Object.keys(restoredFirst),
            participantId: restoredFirst.participantId,
            session: { ...restoredFirst.session },
            revision: restoredFirst.revision,
            secondMatchesFirst: JSON.stringify(restoredSecond) === JSON.stringify(restoredFirst),
            frozen: Object.isFrozen(restoredFirst),
            revisionAfterObserve,
            revisionAfterFirst,
            revisionAfterSecond,
            idempotentNoRevisionBump: revisionAfterFirst === revisionAfterSecond,
            restoredMovesSelectionBack: revisionAfterFirst === revisionAfterObserve + 1,
            activeIsSource: restore.threads.active(restoreBound.thread.threadId)?.participantId === restoreBound.owner,
          },
          idParses: {
            threadIdUpper: parseThreadId('AB123456-1234-4123-8123-123456789ABC'),
            participantIdUpper: parseParticipantId('CD123456-1234-4123-8123-123456789ABC'),
            badThreadId: captureSync(() => parseThreadId('nope')),
            badParticipantId: captureSync(() => parseParticipantId('nope')),
          },
          everyActionIsNeverResend: Object.values(pure).every((decision) => decision.action !== 'resend' && ['complete', 'cancelled', 'rollback', 'reconcile', 'resumable'].includes(decision.action)),
          everyReconcileOrRollbackHasAReasonOrNull: Object.values(pure).every((decision) => decision.reason === null || typeof decision.reason === 'string'),
          allDecisionsFrozen: Object.values(pure).every((decision) => Object.isFrozen(decision)),
        }, {
          pure: {
            active: { action: 'complete', reason: 'handoff_observed', sendAttempted: true },
            cancelled: { action: 'cancelled', reason: 'handoff_cancelled', sendAttempted: false },
            cancelledWithReason: { action: 'cancelled', reason: 'user cancelled', sendAttempted: false },
            failed: { action: 'rollback', reason: null, sendAttempted: true },
            reconcile: { action: 'reconcile', reason: 'handoff_already_reconciling', sendAttempted: true },
            reconcileWithReason: { action: 'reconcile', reason: 'handoff_ack_without_observation', sendAttempted: true },
            preparedNoDeliverOp: { action: 'reconcile', reason: 'handoff_interrupted_before_ack', sendAttempted: false },
            preparedWithDeliverOp: { action: 'reconcile', reason: 'handoff_interrupted_before_ack', sendAttempted: true },
            delivered: { action: 'reconcile', reason: 'handoff_ack_without_observation', sendAttempted: true },
            attached: { action: 'resumable', reason: 'handoff_not_sent', sendAttempted: false },
            checkpoint: { action: 'resumable', reason: 'handoff_not_sent', sendAttempted: false },
          },
          classify: {
            typed: { code: 'unauthorized', field: 'target_auth', typed: true },
            plainError: { code: 'source_unavailable', field: 'handoff_send', typed: false },
            string: { code: 'source_unavailable', field: 'handoff_send', typed: false },
            undefinedError: { code: 'source_unavailable', field: 'handoff_send', typed: false },
            frozen: true,
          },
          restoreOriginalSelection: {
            keys: ['participantId', 'session', 'revision'],
            participantId: restoreBound.owner,
            session: SESSION_CODEX,
            revision: 4,
            secondMatchesFirst: true,
            frozen: true,
            revisionAfterObserve: 3,
            revisionAfterFirst: 4,
            revisionAfterSecond: 4,
            idempotentNoRevisionBump: true,
            restoredMovesSelectionBack: true,
            activeIsSource: true,
          },
          idParses: {
            threadIdUpper: 'ab123456-1234-4123-8123-123456789abc',
            participantIdUpper: 'cd123456-1234-4123-8123-123456789abc',
            badThreadId: { code: 'invalid_request', field: 'thread_id' },
            badParticipantId: { code: 'invalid_request', field: 'participant_id' },
          },
          everyActionIsNeverResend: true,
          everyReconcileOrRollbackHasAReasonOrNull: true,
          allDecisionsFrozen: true,
        });
      }

      // ── F5: a target auth failure marks the handoff failed and restores the original selection ──
      {
        const typed = makeWorld({ openTarget: async () => { throw new ProtocolError('unauthorized', 'handoff_target_auth'); } });
        const typedBound = await bindThread(typed, SESSION_CODEX, [SESSION_ACP]);
        const typedTarget = typed.threads.get(typedBound.thread.threadId).participants[1].participantId;
        const typedBegun = await typed.service.begin({ threadId: typedBound.thread.threadId, sourceParticipantId: typedBound.owner, targetParticipantId: typedTarget, entries: ENTRIES, at: 1 });
        const typedRejection = await capture(() => typed.service.attach({ handoffId: typedBegun.handoffId, at: 2 }));
        const typedView = typed.service.handoff(typedBegun.handoffId);
        const typedReplay = await capture(() => typed.service.attach({ handoffId: typedBegun.handoffId, at: 3 }));
        const plain = makeWorld({ openTarget: async () => { throw new Error('socket hung up'); } });
        const plainBound = await bindThread(plain, SESSION_CODEX, [SESSION_ACP]);
        const plainTarget = plain.threads.get(plainBound.thread.threadId).participants[1].participantId;
        const plainBegun = await plain.service.begin({ threadId: plainBound.thread.threadId, sourceParticipantId: plainBound.owner, targetParticipantId: plainTarget, entries: ENTRIES, at: 1 });
        const plainRejection = await capture(() => plain.service.attach({ handoffId: plainBegun.handoffId, at: 2 }));
        // The thrown identity itself: a typed failure re-throws the ORIGINAL ProtocolError, an
        // untyped one is wrapped in a HandoffError (a ProtocolError subclass) with the fallback.
        const thrown = async (behavior) => {
          const world = makeWorld({ openTarget: behavior });
          const bound = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
          const target = world.threads.get(bound.thread.threadId).participants[1].participantId;
          const begun = await world.service.begin({ threadId: bound.thread.threadId, sourceParticipantId: bound.owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
          try { await world.service.attach({ handoffId: begun.handoffId, at: 2 }); return { threw: false }; }
          catch (error) {
            return {
              threw: true, name: error.name,
              isHandoffError: error instanceof HandoffError,
              isProtocolError: error instanceof ProtocolError,
              code: error.code, field: error.field,
            };
          }
        };
        const typedThrow = await thrown(async () => { throw new ProtocolError('unauthorized', 'handoff_target_auth'); });
        const plainThrow = await thrown(async () => { throw new Error('socket hung up'); });
        check('a target auth failure is marked failed with the ORIGINAL typed code and field — a typed ProtocolError passes through the classifier untouched (unauthorized/handoff_target_auth) while a bare driver error is wrapped into the declared fallback (source_unavailable/handoff_target_open) — the attach op records outcome failed with that code and field, no prompt was ever prepared or sent, the thread and both participants survive, the original participant selection is RESTORED, and a replay of the failed attach is a conflict rather than a second attempt', {
          typedRejection,
          typedState: typedView.state,
          typedResolution: { resolution: typedView.resolution.resolution, code: typedView.resolution.code, field: typedView.resolution.field, reason: typedView.resolution.reason, at: typedView.resolution.at },
          typedActive: typedView.active,
          typedObserved: typedView.observed,
          typedSends: typedView.sends,
          typedPromptFingerprint: typedView.promptFingerprint,
          typedOps: typed.service.ops(typedBegun.handoffId).map((op) => ({ kind: op.kind, outcome: op.outcome, code: op.code, field: op.field, applied: op.applied, duplicate: op.duplicate })),
          typedThreadActive: typed.threads.active(typedBound.thread.threadId)?.participantId,
          typedParticipants: typed.threads.get(typedBound.thread.threadId).participants.length,
          typedSendCalls: typed.counters.sendPrompt,
          typedReplay,
          typedServiceState: { ...typed.service.state },
          plainRejection,
          plainState: plain.service.handoff(plainBegun.handoffId).state,
          plainResolution: { resolution: plain.service.handoff(plainBegun.handoffId).resolution.resolution, code: plain.service.handoff(plainBegun.handoffId).resolution.code, field: plain.service.handoff(plainBegun.handoffId).resolution.field },
          plainThreadActive: plain.threads.active(plainBound.thread.threadId)?.participantId,
          typedThrow,
          plainThrow,
        }, {
          typedRejection: { code: 'unauthorized', field: 'handoff_target_auth' },
          typedState: 'failed',
          typedResolution: { resolution: 'failed', code: 'unauthorized', field: 'handoff_target_auth', reason: null, at: 2 },
          typedActive: false,
          typedObserved: false,
          typedSends: 0,
          typedPromptFingerprint: null,
          typedOps: [
            { kind: 'checkpoint', outcome: 'applied', code: null, field: null, applied: true, duplicate: false },
            { kind: 'attach', outcome: 'failed', code: 'unauthorized', field: 'handoff_target_auth', applied: true, duplicate: false },
          ],
          typedThreadActive: typedBound.owner,
          typedParticipants: 2,
          typedSendCalls: 0,
          typedReplay: { code: 'conflict', field: 'handoff_state' },
          typedServiceState: { handoffs: 1, ops: 2, applied: 2, duplicates: 0, sends: 0, reconciles: 0, failures: 1, closed: false },
          plainRejection: { code: 'source_unavailable', field: 'handoff_target_open' },
          plainState: 'failed',
          plainResolution: { resolution: 'failed', code: 'source_unavailable', field: 'handoff_target_open' },
          plainThreadActive: plainBound.owner,
          typedThrow: { threw: true, name: 'ProtocolError', isHandoffError: false, isProtocolError: true, code: 'unauthorized', field: 'handoff_target_auth' },
          plainThrow: { threw: true, name: 'HandoffError', isHandoffError: true, isProtocolError: true, code: 'source_unavailable', field: 'handoff_target_open' },
        });
      }

      // ── F6: a busy source never auto-migrates without an explicit cancel ──
      {
        const world = makeWorld({ sourceBusy: true });
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const probeCallsBefore = world.busyProbeCalls.length;
        const refusal = await capture(() => world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 }));
        const afterRefusal = {
          handoffs: world.service.state.handoffs,
          ops: world.service.state.ops,
          applied: world.service.state.applied,
          openTargetCalls: world.counters.openTarget,
          sendPromptCalls: world.counters.sendPrompt,
          cancelSourceCalls: world.counters.cancelSource,
          handoffListLength: world.service.handoffs().length,
          threadActive: world.threads.active(thread.threadId)?.participantId,
          participants: world.threads.get(thread.threadId).participants.length,
          probeCalls: world.busyProbeCalls.length,
          probeInput: world.busyProbeCalls[0],
        };
        // With an explicit cancel the source is cancelled FIRST, then the handoff may proceed.
        const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, cancel: true, at: 2 });
        await world.service.attach({ handoffId: begun.handoffId, at: 3 });
        await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 4 });
        await world.service.deliver({ handoffId: begun.handoffId, at: 5 });
        const done = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-after-cancel', at: 6 });
        const threads = createThreadService({ resolveSession: async () => null });
        const checkpoints = createCheckpointService();
        const ok = { openTarget: async () => ({}), sendPrompt: async () => ({}) };
        check('a busy source NEVER auto-migrates without an explicit cancel: the isSourceBusy probe is consulted with {threadId, participantId} and a busy source refuses begin with conflict/handoff_source_busy BEFORE anything is created — zero handoffs, zero ops, zero applied, zero openTarget, zero sendPrompt, zero cancelSource, an empty handoff list, the thread selection and both participants untouched — and only an explicit cancel:true cancels the source first (exactly one cancelSource call carrying the source identity) and then completes the full ladder onto the target; the constructor separately refuses a probe or a cancel source that is not a function', {
          refusal,
          probeCallsBefore,
          afterRefusal,
          afterCancel: { beginState: begun.state, cancelSourceCalls: world.counters.cancelSource, cancelInput: world.cancelCalls[0], finalState: done.state, threadActive: world.threads.active(thread.threadId)?.participantId, targetId: target },
          busyNotAFunction: captureSync(() => createHandoffService({ threads, checkpoints, ...ok, isSourceBusy: 'nope' })),
          cancelNotAFunction: captureSync(() => createHandoffService({ threads, checkpoints, ...ok, cancelSource: 42 })),
        }, {
          refusal: { code: 'conflict', field: 'handoff_source_busy' },
          probeCallsBefore: 0,
          afterRefusal: {
            handoffs: 0, ops: 0, applied: 0,
            openTargetCalls: 0, sendPromptCalls: 0, cancelSourceCalls: 0,
            handoffListLength: 0,
            threadActive: owner,
            participants: 2,
            probeCalls: 1,
            probeInput: { threadId: thread.threadId, participantId: owner },
          },
          afterCancel: { beginState: 'checkpoint', cancelSourceCalls: 1, cancelInput: { threadId: thread.threadId, participantId: owner }, finalState: 'active', threadActive: target, targetId: target },
          busyNotAFunction: { code: 'invalid_request', field: 'handoff_source_busy_probe' },
          cancelNotAFunction: { code: 'invalid_request', field: 'handoff_cancel_source' },
        });
      }

      // ── F7: an ambiguous send stops at reconcile — never retried, never marked successful ──
      {
        const variants = [{ ambiguous: true }, undefined, null, { ackId: '' }, { ackId: 42 }, 'ack-1'];
        const results = [];
        for (const variant of variants) {
          const world = makeWorld({ sendPrompt: async () => variant });
          const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
          const target = world.threads.get(thread.threadId).participants[1].participantId;
          const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
          await world.service.attach({ handoffId: begun.handoffId, at: 2 });
          await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 3 });
          const rejection = await capture(() => world.service.deliver({ handoffId: begun.handoffId, at: 4 }));
          const view = world.service.handoff(begun.handoffId);
          const observeAfter = await capture(() => world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-late', at: 5 }));
          const deliverAfter = await capture(() => world.service.deliver({ handoffId: begun.handoffId, at: 6 }));
          const deliverOp = world.service.ops(begun.handoffId).find((op) => op.kind === 'deliver');
          results.push({
            variant: variant === undefined ? 'undefined' : JSON.stringify(variant),
            rejection,
            state: view.state,
            active: view.active,
            observed: view.observed,
            delivered: view.delivered,
            sends: view.sends,
            resolution: { resolution: view.resolution.resolution, code: view.resolution.code, field: view.resolution.field, reason: view.resolution.reason, at: view.resolution.at },
            observeAfter,
            deliverAfter,
            sendPromptCalls: world.counters.sendPrompt,
            threadActiveIsSource: world.threads.active(thread.threadId)?.participantId === owner,
            deliverOp: { outcome: deliverOp.outcome, code: deliverOp.code, field: deliverOp.field, applied: deliverOp.applied, duplicate: deliverOp.duplicate },
            serviceState: { ...world.service.state },
          });
        }
        check('an ambiguous send stops at reconcile and is never retried or marked successful: an unreadable send outcome — an object with no ackId, undefined, null, an empty ackId, a non-string ackId and a bare string are each OBSERVED — throws reconcile_required/handoff_ambiguous, the handoff reports the RESOLUTION state reconcile (never a forward rung, never active, never observed, and the delivery slice was never written), the resolution is reconcile/reconcile_required/handoff_ambiguous, exactly ONE prompt was attempted, the original selection is restored, the deliver op records outcome reconcile, and both a late observation and a re-delivery are refused with conflict/handoff_state so nothing is retried', {
          variants: results,
          everyStoppedAtReconcile: results.every((entry) => entry.state === 'reconcile' && HANDOFF_RESOLUTIONS.includes(entry.state) && !HANDOFF_LADDER.includes(entry.state)),
          everySendCountOne: results.every((entry) => entry.sendPromptCalls === 1 && entry.sends === 1),
          everyRefusedAfterwards: results.every((entry) => entry.observeAfter.code === 'conflict' && entry.deliverAfter.code === 'conflict'),
          variantCount: results.length,
        }, {
          variants: [
            {
              variant: '{"ambiguous":true}',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
            {
              variant: 'undefined',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
            {
              variant: 'null',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
            {
              variant: '{"ackId":""}',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
            {
              variant: '{"ackId":42}',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
            {
              variant: '"ack-1"',
              rejection: { code: 'reconcile_required', field: 'handoff_ambiguous' },
              state: 'reconcile', active: false, observed: false, delivered: false, sends: 1,
              resolution: { resolution: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', reason: null, at: 4 },
              observeAfter: { code: 'conflict', field: 'handoff_state' },
              deliverAfter: { code: 'conflict', field: 'handoff_state' },
              sendPromptCalls: 1,
              threadActiveIsSource: true,
              deliverOp: { outcome: 'reconcile', code: 'reconcile_required', field: 'handoff_ambiguous', applied: true, duplicate: false },
              serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 1, failures: 0, closed: false },
            },
          ],
          everyStoppedAtReconcile: true,
          everySendCountOne: true,
          everyRefusedAfterwards: true,
          variantCount: 6,
        });
      }

      // ── F8: a fingerprint-differing replay is a conflict, never a silent second execution ──
      {
        const world = makeWorld();
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
        await world.service.attach({ handoffId: begun.handoffId, at: 2 });
        await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 3 });
        const appliedBefore = world.service.state.applied;
        const differingPrompt = await capture(() => world.service.prepare({ handoffId: begun.handoffId, prompt: 'a different prompt', at: 4 }));
        const appliedAfterDifferingPrompt = world.service.state.applied;
        const differingIdentityReopen = await capture(() => world.service.begin({ handoffId: begun.handoffId, threadId: thread.threadId, sourceParticipantId: target, targetParticipantId: owner, entries: ENTRIES, at: 5 }));
        const appliedAfterDifferingIdentity = world.service.state.applied;
        const failed = makeWorld({ sendPrompt: async () => { throw new ProtocolError('unauthorized', 'handoff_target_auth'); } });
        const failedBound = await bindThread(failed, SESSION_CODEX, [SESSION_ACP]);
        const failedTarget = failed.threads.get(failedBound.thread.threadId).participants[1].participantId;
        const failedBegun = await failed.service.begin({ threadId: failedBound.thread.threadId, sourceParticipantId: failedBound.owner, targetParticipantId: failedTarget, entries: ENTRIES, at: 1 });
        await failed.service.attach({ handoffId: failedBegun.handoffId, at: 2 });
        await failed.service.prepare({ handoffId: failedBegun.handoffId, prompt: PROMPT, at: 3 });
        await capture(() => failed.service.deliver({ handoffId: failedBegun.handoffId, at: 4 }));
        const appliedBeforeReplay = failed.service.state.applied;
        const replayAfterFailure = await capture(() => failed.service.deliver({ handoffId: failedBegun.handoffId, at: 5 }));
        const appliedAfterReplay = failed.service.state.applied;
        check('a fingerprint-differing replay is a CONFLICT, never a silent second execution: a prepare replayed with a different prompt (a different prompt fingerprint) is refused with conflict/handoff_prompt, a reopen under the same handoff id with a different source/target identity is refused with conflict/handoff_duplicate, and a deliver replayed after a failed attempt is refused with conflict/handoff_state — and in every case the OBSERVED applied counter did not increase (3→3, 3→3, 4→4), the journal still holds one op per rung with the failed deliver marked outcome failed, and the prompt send count stays exactly 1', {
          differingPrompt,
          appliedBefore,
          appliedAfterDifferingPrompt,
          appliedUnchangedAfterDifferingPrompt: appliedBefore === appliedAfterDifferingPrompt,
          differingIdentityReopen,
          appliedAfterDifferingIdentity,
          appliedUnchangedAfterDifferingIdentity: appliedAfterDifferingPrompt === appliedAfterDifferingIdentity,
          replayAfterFailure,
          appliedBeforeReplay,
          appliedAfterReplay,
          appliedUnchangedAfterReplay: appliedBeforeReplay === appliedAfterReplay,
          sendPromptCalls: failed.counters.sendPrompt,
          duplicates: failed.service.state.duplicates,
          failedOps: failed.service.ops(failedBegun.handoffId).map((op) => ({ kind: op.kind, outcome: op.outcome, applied: op.applied, duplicate: op.duplicate })),
          serviceState: { ...failed.service.state },
        }, {
          differingPrompt: { code: 'conflict', field: 'handoff_prompt' },
          appliedBefore: 3,
          appliedAfterDifferingPrompt: 3,
          appliedUnchangedAfterDifferingPrompt: true,
          differingIdentityReopen: { code: 'conflict', field: 'handoff_duplicate' },
          appliedAfterDifferingIdentity: 3,
          appliedUnchangedAfterDifferingIdentity: true,
          replayAfterFailure: { code: 'conflict', field: 'handoff_state' },
          appliedBeforeReplay: 4,
          appliedAfterReplay: 4,
          appliedUnchangedAfterReplay: true,
          sendPromptCalls: 1,
          duplicates: 0,
          failedOps: [
            { kind: 'checkpoint', outcome: 'applied', applied: true, duplicate: false },
            { kind: 'attach', outcome: 'applied', applied: true, duplicate: false },
            { kind: 'prepare', outcome: 'applied', applied: true, duplicate: false },
            { kind: 'deliver', outcome: 'failed', applied: true, duplicate: false },
          ],
          serviceState: { handoffs: 1, ops: 4, applied: 4, duplicates: 0, sends: 1, reconciles: 0, failures: 1, closed: false },
        });
      }

      // ── F9: a failed open or send neither loses the thread nor duplicates the prompt ──
      {
        const openFailure = makeWorld({ openTarget: async () => { throw new Error('socket hung up'); } });
        const openBound = await bindThread(openFailure, SESSION_CODEX, [SESSION_ACP]);
        const openTarget = openFailure.threads.get(openBound.thread.threadId).participants[1].participantId;
        const threadBefore = JSON.stringify(openFailure.threads.get(openBound.thread.threadId));
        const openBegun = await openFailure.service.begin({ threadId: openBound.thread.threadId, sourceParticipantId: openBound.owner, targetParticipantId: openTarget, entries: ENTRIES, at: 1 });
        await capture(() => openFailure.service.attach({ handoffId: openBegun.handoffId, at: 2 }));
        const threadAfter = JSON.stringify(openFailure.threads.get(openBound.thread.threadId));
        const openView = openFailure.service.handoff(openBegun.handoffId);
        const sendFailure = makeWorld({ sendPrompt: async () => { throw new ProtocolError('unauthorized', 'handoff_target_auth'); } });
        const sendBound = await bindThread(sendFailure, SESSION_CODEX, [SESSION_ACP]);
        const sendTarget = sendFailure.threads.get(sendBound.thread.threadId).participants[1].participantId;
        const sendBegun = await sendFailure.service.begin({ threadId: sendBound.thread.threadId, sourceParticipantId: sendBound.owner, targetParticipantId: sendTarget, entries: ENTRIES, at: 1 });
        await sendFailure.service.attach({ handoffId: sendBegun.handoffId, at: 2 });
        await sendFailure.service.prepare({ handoffId: sendBegun.handoffId, prompt: PROMPT, at: 3 });
        const sendRejection = await capture(() => sendFailure.service.deliver({ handoffId: sendBegun.handoffId, at: 4 }));
        const reDelivery = await capture(() => sendFailure.service.deliver({ handoffId: sendBegun.handoffId, at: 5 }));
        const sendView = sendFailure.service.handoff(sendBegun.handoffId);
        check('a failed open or a failed send neither loses the thread nor duplicates the prompt: a failed open (pre-send) marks the handoff failed with source_unavailable/handoff_target_open and leaves the send count at exactly ZERO with the thread identity, both participant identities and both native sessions untouched and the original selection restored; a failed send marks it failed with the typed unauthorized/handoff_target_auth, the send count is exactly ONE — never two — the thread and both participants survive with the original selection restored, and the re-delivery is refused with conflict/handoff_state rather than retried', {
          failedOpen: {
            state: openView.state,
            resolution: { resolution: openView.resolution.resolution, code: openView.resolution.code, field: openView.resolution.field, reason: openView.resolution.reason, at: openView.resolution.at },
            threadSurvivesByteIdentical: threadAfter === threadBefore,
            participantsBefore: JSON.parse(threadBefore).participants.map((entry) => ({ id: entry.participantId, native: entry.session.nativeSessionId })),
            participantsAfter: JSON.parse(threadAfter).participants.map((entry) => ({ id: entry.participantId, native: entry.session.nativeSessionId })),
            threadActive: openFailure.threads.active(openBound.thread.threadId)?.participantId,
            sendPromptCalls: openFailure.counters.sendPrompt,
            sends: openView.sends,
            ops: openFailure.service.ops(openBegun.handoffId).map((op) => ({ kind: op.kind, outcome: op.outcome, code: op.code, field: op.field })),
          },
          failedSend: {
            rejection: sendRejection,
            reDelivery,
            state: sendView.state,
            resolution: { resolution: sendView.resolution.resolution, code: sendView.resolution.code, field: sendView.resolution.field, reason: sendView.resolution.reason, at: sendView.resolution.at },
            sends: sendView.sends,
            sendPromptCalls: sendFailure.counters.sendPrompt,
            threadActive: sendFailure.threads.active(sendBound.thread.threadId)?.participantId,
            participants: sendFailure.threads.get(sendBound.thread.threadId).participants.length,
            ops: sendFailure.service.ops(sendBegun.handoffId).map((op) => ({ kind: op.kind, outcome: op.outcome, code: op.code, field: op.field })),
          },
        }, {
          failedOpen: {
            state: 'failed',
            resolution: { resolution: 'failed', code: 'source_unavailable', field: 'handoff_target_open', reason: null, at: 2 },
            threadSurvivesByteIdentical: true,
            participantsBefore: [
              { id: openBound.owner, native: 'native:codex-1' },
              { id: openTarget, native: 'native:acp-1' },
            ],
            participantsAfter: [
              { id: openBound.owner, native: 'native:codex-1' },
              { id: openTarget, native: 'native:acp-1' },
            ],
            threadActive: openBound.owner,
            sendPromptCalls: 0,
            sends: 0,
            ops: [
              { kind: 'checkpoint', outcome: 'applied', code: null, field: null },
              { kind: 'attach', outcome: 'failed', code: 'source_unavailable', field: 'handoff_target_open' },
            ],
          },
          failedSend: {
            rejection: { code: 'unauthorized', field: 'handoff_target_auth' },
            reDelivery: { code: 'conflict', field: 'handoff_state' },
            state: 'failed',
            resolution: { resolution: 'failed', code: 'unauthorized', field: 'handoff_target_auth', reason: null, at: 4 },
            sends: 1,
            sendPromptCalls: 1,
            threadActive: sendBound.owner,
            participants: 2,
            ops: [
              { kind: 'checkpoint', outcome: 'applied', code: null, field: null },
              { kind: 'attach', outcome: 'applied', code: null, field: null },
              { kind: 'prepare', outcome: 'applied', code: null, field: null },
              { kind: 'deliver', outcome: 'failed', code: 'unauthorized', field: 'handoff_target_auth' },
            ],
          },
        });
      }

      // ── F10: a carried context hash is never rewritten ──
      {
        const world = makeWorld({ sessions: [SESSION_CODEX, SESSION_ACP, SESSION_CODEX_2, SESSION_ACP_2] });
        const first = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const firstTarget = world.threads.get(first.thread.threadId).participants[1].participantId;
        const carried = await world.service.begin({ threadId: first.thread.threadId, sourceParticipantId: first.owner, targetParticipantId: firstTarget, checkpointId: CKPT, entries: ENTRIES, at: 1 });
        const second = await bindThread(world, SESSION_CODEX_2, [SESSION_ACP_2]);
        const secondTarget = world.threads.get(second.thread.threadId).participants[1].participantId;
        const differentEntries = await capture(() => world.service.begin({ threadId: first.thread.threadId, sourceParticipantId: first.owner, targetParticipantId: firstTarget, checkpointId: CKPT, entries: [{ class: 'goal', origin: { kind: 'host', commandId: 'handoff-qa' }, text: 'a different context' }], at: 2 }));
        const crossThreadScope = await capture(() => world.service.begin({ threadId: second.thread.threadId, sourceParticipantId: second.owner, targetParticipantId: secondTarget, checkpointId: CKPT, entries: ENTRIES, at: 3 }));
        const unknownIdWithoutEntries = await capture(() => world.service.begin({ threadId: first.thread.threadId, sourceParticipantId: first.owner, targetParticipantId: firstTarget, checkpointId: 'dddddddd-dddd-4ddd-8ddd-dddddddddddd', at: 4 }));
        check('a carried context hash is NEVER rewritten: the same entries under the known checkpoint id are carried forward as the very same checkpoint, but DIFFERENT entries under that id are refused with conflict/handoff_checkpoint, a scope from another thread is refused with unauthorized/handoff_checkpoint_scope, and an unknown checkpoint id with no entries is refused with invalid_request/handoff_entries — none of the refusals creates a handoff, and the checkpoint store still holds exactly the one checkpoint that was minted', {
          differentEntries,
          crossThreadScope,
          unknownIdWithoutEntries,
          handoffsAfterRefusals: world.service.state.handoffs,
          checkpointStore: world.checkpoints.checkpoints().map((entry) => ({ id: entry.checkpointId, bytes: entry.bytes, entryCount: entry.entryCount })),
          carriedDigestUnchanged: world.checkpoints.checkpoints()[0].digest === carried.checkpoint.digest,
          carriedDigestIsHex64: HEX64.test(carried.checkpoint.digest),
          carriedBytes: carried.checkpoint.bytes,
          carriedEntryCount: carried.checkpoint.entryCount,
        }, {
          differentEntries: { code: 'conflict', field: 'handoff_checkpoint' },
          crossThreadScope: { code: 'unauthorized', field: 'handoff_checkpoint_scope' },
          unknownIdWithoutEntries: { code: 'invalid_request', field: 'handoff_entries' },
          handoffsAfterRefusals: 1,
          checkpointStore: [{ id: CKPT, bytes: 1138, entryCount: 2 }],
          carriedDigestUnchanged: true,
          carriedDigestIsHex64: true,
          carriedBytes: 1138,
          carriedEntryCount: 2,
        });
      }
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: the observed ladder rung by rung, the A→B→A round trip, the same-participant
      // resume, independent source/target harness surfaces, active-only-on-observation and the
      // idempotent journal.
      // ══════════════════════════════════════════════════════════════════════════════════════════

      // The deterministic read-model shape: random ids are pattern-checked, everything else pinned.
      const viewShape = (view) => ({
        state: view.state,
        active: view.active,
        sourceParticipantId: view.source.participantId,
        sourceSession: { ...view.source.session },
        targetParticipantId: view.target.participantId,
        targetSession: { ...view.target.session },
        originalParticipantId: view.originalParticipantId,
        checkpoint: {
          checkpointIdIsUuid: UUID.test(view.checkpoint.checkpointId),
          digestIsHex64: HEX64.test(view.checkpoint.digest),
          bytes: view.checkpoint.bytes,
          entryCount: view.checkpoint.entryCount,
        },
        promptFingerprint: view.promptFingerprint,
        delivered: view.delivered, deliveredAt: view.deliveredAt, deliveredBy: view.deliveredBy,
        observed: view.observed, observedAt: view.observedAt, observedBy: view.observedBy,
        resolution: view.resolution,
        sends: view.sends, createdAt: view.createdAt, updatedAt: view.updatedAt,
        frozen: [Object.isFrozen(view), Object.isFrozen(view.source), Object.isFrozen(view.target), Object.isFrozen(view.checkpoint)],
        handoffIdIsUuid: UUID.test(view.handoffId),
        environmentId: view.environmentId,
      });

      // ── H1: the Codex→ACP checkpoint handoff, one observed rung per step ──
      const world = makeWorld();
      const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
      const target = world.threads.get(thread.threadId).participants[1].participantId;
      const revisionAfterJoin = world.threads.get(thread.threadId).revision;
      // The revision and the active selection are snapshotted BETWEEN deliver and observe: the
      // observation moves the selection and bumps the revision, so reading them after the full
      // ladder would report the post-observation value under an "after deliver" name.
      const { begun, attached, prepared, delivered, observed, afterDeliverSnapshot } = await driveLadder(world, thread.threadId, owner, target, {
        afterDeliver: () => ({
          revision: world.threads.get(thread.threadId).revision,
          active: world.threads.active(thread.threadId)?.participantId ?? null,
        }),
      });
      const revisionAfterDeliver = afterDeliverSnapshot.revision;
      const activeAfterDeliver = afterDeliverSnapshot.active;
      const revisionAfterObserve = world.threads.get(thread.threadId).revision;
      const activeAfterObserve = world.threads.active(thread.threadId)?.participantId;
      record('ladder', { begun, attached, prepared, delivered, observed });
      check('the Codex→ACP checkpoint handoff walks the OBSERVED ladder rung by rung — checkpoint, attached, prepared, delivered, then active ONLY after the real native observation — with every deterministic view field pinned at each rung (the ack records delivered/deliveredAt/deliveredBy, the observation records observed/observedAt/observedBy), the original source binding retained as originalParticipantId, and the thread revision proving the selection moves ONLY on the observation: revision 2 after the joins, still 2 after the native ack (the source is still the active participant), 3 only after the observation (the target is)', {
        states: [begun.state, attached.state, prepared.state, delivered.state, observed.state],
        begun: viewShape(begun),
        attached: viewShape(attached),
        prepared: viewShape(prepared),
        delivered: viewShape(delivered),
        observed: viewShape(observed),
        revisionAfterJoin,
        revisionAfterDeliver,
        activeAfterDeliver,
        revisionAfterObserve,
        activeAfterObserve,
        sourceStillActiveAfterAck: activeAfterDeliver === owner,
        targetActiveOnlyAfterObservation: activeAfterObserve === target,
        openTargetCalls: world.counters.openTarget,
        sendPromptCalls: world.counters.sendPrompt,
        cancelSourceCalls: world.counters.cancelSource,
        serviceState: { ...world.service.state },
      }, {
        states: ['checkpoint', 'attached', 'prepared', 'delivered', 'active'],
        begun: {
          state: 'checkpoint', active: false,
          sourceParticipantId: owner, sourceSession: SESSION_CODEX,
          targetParticipantId: target, targetSession: SESSION_ACP,
          originalParticipantId: owner,
          checkpoint: { checkpointIdIsUuid: true, digestIsHex64: true, bytes: 1138, entryCount: 2 },
          promptFingerprint: null,
          delivered: false, deliveredAt: null, deliveredBy: null,
          observed: false, observedAt: null, observedBy: null,
          resolution: null, sends: 0, createdAt: 1000, updatedAt: 1000,
          frozen: [true, true, true, true], handoffIdIsUuid: true, environmentId: ENV_A,
        },
        attached: {
          state: 'attached', active: false,
          sourceParticipantId: owner, sourceSession: SESSION_CODEX,
          targetParticipantId: target, targetSession: SESSION_ACP,
          originalParticipantId: owner,
          checkpoint: { checkpointIdIsUuid: true, digestIsHex64: true, bytes: 1138, entryCount: 2 },
          promptFingerprint: null,
          delivered: false, deliveredAt: null, deliveredBy: null,
          observed: false, observedAt: null, observedBy: null,
          resolution: null, sends: 0, createdAt: 1000, updatedAt: 2000,
          frozen: [true, true, true, true], handoffIdIsUuid: true, environmentId: ENV_A,
        },
        prepared: {
          state: 'prepared', active: false,
          sourceParticipantId: owner, sourceSession: SESSION_CODEX,
          targetParticipantId: target, targetSession: SESSION_ACP,
          originalParticipantId: owner,
          checkpoint: { checkpointIdIsUuid: true, digestIsHex64: true, bytes: 1138, entryCount: 2 },
          promptFingerprint: PROMPT_FINGERPRINT,
          delivered: false, deliveredAt: null, deliveredBy: null,
          observed: false, observedAt: null, observedBy: null,
          resolution: null, sends: 0, createdAt: 1000, updatedAt: 3000,
          frozen: [true, true, true, true], handoffIdIsUuid: true, environmentId: ENV_A,
        },
        delivered: {
          state: 'delivered', active: false,
          sourceParticipantId: owner, sourceSession: SESSION_CODEX,
          targetParticipantId: target, targetSession: SESSION_ACP,
          originalParticipantId: owner,
          checkpoint: { checkpointIdIsUuid: true, digestIsHex64: true, bytes: 1138, entryCount: 2 },
          promptFingerprint: PROMPT_FINGERPRINT,
          delivered: true, deliveredAt: 4000, deliveredBy: 'ack-1',
          observed: false, observedAt: null, observedBy: null,
          resolution: null, sends: 1, createdAt: 1000, updatedAt: 4000,
          frozen: [true, true, true, true], handoffIdIsUuid: true, environmentId: ENV_A,
        },
        observed: {
          state: 'active', active: true,
          sourceParticipantId: owner, sourceSession: SESSION_CODEX,
          targetParticipantId: target, targetSession: SESSION_ACP,
          originalParticipantId: owner,
          checkpoint: { checkpointIdIsUuid: true, digestIsHex64: true, bytes: 1138, entryCount: 2 },
          promptFingerprint: PROMPT_FINGERPRINT,
          delivered: true, deliveredAt: 4000, deliveredBy: 'ack-1',
          observed: true, observedAt: 5000, observedBy: 'evt-acp-1',
          resolution: null, sends: 1, createdAt: 1000, updatedAt: 5000,
          frozen: [true, true, true, true], handoffIdIsUuid: true, environmentId: ENV_A,
        },
        revisionAfterJoin: 2,
        revisionAfterDeliver: 2,
        activeAfterDeliver: owner,
        revisionAfterObserve: 3,
        activeAfterObserve: target,
        sourceStillActiveAfterAck: true,
        targetActiveOnlyAfterObservation: true,
        openTargetCalls: 1,
        sendPromptCalls: 1,
        cancelSourceCalls: 0,
        serviceState: { handoffs: 1, ops: 5, applied: 5, duplicates: 0, sends: 1, reconciles: 0, failures: 0, closed: false },
      });

      // ── H2: the journal — every step recorded before its side effect, one op per rung ──
      const ops = world.service.ops(begun.handoffId);
      check('the operation journal records every step BEFORE its side effect runs: exactly one op per rung in ladder order, each applied with outcome applied and no code/field, the checkpoint op carrying {checkpointId, digest} as its detail and the observe op the native event id, five distinct 64-hex fingerprints, and the whole journal plus every handoff view frozen', {
        kinds: ops.map((op) => op.kind),
        applied: ops.map((op) => op.applied),
        duplicates: ops.map((op) => op.duplicate),
        outcomes: ops.map((op) => op.outcome),
        codes: ops.map((op) => op.code),
        fields: ops.map((op) => op.field),
        details: ops.map((op) => op.detail),
        ats: ops.map((op) => op.at),
        fingerprintsAllHex64: ops.every((op) => HEX64.test(op.fingerprint)),
        distinctFingerprints: new Set(ops.map((op) => op.fingerprint)).size,
        opIdsAllUuid: ops.every((op) => UUID.test(op.opId)),
        opHandoffIdsMatch: ops.every((op) => op.handoffId === begun.handoffId),
        opCount: ops.length,
        opsFrozen: Object.isFrozen(ops),
        opViewsFrozen: ops.every((op) => Object.isFrozen(op)),
        handoffsFrozen: [Object.isFrozen(world.service.handoffs()), Object.isFrozen(world.service.handoffs()[0])],
        handoffReadBack: world.service.handoff(begun.handoffId).state,
      }, {
        kinds: ['checkpoint', 'attach', 'prepare', 'deliver', 'observe'],
        applied: [true, true, true, true, true],
        duplicates: [false, false, false, false, false],
        outcomes: ['applied', 'applied', 'applied', 'applied', 'applied'],
        codes: [null, null, null, null, null],
        fields: [null, null, null, null, null],
        details: [
          { checkpointId: begun.checkpoint.checkpointId, digest: begun.checkpoint.digest },
          null, null, null,
          { nativeEventId: 'evt-acp-1' },
        ],
        ats: [1000, 2000, 3000, 4000, 5000],
        fingerprintsAllHex64: true,
        distinctFingerprints: 5,
        opIdsAllUuid: true,
        opHandoffIdsMatch: true,
        opCount: 5,
        opsFrozen: true,
        opViewsFrozen: true,
        handoffsFrozen: [true, true],
        handoffReadBack: 'active',
      });

      // ── H3: a native ack only means delivered — a hostile ack payload changes nothing ──
      {
        const hostile = makeWorld();
        const bound = await bindThread(hostile, SESSION_CODEX, [SESSION_ACP]);
        const hostileTarget = hostile.threads.get(bound.thread.threadId).participants[1].participantId;
        const begunHostile = await hostile.service.begin({ threadId: bound.thread.threadId, sourceParticipantId: bound.owner, targetParticipantId: hostileTarget, entries: ENTRIES, at: 10 });
        await hostile.service.attach({ handoffId: begunHostile.handoffId, at: 20 });
        await hostile.service.prepare({ handoffId: begunHostile.handoffId, prompt: PROMPT, at: 30 });
        const acked = await hostile.service.deliver({ handoffId: begunHostile.handoffId, observed: true, active: true, state: 'active', at: 40 });
        check('a native ack only means delivered, and that is STRUCTURAL rather than conditional: an ack payload that also claims observed, active and the state active is read only for its ackId — the handoff stays at delivered with observed/observedAt/observedBy and active all empty, the deliveredBy/deliveredAt record the ack, the thread selection has NOT moved (the source is still active and the revision is unchanged), and exactly one prompt was sent', {
          state: acked.state,
          delivered: acked.delivered, deliveredAt: acked.deliveredAt, deliveredBy: acked.deliveredBy,
          observed: acked.observed, observedAt: acked.observedAt, observedBy: acked.observedBy,
          active: acked.active,
          sends: acked.sends,
          threadActiveIsSource: hostile.threads.active(bound.thread.threadId)?.participantId === bound.owner,
          revisionAfterHostileAck: hostile.threads.get(bound.thread.threadId).revision,
          sendPromptCalls: hostile.counters.sendPrompt,
          resolutionStillNull: acked.resolution,
        }, {
          state: 'delivered',
          delivered: true, deliveredAt: 40, deliveredBy: 'ack-1',
          observed: false, observedAt: null, observedBy: null,
          active: false,
          sends: 1,
          threadActiveIsSource: true,
          revisionAfterHostileAck: 2,
          sendPromptCalls: 1,
          resolutionStillNull: null,
        });
      }

      // ── H4: the Kimi→Codex checkpoint handoff walks the same observed ladder ──
      {
        const kimi = makeWorld({ sessions: [SESSION_CODEX, SESSION_ACP, SESSION_KIMI] });
        const bound = await bindThread(kimi, SESSION_CODEX, [SESSION_ACP, SESSION_KIMI]);
        const codexId = bound.owner;
        const acpId = bound.joined[0].participantId;
        const kimiId = bound.joined[1].participantId;
        const first = await driveLadder(kimi, bound.thread.threadId, codexId, acpId, { observeEvent: 'evt-acp-9', beginAt: 100 });
        const second = await driveLadder(kimi, bound.thread.threadId, kimiId, codexId, { prompt: 'kimi hands back to codex', observeEvent: 'evt-codex-9', beginAt: 600 });
        record('kimiToCodex', { first: first.observed, second: second.observed });
        check('the Kimi→Codex checkpoint handoff walks the same OBSERVED ladder rung by rung on a thread that spans three harnesses: the source is the kimi-web participant with its own native session, the target is the codex participant, the second handoff\'s original selection is the participant that was active when it began (the acp participant the first handoff observed), each handoff mints its OWN bounded checkpoint (the two digests differ, both 64-hex, both 1138 bytes / 2 entries), the active selection ends on the codex participant, and no participant ever left', {
          firstStates: [first.begun.state, first.attached.state, first.prepared.state, first.delivered.state, first.observed.state],
          secondStates: [second.begun.state, second.attached.state, second.prepared.state, second.delivered.state, second.observed.state],
          secondSource: { ...second.observed.source.session },
          secondTarget: { ...second.observed.target.session },
          secondOriginalParticipantId: second.observed.originalParticipantId,
          secondOriginalIsTheThenActiveAcp: second.observed.originalParticipantId === acpId,
          secondDigestIsHex64: HEX64.test(second.observed.checkpoint.digest),
          secondCheckpointBytes: second.observed.checkpoint.bytes,
          secondCheckpointEntryCount: second.observed.checkpoint.entryCount,
          digestsDiffer: first.observed.checkpoint.digest !== second.observed.checkpoint.digest,
          activeNow: kimi.threads.active(bound.thread.threadId)?.participantId,
          activeIsCodex: kimi.threads.active(bound.thread.threadId)?.participantId === codexId,
          handoffCount: kimi.service.handoffs().length,
          participants: kimi.threads.get(bound.thread.threadId).participants.map((entry) => ({ native: entry.session.nativeSessionId, harness: entry.harnessInstanceId, state: entry.state })),
          counters: { ...kimi.counters },
          serviceState: { ...kimi.service.state },
        }, {
          firstStates: ['checkpoint', 'attached', 'prepared', 'delivered', 'active'],
          secondStates: ['checkpoint', 'attached', 'prepared', 'delivered', 'active'],
          secondSource: SESSION_KIMI,
          secondTarget: SESSION_CODEX,
          secondOriginalParticipantId: acpId,
          secondOriginalIsTheThenActiveAcp: true,
          secondDigestIsHex64: true,
          secondCheckpointBytes: 1138,
          secondCheckpointEntryCount: 2,
          digestsDiffer: true,
          activeNow: codexId,
          activeIsCodex: true,
          handoffCount: 2,
          participants: [
            { native: 'native:codex-1', harness: H_CODEX, state: 'active' },
            { native: 'native:acp-1', harness: H_ACP, state: 'active' },
            { native: 'native:kimi-1', harness: H_KIMI, state: 'active' },
          ],
          counters: { openTarget: 2, sendPrompt: 2, cancelSource: 0 },
          serviceState: { handoffs: 2, ops: 10, applied: 10, duplicates: 0, sends: 2, reconciles: 0, failures: 0, closed: false },
        });
      }

      // ── H5: A→B→A preserves the native sessions and the carried context hash ──
      {
        const store = createNativeStore(path.join(fixture.root, 'native'));
        fixture.register({ kind: 'native-session-store-planned', dir: store.dir, teardown: 'removed with the private root' });
        await store.open();
        await store.write(SESSION_CODEX);
        await store.write(SESSION_ACP);
        const filesBefore = { codex: await store.fingerprint(SESSION_CODEX), acp: await store.fingerprint(SESSION_ACP) };
        const keysBefore = { codex: threadBindingKey(SESSION_CODEX), acp: threadBindingKey(SESSION_ACP) };
        let resolutions = 0;
        const threads = createThreadService({ resolveSession: async (session) => { resolutions += 1; return store.resolve(session); } });
        const checkpoints = createCheckpointService();
        const openCalls = [];
        const sendCalls = [];
        const service = createHandoffService({
          threads,
          checkpoints,
          openTarget: async (input) => { openCalls.push(input); return { nativeSessionId: input.target.session.nativeSessionId }; },
          sendPrompt: async (input) => { sendCalls.push(input); return { ackId: 'ack-native' }; },
        });
        const thread = await threads.bind({ session: SESSION_CODEX, repo: REPO });
        const codexId = thread.participants[0].participantId;
        const acp = await threads.join({ threadId: thread.threadId, session: SESSION_ACP, repo: REPO });
        const resolutionsAfterJoin = resolutions;
        // Leg 1: codex → acp, minting the bounded checkpoint under the explicit id.
        const leg1 = await service.begin({ threadId: thread.threadId, sourceParticipantId: codexId, targetParticipantId: acp.participantId, checkpointId: CKPT, entries: ENTRIES, at: 1000 });
        await service.attach({ handoffId: leg1.handoffId, at: 2000 });
        await service.prepare({ handoffId: leg1.handoffId, prompt: PROMPT, at: 3000 });
        await service.deliver({ handoffId: leg1.handoffId, at: 4000 });
        const leg1done = await service.observe({ handoffId: leg1.handoffId, nativeEventId: 'evt-acp-1', at: 5000 });
        // Leg 2: acp → codex, carrying the SAME checkpoint id and the SAME entries.
        const leg2 = await service.begin({ threadId: thread.threadId, sourceParticipantId: acp.participantId, targetParticipantId: codexId, checkpointId: CKPT, entries: ENTRIES, at: 6000 });
        await service.attach({ handoffId: leg2.handoffId, at: 7000 });
        await service.prepare({ handoffId: leg2.handoffId, prompt: RETURN_PROMPT, at: 8000 });
        await service.deliver({ handoffId: leg2.handoffId, at: 9000 });
        const leg2done = await service.observe({ handoffId: leg2.handoffId, nativeEventId: 'evt-codex-1', at: 10000 });
        const filesAfter = { codex: await store.fingerprint(SESSION_CODEX), acp: await store.fingerprint(SESSION_ACP) };
        const keysAfter = { codex: threadBindingKey(SESSION_CODEX), acp: threadBindingKey(SESSION_ACP) };
        record('roundTrip', { leg1: leg1done, leg2: leg2done, filesBefore, filesAfter });
        check('the A→B→A checkpoint relay preserves BOTH native sessions and the carried context hash: the two real on-disk native-session records survive byte-identical (pinned digests and byte lengths, and the session index was resolved exactly twice — once per bind/join — so no native session was ever re-resolved or re-created), both participants keep their own participantId, role, harness instance and native session, the canonical binding keys are unchanged, the second leg carries the VERY SAME checkpoint (equal digest, equal explicit id, and the checkpoint store holds exactly ONE checkpoint with that digest — the context hash is never rewritten), the active selection returns to the original codex participant, and each leg bound and prompted exactly its OWN target session', {
          leg1: { state: leg1done.state, checkpoint: { checkpointId: leg1done.checkpoint.checkpointId, digestIsHex64: HEX64.test(leg1done.checkpoint.digest), bytes: leg1done.checkpoint.bytes, entryCount: leg1done.checkpoint.entryCount }, sends: leg1done.sends, deliveredAt: leg1done.deliveredAt, deliveredBy: leg1done.deliveredBy, observedAt: leg1done.observedAt, observedBy: leg1done.observedBy, createdAt: leg1done.createdAt, updatedAt: leg1done.updatedAt, originalParticipantId: leg1done.originalParticipantId },
          leg2: { state: leg2done.state, checkpoint: { checkpointId: leg2done.checkpoint.checkpointId, digestIsHex64: HEX64.test(leg2done.checkpoint.digest), bytes: leg2done.checkpoint.bytes, entryCount: leg2done.checkpoint.entryCount }, sends: leg2done.sends, createdAt: leg2done.createdAt, originalParticipantId: leg2done.originalParticipantId },
          carriedDigestEqual: leg1done.checkpoint.digest === leg2done.checkpoint.digest,
          carriedIdEqual: leg1done.checkpoint.checkpointId === leg2done.checkpoint.checkpointId,
          carriedId: leg1done.checkpoint.checkpointId,
          checkpointStore: checkpoints.checkpoints().map((entry) => ({ id: entry.checkpointId, digestIsHex64: HEX64.test(entry.digest), bytes: entry.bytes, entryCount: entry.entryCount })),
          filesBefore,
          filesAfter,
          filesByteIdentical: JSON.stringify(filesBefore) === JSON.stringify(filesAfter),
          keysBefore,
          keysAfter,
          keysUnchanged: JSON.stringify(keysBefore) === JSON.stringify(keysAfter),
          resolutionsAfterJoin,
          resolutionsAfterRoundTrip: resolutions,
          nativeSessionsNeverReResolved: resolutions === resolutionsAfterJoin,
          activeNow: threads.active(thread.threadId)?.participantId,
          activeIsOriginalCodex: threads.active(thread.threadId)?.participantId === codexId,
          participants: threads.get(thread.threadId).participants.map((entry) => ({ participantId: entry.participantId, role: entry.role, state: entry.state, native: entry.session.nativeSessionId, harness: entry.harnessInstanceId })),
          participantCount: threads.get(thread.threadId).participants.length,
          revision: threads.get(thread.threadId).revision,
          openTargets: openCalls.map((call) => ({ handoffTargetParticipantId: call.target.participantId, nativeSessionId: call.target.session.nativeSessionId, harness: call.target.session.harnessInstanceId, threadId: call.threadId, handoffId: call.handoffId })),
          sendPrompts: sendCalls.map((call) => ({ targetNative: call.target.session.nativeSessionId, prompt: call.prompt, promptFingerprint: call.promptFingerprint, promptLength: call.prompt.length })),
          serviceState: { ...service.state },
          handoffViews: service.handoffs().map((view) => ({ state: view.state, active: view.active, observed: view.observed })),
        }, {
          leg1: { state: 'active', checkpoint: { checkpointId: CKPT, digestIsHex64: true, bytes: 1138, entryCount: 2 }, sends: 1, deliveredAt: 4000, deliveredBy: 'ack-native', observedAt: 5000, observedBy: 'evt-acp-1', createdAt: 1000, updatedAt: 5000, originalParticipantId: codexId },
          leg2: { state: 'active', checkpoint: { checkpointId: CKPT, digestIsHex64: true, bytes: 1138, entryCount: 2 }, sends: 1, createdAt: 6000, originalParticipantId: acp.participantId },
          carriedDigestEqual: true,
          carriedIdEqual: true,
          carriedId: CKPT,
          checkpointStore: [{ id: CKPT, digestIsHex64: true, bytes: 1138, entryCount: 2 }],
          filesBefore: { codex: FILE_CODEX, acp: FILE_ACP },
          filesAfter: { codex: FILE_CODEX, acp: FILE_ACP },
          filesByteIdentical: true,
          keysBefore: {
            codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
            acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
          },
          keysAfter: {
            codex: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
            acp: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
          },
          keysUnchanged: true,
          resolutionsAfterJoin: 2,
          resolutionsAfterRoundTrip: 2,
          nativeSessionsNeverReResolved: true,
          activeNow: codexId,
          activeIsOriginalCodex: true,
          participants: [
            { participantId: codexId, role: 'owner', state: 'active', native: 'native:codex-1', harness: H_CODEX },
            { participantId: acp.participantId, role: 'participant', state: 'active', native: 'native:acp-1', harness: H_ACP },
          ],
          participantCount: 2,
          revision: 4,
          openTargets: [
            { handoffTargetParticipantId: acp.participantId, nativeSessionId: 'native:acp-1', harness: H_ACP, threadId: thread.threadId, handoffId: leg1.handoffId },
            { handoffTargetParticipantId: codexId, nativeSessionId: 'native:codex-1', harness: H_CODEX, threadId: thread.threadId, handoffId: leg2.handoffId },
          ],
          sendPrompts: [
            { targetNative: 'native:acp-1', prompt: PROMPT, promptFingerprint: PROMPT_FINGERPRINT, promptLength: PROMPT.length },
            { targetNative: 'native:codex-1', prompt: RETURN_PROMPT, promptFingerprint: RETURN_PROMPT_FINGERPRINT, promptLength: RETURN_PROMPT.length },
          ],
          serviceState: { handoffs: 2, ops: 10, applied: 10, duplicates: 0, sends: 2, reconciles: 0, failures: 0, closed: false },
          handoffViews: [
            { state: 'active', active: true, observed: true },
            { state: 'active', active: true, observed: true },
          ],
        });
      }

      // ── H6: the same participant resumes and the original source binding is retained ──
      {
        const world = makeWorld();
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const beforeKey = threadBindingKey(world.threads.nativeHistory(thread.threadId, owner).session);
        const beforeSession = JSON.stringify(world.threads.nativeHistory(thread.threadId, owner).session);
        const activeAfterHandoff = await driveLadder(world, thread.threadId, owner, target);
        const activeAfterObserve = world.threads.active(thread.threadId)?.participantId;
        const stateBefore = world.threads.get(thread.threadId).participants.find((entry) => entry.participantId === owner).state;
        const left = world.threads.leave({ threadId: thread.threadId, participantId: owner });
        const stateAtLeave = left.state;
        const leftAtAtLeave = left.leftAt;
        const resumed = await world.threads.resume({ threadId: thread.threadId, participantId: owner });
        const stateAtResume = resumed.state;
        const afterKey = threadBindingKey(resumed.session);
        const afterSession = JSON.stringify(resumed.session);
        check('the same participant resumes and the original source binding is retained: after the completed handoff the original source participant leaves and resumes through active→left→active with the SAME participantId, the SAME native SessionRef and the SAME canonical binding key, no orphan reason and no leftover leftAt, the participant count unchanged (nothing was re-created), and the handoff record\'s own source and target sessions are still the exact refs it began with', {
          activeAfterHandoff: activeAfterObserve,
          stateBefore,
          stateAtLeave,
          stateAtResume,
          transitions: [stateBefore, stateAtLeave, stateAtResume],
          leftAtRecordedAtLeave: typeof leftAtAtLeave === 'number' && leftAtAtLeave > 0,
          resumedParticipantId: resumed.participantId,
          sameParticipantId: resumed.participantId === owner,
          sameNativeSession: afterSession === beforeSession,
          sameBindingKey: afterKey === beforeKey,
          resumedOrphanReason: resumed.orphanReason,
          resumedLeftAt: resumed.leftAt,
          participantCount: world.threads.get(thread.threadId).participants.length,
          handoffSourceSessionIntact: JSON.stringify(world.service.handoff(activeAfterHandoff.begun.handoffId).source.session) === beforeSession,
          handoffTargetSessionIntact: JSON.stringify(world.service.handoff(activeAfterHandoff.begun.handoffId).target.session) === JSON.stringify(world.threads.nativeHistory(thread.threadId, target).session),
          sessionIndexResolutions: world.resolutions(),
        }, {
          activeAfterHandoff: target,
          stateBefore: 'active',
          stateAtLeave: 'left',
          stateAtResume: 'active',
          transitions: ['active', 'left', 'active'],
          leftAtRecordedAtLeave: true,
          resumedParticipantId: owner,
          sameParticipantId: true,
          sameNativeSession: true,
          sameBindingKey: true,
          resumedOrphanReason: null,
          resumedLeftAt: null,
          participantCount: 2,
          handoffSourceSessionIntact: true,
          handoffTargetSessionIntact: true,
          sessionIndexResolutions: 3,
        });
      }

      // ── H7: source and target expose INDEPENDENT harness surfaces ──
      {
        const world = makeWorld();
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const driven = await driveLadder(world, thread.threadId, owner, target);
        // A source-side identity presented to the target's attach is refused, never silently bound.
        const withSourceSession = makeWorld({ openTarget: async () => ({ nativeSessionId: SESSION_CODEX.nativeSessionId }) });
        const sourceBound = await bindThread(withSourceSession, SESSION_CODEX, [SESSION_ACP]);
        const sourceTarget = withSourceSession.threads.get(sourceBound.thread.threadId).participants[1].participantId;
        const sourceBegun = await withSourceSession.service.begin({ threadId: sourceBound.thread.threadId, sourceParticipantId: sourceBound.owner, targetParticipantId: sourceTarget, entries: ENTRIES, at: 1 });
        const sourceSessionRefusal = await capture(() => withSourceSession.service.attach({ handoffId: sourceBegun.handoffId, at: 2 }));
        const withForeignSession = makeWorld({ openTarget: async () => ({ nativeSessionId: 'native:someone-else' }) });
        const foreignBound = await bindThread(withForeignSession, SESSION_CODEX, [SESSION_ACP]);
        const foreignTarget = withForeignSession.threads.get(foreignBound.thread.threadId).participants[1].participantId;
        const foreignBegun = await withForeignSession.service.begin({ threadId: foreignBound.thread.threadId, sourceParticipantId: foreignBound.owner, targetParticipantId: foreignTarget, entries: ENTRIES, at: 1 });
        const foreignRefusal = await capture(() => withForeignSession.service.attach({ handoffId: foreignBegun.handoffId, at: 2 }));
        const withNoSession = makeWorld({ openTarget: async () => undefined });
        const noneBound = await bindThread(withNoSession, SESSION_CODEX, [SESSION_ACP]);
        const noneTarget = withNoSession.threads.get(noneBound.thread.threadId).participants[1].participantId;
        const noneBegun = await withNoSession.service.begin({ threadId: noneBound.thread.threadId, sourceParticipantId: noneBound.owner, targetParticipantId: noneTarget, entries: ENTRIES, at: 1 });
        const noneRefusal = await capture(() => withNoSession.service.attach({ handoffId: noneBegun.handoffId, at: 2 }));
        check('the source and target harness instances are INDEPENDENT surfaces: distinct harness instance ids, distinct native session ids and distinct canonical binding keys, each participant keeping its own native history side by side and never merged, the successful handoff binding and prompting exactly the TARGET\'s own session (the openTarget and sendPrompt inputs are the target participant with the target\'s native session, never the source\'s), and a source-side or foreign native session presented to the target\'s attach is REFUSED with conflict/handoff_target_session — the handoff fails closed with the thread and both participants intact and no prompt sent — so a source tool cannot act on the target', {
          sourceHarness: driven.begun.source.session.harnessInstanceId,
          targetHarness: driven.begun.target.session.harnessInstanceId,
          sourceNative: driven.begun.source.session.nativeSessionId,
          targetNative: driven.begun.target.session.nativeSessionId,
          sourceBindingKey: threadBindingKey(driven.begun.source.session),
          targetBindingKey: threadBindingKey(driven.begun.target.session),
          bindingKeysDistinct: threadBindingKey(driven.begun.source.session) !== threadBindingKey(driven.begun.target.session),
          harnessInstanceIds: [...world.threads.get(thread.threadId).harnessInstanceIds],
          nativeHistorySource: world.threads.nativeHistory(thread.threadId, owner).session.nativeSessionId,
          nativeHistoryTarget: world.threads.nativeHistory(thread.threadId, target).session.nativeSessionId,
          historiesNeverMerged: world.threads.nativeHistory(thread.threadId, owner).session.nativeSessionId !== world.threads.nativeHistory(thread.threadId, target).session.nativeSessionId,
          openTargetInput: { targetParticipantId: world.openCalls[0].target.participantId, nativeSessionId: world.openCalls[0].target.session.nativeSessionId, harness: world.openCalls[0].target.session.harnessInstanceId },
          sendPromptInput: { targetNative: world.sendCalls[0].target.session.nativeSessionId, prompt: world.sendCalls[0].prompt, promptFingerprint: world.sendCalls[0].promptFingerprint },
          sourceSessionRefusal,
          stateAfterSourceRefusal: withSourceSession.service.handoff(sourceBegun.handoffId).state,
          foreignRefusal,
          noneRefusal,
          threadsAfterRefusal: withSourceSession.threads.get(sourceBound.thread.threadId).participants.length,
          activeAfterRefusal: withSourceSession.threads.active(sourceBound.thread.threadId)?.participantId,
          sendCallsAfterRefusal: withSourceSession.counters.sendPrompt,
        }, {
          sourceHarness: H_CODEX,
          targetHarness: H_ACP,
          sourceNative: 'native:codex-1',
          targetNative: 'native:acp-1',
          sourceBindingKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJhYWFhYWFhYS1hYWFhLTRhYWEtOGFhYS1hYWFhYWFhYWFhYWEiLCJuYXRpdmU6Y29kZXgtMSJd',
          targetBindingKey: 'WzEsInNlc3Npb24iLCIxMTExMTExMS0xMTExLTQxMTEtODExMS0xMTExMTExMTExMTEiLCJiYmJiYmJiYi1iYmJiLTRiYmItOGJiYi1iYmJiYmJiYmJiYmIiLCJuYXRpdmU6YWNwLTEiXQ',
          bindingKeysDistinct: true,
          harnessInstanceIds: [H_CODEX, H_ACP],
          nativeHistorySource: 'native:codex-1',
          nativeHistoryTarget: 'native:acp-1',
          historiesNeverMerged: true,
          openTargetInput: { targetParticipantId: target, nativeSessionId: 'native:acp-1', harness: H_ACP },
          sendPromptInput: { targetNative: 'native:acp-1', prompt: PROMPT, promptFingerprint: PROMPT_FINGERPRINT },
          sourceSessionRefusal: { code: 'conflict', field: 'handoff_target_session' },
          stateAfterSourceRefusal: 'failed',
          foreignRefusal: { code: 'conflict', field: 'handoff_target_session' },
          noneRefusal: { code: 'conflict', field: 'handoff_target_session' },
          threadsAfterRefusal: 2,
          activeAfterRefusal: sourceBound.owner,
          sendCallsAfterRefusal: 0,
        });
      }

      // ── H8: the idempotent journal — every replay is a detected duplicate, one prompt ever ──
      {
        const world = makeWorld();
        const { thread, owner } = await bindThread(world, SESSION_CODEX, [SESSION_ACP]);
        const target = world.threads.get(thread.threadId).participants[1].participantId;
        const begun = await world.service.begin({ threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, at: 1 });
        await world.service.attach({ handoffId: begun.handoffId, at: 2 });
        await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 3 });
        await world.service.deliver({ handoffId: begun.handoffId, at: 4 });
        await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-1', at: 5 });
        const duplicatesBefore = world.service.state.duplicates;
        const reBegin = await world.service.begin({ handoffId: begun.handoffId, threadId: thread.threadId, sourceParticipantId: owner, targetParticipantId: target, entries: ENTRIES, checkpointId: begun.checkpoint.checkpointId, at: 6 });
        const duplicatesAfterBegin = world.service.state.duplicates;
        const reAttach = await world.service.attach({ handoffId: begun.handoffId, at: 7 });
        const duplicatesAfterAttach = world.service.state.duplicates;
        const rePrepare = await world.service.prepare({ handoffId: begun.handoffId, prompt: PROMPT, at: 8 });
        const duplicatesAfterPrepare = world.service.state.duplicates;
        const reDeliver = await world.service.deliver({ handoffId: begun.handoffId, at: 9 });
        const duplicatesAfterDeliver = world.service.state.duplicates;
        const reObserve = await world.service.observe({ handoffId: begun.handoffId, nativeEventId: 'evt-1', at: 10 });
        const duplicatesAfterObserve = world.service.state.duplicates;
        check('the journal is the point of no retry: replaying every operation against the same handoff id is a DETECTED DUPLICATE that re-runs nothing — the observed duplicate counter steps 0→1→2→3→4→5 across the five replays, every replayed call returns the current view with the state unchanged at active, the journal still holds exactly one op per rung (5 ops, all applied, none marked duplicate), the prompt send count is exactly 1 and openTarget was called exactly once after ALL the replays, and the active selection stays on the observed target', {
          replayStates: [reBegin.state, reAttach.state, rePrepare.state, reDeliver.state, reObserve.state],
          duplicateTrail: [duplicatesBefore, duplicatesAfterBegin, duplicatesAfterAttach, duplicatesAfterPrepare, duplicatesAfterDeliver, duplicatesAfterObserve],
          opCount: world.service.ops(begun.handoffId).length,
          opKinds: world.service.ops(begun.handoffId).map((op) => op.kind),
          opApplied: world.service.ops(begun.handoffId).map((op) => op.applied),
          opDuplicates: world.service.ops(begun.handoffId).map((op) => op.duplicate),
          sends: world.service.handoff(begun.handoffId).sends,
          sendPromptCalls: world.counters.sendPrompt,
          openTargetCalls: world.counters.openTarget,
          activeNow: world.threads.active(thread.threadId)?.participantId,
          serviceState: { ...world.service.state },
        }, {
          replayStates: ['active', 'active', 'active', 'active', 'active'],
          duplicateTrail: [0, 1, 2, 3, 4, 5],
          opCount: 5,
          opKinds: ['checkpoint', 'attach', 'prepare', 'deliver', 'observe'],
          opApplied: [true, true, true, true, true],
          opDuplicates: [false, false, false, false, false],
          sends: 1,
          sendPromptCalls: 1,
          openTargetCalls: 1,
          activeNow: target,
          serviceState: { handoffs: 1, ops: 5, applied: 5, duplicates: 5, sends: 1, reconciles: 0, failures: 0, closed: false },
        });
      }
    }
    // ── every rejection code the product emitted belongs to the frozen canonical table ──
    const codes = [...observedCodes].sort();
    const browserMembership = await evaluate((list) => window.task34.codeMembership(list), codes);
    protocol.browser.codeMembership = browserMembership;
    record('codeMembership', { codes, browserMembership });
    check('every rejection code the product actually emitted across this case belongs to the frozen canonical ERROR_CODES table, checked in BOTH realms over the list the worker collected — no handoff rejection ever carries a code outside the protocol vocabulary', {
      observedCodes: codes,
      workerAllInTable: codes.every((code) => ERROR_CODES.includes(code)),
      browser: browserMembership,
    }, {
      observedCodes: codes,
      workerAllInTable: true,
      browser: { observedCount: codes.length, missing: [], allObservedCodesInTable: true, distinctObserved: new Set(codes).size },
    });

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task34.errors());
    check('the browser entry logged no error while computing the shared identity contract in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa34-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa34-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task34.domText());
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowthBytes = heapEnd - heapStart;
    record('heap', { heapStart, heapEnd, heapGrowthBytes });
    check('the case stays bounded: real heap growth is under the bound and it exercised a fixed set of owned resources with zero borrowed spawns', {
      heapGrowthBytes,
      heapGrowthUnderBound: heapGrowthBytes < HEAP_BOUND,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    }, {
      heapGrowthBytes,
      heapGrowthUnderBound: true,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
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
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task34Errors ?? [], task34: Boolean(window.task34) })).catch((value) => ({ unavailable: String(value) }));
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'observable-recoverable-cross-harness-handoff', schema: 'runtime-handoff-relay/v1' },
    cleanup: proof.cleanup,
    defects: {
      durableJournalNotWired: {
        severity: 'acceptance-criterion-gap',
        observed: 'the restart table\'s `prepared`-WITH-a-deliver-op branch (a crash between the committed send intent and any native ack) is unreachable in-process, because the single-writer durable store the journal would compose with is design intent, not executed proof',
        contradictsPlanCriterion: 'the plan\'s failure criterion "restart mid-handoff must fail closed to reconcile with no prompt duplicated"',
        coveredInstead: 'the branch is proven at the pure-policy level by driving the exported handoffRecoveryDecision with a record+ops pair shaped exactly as such a crash leaves them (state prepared, ops [checkpoint, attach, prepare, deliver(pending)]) — the decision is reconcile/handoff_interrupted_before_ack with sendAttempted true — and the two REACHABLE restart states are proven over the real service: a restart between prepare and deliver (no deliver op) and a restart after delivered-without-observed',
      },
      journalOpFingerprintGuardUnreachable: {
        severity: 'observation',
        observed: 'journalOp\'s own fingerprint-differing guard (conflict/handoff_op) is unreachable through the public API in a single in-memory process: every caller either pre-checks journal.byKey (enterStep, cancel) or handoffsById (begin) before journalOp runs, so the guard never sees an existing key',
        coveredInstead: 'the reachable fingerprint-differing paths are asserted with observed codes and an unchanged applied counter: a prepare replayed with a DIFFERENT prompt (conflict/handoff_prompt), a reopen with a different source/target identity under the same handoff id (conflict/handoff_duplicate) and a deliver replayed after a failed attempt (conflict/handoff_state)',
      },
      observedRungIsNeverAProjectedState: {
        severity: 'observation',
        observed: 'HANDOFF_LADDER lists `observed` between delivered and active, but projectHandoffState maps observation.observed directly to `active`; no read model ever reports the state `observed`',
        assertedAs: 'the observed rung is represented by the view\'s observed/observedAt/observedBy fields, and the projection order is pinned explicitly (resolution first, then active, then delivered, prepared, attached, checkpoint)',
      },
      checkpointDigestIsPerRun: {
        severity: 'observation',
        observed: 'begin() does not forward its `at` to the checkpoint build, so the checkpoint\'s createdAt is Date.now() and its digest therefore differs between runs even for identical entries',
        assertedAs: 'the carried context hash is proven by EQUALITY (both legs of the round trip report the same digest, and the checkpoint store holds exactly one checkpoint with that digest) plus the pinned deterministic fields (bytes 1138, entryCount 2, the explicit checkpoint id), never by a pinned digest literal',
      },
      harnessMixFilesAbsent: {
        severity: 'out-of-scope',
        observed: 'the harness-mix pinned files (src/main/host/runtime.js:524-527,767-836 and the plan\'s handoff-checkpoints.js / handoff.js) are absent from this environment — searched by filename, directory name and content grep across the worktree, the main repo and node_modules; nothing was found',
        carriedAs: 'no claim in this case rests on them; the end-to-end wiring is task 46\'s surface',
      },
      evidencePageOffsetCarriedForward: {
        severity: 'acceptance-criterion-gap-carried-forward',
        observed: 'task 33\'s independent gate found the MCP tool context.evidence.page advertises optional offset/length in its own inputSchema while TOOL_ARGUMENT_KEYS freezes the accepted keys to [checkpointId, scope, hash], so through the dispatcher a second harness can only ever obtain the FIRST page',
        relevanceToThisCase: 'this case reads NO paged evidence — the handoff carries a bounded context checkpoint by id and digest only — so the gap is carried forward untouched rather than re-proven or worked around',
      },
    },
    evidenceBoundary: 'The real landed bridge services handoffService.js and handoffRecovery.js run in the Node worker composed with the real Thread service (createThreadService + participantService) and the real Checkpoint service (createCheckpointService, task 33), with the four seams the product\'s own signature declares as injection points (openTarget / sendPrompt / cancelSource / isSourceBusy) backed by counting, recording case-owned fakes and the harness session index backed by an in-memory catalog (ladder scenarios) and by REAL JSON files under the private root read back with node:fs (the A→B→A native-session preservation proof). The pure shared contract modules (thread.js / identity.js / capabilities.js) also run in a real headless Chromium served by a case-owned Vite server, proving the canonical binding key, the receiver-side binding parse, the id normalization and the frozen error-code table are engine-independent and equal to the keys the real handoff records carry; no browser shim is needed because none of those modules imports a node:* builtin. The stateful handoff service cannot cross into the browser realm at all (handoffService.js:1 imports node:crypto), so its lifecycle is proven in the worker only and that split is stated rather than papered over. This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 35 owns the Thread/handoff UI), and authors no PASS verdict.',
  };
}
