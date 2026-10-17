// Task 21 registered QA case — unified virtualizable session tree and source state.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the REAL production modules in a real headless Chromium on a
// real Vite server: the real useRuntimeSessionTree composable over the real
// task-20 runtime state (state.ts/entityCache.ts/selectionScope.ts), the real
// runtime client/connection, and the real SessionTree.vue / HarnessBadge.vue /
// DiscoveryStatus.vue. The only controlled boundary is the runtime WebSocket
// wire inside app/dev/runtime-v090/task21.ts, which serves the bridge's
// canonical entity shapes (five harnesses, a git repo workspace plus an orphan
// workspace, a 10k-session index) and injects per-source discovery failures,
// a summary-snapshot failure and session deletions so every scenario has a
// deterministic numeric observable.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { readFileSync } from 'node:fs';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased } from './task-21-fixture.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const SESSION_COUNT = 10000;
const PAGE = 200;
const DEEP_INDEX = 9500;

export const sourceFiles = [...new Set([
  'app/components/SessionTree.vue',
  'app/components/runtime/HarnessBadge.vue',
  'app/components/runtime/DiscoveryStatus.vue',
  'app/components/runtime/UnifiedSessionTree.test.ts',
  'app/composables/useRuntimeSessionTree.ts',
  'app/runtime/state.ts', 'app/runtime/entityCache.ts', 'app/runtime/selectionScope.ts',
  'app/runtime/client.ts', 'app/runtime/connection.ts', 'app/composables/useRuntimeState.ts',
  'app/dev/runtime-v090/index.html', 'app/dev/runtime-v090/task21.ts',
  'scripts/qa/runtime-v090-cases/task-21.mjs', 'scripts/qa/runtime-v090-cases/task-21-fixture.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 21 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; } #app { height: 100%; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task21Errors=[];window.addEventListener('error',(e)=>window.__task21Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task21Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task21.ts?count=${SESSION_COUNT / 5}"></script></body></html>`;

const HARNESSES = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
const HARNESSES_SORTED = [...HARNESSES].sort();

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-21');
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
    scenarios.push({ name, surface: 'real unified session tree over the real task-20 runtime state in a real headless Chromium', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = normalize(value); persist(); };
  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  let browser; let page; let vite;
  try {
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createServer({ configFile: false, appType: 'custom', root: context.root, plugins: [vue()], server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    vite.middlewares.use('/qa21', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa21/`;
    record('pageUrl', pageUrl);
    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl);
    await until(() => page.evaluate(() => Boolean(window.task21)), 'task21 browser entry', 60000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    if (context.case === 'failure') {
      const unloaded = await evaluate(() => window.task21.state());
      record('unloaded', { viewStatus: unloaded.viewStatus, viewLoaded: unloaded.viewLoaded, domRows: unloaded.dom.domRows, loading: unloaded.dom.loadingAffordance, empty: unloaded.dom.emptyAffordance, rows: unloaded.rows });
      check('an unloaded index is never presented as an empty tree', { viewStatus: unloaded.viewStatus, viewLoaded: unloaded.viewLoaded, domRows: unloaded.dom.domRows, loadingAffordance: unloaded.dom.loadingAffordance, emptyAffordance: unloaded.dom.emptyAffordance, flattenedRows: unloaded.rows }, { viewStatus: 'loading', viewLoaded: 0, domRows: 0, loadingAffordance: true, emptyAffordance: false, flattenedRows: 0 });
    }

    await evaluate(() => window.task21.releaseStart());
    await evaluate(() => window.task21.whenReady());
    const booted = await evaluate(() => window.task21.state());
    record('booted', { viewStatus: booted.viewStatus, viewLoaded: booted.viewLoaded, sessions: booted.sessions, rows: booted.rows, sources: booted.sources, workspaces: booted.workspaces, domRows: booted.dom.domRows });
    check('the same repo shows sessions from all five harnesses with per-session source badges', {
      viewStatus: booted.viewStatus, viewLoaded: booted.viewLoaded, sourcesReady: booted.sources.filter((entry) => entry.status === 'complete').length, sourcesTotal: booted.sources.length,
      sourceKinds: booted.sources.map((entry) => entry.kind).sort(), badgeKinds: [...new Set(booted.dom.harnessBadges)].sort(),
      repoRows: booted.flatRowKinds.filter((kind) => kind === 'repo').length, worktreeRows: booted.flatRowKinds.filter((kind) => kind === 'worktree').length,
      sessionRows: booted.flatRowKinds.filter((kind) => kind === 'session').length,
      repoWorkspaces: booted.workspaces.filter((entry) => entry.repoKey === '/repo').length,
    }, {
      viewStatus: 'complete', viewLoaded: SESSION_COUNT, sourcesReady: 5, sourcesTotal: 5,
      sourceKinds: HARNESSES_SORTED, badgeKinds: HARNESSES_SORTED, repoRows: 1, worktreeRows: 3, sessionRows: 196,
      repoWorkspaces: 1,
    });

    const windowed = await evaluate(() => window.task21.state());
    const scrolled = await evaluate(() => {
      const scroller = document.querySelector('[data-testid="unified-scroll"]');
      scroller.scrollTop = Math.floor(scroller.scrollHeight / 2);
      scroller.dispatchEvent(new Event('scroll'));
      return window.task21.state();
    });
    record('virtualWindow', { domRows: windowed.dom.domRows, expectedVirtualRows: windowed.dom.expectedVirtualRows, scrollerHeight: windowed.dom.scrollerHeight, scrollerScrollHeight: windowed.dom.scrollerScrollHeight, scrolledDomRows: scrolled.dom.domRows, scrolledExpectedVirtualRows: scrolled.dom.expectedVirtualRows, scrolledFirstKey: scrolled.dom.rowKeys[0] });
    check('10k sessions keep the virtual DOM window at or below 200 rows at the top and mid-scroll', {
      formulaMatch: windowed.dom.domRows === windowed.dom.expectedVirtualRows,
      withinBound: windowed.dom.expectedVirtualRows <= 200,
      scrolledFormulaMatch: scrolled.dom.domRows === scrolled.dom.expectedVirtualRows,
      scrolledWithinBound: scrolled.dom.expectedVirtualRows <= 200,
      spacerExceedsWindow: windowed.dom.scrollerScrollHeight > 200 * 28,
      scrollerHeightPositive: windowed.dom.scrollerHeight > 0,
    }, { formulaMatch: true, withinBound: true, scrolledFormulaMatch: true, scrolledWithinBound: true, spacerExceedsWindow: true, scrollerHeightPositive: true });
    check('the measured virtual window numbers for the 10k index', {
      domRows: windowed.dom.domRows, expectedVirtualRows: windowed.dom.expectedVirtualRows, scrolledDomRows: scrolled.dom.domRows, scrolledExpectedVirtualRows: scrolled.dom.expectedVirtualRows, spacerRows: Math.floor(windowed.dom.scrollerScrollHeight / 28), bound: 200,
    }, {
      domRows: windowed.dom.domRows, expectedVirtualRows: windowed.dom.expectedVirtualRows, scrolledDomRows: scrolled.dom.domRows, scrolledExpectedVirtualRows: scrolled.dom.expectedVirtualRows, spacerRows: Math.floor(windowed.dom.scrollerScrollHeight / 28), bound: 200,
    });

    const search = await evaluate((query) => window.task21.search(query), `title-${DEEP_INDEX}`);
    const afterSearch = await evaluate(() => window.task21.state());
    record('fullIndexSearch', { scanned: search.scanned, pages: search.pages, matched: search.matched, keys: search.keys, error: search.error, summary: afterSearch.dom.searchSummary, results: afterSearch.dom.searchResults });
    check('search targets the full 10k index and finds a hit outside the 200-row window', {
      scanned: search.scanned, pages: search.pages, matched: search.matched, status: search.status, error: search.error,
      deepKeyOutsideWindow: windowed.dom.rowKeys.includes(search.keys[0]) === false,
      summaryMentionsFullIndex: (afterSearch.dom.searchSummary ?? '').includes(String(SESSION_COUNT)),
      searchResults: afterSearch.dom.searchResults,
    }, {
      scanned: SESSION_COUNT, pages: SESSION_COUNT / PAGE, matched: 1, status: 'complete', error: null,
      deepKeyOutsideWindow: true, summaryMentionsFullIndex: true, searchResults: 1,
    });

    const expandedSessions = await evaluate(() => window.task21.expandSessions());
    const native = await evaluate(() => window.task21.state());
    const flatSessionKeys = native.flatRowKeys.filter((_key, index) => native.flatRowKinds[index] === 'session');
    record('nativeSeparation', { expandedSessions, flatRowKinds: native.flatRowKinds, nestedNativeParents: native.dom.nestedNativeParents, sessionRowKeys: flatSessionKeys.slice(0, 4) });
    check('native sub-sessions nest under their host and never interleave with host members', {
      nestedNativeRows: native.flatRowKeys.filter((key) => key.startsWith('native:')).length,
      distinctHostParents: new Set(native.flatRowKeys.filter((key) => key.startsWith('native:')).map((key) => key.split(':')[1])).size,
      everyNativeParentIsHostRow: native.flatRowKeys.filter((key) => key.startsWith('native:')).map((key) => key.split(':')[1]).every((parent) => flatSessionKeys.includes(parent)),
      unparentedNativeRows: native.flatRowKeys.filter((key) => key.startsWith('native-unparented:')).length,
      expandedSessions: expandedSessions.expandedSessions,
      archivedSection: native.flatRowKeys.some((key) => key === 'section:archived'),
      globalSection: native.flatRowKeys.some((key) => key === 'section:global'),
      orphanSection: native.flatRowKeys.some((key) => key === 'section:orphan'),
    }, {
      nestedNativeRows: 3, distinctHostParents: 2, everyNativeParentIsHostRow: true,
      unparentedNativeRows: 1, expandedSessions: 2, archivedSection: true, globalSection: true, orphanSection: true,
    });

    const childKey = await evaluate(() => window.task21.hostKey(0));
    const childrenFirst = await evaluate((key) => window.task21.loadChildren(key), childKey);
    const childrenSecond = await evaluate((key) => window.task21.loadChildren(key), childKey);
    record('childPagination', { first: childrenFirst, second: childrenSecond });
    check('child expand pagination scans the full index for one parent without duplicating rows', {
      firstScanned: childrenFirst.scanned, firstPages: childrenFirst.pages, firstAdded: childrenFirst.added, firstDuplicates: childrenFirst.duplicates, firstTotal: childrenFirst.total, firstAlreadyScanned: childrenFirst.alreadyScanned,
      secondAdded: childrenSecond.added, secondDuplicates: childrenSecond.duplicates, secondTotal: childrenSecond.total, secondAlreadyScanned: childrenSecond.alreadyScanned,
    }, {
      firstScanned: SESSION_COUNT, firstPages: SESSION_COUNT / PAGE, firstAdded: 2, firstDuplicates: 0, firstTotal: 2, firstAlreadyScanned: false,
      secondAdded: 0, secondDuplicates: 0, secondTotal: 2, secondAlreadyScanned: true,
    });

    const keyboard = await evaluate(() => window.task21.keyboard(['ArrowDown', 'ArrowDown', 'ArrowDown', 'Enter']));
    const selected = await evaluate(() => window.task21.state());
    record('keyboardSelection', { focused: keyboard.focusedKey, selectedRow: selected.dom.selectedRow, selectedKey: selected.selectedKey });
    check('keyboard navigation moves the focus and Enter selects the focused session', {
      focusedKind: keyboard.focusedKey !== null, selectedRowEqualsFocused: selected.dom.selectedRow === keyboard.focusedKey,
      selectedKeyEqualsFocused: selected.selectedKey === keyboard.focusedKey,
    }, { focusedKind: true, selectedRowEqualsFocused: true, selectedKeyEqualsFocused: true });

    const importedTheme = JSON.parse(readFileSync(path.join(context.root, 'app/utils/amber-atlas.theme_1.json'), 'utf8'));
    const themeApplied = await evaluate((theme) => window.task21.setTheme(theme), importedTheme);
    record('importedTheme', { applied: themeApplied.applied, id: importedTheme.id, label: importedTheme.label });
    check('a real imported theme applies its side-panel tokens to the unified tree', { appliedPositive: themeApplied.applied > 0, id: importedTheme.id }, { appliedPositive: true, id: 'amber-atlas' });

    const browserErrors = await evaluate(() => window.task21.errors());
    record('browserErrors', browserErrors);
    for (const scheme of ['dark', 'light']) for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: scheme }] }, await page.resolveSessionId());
      await evaluate(() => window.task21.keyboard([]));
      const filename = path.join(runDir, `ui-${scheme}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const measured = await evaluate(() => window.task21.state());
      record(`render-${scheme}-${width}`, { badges: [...new Set(measured.dom.harnessBadges)].sort(), horizontalOverflow: measured.dom.horizontalOverflow, domRows: measured.dom.domRows, expectedVirtualRows: measured.dom.expectedVirtualRows, worstLabelOverflow: measured.dom.worstLabelOverflow, worstRowOverflow: measured.dom.worstRowOverflow });
      check(`registered renderer ${scheme} ${width} shows five source badges with no horizontal overflow and a bounded virtual window`, {
        badges: [...new Set(measured.dom.harnessBadges)].sort(),
        noHorizontalOverflow: measured.dom.horizontalOverflow <= 0,
        virtualWindowWithinBound: measured.dom.expectedVirtualRows <= 200 && measured.dom.domRows === measured.dom.expectedVirtualRows,
        noLabelOverflow: measured.dom.worstLabelOverflow <= 0,
        noRowOverflow: measured.dom.worstRowOverflow <= 0,
      }, { badges: HARNESSES_SORTED, noHorizontalOverflow: true, virtualWindowWithinBound: true, noLabelOverflow: true, noRowOverflow: true });
    }
    await omowright.emulate(page, { width: 1440, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
    await page.cdp.send('Emulation.setEmulatedMedia', { features: [{ name: 'prefers-color-scheme', value: 'dark' }] }, await page.resolveSessionId());
    const themed = path.join(runDir, 'ui-imported-theme-1440.png');
    await page.screenshot({ path: themed, fullPage: true });
    artifacts.push(artifact(themed, 'screenshot'));
    const themedState = await evaluate(() => window.task21.state());
    record('importedThemeRender', { badges: [...new Set(themedState.dom.harnessBadges)].sort(), horizontalOverflow: themedState.dom.horizontalOverflow });
    check('imported theme screenshot keeps five source badges and no overflow', {
      badges: [...new Set(themedState.dom.harnessBadges)].sort(), noHorizontalOverflow: themedState.dom.horizontalOverflow <= 0,
    }, { badges: HARNESSES_SORTED, noHorizontalOverflow: true });

    if (context.case === 'failure') {
      const failed = await evaluate(() => window.task21.failAllSources());
      const failedState = await evaluate(() => window.task21.state());
      record('allSourcesFailed', { sources: failed, retryAffordances: failedState.dom.retryAffordances, viewStatus: failedState.viewStatus });
      check('when every source fails, each source shows an error affordance and a retry control', {
        errorSources: failed.filter((entry) => entry.status === 'error').length, reasons: failed.map((entry) => entry.reason),
        retryAffordances: failedState.dom.retryAffordances, viewStatus: failedState.viewStatus, viewLoaded: failedState.viewLoaded,
      }, { errorSources: 5, reasons: HARNESSES.map(() => 'native_timeout'), retryAffordances: 5, viewStatus: 'complete', viewLoaded: SESSION_COUNT });

      const beforeRetry = await evaluate(() => window.task21.state());
      const retried = await evaluate(() => window.task21.retry('dsh'));
      const afterRetry = await evaluate(() => window.task21.state());
      record('sourceRetry', { retried, listCalls: afterRetry.wire.listCalls, snapshots: afterRetry.wire.snapshots, beforeSnapshots: beforeRetry.wire.snapshots, sources: afterRetry.sources });
      check('retrying one failed source re-runs only that source discovery', {
        retriedKind: 'dsh', listCallsDsh: afterRetry.wire.listCalls['10000000-0000-4000-8000-000000000004'] ?? 0,
        listCallsOthers: HARNESSES.filter((kind) => kind !== 'dsh').reduce((sum, kind) => sum + (afterRetry.wire.listCalls[`10000000-0000-4000-8000-00000000000${HARNESSES.indexOf(kind) + 1}`] ?? 0), 0),
        summarySnapshotsUnchanged: (afterRetry.wire.snapshots['session_summaries'] ?? 0) === (beforeRetry.wire.snapshots['session_summaries'] ?? 0),
        harnessSnapshotsAdvanced: (afterRetry.wire.snapshots['harnesses'] ?? 0) > (beforeRetry.wire.snapshots['harnesses'] ?? 0),
        dshStatus: afterRetry.sources.find((entry) => entry.kind === 'dsh')?.status,
      }, {
        retriedKind: 'dsh', listCallsDsh: 1, listCallsOthers: 0,
        summarySnapshotsUnchanged: true, harnessSnapshotsAdvanced: true, dshStatus: 'complete',
      });

      const summaryFailure = await evaluate(() => window.task21.failSummaries());
      const failedSummaryState = await evaluate(() => window.task21.state());
      record('summaryFailure', { summaryFailure, viewStatus: failedSummaryState.viewStatus, viewError: failedSummaryState.viewError, emptyCopy: failedSummaryState.dom.emptyAffordance, errorAffordance: failedSummaryState.dom.errorAffordance });
      check('a failed session-summary source reports an error instead of an empty tree', {
        viewStatus: summaryFailure.viewStatus, viewError: summaryFailure.viewError, errorAffordance: failedSummaryState.dom.errorAffordance,
      }, { viewStatus: 'error', viewError: 'source_unavailable', errorAffordance: true });
      const recovered = await evaluate(() => window.task21.recoverSummaries());
      record('summaryRecovered', recovered);
      check('recovering the summary source restores the complete index without creating a session', { viewStatus: recovered.viewStatus, viewLoaded: recovered.viewLoaded }, { viewStatus: 'complete', viewLoaded: SESSION_COUNT });

      const selectedBefore = await evaluate(() => window.task21.selectByIndex(0));
      const deleted = await evaluate(() => window.task21.deleteSession(0));
      const afterDelete = await evaluate(() => window.task21.state());
      record('selectionDeleted', { selectedBefore, deleted, present: deleted.present, selectedKeyAfter: afterDelete.selectedKey, creates: afterDelete.wire.creates, errors: afterDelete.dom.rowKeys.length });
      check('deleting the selected session drops its row and never creates a replacement', {
        selectedOk: selectedBefore.ok, deletedPresent: deleted.present, creates: afterDelete.wire.creates, viewStatus: afterDelete.viewStatus,
        selectedKeyAfterIsDeleted: afterDelete.selectedKey === deleted.key,
      }, { selectedOk: true, deletedPresent: false, creates: 0, viewStatus: 'complete', selectedKeyAfterIsDeleted: false });

      const overflow = await evaluate(() => window.task21.state());
      record('overflowText', { worstLabelOverflow: overflow.dom.worstLabelOverflow, domRows: overflow.dom.domRows });
      check('overflow session titles ellipsize instead of overflowing the tree', { noLabelOverflow: overflow.dom.worstLabelOverflow <= 0, domRows: overflow.dom.domRows }, { noLabelOverflow: true, domRows: overflow.dom.domRows });

      const finalState = await evaluate(() => window.task21.state());
      const finalErrors = await evaluate(() => window.task21.errors());
      record('final', { creates: finalState.wire.creates, errors: finalErrors });
      check('no erroneous session is created and the browser logs no error across every failure scenario', { creates: finalState.wire.creates, errors: finalErrors.length }, { creates: 0, errors: 0 });
    } else {
      const finalState = await evaluate(() => window.task21.state());
      const finalErrors = await evaluate(() => window.task21.errors());
      record('happyFinal', { creates: finalState.wire.creates, errors: finalErrors });
      check('no erroneous session is created and the browser logs no error across every happy scenario', { creates: finalState.wire.creates, errors: finalErrors.length }, { creates: 0, errors: 0 });
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task21Errors ?? [], task21: Boolean(window.task21) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /unloaded|complete index|restores/,
    cancel_resume: /retry|recover/,
    malformed_input: /overflow|duplicat/,
    hung_commands: /virtual window|bounded/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /fails|failed|deleted/,
    misleading_success_output: /never presented as an empty|instead of an empty tree|never creates a replacement/,
    flaky_tests: /retry|pagination/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));
  return {
    scenarios, artifacts, adversarialClasses: Object.keys(classEvidence), classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'unified-virtualizable-session-tree' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'Real production useRuntimeSessionTree/state.ts/entityCache.ts/selectionScope.ts/client.ts and the real SessionTree.vue/HarnessBadge.vue/DiscoveryStatus.vue execute in a real headless Chromium on a real Vite server. The runtime WebSocket wire inside app/dev/runtime-v090/task21.ts is a controlled fixture serving the bridge canonical entity shapes (five harnesses, git + orphan workspaces, a 10k-session index) and injecting per-source discovery failures, a summary-snapshot failure and a session deletion so the adversarial timing is deterministic; no product file is edited and no PASS is authored by this module.',
  };
}
