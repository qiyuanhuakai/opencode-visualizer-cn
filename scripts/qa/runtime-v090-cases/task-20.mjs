// Task 20 registered QA case — bounded entity state and session-level caches.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the real production modules in a real headless Chromium on a
// real Vite server: app/runtime/state.ts, entityCache.ts, selectionScope.ts,
// draftCache.ts, pinStore.ts plus the real DraftStore/IndexedDB. A controlled
// runtime WebSocket wire (inside app/dev/runtime-v090/task20.ts) injects timing
// at the transport seam so the adversarial scenarios are deterministic.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readdirSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased } from './task-20-fixture.mjs';

const root = path.resolve(new URL('../../..', import.meta.url).pathname);
const tree = (directory) => readdirSync(path.join(root, directory), { recursive: true, withFileTypes: true }).filter((entry) => entry.isFile() && /\.(?:js|mjs|ts)$/.test(entry.name)).map((entry) => path.relative(root, path.join(entry.parentPath, entry.name)));
const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const EXPECTED_PIN_PAGE_HASH = '5ec02fc9cf5dfd4f5d443ece1dc7f936d99e180493bad3ad7e373517a6c79a8b';
const EXPECTED_PIN_SAMPLE_HASH = '2d6c5ba04dac51c2835c066f5f73d868a7ca7c458dc5bcd2675164acefa4b946';
const MIB = 1024 * 1024;

export const sourceFiles = [...new Set([
  ...tree('shared/runtime'),
  'app/runtime/state.ts', 'app/runtime/entityCache.ts', 'app/runtime/selectionScope.ts',
  'app/runtime/draftCache.ts', 'app/runtime/draftStore.ts', 'app/runtime/pinStore.ts',
  'app/runtime/client.ts', 'app/runtime/connection.ts', 'app/runtime/migration/draftChunks.ts',
  'app/runtime/historySource.ts', 'app/runtime/historyCache.ts', 'app/composables/useRuntimeState.ts',
  'app/dev/runtime-v090/index.html', 'app/dev/runtime-v090/task20.ts', 'app/dev/runtime-v090/task19.ts',
  ...tree('scripts/qa'), 'package.json',
])];

const PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 20 registered case</title>
<style>:root { color-scheme: light dark; font: 1rem/1.6 system-ui; } body { margin: auto; padding: 1rem; max-width: 48rem; } pre { white-space: pre-wrap; overflow-wrap: anywhere; }</style></head>
<body><main><h1>Task 20 — bounded entity state and session caches</h1><pre id="status" role="status" aria-live="polite">booting</pre></main>
<script type="module">window.__task20Errors=[];window.addEventListener('error',(e)=>window.__task20Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task20Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task20.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-20/qa-case-ownership');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { case: context.case, runDir, checks, observations };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const normalize = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const check = (name, observed, expected) => {
    const left = normalize(observed); const right = normalize(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface: 'real production state/selection/entityCache/draftCache/pinStore in real headless Chromium', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = normalize(value); persist(); };
  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  let browser; let page; let vite;
  try {
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createServer({ configFile: false, appType: 'custom', root: context.root, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    vite.middlewares.use('/qa20', (request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa20/`;
    record('pageUrl', pageUrl);
    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 150000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl);
    await until(() => page.evaluate(() => Boolean(window.task20)), 'task20 browser entry', 30000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    if (context.case === 'happy') {
      await evaluate(() => window.task20.seedPins(100000));
      const pins = await evaluate(() => window.task20.rollingPins());
      record('rollingPins', { rows: pins.rows, total: pins.total, pages: pins.pages, maxPage: pins.maxPage, p95Ms: pins.p95, p95First10kMs: pins.p95First10k, heapPeakBytes: pins.heapPeak, hash: pins.hash, sampleHash: pins.sampleHash });
      check('rolling-100k-pins bounded paging keeps 100000 rows and exact identity hashes with numeric p95/heap recorded', { rows: pins.rows, total: pins.total, pages: pins.pages, maxPage: pins.maxPage, hash: pins.hash, sampleHash: pins.sampleHash, timedPages: pins.pages, heapPeakPositive: pins.heapPeak > 0, p95MsPositive: pins.p95 > 0 }, { rows: 100000, total: 100000, pages: 1000, maxPage: 100, hash: EXPECTED_PIN_PAGE_HASH, sampleHash: EXPECTED_PIN_SAMPLE_HASH, timedPages: 1000, heapPeakPositive: true, p95MsPositive: true });
      await evaluate(() => window.task20.seedDrafts(100000, 'draft100k'));
      const drafts = await evaluate(() => window.task20.rollingDrafts());
      record('rollingDrafts', { headers: drafts.headers, pages: drafts.pages, maxEntries: drafts.maxEntries, maxLedgerBytes: drafts.maxLedger, p95Ms: drafts.p95, p95First10kMs: drafts.p95First10k, heapPeakBytes: drafts.heapPeak, first: drafts.first, last: drafts.last });
      check('rolling-10k/100k-draft-headers bounded at 32 entries with numeric p95/heap and fully released ledger', { headers: drafts.headers, maxEntries: drafts.maxEntries, maxLedgerWithinCap: drafts.maxLedger <= 8 * MIB, ledgerAfter: drafts.ledgerAfter, first: drafts.first, last: drafts.last, heapPeakPositive: drafts.heapPeak > 0, p95MsPositive: drafts.p95 > 0 }, { headers: 100000, maxEntries: 32, maxLedgerWithinCap: true, ledgerAfter: { residentBytes: 0, reservedBytes: 0, entries: 0 }, first: 'draft100k-000000', last: 'draft100k-099999', heapPeakPositive: true, p95MsPositive: true });
      const cross = await evaluate(() => window.task20.crossSourceSwitch());
      record('crossSourceSwitch', cross);
      check('same nativeID different source switch aborts the stale capture and never pollutes the current one', { staleAborted: cross.staleAborted, staleCurrent: cross.staleCurrent, staleGeneration: cross.staleGeneration, currentIsCurrent: cross.currentIsCurrent, currentGeneration: cross.currentGeneration, stateSelectStale: cross.stateSelectStale, stateSelectCurrent: cross.stateSelectCurrent, sameNativeId: cross.sameNativeId, distinctKeys: cross.distinctKeys, distinctKeyCount: cross.distinctKeyCount, priorForeignCurrent: cross.priorForeignCurrent, priorForeignAborted: cross.priorForeignAborted, foreignCurrent: cross.foreignCurrent }, { staleAborted: true, staleCurrent: false, staleGeneration: 1, currentIsCurrent: true, currentGeneration: 2, stateSelectStale: true, stateSelectCurrent: 'same', sameNativeId: true, distinctKeys: true, distinctKeyCount: 2, priorForeignCurrent: false, priorForeignAborted: true, foreignCurrent: true });
      const background = await evaluate(() => window.task20.backgroundSummary());
      record('backgroundSummary', background);
      check('active event and background summary both apply through real state without a native history subscription', { backgroundTitle: background.backgroundTitle, activeTitle: background.activeTitle, appliedEvents: background.appliedEvents, selected: background.selected, invalidated: background.invalidated, nativeHistoryReads: background.nativeHistoryReads }, { backgroundTitle: 'background', activeTitle: 'active', appliedEvents: 2, selected: 1, invalidated: 1, nativeHistoryReads: false });
      const bounded = await evaluate(() => window.task20.boundedCache());
      record('boundedCache', bounded);
      check('bounded cache holds exactly 32 resident copies then refuses more until release', { heldHeaders: bounded.heldHeaders, heldEntries: bounded.heldEntries, openBlocked: bounded.openBlocked, pageBlocked: bounded.pageBlocked, released: bounded.released }, { heldHeaders: 32, heldEntries: 32, openBlocked: 'paused', pageBlocked: 'paused', released: { residentBytes: 0, reservedBytes: 0, entries: 0 } });
    } else {
      const del = await evaluate(() => window.task20.deleteVsSnapshot());
      record('deleteVsSnapshot', del);
      check('canonical deletion survives a completed snapshot and its retry', { before: del.before, afterDelete: del.afterDelete, afterRetry: del.afterRetry, tombstoneDeleted: del.tombstoneDeleted, snapshots: del.snapshots }, { before: true, afterDelete: false, afterRetry: false, tombstoneDeleted: true, snapshots: 2 });
      const loading = await evaluate(() => window.task20.switchWhileLoading());
      record('switchWhileLoading', loading);
      check('switching target while a selection resolve is held retires the old target view without pollution', { capture: loading.capture, otherLoaded: loading.otherLoaded, otherFirstTitle: loading.otherFirstTitle, targetRowPresent: loading.targetRowPresent >= 0, heldCount: loading.heldCount }, { capture: true, otherLoaded: 500, otherFirstTitle: 'title-0', targetRowPresent: true, heldCount: 0 });
      const oversized = await evaluate(() => window.task20.oversizedHistory());
      record('oversizedHistory', oversized);
      check('an oversized (chunked) history entity forces a resnapshot and never becomes resident', { status: oversized.status, errorCode: oversized.errorCode, snapshots: oversized.snapshots, entityResolveCalls: oversized.entityResolveCalls, row0Title: oversized.row0Title, chunkedReferenceBytes: oversized.chunkedReferenceBytes }, { status: 'complete', errorCode: null, snapshots: 2, entityResolveCalls: 1, row0Title: 'title-0', chunkedReferenceBytes: 16 * MIB });
      const isolation = await evaluate(() => window.task20.pageErrorIsolation());
      record('pageErrorIsolation', isolation);
      check('a middle-page source error isolates to its target and never marks the healthy traversal complete', { failureCode: isolation.failureCode, otherStatus: isolation.otherStatus, otherLoaded: isolation.otherLoaded, otherErrorCode: isolation.otherErrorCode, targetStatus: isolation.targetStatus, targetLoaded: isolation.targetLoaded, closed: isolation.closed }, { failureCode: 'source_unavailable', otherStatus: 'error', otherLoaded: 200, otherErrorCode: 'source_unavailable', targetStatus: 'complete', targetLoaded: 500, closed: 1 });
      const beforeAck = await evaluate(() => window.task20.draftBeforeAck());
      record('draftBeforeAck', beforeAck);
      check('draft disconnect before the durable ack recovers the prior committed revision only', { ok: beforeAck.ok, code: beforeAck.code, priorRevision: beforeAck.priorRevision, priorHashMatchesCommitted: beforeAck.priorHash === beforeAck.committedHash, attemptedAbsent: beforeAck.attemptedAbsent }, { ok: false, code: 'unavailable', priorRevision: 1, priorHashMatchesCommitted: true, attemptedAbsent: true });
      const afterAck = await evaluate(() => window.task20.draftAfterAck());
      record('draftAfterAck', afterAck);
      check('draft disconnect after the durable ack recovers the exact new hashes', { revision: afterAck.revision, newHashMatches: afterAck.newHash === afterAck.expectedNewHash, priorRevision: afterAck.priorRevision, bodyBytes: afterAck.bodyBytes }, { revision: 2, newHashMatches: true, priorRevision: 1, bodyBytes: 4096 });
      const quota = await evaluate(() => window.task20.quotaFailure());
      record('quotaFailure', quota);
      check('quota exhaustion refuses the edit with paused while the durable draft stays intact', { ok: quota.ok, code: quota.code, heldEntries: quota.heldEntries, priorRevision: quota.priorRevision, preservedBytes: quota.preservedBytes, released: quota.released }, { ok: false, code: 'paused', heldEntries: 32, priorRevision: 1, preservedBytes: 128, released: { residentBytes: 0, reservedBytes: 0, entries: 0 } });
      const oversizedContent = await evaluate(() => window.task20.oversizedBodyAttachment());
      record('oversizedBodyAttachment', { bodyBytes: oversizedContent.bodyBytes, bodyHash: oversizedContent.bodyHash, attachmentBytes: oversizedContent.attachmentBytes, attachmentHash: oversizedContent.attachmentHash, peakLedgerBytes: oversizedContent.peakLedger, largestChunk: oversizedContent.largest, heapPeakBytes: oversizedContent.heapPeak });
      check('oversized body and attachment are retained losslessly inside the resident budget', { bodyBytes: oversizedContent.bodyBytes, bodyHashMatches: oversizedContent.bodyHash === oversizedContent.bodyExpected, attachmentBytes: oversizedContent.attachmentBytes, attachmentHashMatches: oversizedContent.attachmentHash === oversizedContent.attachmentExpected, largestChunk: oversizedContent.largest, peakLedgerWithinCap: oversizedContent.peakLedger <= 8 * MIB }, { bodyBytes: 4 * MIB, bodyHashMatches: true, attachmentBytes: 8 * MIB, attachmentHashMatches: true, largestChunk: 65536, peakLedgerWithinCap: true });
    }

    const browserErrors = await evaluate(() => window.task20.errors());
    record('browserErrors', browserErrors);
    for (const scheme of ['light', 'dark']) for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, await page.resolveSessionId());
      const filename = path.join(runDir, `browser-${scheme}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      check(`registered renderer ${scheme} ${width} has no horizontal overflow`, await evaluate(() => document.documentElement.scrollWidth <= innerWidth), true);
    }
    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) { proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText, errors: window.task20 ? window.task20.errors() : null })).catch((value) => ({ unavailable: String(value) })); await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined); }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(runDir, 'resources.json'), 'resource-ledger'));
  }
  const classMatchers = {
    stale_state: /bounded paging|stale capture|delet|resnapshot|isolat|retire/,
    cancel_resume: /switch|abort|retire/,
    malformed_input: /oversized|chunked|quota/,
    hung_commands: /held|bounded/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /disconnect|recovers/,
    misleading_success_output: /never becomes resident|refuses the edit/,
    flaky_tests: /retry|recover/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));
  return {
    scenarios, artifacts, adversarialClasses: Object.keys(classEvidence), classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'bounded-entity-state-and-session-caches' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'Real production state.ts/selectionScope.ts/entityCache.ts/draftCache.ts/pinStore.ts execute in a real headless Chromium on a real Vite server with a real IndexedDB. The runtime WebSocket wire is a controlled fixture that injects held responses, deletions, page failures and chunked oversized entities so the adversarial timing is deterministic; no product file is edited and no PASS is authored by this module.',
  };
}
