// Task 32 registered QA case — causal Turn timeline and state projection.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array
// and a run(context) returning a JSON-serialisable result whose scenarios each carry
// assertions with observed === expected. The runner re-invokes this module with
// VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent asserts a clean worker
// receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge service bridge/runtime/threads/turnService.js
//     plus bridge/runtime/threads/timelineProjection.js — the real two-origin ordered
//     projection, the real per-source dedup, the real four independent turn states, the
//     real paged/history/gap read models, the real frozen views and the real explicit-code
//     rejections. Nothing is stubbed: the service takes no injected port.
//   * In a real headless Chromium: the landed app-side twin app/runtime/timeline.ts runs
//     the IDENTICAL script through createTurnTimeline() in a different JS realm, and the
//     case asserts the two read models are equal — every entry (order, seq, entryId, kind,
//     source, at, payload, late, dedupKey), every turn view, the history grouping, the gap
//     list, the paged walk, the state counters and the oversized-payload boundary. The UI
//     (task 35) consumes the app twin while the bridge produces the canonical projection,
//     so divergence between them is a real defect class.
//
// The controlled boundaries are:
//   * none in the product — createTurnService() takes no port; the "restart" is a fresh
//     service instance replaying the same ordered script (the product is storage-free by
//     design, and its own unit test rebuilds exactly this way);
//   * the browser entry is served by a case-owned Vite server and driven by an owned
//     Chromium; NO browser shim is needed because app/runtime/timeline.ts ->
//     shared/runtime/capabilities.js -> shared/runtime/identity.js is pure ESM with no
//     node:* builtin and no bare/aliased specifier (task-30 needed one only because the
//     real Icon component fetches the Iconify API at runtime).
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns
// that — claims no UI rendering (task 35 owns the Thread UI), authors no PASS verdict, and
// edits no product or test file.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-32-fixture.mjs';

import { createTurnService } from '../../../bridge/runtime/threads/turnService.js';
import {
  DEFAULT_TIMELINE_PAGE_LIMIT,
  MAX_TIMELINE_ENTRY_CHARS,
  MAX_TIMELINE_PAGE_LIMIT,
  TIMELINE_ENTRY_KINDS,
  TIMELINE_TERMINAL_REASONS,
  TURN_COMMAND_PHASES,
  TURN_STATE_FLAGS,
  createHostSink,
  createNativeSink,
  entryView,
  parseAt,
  parseCommandPhase,
  parseSeq,
  parseTerminalReason,
  parseTimelineSource,
  parseTurnId,
  parseTurnIdentity,
  sameTurnIdentity,
  timelineDedupKey,
  timelineSourceKey,
  turnIdentity,
  turnView,
} from '../../../bridge/runtime/threads/timelineProjection.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const HEAP_BOUND = 256 * 1024 * 1024;

// Canonical UUIDs (version-4 shape, lowercase) — parseTurnId lowercases, so these are already canonical.
const T1 = '31000000-0000-4000-8000-000000000001';
const T2 = '31000000-0000-4000-8000-000000000002';
const R1 = '32000000-0000-4000-8000-000000000001';
const MISSING = '99999999-9999-4999-8999-999999999999';

const HARNESS_OPENCODE = 'opencode';
const HARNESS_CODEX = 'codex';

// ── the shared script: driven through the bridge service in the worker AND through the
// ── app-side twin in the browser. Both realms must project it identically.
const PROJECT_SCRIPT = [
  ['open', { turnId: T1, causedBy: 'cmd-root', attempt: 1, sourceNativeId: 'nat-1' }],
  ['open', { turnId: T2, parentTurn: T1, causedBy: 'cmd-root', attempt: 2 }],
  ['command', { turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 1000 }],
  ['command', { turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 2000, payload: { text: 'hello' } }],
  ['event', { turnId: T1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'a-1' }, kind: 'tool', at: 3000, seq: 2, payload: { name: 'grep' } }],
  ['event', { turnId: T2, source: { kind: 'native', harness: HARNESS_CODEX, nativeEventId: 'b-1' }, kind: 'interaction', at: 3100, seq: 1, payload: { type: 'permission' } }],
  ['event', { turnId: T1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'a-2' }, kind: 'message', at: 3200, seq: 3, payload: { type: 'delta', text: 'par' } }],
  ['event', { turnId: T2, source: { kind: 'native', harness: HARNESS_CODEX, nativeEventId: 'b-2' }, kind: 'tool', at: 3300, seq: 2, payload: { name: 'read' } }],
  ['event', { turnId: T1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'a-3' }, kind: 'usage', at: 3400, seq: 4, payload: { tokens: 12 } }],
  ['end', { turnId: T1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'a-end' }, terminalReason: 'completed', at: 4000 }],
  ['event', { turnId: T1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'a-late' }, kind: 'message', at: 5000, seq: 5, payload: { type: 'delta', text: 'late' } }],
];

// ── the rejection script: every op but the FIRST is malformed — the first is the one VALID
// ── open that creates the turn the rest of the script then fails against (which is why the
// ── post-script state still has turns: 1). Both realms must return the same code+field for
// ── every op, and the worker's list is additionally pinned to hand-derived expectations.
const REJECTION_SCRIPT = [
  ['open', { turnId: R1, causedBy: 'cmd-root' }],
  ['open', { turnId: '32000000-0000-4000-8000-000000000002', parentTurn: 'not-a-uuid', causedBy: 'cmd-root' }],
  ['open', { turnId: R1, causedBy: 42 }],
  ['open', { turnId: R1, causedBy: 'x'.repeat(513) }],
  ['open', { turnId: R1, attempt: 0 }],
  ['open', { turnId: R1, attempt: 1.5 }],
  ['open', { turnId: R1, parentTurn: 'also-not-a-uuid' }],
  ['open', { turnId: R1, sourceNativeId: '' }],
  ['open', { turnId: R1, causedBy: 'cmd-root', attempt: 2 }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-1' }, kind: 'permission', at: 1, payload: {} }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE }, kind: 'message', at: 1, payload: {} }],
  ['event', { turnId: R1, source: { kind: 'sideways' }, kind: 'message', at: 1, payload: {} }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-2' }, kind: 'message', at: 1, payload: [1, 2] }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-3' }, kind: 'message', at: 1, seq: -1, payload: {} }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-4' }, kind: 'message', at: '__NaN__', payload: {} }],
  ['event', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-5' }, kind: 'message', at: 1, payload: 'plain' }],
  ['event', { turnId: MISSING, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-6' }, kind: 'message', at: 1, payload: {} }],
  ['end', { turnId: R1, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-end' }, terminalReason: 'vibes', at: 1 }],
  ['end', { turnId: R1, source: { kind: 'host', commandId: 'cmd-1' }, terminalReason: 'completed', at: 1 }],
  ['end', { turnId: MISSING, source: { kind: 'native', harness: HARNESS_OPENCODE, nativeEventId: 'ev-end' }, terminalReason: 'completed', at: 1 }],
  ['command', { turnId: R1, commandId: 'cmd-1', phase: 'weird', at: 1 }],
  ['command', { turnId: R1, commandId: '', phase: 'accepted', at: 1 }],
  ['command', { turnId: MISSING, commandId: 'cmd-1', phase: 'accepted', at: 1 }],
  ['page', { limit: 0 }],
  ['page', { limit: 501 }],
  ['page', { limit: 1.5 }],
  ['page', { limit: 10, cursor: -1 }],
  ['page', { limit: 10, turnId: MISSING }],
  ['turn', MISSING],
  ['history', MISSING],
  ['gaps', MISSING],
];

export const sourceFiles = [...new Set([
  // the three product paths this unit owns
  'bridge/runtime/threads/turnService.js',
  'bridge/runtime/threads/timelineProjection.js',
  'app/runtime/timeline.ts',
  'app/runtime/threadTimeline.test.ts',
  // the shared modules the product pulls in
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task32.ts',
  'scripts/qa/runtime-v090-cases/task-32.mjs',
  'scripts/qa/runtime-v090-cases/task-32-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 32 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task32Errors=[];window.addEventListener('error',(e)=>window.__task32Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task32Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task32.ts"></script></body></html>`;

// ── capture helpers: a typed rejection is { code, field }; anything else is loud ──
// BOTH realms must emit the SAME envelope on EVERY path, success included. The browser
// capture (app/dev/runtime-v090/task32.ts) returns { code: null, field: null } on success,
// so a worker returning a bare {} made the cross-realm outcomes stringify comparison
// unreachable for any script with a successful op — outcomesEqual could never be true. The
// browser shape is the typed Rejection contract and the more informative one, so the worker
// mirrors it exactly: same keys, same order, same loudness on a non-TurnError.
const captureSync = (run) => {
  try { run(); return { code: null, field: null }; }
  catch (error) {
    if (error !== null && typeof error === 'object' && 'code' in error && 'field' in error) {
      if (typeof error.code === 'string' && typeof error.field === 'string') return { code: error.code, field: error.field };
    }
    return { code: 'not-a-TurnError', field: String(error) };
  }
};

const nativeSource = (harness, nativeEventId) => ({ kind: 'native', harness, nativeEventId });
const hostSource = (commandId) => ({ kind: 'host', commandId });

/** NaN cannot cross page.evaluate's JSON boundary, so the script carries the sentinel. */
const revive = (input) => {
  if (input !== null && typeof input === 'object' && !Array.isArray(input) && input.at === '__NaN__') {
    return { ...input, at: Number.NaN };
  }
  return input;
};

/** Drives a [op, input] script through a service, capturing each outcome. */
function driveScript(service, script) {
  const outcomes = [];
  for (const [op, rawInput] of script) {
    const input = revive(rawInput);
    outcomes.push(captureSync(() => {
      if (op === 'open') return service.open(input);
      if (op === 'command') return service.command(input);
      if (op === 'event') return service.event(input);
      if (op === 'end') return service.end(input);
      if (op === 'page') return service.page(input);
      if (op === 'turn') return service.turn(input);
      if (op === 'history') return service.history(input);
      if (op === 'gaps') return service.gaps(input);
      throw new Error(`unknown op ${op}`);
    }));
  }
  return outcomes;
}

const entryShape = (entry) => ({
  entryId: entry.entryId, order: entry.order, seq: entry.seq, turnId: entry.turnId, kind: entry.kind,
  source: { ...entry.source }, at: entry.at, payload: entry.payload, late: entry.late, dedupKey: entry.dedupKey,
});

/**
 * The turn shape used for every cross-realm comparison. The observed flags are INCLUDED here:
 * for the shared project script every event succeeds, so both realms observe identically. The
 * one genuine divergence (a REJECTED kind/seq) is asserted separately by its own check, which
 * pins both realms' observed values instead of forcing one side.
 */
const fullTurn = (turn) => ({
  turnId: turn.turnId,
  causedBy: turn.causedBy,
  parentTurn: turn.parentTurn,
  attempt: turn.attempt,
  sourceNativeId: turn.sourceNativeId,
  accepted: turn.accepted, acceptedAt: turn.acceptedAt, acceptedBy: turn.acceptedBy,
  sent: turn.sent, sentAt: turn.sentAt, sentBy: turn.sentBy,
  observed: turn.observed, observedAt: turn.observedAt, observedBy: turn.observedBy,
  terminal: turn.terminal, terminalAt: turn.terminalAt, terminalReason: turn.terminalReason, terminalBy: turn.terminalBy,
  entryCount: turn.entryCount, lastOrder: turn.lastOrder, seqMax: turn.seqMax,
  createdAtIsPositiveInteger: Number.isInteger(turn.createdAt) && turn.createdAt > 0,
});

const workerSnapshot = (service, focus) => {
  const page = service.page({});
  const turns = service.turns();
  const history = service.history(focus);
  const gaps = service.gaps(focus);
  return {
    entries: page.entries.map(entryShape),
    turns: turns.map(fullTurn),
    state: { ...service.state },
    history: {
      turnId: history.turnId,
      entryCount: history.entryCount,
      sources: history.sources.map((group) => ({ source: { ...group.source }, count: group.count, entries: group.entries.map(entryShape) })),
    },
    gaps: [...gaps],
    page: { total: page.total, nextCursor: page.nextCursor, orders: page.entries.map((entry) => entry.order), entryIds: page.entries.map((entry) => entry.entryId) },
    frozen: {
      page: Object.isFrozen(page),
      pageEntries: Object.isFrozen(page.entries),
      entries: page.entries.map((entry) => Object.isFrozen(entry)),
      entrySources: page.entries.map((entry) => Object.isFrozen(entry.source)),
      entryPayloads: page.entries.map((entry) => Object.isFrozen(entry.payload)),
      turns: turns.map((turn) => Object.isFrozen(turn)),
      history: Object.isFrozen(history),
      historySources: Object.isFrozen(history.sources),
      historyGroups: history.sources.map((group) => Object.isFrozen(group)),
      historyGroupEntries: history.sources.map((group) => Object.isFrozen(group.entries)),
      gaps: Object.isFrozen(gaps),
    },
  };
};

/** The oversized-payload boundary, observed in the worker with real byte sizes. */
function workerBoundary(service) {
  const max = MAX_TIMELINE_ENTRY_CHARS;
  const singleOverhead = JSON.stringify({ text: '' }).length;
  const multiOverhead = JSON.stringify({ a: '', b: 1 }).length;
  const exactSingleText = 'x'.repeat(max - singleOverhead);
  const overSingleText = 'x'.repeat(max - singleOverhead + 1);
  const exactMultiText = 'x'.repeat(max - multiOverhead);
  const overMultiText = 'x'.repeat(max - multiOverhead + 1);
  const turn = service.open({ turnId: 'c0000000-0000-4000-8000-00000000000c', causedBy: 'cmd-1' });
  const exactSingle = captureSync(() => service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_CODEX, 'evt-exact-single'), kind: 'message', at: 1, payload: { text: exactSingleText } }));
  const exactSingleSerialized = JSON.stringify({ text: exactSingleText }).length;
  const overSingle = captureSync(() => service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_CODEX, 'evt-over-single'), kind: 'message', at: 2, payload: { text: overSingleText } }));
  const overSingleSerialized = JSON.stringify({ text: overSingleText }).length;
  const exactMulti = captureSync(() => service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_CODEX, 'evt-exact-multi'), kind: 'message', at: 3, payload: { a: exactMultiText, b: 1 } }));
  const exactMultiSerialized = JSON.stringify({ a: exactMultiText, b: 1 }).length;
  const overMulti = captureSync(() => service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_CODEX, 'evt-over-multi'), kind: 'message', at: 4, payload: { a: overMultiText, b: 1 } }));
  const overMultiSerialized = JSON.stringify({ a: overMultiText, b: 1 }).length;
  const retained = service.page({ limit: 10 });
  return {
    maxChars: max,
    singleOverhead,
    multiOverhead,
    exactSingle, exactSingleSerialized, exactSingleTextLength: exactSingleText.length,
    overSingle, overSingleSerialized, overSingleTextLength: overSingleText.length,
    exactMulti, exactMultiSerialized, exactMultiTextLength: exactMultiText.length,
    overMulti, overMultiSerialized, overMultiTextLength: overMultiText.length,
    retainedTotal: retained.total,
    retainedEntryIds: retained.entries.map((entry) => entry.entryId),
    retainedSerializedLengths: retained.entries.map((entry) => JSON.stringify(entry.payload).length),
    retainedPayloadKeys: retained.entries.map((entry) => Object.keys(entry.payload)),
  };
}

/** Does a REJECTED event still mark the turn observed? The bridge observes first (timelineProjection.js:257). */
function workerObservedAfterRejection(probe) {
  const service = createTurnService();
  const turn = service.open({ turnId: 'c0000000-0000-4000-8000-00000000000c', causedBy: 'cmd-1' });
  captureSync(() => {
    if (probe === 'kind') service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'permission', at: 1, payload: {} });
    else if (probe === 'seq') service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 1, seq: -1, payload: {} });
    else if (probe === 'payload') service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 1, payload: [1, 2] });
    else service.event({ turnId: turn.turnId, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: Number.NaN, payload: {} });
  });
  const view = service.turn(turn.turnId);
  return { observed: view.observed, observedAt: view.observedAt, observedBy: view.observedBy };
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-32/cases');
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
      surface: 'real landed bridge Turn service + timeline projection in the Node worker (createTurnService() takes no injected port), plus the landed app-side twin app/runtime/timeline.ts in a real headless Chromium served by a case-owned Vite server',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  persist();

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-32.mjs',
    'scripts/qa/runtime-v090-cases/task-32-fixture.mjs',
    'app/dev/runtime-v090/task32.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the landed app-side twin (no shim: no node:* builtin anywhere)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa32', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa32/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task32 && window.task32.ready)), 'task32 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── the fixed tables are identical in both realms ──
    const workerTables = {
      stateFlags: [...TURN_STATE_FLAGS],
      kinds: [...TIMELINE_ENTRY_KINDS],
      reasons: [...TIMELINE_TERMINAL_REASONS],
      phases: [...TURN_COMMAND_PHASES],
      maxEntryChars: MAX_TIMELINE_ENTRY_CHARS,
      defaultLimit: DEFAULT_TIMELINE_PAGE_LIMIT,
      maxLimit: MAX_TIMELINE_PAGE_LIMIT,
      allTablesFrozen: [TURN_STATE_FLAGS, TIMELINE_ENTRY_KINDS, TIMELINE_TERMINAL_REASONS, TURN_COMMAND_PHASES].every((table) => Object.isFrozen(table)),
    };
    const browserTables = await evaluate(() => window.task32.tables());
    protocol.browser.tables = browserTables;
    record('tables', { worker: workerTables, browser: browserTables });
    check('the fixed state/kind/reason/phase tables, the payload ceiling and the page limits are identical in the browser realm and the bridge worker, and every table is frozen', {
      workerTables,
      browserTables,
      tablesEqual: JSON.stringify(workerTables) === JSON.stringify(browserTables),
    }, {
      workerTables: {
        stateFlags: ['accepted', 'sent', 'observed', 'terminal'],
        kinds: ['message', 'tool', 'thinking', 'interaction', 'usage'],
        reasons: ['completed', 'failed', 'cancelled', 'timeout', 'aborted'],
        phases: ['accepted', 'sent', 'cancelled'],
        maxEntryChars: 262144,
        defaultLimit: 100,
        maxLimit: 500,
        allTablesFrozen: true,
      },
      browserTables: {
        stateFlags: ['accepted', 'sent', 'observed', 'terminal'],
        kinds: ['message', 'tool', 'thinking', 'interaction', 'usage'],
        reasons: ['completed', 'failed', 'cancelled', 'timeout', 'aborted'],
        phases: ['accepted', 'sent', 'cancelled'],
        maxEntryChars: 262144,
        defaultLimit: 100,
        maxLimit: 500,
        allTablesFrozen: true,
      },
      tablesEqual: true,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // CROSS-REALM: the same script projected by the bridge service and by the app-side twin
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const projectService = createTurnService();
    const projectOutcomes = driveScript(projectService, PROJECT_SCRIPT);
    const projectSnapshot = workerSnapshot(projectService, T1);
    const browserProject = await evaluate((payload) => window.task32.drive(payload.script, payload.focus), { script: PROJECT_SCRIPT, focus: T1 });
    protocol.browser.project = browserProject;
    record('projectOutcomes', projectOutcomes);
    check('the bridge service and the app-side twin project the SAME interleaved script into IDENTICAL read models: every entry (order, seq, entryId, kind, source, at, payload, late, dedupKey), both turn views, the per-source history grouping, the gap list, the paged walk, the state counters and the frozen-view flags', {
      browser: browserProject.snapshot,
      worker: projectSnapshot,
      equal: JSON.stringify(browserProject.snapshot) === JSON.stringify(projectSnapshot),
      outcomesEqual: JSON.stringify(browserProject.outcomes) === JSON.stringify(projectOutcomes),
    }, {
      browser: projectSnapshot,
      worker: projectSnapshot,
      equal: true,
      outcomesEqual: true,
    });

    // ── the observed values of that shared script, pinned against the product ──
    check('the shared script projects into the observed timeline: 7 entries in global arrival order across two turns, a host message plus four opencode and two codex natives, one late entry after the native end, and the causal chain T2.parentTurn === T1', {
      orders: projectSnapshot.page.orders,
      entryIds: projectSnapshot.page.entryIds,
      turnIds: projectSnapshot.entries.map((entry) => entry.turnId),
      kinds: projectSnapshot.entries.map((entry) => entry.kind),
      harnesses: projectSnapshot.entries.map((entry) => (entry.source.kind === 'host' ? 'host' : entry.source.harness)),
      seqs: projectSnapshot.entries.map((entry) => entry.seq),
      ats: projectSnapshot.entries.map((entry) => entry.at),
      lateFlags: projectSnapshot.entries.map((entry) => entry.late),
      dedupKeys: projectSnapshot.entries.map((entry) => entry.dedupKey),
      pageTotal: projectSnapshot.page.total,
      nextCursor: projectSnapshot.page.nextCursor,
      state: projectSnapshot.state,
      historyCounts: projectSnapshot.history.sources.map((group) => group.count),
      historyEntryCount: projectSnapshot.history.entryCount,
      gaps: projectSnapshot.gaps,
      parentChain: projectSnapshot.turns.map((turn) => [turn.turnId, turn.parentTurn, turn.causedBy, turn.attempt]),
      acceptedTrail: projectSnapshot.turns.map((turn) => [turn.accepted, turn.acceptedAt, turn.acceptedBy]),
      sentTrail: projectSnapshot.turns.map((turn) => [turn.sent, turn.sentAt, turn.sentBy]),
      terminalTrail: projectSnapshot.turns.map((turn) => [turn.terminal, turn.terminalAt, turn.terminalReason, turn.terminalBy]),
      frozen: projectSnapshot.frozen,
    }, {
      orders: [1, 2, 3, 4, 5, 6, 7],
      entryIds: [T1 + ':1', T1 + ':2', T2 + ':3', T1 + ':4', T2 + ':5', T1 + ':6', T1 + ':7'],
      turnIds: [T1, T1, T2, T1, T2, T1, T1],
      kinds: ['message', 'tool', 'interaction', 'message', 'tool', 'usage', 'message'],
      harnesses: ['host', 'opencode', 'codex', 'opencode', 'codex', 'opencode', 'opencode'],
      seqs: [1, 2, 1, 3, 2, 4, 5],
      ats: [2000, 3000, 3100, 3200, 3300, 3400, 5000],
      lateFlags: [false, false, false, false, false, false, true],
      dedupKeys: [
        'host|cmd-1\u0000cmd-1',
        'native|opencode\u0000a-1',
        'native|codex\u0000b-1',
        'native|opencode\u0000a-2',
        'native|codex\u0000b-2',
        'native|opencode\u0000a-3',
        'native|opencode\u0000a-late',
      ],
      pageTotal: 7,
      nextCursor: null,
      state: { turns: 2, entries: 7, duplicates: 0, superseded: 0, late: 1, closed: false },
      historyCounts: [1, 4],
      historyEntryCount: 5,
      gaps: [],
      parentChain: [
        [T1, null, 'cmd-root', 1],
        [T2, T1, 'cmd-root', 2],
      ],
      acceptedTrail: [[true, 1000, 'cmd-1'], [false, null, null]],
      sentTrail: [[true, 2000, 'cmd-1'], [false, null, null]],
      terminalTrail: [[true, 4000, 'completed', 'native|opencode'], [false, null, null, null]],
      frozen: {
        page: true, pageEntries: true, entries: [true, true, true, true, true, true, true],
        entrySources: [true, true, true, true, true, true, true],
        entryPayloads: [true, true, true, true, true, true, true],
        turns: [true, true], history: true, historySources: true,
        historyGroups: [true, true], historyGroupEntries: [true, true], gaps: true,
      },
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // CROSS-REALM: every rejection carries the same explicit code+field in both realms
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const rejectionService = createTurnService();
    const rejectionOutcomes = driveScript(rejectionService, REJECTION_SCRIPT);
    const browserRejection = await evaluate((payload) => window.task32.drive(payload.script, payload.focus), { script: REJECTION_SCRIPT, focus: R1 });
    protocol.browser.rejection = browserRejection;
    record('rejectionOutcomes', rejectionOutcomes);
    check('every malformed input is refused with the SAME explicit code and field in the browser realm and the bridge worker, and nothing is created by any of them', {
      browser: browserRejection.outcomes,
      worker: rejectionOutcomes,
      equal: JSON.stringify(browserRejection.outcomes) === JSON.stringify(rejectionOutcomes),
      stateAfter: rejectionService.state,
      turnsAfter: rejectionService.turns().length,
    }, {
      // index 0 is the one VALID op (open R1): it SUCCEEDS in both realms, so its envelope is
      // the unified success shape { code: null, field: null } — not a rejection.
      browser: [
        { code: null, field: null }, { code: 'invalid_request', field: 'turn_parent_turn' }, { code: 'invalid_request', field: 'turn_caused_by' },
        { code: 'invalid_request', field: 'turn_caused_by' }, { code: 'invalid_request', field: 'turn_attempt' },
        { code: 'invalid_request', field: 'turn_attempt' }, { code: 'invalid_request', field: 'turn_parent_turn' },
        { code: 'invalid_request', field: 'turn_source_native_id' }, { code: 'conflict', field: 'turn_duplicate' },
        { code: 'invalid_request', field: 'timeline_entry_kind' }, { code: 'invalid_request', field: 'timeline_source' },
        { code: 'invalid_request', field: 'timeline_source' }, { code: 'invalid_request', field: 'timeline_payload' },
        { code: 'invalid_request', field: 'timeline_seq' }, { code: 'invalid_request', field: 'timeline_time' },
        { code: 'invalid_request', field: 'timeline_payload' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'turn_terminal_reason' }, { code: 'invalid_request', field: 'turn_end_source' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'turn_command_phase' },
        { code: 'invalid_request', field: 'turn_command_id' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'timeline_limit' }, { code: 'invalid_request', field: 'timeline_limit' },
        { code: 'invalid_request', field: 'timeline_limit' }, { code: 'invalid_request', field: 'timeline_cursor' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
      ],
      worker: [
        { code: null, field: null }, { code: 'invalid_request', field: 'turn_parent_turn' }, { code: 'invalid_request', field: 'turn_caused_by' },
        { code: 'invalid_request', field: 'turn_caused_by' }, { code: 'invalid_request', field: 'turn_attempt' },
        { code: 'invalid_request', field: 'turn_attempt' }, { code: 'invalid_request', field: 'turn_parent_turn' },
        { code: 'invalid_request', field: 'turn_source_native_id' }, { code: 'conflict', field: 'turn_duplicate' },
        { code: 'invalid_request', field: 'timeline_entry_kind' }, { code: 'invalid_request', field: 'timeline_source' },
        { code: 'invalid_request', field: 'timeline_source' }, { code: 'invalid_request', field: 'timeline_payload' },
        { code: 'invalid_request', field: 'timeline_seq' }, { code: 'invalid_request', field: 'timeline_time' },
        { code: 'invalid_request', field: 'timeline_payload' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'turn_terminal_reason' }, { code: 'invalid_request', field: 'turn_end_source' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'turn_command_phase' },
        { code: 'invalid_request', field: 'turn_command_id' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'timeline_limit' }, { code: 'invalid_request', field: 'timeline_limit' },
        { code: 'invalid_request', field: 'timeline_limit' }, { code: 'invalid_request', field: 'timeline_cursor' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
        { code: 'invalid_request', field: 'timeline_turn_unknown' }, { code: 'invalid_request', field: 'timeline_turn_unknown' },
      ],
      equal: true,
      stateAfter: { turns: 1, entries: 0, duplicates: 0, superseded: 0, late: 0, closed: false },
      turnsAfter: 1,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // CROSS-REALM: the oversized-payload ceiling, observed with real byte sizes in both realms
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const boundaryService = createTurnService();
    const workerBoundaryResult = workerBoundary(boundaryService);
    const browserBoundaryResult = await evaluate(() => window.task32.boundary());
    protocol.browser.boundary = browserBoundaryResult;
    record('boundary', { worker: workerBoundaryResult, browser: browserBoundaryResult });
    check('the 262144-char serialized ceiling is observed with REAL byte sizes in both realms: the exact-boundary payload is accepted and the one-char-over payload is refused with timeline_payload_too_large, for both a single-key and a multi-key payload, and only the two accepted entries are retained', {
      browser: browserBoundaryResult,
      worker: workerBoundaryResult,
      equal: JSON.stringify(browserBoundaryResult) === JSON.stringify(workerBoundaryResult),
    }, {
      browser: {
        maxChars: 262144,
        singleOverhead: 11,
        multiOverhead: 14,
        exactSingle: { code: null, field: null }, exactSingleSerialized: 262144, exactSingleTextLength: 262133,
        overSingle: { code: 'invalid_request', field: 'timeline_payload_too_large' }, overSingleSerialized: 262145, overSingleTextLength: 262134,
        exactMulti: { code: null, field: null }, exactMultiSerialized: 262144, exactMultiTextLength: 262130,
        overMulti: { code: 'invalid_request', field: 'timeline_payload_too_large' }, overMultiSerialized: 262145, overMultiTextLength: 262131,
        retainedTotal: 2,
        retainedEntryIds: ['c0000000-0000-4000-8000-00000000000c:1', 'c0000000-0000-4000-8000-00000000000c:2'],
        retainedSerializedLengths: [262144, 262144],
        retainedPayloadKeys: [['text'], ['a', 'b']],
      },
      worker: {
        maxChars: 262144,
        singleOverhead: 11,
        multiOverhead: 14,
        exactSingle: { code: null, field: null }, exactSingleSerialized: 262144, exactSingleTextLength: 262133,
        overSingle: { code: 'invalid_request', field: 'timeline_payload_too_large' }, overSingleSerialized: 262145, overSingleTextLength: 262134,
        exactMulti: { code: null, field: null }, exactMultiSerialized: 262144, exactMultiTextLength: 262130,
        overMulti: { code: 'invalid_request', field: 'timeline_payload_too_large' }, overMultiSerialized: 262145, overMultiTextLength: 262131,
        retainedTotal: 2,
        retainedEntryIds: ['c0000000-0000-4000-8000-00000000000c:1', 'c0000000-0000-4000-8000-00000000000c:2'],
        retainedSerializedLengths: [262144, 262144],
        retainedPayloadKeys: [['text'], ['a', 'b']],
      },
      equal: true,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // The ONE divergence between the twins, recorded explicitly instead of forced
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const observedProbes = {};
    for (const probe of ['kind', 'seq', 'payload', 'time']) {
      observedProbes[probe] = {
        bridge: workerObservedAfterRejection(probe),
        app: await evaluate((name) => window.task32.observedAfterRejection(name), probe),
      };
    }
    record('observedAfterRejection', observedProbes);
    check('the two twins agree that a rejected payload still observes and a rejected time does not, and the ONE real divergence is recorded rather than forced: the BRIDGE marks the turn observed by an event whose kind/seq is later rejected (observe() runs before recordEntry parses them, timelineProjection.js:256-259) while the APP twin parses kind/seq/time before observing (timeline.ts:641-648) — both observed values are asserted as observed', {
      bridge: {
        kind: observedProbes.kind.bridge,
        seq: observedProbes.seq.bridge,
        payload: observedProbes.payload.bridge,
        time: observedProbes.time.bridge,
      },
      app: {
        kind: observedProbes.kind.app,
        seq: observedProbes.seq.app,
        payload: observedProbes.payload.app,
        time: observedProbes.time.app,
      },
      agreeOnPayload: JSON.stringify(observedProbes.payload.bridge) === JSON.stringify(observedProbes.payload.app),
      agreeOnTime: JSON.stringify(observedProbes.time.bridge) === JSON.stringify(observedProbes.time.app),
      divergenceRecorded: true,
    }, {
      bridge: {
        kind: { observed: true, observedAt: 1, observedBy: 'native|opencode' },
        seq: { observed: true, observedAt: 1, observedBy: 'native|opencode' },
        payload: { observed: true, observedAt: 1, observedBy: 'native|opencode' },
        time: { observed: false, observedAt: null, observedBy: null },
      },
      app: {
        kind: { observed: false, observedAt: null, observedBy: null },
        seq: { observed: false, observedAt: null, observedBy: null },
        payload: { observed: true, observedAt: 1, observedBy: 'native|opencode' },
        time: { observed: false, observedAt: null, observedBy: null },
      },
      agreeOnPayload: true,
      agreeOnTime: true,
      divergenceRecorded: true,
    });

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Failure lane: late event, duplicate terminal, gap epoch, oversized message,
      // response without a turn, cancelled turn's late completion, native ended ≠ Host accepted
      // ══════════════════════════════════════════════════════════════════════════════════════

      // ── F1: a late event is ORDERED explicitly, never silently dropped ──
      const f1 = createTurnService();
      f1.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      f1.command({ turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 1 });
      f1.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 2, payload: { text: 'go' } });
      const f1First = f1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 3, seq: 2, payload: { text: 'one' } });
      const f1End = f1.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end'), terminalReason: 'completed', at: 10 });
      const f1Late = f1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-late'), kind: 'message', at: 30, seq: 3, payload: { text: 'arrived after the end' } });
      const f1LateOlderAt = f1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-late-older'), kind: 'message', at: 5, seq: 4, payload: { text: 'older clock, still late' } });
      const f1DuplicateLate = f1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 40, payload: { text: 'one' } });
      check('a late event is ORDERED explicitly — recorded with late:true and counted in state.late — never rejected and never dropped, and lateness is structural (post-terminal), not clock-based: an event whose `at` PRECEDES the terminal is still late, while a duplicate of a pre-terminal entry keeps its original late:false', {
        endApplied: f1End.applied,
        lateEntryId: f1Late.entry.entryId,
        lateFlag: f1Late.entry.late,
        lateDuplicate: f1Late.duplicate,
        olderAtEntryLate: f1LateOlderAt.entry.late,
        olderAtEntryAt: f1LateOlderAt.entry.at,
        duplicateOfPreTerminal: f1DuplicateLate.duplicate,
        duplicateEntryLate: f1DuplicateLate.entry.late,
        duplicateEntryId: f1DuplicateLate.entry.entryId,
        firstEntryLate: f1First.entry.late,
        pageLates: f1.page({ limit: 10 }).entries.map((entry) => entry.late),
        pageTotal: f1.page({ limit: 10 }).total,
        historyEntryCount: f1.history(T1).entryCount,
        state: f1.state,
        terminalUnchanged: (() => { const view = f1.turn(T1); return { terminal: view.terminal, terminalAt: view.terminalAt, terminalReason: view.terminalReason, terminalBy: view.terminalBy }; })(),
      }, {
        endApplied: true,
        lateEntryId: T1 + ':3',
        lateFlag: true,
        lateDuplicate: false,
        olderAtEntryLate: true,
        olderAtEntryAt: 5,
        duplicateOfPreTerminal: true,
        duplicateEntryLate: false,
        duplicateEntryId: T1 + ':2',
        firstEntryLate: false,
        pageLates: [false, false, true, true],
        pageTotal: 4,
        historyEntryCount: 4,
        state: { turns: 1, entries: 4, duplicates: 1, superseded: 0, late: 2, closed: false },
        terminalUnchanged: { terminal: true, terminalAt: 10, terminalReason: 'completed', terminalBy: 'native|opencode' },
      });

      // ── F2: a duplicate terminal is not applied twice ──
      const f2 = createTurnService();
      f2.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      const f2First = f2.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end-1'), terminalReason: 'completed', at: 10 });
      const f2Second = f2.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end-2'), terminalReason: 'failed', at: 11 });
      const f2Repeat = f2.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end-1'), terminalReason: 'completed', at: 12 });
      const f2OtherHarness = f2.end({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'ev-end-1'), terminalReason: 'timeout', at: 13 });
      const f2HostCancel = f2.command({ turnId: T1, commandId: 'cmd-cancel', phase: 'cancelled', at: 14 });
      check('the FIRST terminal wins and a duplicate is never applied twice: an identical repeat is duplicate (applied:false, superseded:false), a different terminal reason from the same source is superseded, a terminal from another harness is superseded, and a Host cancel arriving after a native end is superseded — none of them rewrites terminalAt, terminalReason or terminalBy', {
        first: { applied: f2First.applied, superseded: f2First.superseded, duplicate: f2First.duplicate },
        second: { applied: f2Second.applied, superseded: f2Second.superseded, duplicate: f2Second.duplicate },
        repeat: { applied: f2Repeat.applied, superseded: f2Repeat.superseded, duplicate: f2Repeat.duplicate },
        otherHarness: { applied: f2OtherHarness.applied, superseded: f2OtherHarness.superseded, duplicate: f2OtherHarness.duplicate },
        hostCancel: { applied: f2HostCancel.applied, superseded: f2HostCancel.superseded, duplicate: f2HostCancel.duplicate },
        view: (() => { const v = f2.turn(T1); return { terminal: v.terminal, terminalAt: v.terminalAt, terminalReason: v.terminalReason, terminalBy: v.terminalBy }; })(),
        state: f2.state,
        historyEntryCount: f2.history(T1).entryCount,
      }, {
        first: { applied: true, superseded: false, duplicate: false },
        second: { applied: false, superseded: true, duplicate: false },
        repeat: { applied: false, superseded: false, duplicate: true },
        otherHarness: { applied: false, superseded: true, duplicate: false },
        hostCancel: { applied: false, superseded: true, duplicate: false },
        view: { terminal: true, terminalAt: 10, terminalReason: 'completed', terminalBy: 'native|opencode' },
        state: { turns: 1, entries: 0, duplicates: 1, superseded: 3, late: 0, closed: false },
        historyEntryCount: 0,
      });

      // ── F3: a gap epoch is detected with real numbers ──
      const f3 = createTurnService();
      f3.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      const gapsAfterTwo = (() => {
        f3.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 1, seq: 1, payload: { text: 'one' } });
        f3.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-2'), kind: 'message', at: 2, seq: 2, payload: { text: 'two' } });
        return [...f3.gaps(T1)];
      })();
      const gapsAfterFour = (() => {
        f3.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-4'), kind: 'message', at: 4, seq: 4, payload: { text: 'four' } });
        return [...f3.gaps(T1)];
      })();
      const gapsAfterSix = (() => {
        f3.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-6'), kind: 'message', at: 6, seq: 6, payload: { text: 'six' } });
        return [...f3.gaps(T1)];
      })();
      const gapsAfterAuto = (() => {
        f3.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-7'), kind: 'message', at: 7, payload: { text: 'auto' } });
        return [...f3.gaps(T1)];
      })();
      f3.open({ turnId: T2, causedBy: 'cmd-1', attempt: 1 });
      check('a sequence gap is DETECTED with real numbers: gaps() reports exactly the missing epochs between the lowest and highest observed seq ([3] after 1,2,4; [3,5] after 1,2,4,6), an auto-assigned seq continues above the maximum instead of filling a gap, and a turn with no seqs reports no gap', {
        gapsAfterTwo,
        gapsAfterFour,
        gapsAfterSix,
        gapsAfterAuto,
        emptyTurnGaps: [...f3.gaps(T2)],
        emptyTurnGapsFrozen: Object.isFrozen(f3.gaps(T2)),
        seqMax: f3.turn(T1).seqMax,
        entryCount: f3.turn(T1).entryCount,
        seqs: f3.page({ limit: 10 }).entries.map((entry) => entry.seq),
      }, {
        gapsAfterTwo: [],
        gapsAfterFour: [3],
        gapsAfterSix: [3, 5],
        gapsAfterAuto: [3, 5],
        emptyTurnGaps: [],
        emptyTurnGapsFrozen: true,
        seqMax: 7,
        entryCount: 5,
        seqs: [1, 2, 4, 6, 7],
      });

      // ── F4: an oversized message is BOUNDED with the observed byte size and retained count ──
      const f4 = createTurnService();
      f4.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      const f4Exact = f4.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'evt-exact-single'), kind: 'message', at: 1, payload: { text: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS - 11) } });
      const f4Over = captureSync(() => f4.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'evt-over-single'), kind: 'message', at: 2, payload: { text: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS - 10) } }));
      const f4MultiExact = f4.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'evt-exact-multi'), kind: 'message', at: 3, payload: { a: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS - 14), b: 1 } });
      const f4MultiOver = captureSync(() => f4.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'evt-over-multi'), kind: 'message', at: 4, payload: { a: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS - 13), b: 1 } }));
      const f4HostOver = captureSync(() => f4.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 5, payload: { text: 'x'.repeat(MAX_TIMELINE_ENTRY_CHARS - 10) } }));
      const f4HostOk = f4.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 6, payload: { text: 'ok' } });
      check('an oversized message is BOUNDED with REAL NUMBERS — not prose: the exact 262144-char serialized payload is accepted and retained (observed serialized length 262144), the one-char-over payload is refused with timeline_payload_too_large and NOT retained (the retained count only grows for accepted payloads), a Host send with an oversized payload is refused without marking the turn sent, and the turn stays usable afterwards', {
        exactEntryId: f4Exact.entry.entryId,
        exactSerialized: JSON.stringify(f4Exact.entry.payload).length,
        exactTextLength: f4Exact.entry.payload.text.length,
        over: f4Over,
        multiExactSerialized: JSON.stringify(f4MultiExact.entry.payload).length,
        multiOver: f4MultiOver,
        hostOver: f4HostOver,
        hostOkApplied: f4HostOk.applied,
        hostOkSent: f4HostOk.turn.sent,
        retainedTotal: f4.page({ limit: 10 }).total,
        retainedSerializedLengths: f4.page({ limit: 10 }).entries.map((entry) => JSON.stringify(entry.payload).length),
        retainedEntryIds: f4.page({ limit: 10 }).entries.map((entry) => entry.entryId),
        state: f4.state,
      }, {
        exactEntryId: T1 + ':1',
        exactSerialized: 262144,
        exactTextLength: 262133,
        over: { code: 'invalid_request', field: 'timeline_payload_too_large' },
        multiExactSerialized: 262144,
        multiOver: { code: 'invalid_request', field: 'timeline_payload_too_large' },
        hostOver: { code: 'invalid_request', field: 'timeline_payload_too_large' },
        hostOkApplied: true,
        hostOkSent: true,
        retainedTotal: 3,
        retainedSerializedLengths: [262144, 262144, 13],
        retainedEntryIds: [T1 + ':1', T1 + ':2', T1 + ':3'],
        state: { turns: 1, entries: 3, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── F5: a response without a turn is refused with an explicit code ──
      const f5 = createTurnService();
      f5.open({ turnId: R1, causedBy: 'cmd-1', attempt: 1 });
      const f5Event = captureSync(() => f5.event({ turnId: MISSING, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 1, payload: {} }));
      const f5End = captureSync(() => f5.end({ turnId: MISSING, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), terminalReason: 'completed', at: 1 }));
      const f5Command = captureSync(() => f5.command({ turnId: MISSING, commandId: 'cmd-1', phase: 'accepted', at: 1 }));
      const f5Turn = captureSync(() => f5.turn(MISSING));
      const f5History = captureSync(() => f5.history(MISSING));
      const f5Gaps = captureSync(() => f5.gaps(MISSING));
      const f5Page = captureSync(() => f5.page({ limit: 10, turnId: MISSING }));
      const f5BadId = captureSync(() => f5.event({ turnId: 'not-a-uuid', source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'message', at: 1, payload: {} }));
      check('a response for an unknown turn is refused with an explicit code and field on every entry point (event, end, command, turn, history, gaps, page) and a malformed turn id is refused before anything else, while the known turn keeps working', {
        event: f5Event, end: f5End, command: f5Command, turn: f5Turn, history: f5History, gaps: f5Gaps, page: f5Page, badId: f5BadId,
        knownTurnStillReadable: f5.turn(R1).turnId,
        knownTurnHistory: f5.history(R1).entryCount,
        knownTurnPage: f5.page({ limit: 10, turnId: R1 }).total,
        state: f5.state,
      }, {
        event: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        end: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        command: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        turn: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        history: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        gaps: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        page: { code: 'invalid_request', field: 'timeline_turn_unknown' },
        badId: { code: 'invalid_request', field: 'timeline_turn_id' },
        knownTurnStillReadable: R1,
        knownTurnHistory: 0,
        knownTurnPage: 0,
        state: { turns: 1, entries: 0, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── F6: a cancelled turn whose completion arrives late is NOT recorded as success ──
      const f6 = createTurnService();
      f6.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      f6.command({ turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 1000 });
      f6.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 2000, payload: { text: 'go' } });
      f6.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'tool', at: 3000, seq: 2, payload: { tool: 'bash' } });
      const f6Cancel = f6.command({ turnId: T1, commandId: 'cmd-cancel', phase: 'cancelled', at: 5000 });
      const f6LateCompletion = f6.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-done'), terminalReason: 'completed', at: 9000 });
      const f6LateEvent = f6.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-late'), kind: 'message', at: 9500, seq: 3, payload: { text: 'late' } });
      check("a cancelled turn whose completion arrives late is NOT recorded as success: the late native end is superseded (applied:false) and the turn STAYS cancelled — terminalReason 'cancelled', terminalAt 5000, terminalBy 'host|cmd-cancel', never 'completed'/9000/'native|opencode' — while the Host accepted/sent states it already had are untouched and the late event is only ordered", {
        cancelApplied: f6Cancel.applied,
        cancelSuperseded: f6Cancel.superseded,
        cancelDuplicate: f6Cancel.duplicate,
        lateCompletion: { applied: f6LateCompletion.applied, superseded: f6LateCompletion.superseded, duplicate: f6LateCompletion.duplicate },
        view: (() => { const v = f6.turn(T1); return { accepted: v.accepted, acceptedAt: v.acceptedAt, acceptedBy: v.acceptedBy, sent: v.sent, sentAt: v.sentAt, sentBy: v.sentBy, terminal: v.terminal, terminalAt: v.terminalAt, terminalReason: v.terminalReason, terminalBy: v.terminalBy }; })(),
        notMarkedSuccessful: f6.turn(T1).terminalReason !== 'completed' && f6.turn(T1).terminalAt !== 9000 && f6.turn(T1).terminalBy !== 'native|opencode',
        lateEventLate: f6LateEvent.entry.late,
        state: f6.state,
        historyEntryCount: f6.history(T1).entryCount,
      }, {
        cancelApplied: true,
        cancelSuperseded: false,
        cancelDuplicate: false,
        lateCompletion: { applied: false, superseded: true, duplicate: false },
        view: { accepted: true, acceptedAt: 1000, acceptedBy: 'cmd-1', sent: true, sentAt: 2000, sentBy: 'cmd-1', terminal: true, terminalAt: 5000, terminalReason: 'cancelled', terminalBy: 'host|cmd-cancel' },
        notMarkedSuccessful: true,
        lateEventLate: true,
        state: { turns: 1, entries: 3, duplicates: 0, superseded: 1, late: 1, closed: false },
        historyEntryCount: 3,
      });

      // ── F7: "native ended is NOT Host accepted" proven directly, not argued ──
      const f7 = createTurnService();
      f7.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1, sourceNativeId: 'codex-turn-1' });
      f7.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-a'), kind: 'thinking', at: 1, payload: { text: 'plan' } });
      f7.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-b'), kind: 'tool', at: 2, payload: { tool: 'bash' } });
      f7.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-c'), kind: 'interaction', at: 3, payload: { id: 'approval-1' } });
      f7.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-d'), kind: 'usage', at: 4, payload: { input: 10, output: 20 } });
      const f7End = f7.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end'), terminalReason: 'completed', at: 5 });
      const f7View = f7.turn(T1);
      f7.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-end'), terminalReason: 'completed', at: 6 });
      f7.end({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'ev-other'), terminalReason: 'failed', at: 7 });
      const f7ViewAfterExtraEnds = f7.turn(T1);
      const f7LateHostAccept = f7.command({ turnId: T1, commandId: 'cmd-late-host', phase: 'accepted', at: 8000 });
      const f7LateHostSend = f7.command({ turnId: T1, commandId: 'cmd-late-host', phase: 'sent', at: 8100, payload: { text: 'late host prompt' } });

      // The structural proof, observed on the exported sinks themselves.
      const structuralTurn = {
        turnId: T1, causedBy: null, parentTurn: null, attempt: 1, sourceNativeId: null,
        host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
        native: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
        entries: [], seen: new Map(), terminalKeys: new Set(), seqs: new Set(), lastOrder: null, seqMax: 0,
      };
      const entryScopeOf = (turn) => {
        let orderCounter = 0;
        return {
          turnId: turn.turnId, entries: turn.entries, seen: turn.seen, seqs: turn.seqs, native: turn.native,
          nextOrder() { orderCounter += 1; return orderCounter; },
          nextSeq() { let max = 0; for (const value of turn.seqs) if (value > max) max = value; return max + 1; },
          note(entry) { turn.seqMax = Math.max(turn.seqMax, entry.seq); turn.lastOrder = Math.max(turn.lastOrder ?? 0, entry.order); },
          publish() {}, markDuplicate() {}, markSuperseded() {}, markLate() {},
        };
      };
      const nativeScopeOf = (turn) => ({ ...entryScopeOf(turn), terminalKeys: turn.terminalKeys });
      const hostScopeOf = (turn) => ({ ...entryScopeOf(turn), host: turn.host, terminalKeys: turn.terminalKeys });
      const structuralNativeSink = createNativeSink(nativeScopeOf(structuralTurn));
      const structuralHostSink = createHostSink(hostScopeOf(structuralTurn));
      const structuralEnd = structuralNativeSink.end({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'x'), terminalReason: 'completed', at: 1 });
      const structuralHostSourceEnd = captureSync(() => structuralNativeSink.end({ turnId: T1, source: hostSource('cmd-x'), terminalReason: 'completed', at: 2 }));
      // A FRESH turn for the Host-cancel leg, so the cancel actually applies and its write path is
      // observed: it terminates through the NATIVE slice and never marks the turn Host-accepted.
      const cancelTurn = {
        turnId: T1, causedBy: null, parentTurn: null, attempt: 1, sourceNativeId: null,
        host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
        native: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
        entries: [], seen: new Map(), terminalKeys: new Set(), seqs: new Set(), lastOrder: null, seqMax: 0,
      };
      const structuralHostCancel = createHostSink(hostScopeOf(cancelTurn)).cancel({ commandId: 'cmd-x', at: 3 });

      check('"native ended is NOT Host accepted" is proven DIRECTLY, not argued: a full native lifecycle driven with NO Host command leaves accepted/sent false with acceptedAt/sentAt/acceptedBy/sentBy null while observed/terminal are true, the extra native ends leave the Host slice untouched, the Host path still works afterwards (a late Host accept/send applies), and the exported sinks themselves prove the split — the native sink exposes ONLY observe/record/end with no accept/send member, the host sink ONLY accept/send/cancel with no end member, a native terminal driven straight through the native sink leaves the host slice of the very same scope untouched, and a host cancel terminates through the NATIVE slice without marking the turn accepted', {
        endApplied: f7End.applied,
        stateFlags: TURN_STATE_FLAGS.map((flag) => f7View[flag]),
        accepted: f7View.accepted, acceptedAt: f7View.acceptedAt, acceptedBy: f7View.acceptedBy,
        sent: f7View.sent, sentAt: f7View.sentAt, sentBy: f7View.sentBy,
        observed: f7View.observed, observedAt: f7View.observedAt, observedBy: f7View.observedBy,
        terminal: f7View.terminal, terminalAt: f7View.terminalAt, terminalReason: f7View.terminalReason, terminalBy: f7View.terminalBy,
        afterExtraEnds: (() => { const v = f7ViewAfterExtraEnds; return { accepted: v.accepted, acceptedAt: v.acceptedAt, acceptedBy: v.acceptedBy, sent: v.sent, sentAt: v.sentAt, sentBy: v.sentBy, terminalReason: v.terminalReason, terminalAt: v.terminalAt }; })(),
        lateHostAcceptApplied: f7LateHostAccept.applied,
        lateHostAcceptView: (() => { const v = f7LateHostAccept.turn; return { accepted: v.accepted, acceptedAt: v.acceptedAt, acceptedBy: v.acceptedBy, sent: v.sent, observed: v.observed, terminal: v.terminal }; })(),
        lateHostSendApplied: f7LateHostSend.applied,
        lateHostSendEntryId: f7LateHostSend.entry.entryId,
        nativeSinkKeys: Object.keys(structuralNativeSink),
        nativeSinkHasAccept: 'accept' in structuralNativeSink,
        nativeSinkHasSend: 'send' in structuralNativeSink,
        hostSinkKeys: Object.keys(structuralHostSink),
        hostSinkHasEnd: 'end' in structuralHostSink,
        hostSinkHasObserve: 'observe' in structuralHostSink,
        hostSinkHasRecord: 'record' in structuralHostSink,
        structuralEnd: { applied: structuralEnd.applied, superseded: structuralEnd.superseded, duplicate: structuralEnd.duplicate },
        structuralNativeState: (() => { const n = structuralTurn.native; return { terminal: n.terminal, terminalReason: n.terminalReason, terminalBy: n.terminalBy }; })(),
        structuralHostState: (() => { const h = structuralTurn.host; return { accepted: h.accepted, acceptedAt: h.acceptedAt, acceptedBy: h.acceptedBy, sent: h.sent, sentAt: h.sentAt, sentBy: h.sentBy }; })(),
        structuralHostSourceEnd,
        structuralHostCancel: { applied: structuralHostCancel.applied, superseded: structuralHostCancel.superseded, duplicate: structuralHostCancel.duplicate },
        structuralHostCancelHostState: (() => { const h = cancelTurn.host; return { accepted: h.accepted, acceptedAt: h.acceptedAt }; })(),
        state: f7.state,
      }, {
        endApplied: true,
        stateFlags: [false, false, true, true],
        accepted: false, acceptedAt: null, acceptedBy: null,
        sent: false, sentAt: null, sentBy: null,
        observed: true, observedAt: 1, observedBy: 'native|opencode',
        terminal: true, terminalAt: 5, terminalReason: 'completed', terminalBy: 'native|opencode',
        afterExtraEnds: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null, terminalReason: 'completed', terminalAt: 5 },
        lateHostAcceptApplied: true,
        lateHostAcceptView: { accepted: true, acceptedAt: 8000, acceptedBy: 'cmd-late-host', sent: false, observed: true, terminal: true },
        lateHostSendApplied: true,
        lateHostSendEntryId: T1 + ':5',
        nativeSinkKeys: ['observe', 'record', 'end'],
        nativeSinkHasAccept: false,
        nativeSinkHasSend: false,
        hostSinkKeys: ['accept', 'send', 'cancel'],
        hostSinkHasEnd: false,
        hostSinkHasObserve: false,
        hostSinkHasRecord: false,
        structuralEnd: { applied: true, superseded: false, duplicate: false },
        structuralNativeState: { terminal: true, terminalReason: 'completed', terminalBy: 'native|opencode' },
        structuralHostState: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
        structuralHostSourceEnd: { code: 'invalid_request', field: 'turn_end_source' },
        structuralHostCancel: { applied: true, superseded: false, duplicate: false },
        structuralHostCancelHostState: { accepted: false, acceptedAt: null },
        state: { turns: 1, entries: 5, duplicates: 1, superseded: 1, late: 1, closed: false },
      });

      // ── F8: the paged read model validates its limit and cursor ──
      const f8 = createTurnService();
      f8.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      for (let index = 0; index < 3; index += 1) {
        f8.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, `ev-${index}`), kind: 'message', at: index + 1, seq: index + 1, payload: { index } });
      }
      check('page() validates its limit (integer 1..500) and cursor (integer >= 0) with explicit codes, treats a null cursor as 0, returns an empty page past the end without losing the total, and refuses an unknown turnId', {
        limitZero: captureSync(() => f8.page({ limit: 0 })),
        limitOver: captureSync(() => f8.page({ limit: 501 })),
        limitFraction: captureSync(() => f8.page({ limit: 1.5 })),
        limitString: captureSync(() => f8.page({ limit: '10' })),
        limitMax: f8.page({ limit: 500 }).total,
        limitDefault: f8.page({}).total,
        cursorNegative: captureSync(() => f8.page({ limit: 10, cursor: -1 })),
        cursorFraction: captureSync(() => f8.page({ limit: 10, cursor: 1.5 })),
        cursorNull: f8.page({ limit: 10, cursor: null }).total,
        cursorPastEnd: (() => { const p = f8.page({ limit: 10, cursor: 999 }); return { entries: p.entries.length, nextCursor: p.nextCursor, total: p.total }; })(),
        unknownTurn: captureSync(() => f8.page({ limit: 10, turnId: MISSING })),
      }, {
        limitZero: { code: 'invalid_request', field: 'timeline_limit' },
        limitOver: { code: 'invalid_request', field: 'timeline_limit' },
        limitFraction: { code: 'invalid_request', field: 'timeline_limit' },
        limitString: { code: 'invalid_request', field: 'timeline_limit' },
        limitMax: 3,
        limitDefault: 3,
        cursorNegative: { code: 'invalid_request', field: 'timeline_cursor' },
        cursorFraction: { code: 'invalid_request', field: 'timeline_cursor' },
        cursorNull: 3,
        cursorPastEnd: { entries: 0, nextCursor: null, total: 3 },
        unknownTurn: { code: 'invalid_request', field: 'timeline_turn_unknown' },
      });
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════
      // Happy lane: two harnesses interleave, fan-out causal placeholder, restart rebuild,
      // every kind carries its complete source, four independent states
      // ══════════════════════════════════════════════════════════════════════════════════════

      // ── H1: two harnesses interleave tool / permission / delta; the paged timeline shows the
      // ── TRUE interleaved order (asserted as the observed order array, not a boolean) ──
      const h1 = createTurnService();
      h1.open({ turnId: T1, causedBy: 'cmd-root', attempt: 1 });
      h1.command({ turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 1000 });
      h1.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 1100, payload: { text: 'go' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'oc-1'), kind: 'tool', at: 1200, seq: 1, payload: { name: 'grep' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'cx-1'), kind: 'interaction', at: 1300, seq: 1, payload: { type: 'permission' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'oc-2'), kind: 'message', at: 1400, seq: 2, payload: { type: 'delta', text: 'par' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'cx-2'), kind: 'tool', at: 1500, seq: 2, payload: { name: 'read' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'oc-3'), kind: 'thinking', at: 1600, seq: 3, payload: { text: 'plan' } });
      h1.event({ turnId: T1, source: nativeSource(HARNESS_CODEX, 'cx-3'), kind: 'message', at: 1700, seq: 3, payload: { type: 'delta', text: 'tial' } });
      const h1First = h1.page({ limit: 4 });
      const h1Second = h1.page({ limit: 4, cursor: h1First.nextCursor });
      check('two harnesses interleave tool / permission / delta events and the paged timeline reflects the TRUE interleaved arrival order — asserted as the observed order/harness/kind arrays, not a boolean — with a per-source seq that stays monotonic per harness and a stable cursor walk', {
        orders: h1First.entries.map((entry) => entry.order),
        harnesses: h1First.entries.map((entry) => entry.source.harness),
        kinds: h1First.entries.map((entry) => entry.kind),
        seqs: h1First.entries.map((entry) => entry.seq),
        secondOrders: h1Second.entries.map((entry) => entry.order),
        secondHarnesses: h1Second.entries.map((entry) => entry.source.harness),
        secondKinds: h1Second.entries.map((entry) => entry.kind),
        cursors: [h1First.nextCursor, h1Second.nextCursor],
        totals: [h1First.total, h1Second.total],
        historySources: h1.history(T1).sources.map((group) => [timelineSourceKey(group.source), group.count]),
        historyEntryIds: h1.history(T1).sources.map((group) => group.entries.map((entry) => entry.entryId)),
        state: h1.state,
      }, {
        orders: [1, 2, 3, 4],
        harnesses: [null, 'opencode', 'codex', 'opencode'],
        kinds: ['message', 'tool', 'interaction', 'message'],
        seqs: [1, 1, 1, 2],
        secondOrders: [5, 6, 7],
        secondHarnesses: ['codex', 'opencode', 'codex'],
        secondKinds: ['tool', 'thinking', 'message'],
        cursors: [4, null],
        totals: [7, 7],
        historySources: [['host|cmd-1', 1], ['native|opencode', 3], ['native|codex', 3]],
        historyEntryIds: [[T1 + ':1'], [T1 + ':2', T1 + ':4', T1 + ':6'], [T1 + ':3', T1 + ':5', T1 + ':7']],
        state: { turns: 1, entries: 7, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── H2: a fan-out causal placeholder: the causedBy / parentTurn chain is complete ──
      const h2 = createTurnService();
      h2.open({ turnId: T1, causedBy: 'cmd-root', attempt: 1, sourceNativeId: 'nat-root' });
      h2.open({ turnId: T2, causedBy: T1, parentTurn: T1, attempt: 1, sourceNativeId: 'nat-child' });
      h2.open({ turnId: R1, causedBy: T2, parentTurn: T2, attempt: 2 });
      h2.event({ turnId: T2, source: nativeSource(HARNESS_OPENCODE, 'oc-child'), kind: 'tool', at: 10, seq: 1, payload: { name: 'grep' } });
      h2.event({ turnId: R1, source: nativeSource(HARNESS_CODEX, 'cx-grand'), kind: 'message', at: 20, seq: 1, payload: { type: 'delta' } });
      check('a fan-out causal placeholder keeps the causedBy / parentTurn chain complete and correct: the root has no parent, the child is causedBy the root and parentTurn the root, the grandchild is causedBy the child and parentTurn the child, the attempts differ, and the chain is visible in the turn views and the global page', {
        root: (() => { const v = h2.turn(T1); return { causedBy: v.causedBy, parentTurn: v.parentTurn, attempt: v.attempt, sourceNativeId: v.sourceNativeId }; })(),
        child: (() => { const v = h2.turn(T2); return { causedBy: v.causedBy, parentTurn: v.parentTurn, attempt: v.attempt, sourceNativeId: v.sourceNativeId }; })(),
        grand: (() => { const v = h2.turn(R1); return { causedBy: v.causedBy, parentTurn: v.parentTurn, attempt: v.attempt, sourceNativeId: v.sourceNativeId }; })(),
        turns: h2.turns().map((turn) => turn.turnId),
        pageTurnIds: h2.page({ limit: 10 }).entries.map((entry) => entry.turnId),
        pageOrders: h2.page({ limit: 10 }).entries.map((entry) => entry.order),
        identityRoundTrip: sameTurnIdentity(turnIdentity(h2.turn(T2)), parseTurnIdentity({ causedBy: T1, parentTurn: T1, attempt: 1, sourceNativeId: 'nat-child' })),
        identityDiffers: sameTurnIdentity(turnIdentity(h2.turn(T2)), turnIdentity(h2.turn(R1))),
        state: h2.state,
      }, {
        root: { causedBy: 'cmd-root', parentTurn: null, attempt: 1, sourceNativeId: 'nat-root' },
        child: { causedBy: T1, parentTurn: T1, attempt: 1, sourceNativeId: 'nat-child' },
        grand: { causedBy: T2, parentTurn: T2, attempt: 2, sourceNativeId: null },
        turns: [T1, T2, R1],
        pageTurnIds: [T2, R1],
        pageOrders: [1, 2],
        identityRoundTrip: true,
        identityDiffers: false,
        state: { turns: 3, entries: 2, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── H3: a restart rebuilds the timeline consistently ──
      const rebuild = (script) => {
        const service = createTurnService();
        driveScript(service, script);
        return workerSnapshot(service, T1);
      };
      const beforeRestart = rebuild(PROJECT_SCRIPT);
      const afterRestart = rebuild(PROJECT_SCRIPT);
      check('a restart rebuilds the timeline consistently: replaying the same ordered script into a fresh service yields an IDENTICAL projection — the same entry count, the same global order sequence, the same entry ids, the same per-entry source identities, the same turn views, the same history grouping, the same gap list and the same state counters', {
        entryCount: [beforeRestart.entries.length, afterRestart.entries.length],
        orders: [beforeRestart.page.orders, afterRestart.page.orders],
        entryIds: [beforeRestart.page.entryIds, afterRestart.page.entryIds],
        sources: [beforeRestart.entries.map((entry) => entry.source), afterRestart.entries.map((entry) => entry.source)],
        dedupKeys: [beforeRestart.entries.map((entry) => entry.dedupKey), afterRestart.entries.map((entry) => entry.dedupKey)],
        turns: [beforeRestart.turns, afterRestart.turns],
        history: [beforeRestart.history, afterRestart.history],
        gaps: [beforeRestart.gaps, afterRestart.gaps],
        state: [beforeRestart.state, afterRestart.state],
        identical: JSON.stringify(beforeRestart) === JSON.stringify(afterRestart),
      }, {
        entryCount: [7, 7],
        orders: [[1, 2, 3, 4, 5, 6, 7], [1, 2, 3, 4, 5, 6, 7]],
        entryIds: [
          [T1 + ':1', T1 + ':2', T2 + ':3', T1 + ':4', T2 + ':5', T1 + ':6', T1 + ':7'],
          [T1 + ':1', T1 + ':2', T2 + ':3', T1 + ':4', T2 + ':5', T1 + ':6', T1 + ':7'],
        ],
        sources: [
          [
            { kind: 'host', commandId: 'cmd-1' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-1' },
            { kind: 'native', harness: 'codex', nativeEventId: 'b-1' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-2' },
            { kind: 'native', harness: 'codex', nativeEventId: 'b-2' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-3' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-late' },
          ],
          [
            { kind: 'host', commandId: 'cmd-1' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-1' },
            { kind: 'native', harness: 'codex', nativeEventId: 'b-1' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-2' },
            { kind: 'native', harness: 'codex', nativeEventId: 'b-2' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-3' },
            { kind: 'native', harness: 'opencode', nativeEventId: 'a-late' },
          ],
        ],
        dedupKeys: [
          ['host|cmd-1\u0000cmd-1', 'native|opencode\u0000a-1', 'native|codex\u0000b-1', 'native|opencode\u0000a-2', 'native|codex\u0000b-2', 'native|opencode\u0000a-3', 'native|opencode\u0000a-late'],
          ['host|cmd-1\u0000cmd-1', 'native|opencode\u0000a-1', 'native|codex\u0000b-1', 'native|opencode\u0000a-2', 'native|codex\u0000b-2', 'native|opencode\u0000a-3', 'native|opencode\u0000a-late'],
        ],
        turns: [beforeRestart.turns, afterRestart.turns],
        history: [beforeRestart.history, afterRestart.history],
        gaps: [[], []],
        state: [
          { turns: 2, entries: 7, duplicates: 0, superseded: 0, late: 1, closed: false },
          { turns: 2, entries: 7, duplicates: 0, superseded: 0, late: 1, closed: false },
        ],
        identical: true,
      });

      // ── H4: every entry kind carries its COMPLETE source, and no entry is missing one ──
      const h4 = createTurnService();
      h4.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      h4.command({ turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 1 });
      const kindEntries = TIMELINE_ENTRY_KINDS.map((kind, index) => h4.event({
        turnId: T1,
        source: nativeSource(HARNESS_OPENCODE, `ev-${kind}`),
        kind,
        at: 10 + index,
        seq: index + 1,
        payload: { kind, index },
      }).entry);
      const h4HostEntry = h4.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 20, payload: { text: 'host prompt' } }).entry;
      check('message / tool / thinking / interaction / usage each carry their COMPLETE source — the observed source object for every kind, with no entry missing its source — and the host origin carries its commandId, with per-source dedup keys and a per-source history grouping', {
        kinds: kindEntries.map((entry) => entry.kind),
        sources: kindEntries.map((entry) => entry.source),
        entryIds: kindEntries.map((entry) => entry.entryId),
        dedupKeys: kindEntries.map((entry) => entry.dedupKey),
        hostSource: h4HostEntry.source,
        hostEntryId: h4HostEntry.entryId,
        everyEntryHasSource: h4.page({ limit: 10 }).entries.every((entry) => entry.source !== null && typeof entry.source === 'object' && (entry.source.kind === 'host' ? typeof entry.source.commandId === 'string' && entry.source.commandId.length > 0 : typeof entry.source.harness === 'string' && entry.source.harness.length > 0 && typeof entry.source.nativeEventId === 'string' && entry.source.nativeEventId.length > 0)),
        entryKeys: h4.page({ limit: 10 }).entries.map((entry) => Object.keys(entry).sort()),
        historyGroups: h4.history(T1).sources.map((group) => [group.source.kind === 'host' ? group.source.commandId : group.source.harness, group.count]),
        historyEntryCount: h4.history(T1).entryCount,
        state: h4.state,
      }, {
        kinds: ['message', 'tool', 'thinking', 'interaction', 'usage'],
        sources: [
          { kind: 'native', harness: 'opencode', nativeEventId: 'ev-message' },
          { kind: 'native', harness: 'opencode', nativeEventId: 'ev-tool' },
          { kind: 'native', harness: 'opencode', nativeEventId: 'ev-thinking' },
          { kind: 'native', harness: 'opencode', nativeEventId: 'ev-interaction' },
          { kind: 'native', harness: 'opencode', nativeEventId: 'ev-usage' },
        ],
        entryIds: [T1 + ':1', T1 + ':2', T1 + ':3', T1 + ':4', T1 + ':5'],
        dedupKeys: [
          'native|opencode\u0000ev-message',
          'native|opencode\u0000ev-tool',
          'native|opencode\u0000ev-thinking',
          'native|opencode\u0000ev-interaction',
          'native|opencode\u0000ev-usage',
        ],
        hostSource: { kind: 'host', commandId: 'cmd-1' },
        hostEntryId: T1 + ':6',
        everyEntryHasSource: true,
        entryKeys: [
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
          ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
        ],
        historyGroups: [['opencode', 5], ['cmd-1', 1]],
        historyEntryCount: 6,
        state: { turns: 1, entries: 6, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── H5: the four states are INDEPENDENT, with real transition values ──
      const h5 = createTurnService();
      h5.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      const h5Open = h5.turn(T1);
      const h5Accepted = h5.command({ turnId: T1, commandId: 'cmd-1', phase: 'accepted', at: 100 });
      const h5Sent = h5.command({ turnId: T1, commandId: 'cmd-1', phase: 'sent', at: 200, payload: { text: 'go' } });
      const h5Observed = h5.event({ turnId: T1, source: nativeSource(HARNESS_OPENCODE, 'ev-1'), kind: 'tool', at: 300, seq: 2, payload: { name: 'grep' } });
      // SNAPSHOT at the moment of observation: turn() re-reads the live record, so reading it
      // after the cancel below would observe the post-cancel state instead of the post-observe one.
      const h5AfterObserve = h5.turn(T1);
      const h5Terminal = h5.command({ turnId: T1, commandId: 'cmd-cancel', phase: 'cancelled', at: 400 });
      check("the four turn states are INDEPENDENT and each transition is observed with real values: the Host accept writes only accepted/acceptedAt/acceptedBy, the Host send writes only sent/sentAt/sentBy (plus its message entry), the native event writes only observed/observedAt/observedBy, and the Host cancel writes only the native terminal slice as 'cancelled' — leaving accepted and sent exactly as they were", {
        atOpen: [h5Open.accepted, h5Open.acceptedAt, h5Open.acceptedBy, h5Open.sent, h5Open.sentAt, h5Open.sentBy, h5Open.observed, h5Open.observedAt, h5Open.observedBy, h5Open.terminal, h5Open.terminalAt, h5Open.terminalReason, h5Open.terminalBy],
        afterAccept: (() => { const v = h5Accepted.turn; return [v.accepted, v.acceptedAt, v.acceptedBy, v.sent, v.sentAt, v.sentBy, v.observed, v.observedAt, v.observedBy, v.terminal, v.terminalAt, v.terminalReason, v.terminalBy]; })(),
        afterSend: (() => { const v = h5Sent.turn; return [v.accepted, v.acceptedAt, v.acceptedBy, v.sent, v.sentAt, v.sentBy, v.observed, v.observedAt, v.observedBy, v.terminal, v.terminalAt, v.terminalReason, v.terminalBy]; })(),
        afterObserve: (() => { const v = h5AfterObserve; return [v.accepted, v.acceptedAt, v.acceptedBy, v.sent, v.sentAt, v.sentBy, v.observed, v.observedAt, v.observedBy, v.terminal, v.terminalAt, v.terminalReason, v.terminalBy]; })(),
        afterCancel: (() => { const v = h5Terminal.turn; return [v.accepted, v.acceptedAt, v.acceptedBy, v.sent, v.sentAt, v.sentBy, v.observed, v.observedAt, v.observedBy, v.terminal, v.terminalAt, v.terminalReason, v.terminalBy]; })(),
        sendEntryId: h5Sent.entry.entryId,
        sendEntrySource: h5Sent.entry.source,
        observeEntryId: h5Observed.entry.entryId,
        state: h5.state,
      }, {
        atOpen: [false, null, null, false, null, null, false, null, null, false, null, null, null],
        afterAccept: [true, 100, 'cmd-1', false, null, null, false, null, null, false, null, null, null],
        afterSend: [true, 100, 'cmd-1', true, 200, 'cmd-1', false, null, null, false, null, null, null],
        afterObserve: [true, 100, 'cmd-1', true, 200, 'cmd-1', true, 300, 'native|opencode', false, null, null, null],
        afterCancel: [true, 100, 'cmd-1', true, 200, 'cmd-1', true, 300, 'native|opencode', true, 400, 'cancelled', 'host|cmd-cancel'],
        sendEntryId: T1 + ':1',
        sendEntrySource: { kind: 'host', commandId: 'cmd-1' },
        observeEntryId: T1 + ':2',
        state: { turns: 1, entries: 2, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── H6: the paged walk, the per-source history and the frozen read models ──
      const h6 = createTurnService();
      h6.open({ turnId: T1, causedBy: 'cmd-1', attempt: 1 });
      for (let index = 0; index < 7; index += 1) {
        h6.event({ turnId: T1, source: nativeSource(index % 2 === 0 ? HARNESS_OPENCODE : HARNESS_CODEX, `ev-${index}`), kind: 'message', at: index + 1, seq: index + 1, payload: { index } });
      }
      const h6First = h6.page({ limit: 3 });
      const h6Second = h6.page({ limit: 3, cursor: h6First.nextCursor });
      const h6Third = h6.page({ limit: 3, cursor: h6Second.nextCursor });
      const h6All = [...h6First.entries, ...h6Second.entries, ...h6Third.entries];
      const h6Gaps = h6.gaps(T1);
      const h6History = h6.history(T1);
      const h6Turns = h6.turns();
      check('the paged walk covers every entry exactly once in order with a stable cursor, the history groups per source without concatenating them, and every read model is frozen so a later mutation cannot be observed through an earlier view', {
        walkOrders: h6All.map((entry) => entry.order),
        walkEntryIds: h6All.map((entry) => entry.entryId),
        distinctOrders: new Set(h6All.map((entry) => entry.order)).size,
        cursors: [h6First.nextCursor, h6Second.nextCursor, h6Third.nextCursor],
        totals: [h6First.total, h6Second.total, h6Third.total],
        historyGroups: h6History.sources.map((group) => [group.source.harness, group.count]),
        historyEntryIds: h6History.sources.map((group) => group.entries.map((entry) => entry.entryId)),
        historyEntryCount: h6History.entryCount,
        gaps: [...h6Gaps],
        frozen: {
          page: Object.isFrozen(h6First), pageEntries: Object.isFrozen(h6First.entries),
          entries: h6First.entries.map((entry) => Object.isFrozen(entry)),
          entrySources: h6First.entries.map((entry) => Object.isFrozen(entry.source)),
          entryPayloads: h6First.entries.map((entry) => Object.isFrozen(entry.payload)),
          history: Object.isFrozen(h6History), historySources: Object.isFrozen(h6History.sources),
          historyGroups: h6History.sources.map((group) => Object.isFrozen(group)),
          historyGroupEntries: h6History.sources.map((group) => Object.isFrozen(group.entries)),
          gaps: Object.isFrozen(h6Gaps), turns: Object.isFrozen(h6Turns), turnViews: h6Turns.map((turn) => Object.isFrozen(turn)),
        },
        state: h6.state,
      }, {
        walkOrders: [1, 2, 3, 4, 5, 6, 7],
        walkEntryIds: [T1 + ':1', T1 + ':2', T1 + ':3', T1 + ':4', T1 + ':5', T1 + ':6', T1 + ':7'],
        distinctOrders: 7,
        cursors: [3, 6, null],
        totals: [7, 7, 7],
        historyGroups: [['opencode', 4], ['codex', 3]],
        historyEntryIds: [[T1 + ':1', T1 + ':3', T1 + ':5', T1 + ':7'], [T1 + ':2', T1 + ':4', T1 + ':6']],
        historyEntryCount: 7,
        gaps: [],
        frozen: {
          page: true, pageEntries: true, entries: [true, true, true],
          entrySources: [true, true, true], entryPayloads: [true, true, true],
          history: true, historySources: true, historyGroups: [true, true], historyGroupEntries: [true, true],
          gaps: true, turns: true, turnViews: [true],
        },
        state: { turns: 1, entries: 7, duplicates: 0, superseded: 0, late: 0, closed: false },
      });

      // ── H7: the exported pure parsers and the fixed tables, observed directly ──
      check('the exported pure parsers and helpers enforce the same contract the service uses: canonical UUID lowercasing, identity parsing with the attempt default, source-key and per-source dedup-key construction, and explicit-code rejections for a malformed id / source / seq / time / phase / reason', {
        turnId: parseTurnId('AAAAAAAA-AAAA-4AAA-8AAA-AAAAAAAAAAAA'),
        identity: parseTurnIdentity({}),
        identityFull: parseTurnIdentity({ causedBy: 'cmd-1', parentTurn: T1, attempt: 3, sourceNativeId: 'nat-1' }),
        identitySame: sameTurnIdentity(parseTurnIdentity({ causedBy: 'a' }), parseTurnIdentity({ causedBy: 'a' })),
        identityDiffers: sameTurnIdentity(parseTurnIdentity({ causedBy: 'a' }), parseTurnIdentity({ causedBy: 'b' })),
        sourceKeyHost: timelineSourceKey(hostSource('cmd-1')),
        sourceKeyNative: timelineSourceKey(nativeSource('opencode', 'ev-1')),
        dedupHost: timelineDedupKey(hostSource('cmd-1'), 'cmd-1'),
        dedupNative: timelineDedupKey(nativeSource('opencode', 'ev-1'), 'ev-1'),
        at: parseAt(1234),
        seq: parseSeq(7),
        phase: parseCommandPhase('sent'),
        reason: parseTerminalReason('aborted'),
        source: parseTimelineSource(nativeSource('dsh', 'ev-1')),
        rejectTurnId: captureSync(() => parseTurnId('not-a-uuid')),
        rejectSource: captureSync(() => parseTimelineSource({ kind: 'sideways' })),
        rejectSeq: captureSync(() => parseSeq(-1)),
        rejectTime: captureSync(() => parseAt(Number.NaN)),
        rejectPhase: captureSync(() => parseCommandPhase('weird')),
        rejectReason: captureSync(() => parseTerminalReason('vibes')),
        turnViewKeys: Object.keys(turnView({
          turnId: T1, causedBy: null, parentTurn: null, attempt: 1, sourceNativeId: null, createdAt: 1,
          host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
          native: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
          entries: [], lastOrder: null, seqMax: 0,
        })).sort(),
        entryViewKeys: Object.keys(entryView({
          entryId: T1 + ':1', order: 1, seq: 1, turnId: T1, kind: 'message', source: hostSource('cmd-1'), at: 1, payload: {}, late: false, dedupKey: 'k',
        })).sort(),
        viewFrozen: [Object.isFrozen(turnView({
          turnId: T1, causedBy: null, parentTurn: null, attempt: 1, sourceNativeId: null, createdAt: 1,
          host: { accepted: false, acceptedAt: null, acceptedBy: null, sent: false, sentAt: null, sentBy: null },
          native: { observed: false, observedAt: null, observedBy: null, terminal: false, terminalAt: null, terminalReason: null, terminalBy: null },
          entries: [], lastOrder: null, seqMax: 0,
        })), Object.isFrozen(entryView({
          entryId: T1 + ':1', order: 1, seq: 1, turnId: T1, kind: 'message', source: hostSource('cmd-1'), at: 1, payload: {}, late: false, dedupKey: 'k',
        }))],
      }, {
        turnId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
        identity: { causedBy: null, parentTurn: null, attempt: 1, sourceNativeId: null },
        identityFull: { causedBy: 'cmd-1', parentTurn: T1, attempt: 3, sourceNativeId: 'nat-1' },
        identitySame: true,
        identityDiffers: false,
        sourceKeyHost: 'host|cmd-1',
        sourceKeyNative: 'native|opencode',
        dedupHost: 'host|cmd-1\u0000cmd-1',
        dedupNative: 'native|opencode\u0000ev-1',
        at: 1234,
        seq: 7,
        phase: 'sent',
        reason: 'aborted',
        source: { kind: 'native', harness: 'dsh', nativeEventId: 'ev-1' },
        rejectTurnId: { code: 'invalid_request', field: 'timeline_turn_id' },
        rejectSource: { code: 'invalid_request', field: 'timeline_source' },
        rejectSeq: { code: 'invalid_request', field: 'timeline_seq' },
        rejectTime: { code: 'invalid_request', field: 'timeline_time' },
        rejectPhase: { code: 'invalid_request', field: 'turn_command_phase' },
        rejectReason: { code: 'invalid_request', field: 'turn_terminal_reason' },
        turnViewKeys: ['accepted', 'acceptedAt', 'acceptedBy', 'attempt', 'causedBy', 'createdAt', 'entryCount', 'lastOrder', 'observed', 'observedAt', 'observedBy', 'parentTurn', 'sent', 'sentAt', 'sentBy', 'seqMax', 'sourceNativeId', 'terminal', 'terminalAt', 'terminalBy', 'terminalReason', 'turnId'],
        entryViewKeys: ['at', 'dedupKey', 'entryId', 'kind', 'late', 'order', 'payload', 'seq', 'source', 'turnId'],
        viewFrozen: [true, true],
      });
    }

    // ── the browser entry logged no error across the whole case ──
    const browserErrors = await evaluate(() => window.task32.errors());
    check('the browser entry logged no error while projecting the timeline in a second JS realm', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace (the projection surface the browser computed).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa32-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa32-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }
    protocol.browser.domText = await evaluate(() => window.task32.domText());
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
      status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0,
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
    }, {
      status: true,
      authoredFileCount: ownedFiles.length,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task32Errors ?? [], task32: Boolean(window.task32) })).catch((value) => ({ unavailable: String(value) }));
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'causal-turn-timeline-state-projection', schema: 'runtime-turn-timeline/v1' },
    cleanup: proof.cleanup,
    defects: {},
    evidenceBoundary: 'The real landed bridge service bridge/runtime/threads/turnService.js plus timelineProjection.js run in the Node worker with no injected port: the real two-origin ordered projection (Host commands + native events), the real per-source dedup, the real four independent turn states, the real paged/history/gap read models, the real frozen views and the real explicit-code rejections. The landed app-side twin app/runtime/timeline.ts runs the IDENTICAL script in a real headless Chromium served by a case-owned Vite server, and every read model is asserted equal across the two realms; no browser shim is needed because the whole import closure is pure ESM with no node:* builtin and no bare/aliased specifier. The "restart" is a fresh service instance replaying the same ordered script (the product is storage-free by design and its own unit test rebuilds exactly this way). This case performs or claims NO live SSH and NO live Slurm verification (task 46 owns that), claims NO UI rendering (task 35 owns the Thread UI), and authors no PASS verdict.',
  };
}
