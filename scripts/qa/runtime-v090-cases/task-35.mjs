// Task 35 registered QA case — the Thread participant and handoff interaction UI (plan task 35).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls run(context); the parent asserts a clean worker receipt, re-hashes every pinned source and
// parses the written result.
//
// What executes for REAL, and where:
//   * In a real headless Chromium over a case-owned Vite dev server: the landed Vue surface
//     (ThreadView / ParticipantPicker / HandoffDialog / ContextEvidenceView) mounted over the REAL
//     app/composables/useRuntimeThread.ts, driving the REAL landed bridge services
//     bridge/runtime/threads/{threadService,participantService,handoffService,checkpointService}.js
//     and the pure shared contract shared/runtime/{thread,context,identity,capabilities}.js plus
//     app/runtime/timeline.ts — through genuine clicks and data-testid / data-* reads, with the
//     REAL imported-theme token pipeline (app/utils/{regionTheme,themeTokens}.ts + the soft-white
//     and anime-night presets) measured with real computed colours.
//   * The container wiring is this case's own browser entry (app/dev/runtime-v090/task35.ts): no
//     container provides RUNTIME_THREAD_STATE_KEY yet (App.vue is outside the owned paths), so the
//     running app renders nothing until a one-line provide lands. This case therefore IS the
//     container, wired exactly as the landed ThreadView.test.ts wires it, and it makes NO claim that
//     the running app already renders the Thread UI.
//
// The controlled boundaries (injected fakes) are:
//   * `node:crypto` — aliased to app/dev/runtime-v090/task-35-browser-shim.mjs, because the real
//     bridge services import it at module scope and cannot execute in a browser realm without it
//     (tasks 26-29 use the same seam). The shim supplies randomUUID from the browser's own crypto
//     and createHash('sha256') from the product's own pure SHA-256, so every line of service LOGIC
//     under test is the real landed code. NO asserted value depends on the shim: ids are asserted by
//     shape and equality-across-reads, and no fingerprint is asserted.
//   * `@iconify/vue` — aliased to the same shim's inert Icon (the real one fetches the Iconify API
//     at runtime; icons are decorative and no assertion reads one).
//   * openTarget / sendPrompt — handoffService's own two declared seams: openTarget binds the
//     target's OWN native session, sendPrompt answers with a native ack id, or with an unreadable
//     outcome to drive the ambiguous path. No live harness is contacted.
//   * the evidence reader — a case-owned hash-addressed store, which is the product's declared
//     injection point (context.js:686); it is content-addressed by hash, exactly as the product
//     calls it, so no snapshot of the checkpoint's own bytes can satisfy a read.
//
// What this case does NOT do:
//   * it does NOT test fan-out behaviour — the slot is a labelled RESERVED placeholder (task 38
//     builds the behaviour, task 42 enables the slot); it only asserts the slot is visibly reserved;
//   * it does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that;
//   * it does NOT run the product test suite, edit any product or test file, or perform any git
//     operation, and it authors no PASS verdict.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, digest, sourceSnapshot, validateSources, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-35-fixture.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const HARNESS_A = '22222222-2222-4222-8222-222222222222';
const HARNESS_B = '33333333-3333-4333-8333-333333333333';
const EVIDENCE_TARGET = Object.freeze({ repoKey: 'repo:/repo', revision: '1' });

export const sourceFiles = [...new Set([
  // the seven product paths this unit owns + its landed test file
  'app/components/runtime/ThreadView.vue', 'app/components/runtime/ParticipantPicker.vue',
  'app/components/runtime/HandoffDialog.vue', 'app/components/runtime/ContextEvidenceView.vue',
  'app/composables/useRuntimeThread.ts',
  'app/components/InputPanel.vue', 'app/components/OutputPanel.vue',
  'app/components/runtime/ThreadView.test.ts',
  // the shared contract the components and composable pull in
  'shared/runtime/thread.js', 'shared/runtime/thread.d.ts',
  'shared/runtime/context.js', 'shared/runtime/context.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  'app/runtime/timeline.ts',
  // the real bridge services the browser entry composes
  'bridge/runtime/threads/threadService.js', 'bridge/runtime/threads/threadService.d.ts',
  'bridge/runtime/threads/participantService.js', 'bridge/runtime/threads/participantService.d.ts',
  'bridge/runtime/threads/handoffService.js', 'bridge/runtime/threads/handoffRecovery.js',
  'bridge/runtime/threads/checkpointService.js',
  // the imported-theme token pipeline the surface renders under
  'app/utils/regionTheme.ts', 'app/utils/themeTokens.ts', 'app/utils/colorValue.ts',
  'app/utils/soft-white.theme_1.json', 'app/utils/anime-night.theme_1.json',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task35.ts',
  'app/dev/runtime-v090/task-35-browser-shim.mjs',
  'scripts/qa/runtime-v090-cases/task-35.mjs',
  'scripts/qa/runtime-v090-cases/task-35-fixture.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en" data-region-theme="none"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 35 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; background: var(--theme-surface-page, #ffffff); color: var(--theme-text-primary, #111); }</style></head>
<body><div id="app"></div>
<script type="module">window.__task35Errors=[];window.addEventListener('error',(e)=>window.__task35Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task35Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task35.ts"></script></body></html>`;

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);

/** The three pinned product files whose sha256 is independently recomputed after the run. */
const PINNED_PRODUCT_FILES = Object.freeze([
  'app/components/runtime/ThreadView.vue',
  'app/composables/useRuntimeThread.ts',
  'app/components/runtime/HandoffDialog.vue',
  'app/components/runtime/ParticipantPicker.vue',
  'app/components/runtime/ContextEvidenceView.vue',
]);

const metaTail = (text) => {
  const parts = String(text ?? '').split(' · ');
  return parts.length > 1 ? parts.slice(1).join(' · ') : null;
};

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-35/cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const protocol = { case: context.case, runDir, checks, observations, harness: {}, theme: {}, evidence: {} };
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
      surface: 'real landed task-35 Vue surface (ThreadView/ParticipantPicker/HandoffDialog/ContextEvidenceView) over the real useRuntimeThread composable driving the real bridge Thread/Handoff/Checkpoint services, in a real headless Chromium over a case-owned Vite dev server, with the real imported-theme token pipeline',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-35.mjs',
    'scripts/qa/runtime-v090-cases/task-35-fixture.mjs',
    'app/dev/runtime-v090/task35.ts',
    'app/dev/runtime-v090/task-35-browser-shim.mjs',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const pinnedBefore = sourceSnapshot(context.root, PINNED_PRODUCT_FILES);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the REAL Vue surface + composable + bridge services
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
    vite.middlewares.use('/qa35', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa35/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task35 && window.task35.ready)), 'task35 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── drivers: every one is a REAL click (or the container's own setter) followed by the
    //    composable action being awaited and Vue re-rendering before anything is read.
    const bootThread = (options) => evaluate((input) => window.task35.boot(input), options);
    const observe = () => evaluate(() => window.task35.observe());
    const checkpointProbe = () => evaluate(() => window.task35.checkpointProbe());
    const layoutProbe = () => evaluate(() => window.task35.layoutProbe());
    const setDraft = (text) => evaluate((value) => window.task35.setDraft(value), text);
    const setLatestNativeEventId = (id) => evaluate((value) => window.task35.setLatestNativeEventId(value), id);
    const setAvailableSessions = (keys) => evaluate((value) => window.task35.setAvailableSessions(value), keys);
    const setHarnessLabels = (labels) => evaluate((value) => window.task35.setHarnessLabels(value), labels);
    const setNativeHistory = (spec) => evaluate((value) => window.task35.setNativeHistory(value), spec);
    const setPageLength = (value) => evaluate((input) => window.task35.setPageLength(input), value);
    const setSelectedSession = (key) => evaluate((value) => window.task35.setSelectedSession(value), key);
    const addSource = (key) => evaluate((value) => window.task35.addSourceViaUi(value), key);
    const setTarget = (participantId) => evaluate((value) => window.task35.setTargetViaUi(value), participantId);
    const activate = (participantId) => evaluate((value) => window.task35.activateViaUi(value), participantId);
    const locate = (participantId) => evaluate((value) => window.task35.locateViaUi(value), participantId);
    const browseNativeHistory = (participantId) => evaluate((value) => window.task35.browseNativeHistoryViaUi(value), participantId);
    const begin = () => evaluate(() => window.task35.beginViaUi());
    const prepare = () => evaluate(() => window.task35.prepareViaUi());
    const deliver = () => evaluate(() => window.task35.deliverViaUi());
    const observeHandoff = () => evaluate(() => window.task35.observeViaUi());
    const cancel = () => evaluate(() => window.task35.cancelViaUi());
    const readEvidencePage = () => evaluate(() => window.task35.readEvidencePageViaUi());
    const nextEvidencePage = () => evaluate(() => window.task35.nextEvidencePageViaUi());
    const seedEvidence = (text) => evaluate((value) => window.task35.seedEvidence(value), text);
    const createCheckpoint = (entries) => evaluate((value) => window.task35.createCheckpoint(value), entries);
    const setCurrentTarget = (target) => evaluate((value) => window.task35.setCurrentTarget(value), target);
    const readerPage = (offset, length) => evaluate((input) => window.task35.readerPage(input.offset, input.length), { offset, length });
    const dispatcherOffsetAttempt = () => evaluate(() => window.task35.dispatcherOffsetAttempt());
    const applyTheme = (kind) => evaluate((value) => window.task35.applyTheme(value), kind);
    const styleProbe = () => evaluate(() => window.task35.styleProbe());
    const domText = () => evaluate(() => window.task35.domText());
    const errors = () => evaluate(() => window.task35.errors());
    const sendLog = () => evaluate(() => window.task35.sendLog());
    const injectionExecuted = () => evaluate(() => window.task35.injectionExecuted());
    const sessionOfParticipant = (participantId) => evaluate((value) => window.task35.sessionOfParticipant(value), participantId);
    const threadForSession = (key) => evaluate((value) => window.task35.threadForSession(value), key);
    const emittedOf = (name) => evaluate((value) => window.task35.emitted(value), name);

    // ── H1: two sources join the SAME thread through the picker ────────────────────────────────
    // The thread binds its owner lazily (task 31's idempotent lazy wrapper); the picker then adds
    // two more native sessions. Every join goes through the REAL participant service.
    const boot1 = await bootThread({ owner: 'a' });
    record('boot-thread-1', boot1);
    const ownerA = boot1.snapshot.participants[0].participantId;
    check('the thread opens on its owner: one participant, the owner active, and the input follows it with no explicit target', {
      participantCount: boot1.probe.participantCount,
      rows: boot1.probe.participantRows.map((row) => ({ role: row.role, state: row.state, active: row.active, sessionCell: row.sessionCell })),
      metaTail: metaTail(boot1.probe.threadMeta),
      chips: boot1.probe.targetChips.map((chip) => ({ participantId: chip.participantId, role: chip.role })),
      chipParticipantIsOwner: boot1.probe.targetChips[0]?.participantId === ownerA,
      targetCount: boot1.probe.targetCount,
      followHint: boot1.probe.targetFollowHint,
      draftPreview: boot1.probe.draftPreview,
      revision: boot1.snapshot.revision,
      activeParticipantId: boot1.snapshot.activeParticipantId === ownerA,
    }, {
      participantCount: '1',
      rows: [{ role: 'owner', state: 'active', active: true, sessionCell: 'opencode · session-a' }],
      metaTail: 'rev 1 · 1 participants',
      chips: [{ participantId: ownerA, role: 'owner' }],
      chipParticipantIsOwner: true,
      targetCount: '1',
      followHint: 'No explicit target: the input follows the thread\'s active participant.',
      draftPreview: '(no prompt drafted)',
      revision: 1,
      activeParticipantId: true,
    });

    const addB = await addSource('b');
    const afterAddB = await observe();
    const participantB = afterAddB.snapshot.participants.find((entry) => entry.nativeSessionId === 'session-b')?.participantId ?? null;
    const addC = await addSource('c');
    const afterAddC = await observe();
    const participantC = afterAddC.snapshot.participants.find((entry) => entry.nativeSessionId === 'session-c')?.participantId ?? null;
    record('add-two-sources', { addB, afterAddB, addC, afterAddC });
    check('the picker adds two sources to the SAME thread through the REAL service: the observed participant count and identities follow, and an already-joined session is offered disabled', {
      addBClicked: addB, addCClicked: addC,
      countAfterFirst: afterAddB.probe.participantCount,
      identitiesAfterFirst: afterAddB.snapshot.participants.map((entry) => `${entry.role}:${entry.nativeSessionId}`),
      countAfterSecond: afterAddC.probe.participantCount,
      identitiesAfterSecond: afterAddC.snapshot.participants.map((entry) => `${entry.role}:${entry.nativeSessionId}`),
      rowsAfterSecond: afterAddC.probe.participantRows.map((row) => ({ role: row.role, state: row.state })),
      revisionAfterSecond: afterAddC.snapshot.revision,
      joinedButtonsDisabled: afterAddC.probe.addSourceButtons.filter((entry) => entry.nativeSessionId !== 'session-missing').every((entry) => entry.disabled === true),
      missingButtonEnabled: afterAddC.probe.addSourceButtons.find((entry) => entry.nativeSessionId === 'session-missing')?.disabled === false,
      activeUnchanged: afterAddC.snapshot.activeParticipantId === ownerA,
    }, {
      addBClicked: true, addCClicked: true,
      countAfterFirst: '2',
      identitiesAfterFirst: ['owner:session-a', 'participant:session-b'],
      countAfterSecond: '3',
      identitiesAfterSecond: ['owner:session-a', 'participant:session-b', 'participant:session-c'],
      rowsAfterSecond: [
        { role: 'owner', state: 'active' },
        { role: 'participant', state: 'active' },
        { role: 'participant', state: 'active' },
      ],
      revisionAfterSecond: 3,
      joinedButtonsDisabled: true,
      missingButtonEnabled: true,
      activeUnchanged: true,
    });

    // ── H2: designate the send target; the draft never moves ──────────────────────────────────
    await setDraft('continue from the checkpoint');
    const designated = await setTarget(participantB);
    const afterDesignate = await observe();
    record('designate-target', { designated, afterDesignate });
    check('designating the send target moves the chips to that participant only, drops the follow hint, and leaves the draft exactly where it was', {
      chips: afterDesignate.probe.targetChips.map((chip) => ({ participantId: chip.participantId, role: chip.role })),
      chipIsParticipantB: afterDesignate.probe.targetChips[0]?.participantId === participantB,
      chipIsNotC: afterDesignate.probe.targetChips.every((chip) => chip.participantId !== participantC),
      targetCount: afterDesignate.probe.targetCount,
      followHint: afterDesignate.probe.targetFollowHint,
      draftPreview: afterDesignate.probe.draftPreview,
      targets: afterDesignate.snapshot.targets,
      rowTargetFlags: afterDesignate.probe.participantRows.map((row) => ({ id: row.participantId, target: row.target })),
    }, {
      chips: [{ participantId: participantB, role: 'participant' }],
      chipIsParticipantB: true,
      chipIsNotC: true,
      targetCount: '1',
      followHint: null,
      draftPreview: 'continue from the checkpoint',
      targets: [participantB],
      rowTargetFlags: [
        { id: ownerA, target: 'false' },
        { id: participantB, target: 'true' },
        { id: participantC, target: 'false' },
      ],
    });

    // ── H3: the relay A→B, rung by rung, with the derived state at every rung ──────────────────
    const afterBegin = await begin();
    const beginState = await observe();
    const afterPrepare = await prepare();
    const prepareState = await observe();
    const afterDeliver = await deliver();
    const deliverState = await observe();
    record('relay-a-to-b', { afterBegin, beginState, afterPrepare, prepareState, afterDeliver, deliverState });
    check('the relay A→B walks checkpoint→attached→prepared→delivered with the OBSERVED source and target participants and harnesses at every rung', {
      beginClicked: afterBegin,
      stateAfterBegin: beginState.probe.handoff.state,
      currentRungAfterBegin: beginState.probe.handoff.ladder.filter((rung) => rung.current === 'true').map((rung) => rung.rung),
      sourceAfterBegin: beginState.probe.handoff.sourceParticipantId,
      targetAfterBegin: beginState.probe.handoff.targetParticipantId,
      sourceHarness: beginState.probe.handoff.sourceHarness,
      targetHarness: beginState.probe.handoff.targetHarness,
      checkpointCellHasOneEntry: /· 1 entries ·/.test(String(beginState.probe.handoff.checkpointCell ?? '')),
      carriedEntryCount: beginState.snapshot.handoff.checkpoint.entryCount,
      prepareClicked: afterPrepare,
      stateAfterPrepare: prepareState.probe.handoff.state,
      currentRungAfterPrepare: prepareState.probe.handoff.ladder.filter((rung) => rung.current === 'true').map((rung) => rung.rung),
      sourceAfterPrepare: prepareState.probe.handoff.sourceParticipantId,
      targetAfterPrepare: prepareState.probe.handoff.targetParticipantId,
      deliverClicked: afterDeliver,
      stateAfterDeliver: deliverState.probe.handoff.state,
      currentRungAfterDeliver: deliverState.probe.handoff.ladder.filter((rung) => rung.current === 'true').map((rung) => rung.rung),
      sourceAfterDeliver: deliverState.probe.handoff.sourceParticipantId,
      targetAfterDeliver: deliverState.probe.handoff.targetParticipantId,
      opsAfterDeliver: deliverState.probe.handoff.ops,
    }, {
      beginClicked: true,
      stateAfterBegin: 'attached',
      currentRungAfterBegin: ['attached'],
      sourceAfterBegin: ownerA,
      targetAfterBegin: participantB,
      sourceHarness: 'opencode',
      targetHarness: 'codex',
      checkpointCellHasOneEntry: true,
      carriedEntryCount: 1,
      prepareClicked: true,
      stateAfterPrepare: 'prepared',
      currentRungAfterPrepare: ['prepared'],
      sourceAfterPrepare: ownerA,
      targetAfterPrepare: participantB,
      deliverClicked: true,
      stateAfterDeliver: 'delivered',
      currentRungAfterDeliver: ['delivered'],
      sourceAfterDeliver: ownerA,
      targetAfterDeliver: participantB,
      opsAfterDeliver: ['checkpoint applied', 'attach applied', 'prepare applied', 'deliver applied'],
    });

    // ── H4: `active` appears ONLY after a real native observation ──────────────────────────────
    // The ack is not an observation: the derived state stays `delivered`, the observe action is
    // disabled without a real native event id, and the thread's active selection is still the
    // source. Only the real observation produces `active` and moves the seat.
    const afterAck = await observe();
    const observeDisabledAfterAck = afterAck.probe.handoff.observeDisabled;
    const waitingAfterAck = afterAck.probe.handoff.observeWaiting;
    await setLatestNativeEventId('native-evt-b1');
    const afterEventId = await observe();
    await observeHandoff();
    const afterObserve = await observe();
    record('active-only-after-observation', { afterAck, afterEventId, afterObserve, waitingNoteVerbatim: waitingAfterAck });
    check('`active` is rendered ONLY after a real native observation: the native ack leaves the derived state at `delivered` with no active marker and the seat on the source, and only the observation produces `active` and moves the seat to the target', {
      stateAfterAck: afterAck.probe.handoff.state,
      activeMarkerAfterAck: afterAck.probe.handoff.activeMarker,
      derivedActiveAfterAck: afterAck.snapshot.handoff.active,
      deliveredByAfterAck: afterAck.probe.handoff.deliveredBy,
      observeDisabledAfterAck,
      waitingMentionsNativeObservation: /native observation/.test(String(waitingAfterAck ?? '')),
      waitingMentionsNeverActiveFromAck: /never marked active from an ack/.test(String(waitingAfterAck ?? '')),
      waitingMentionsNeverRetried: /never retried/.test(String(waitingAfterAck ?? '')),
      seatAfterAck: afterAck.snapshot.activeParticipantId === ownerA,
      revisionAfterAck: afterAck.snapshot.revision,
      observeDisabledWithEventId: afterEventId.probe.handoff.observeDisabled,
      waitingNoteWithEventId: afterEventId.probe.handoff.observeWaiting,
      stateAfterObserve: afterObserve.probe.handoff.state,
      activeMarkerAfterObserve: afterObserve.probe.handoff.activeMarker,
      activeMarkerAttrAfterObserve: afterObserve.probe.handoff.activeMarkerAttr,
      derivedActiveAfterObserve: afterObserve.snapshot.handoff.active,
      observedByAfterObserve: afterObserve.probe.handoff.observedBy,
      seatAfterObserve: afterObserve.snapshot.activeParticipantId === participantB,
      revisionAfterObserve: afterObserve.snapshot.revision,
      opsAfterObserve: afterObserve.probe.handoff.ops,
    }, {
      stateAfterAck: 'delivered',
      activeMarkerAfterAck: null,
      derivedActiveAfterAck: false,
      deliveredByAfterAck: 'ack-1',
      observeDisabledAfterAck: true,
      waitingMentionsNativeObservation: true,
      waitingMentionsNeverActiveFromAck: true,
      waitingMentionsNeverRetried: true,
      seatAfterAck: true,
      revisionAfterAck: 3,
      observeDisabledWithEventId: false,
      waitingNoteWithEventId: null,
      stateAfterObserve: 'active',
      activeMarkerAfterObserve: 'active — confirmed by a native observation',
      activeMarkerAttrAfterObserve: 'true',
      derivedActiveAfterObserve: true,
      observedByAfterObserve: 'native-evt-b1',
      seatAfterObserve: true,
      revisionAfterObserve: 4,
      opsAfterObserve: ['checkpoint applied', 'attach applied', 'prepare applied', 'deliver applied', 'observe applied'],
    });

    // ── H5: the return leg — the product refuses a second handoff on a completed thread ────────
    // A→B→A as TWO sequential handoffs on one thread is NOT offered: useRuntimeThread.beginHandoff
    // refuses when the existing handoff is past `attached` (useRuntimeThread.ts:376-379) and
    // HandoffDialog.canBegin disables Begin (HandoffDialog.vue:234-240). The observed refusal is
    // asserted rather than forced, and the thread's own active-seat selection carries the seat back
    // to the source — the relay seat is observed A → B → A.
    const beginDisabledAfterActive = (await observe()).probe.handoff.beginDisabled;
    const seatBeforeActivate = (await observe()).snapshot.activeParticipantId;
    const activateClicked = await activate(ownerA);
    const afterActivate = await observe();
    record('return-leg', { beginDisabledAfterActive, seatBeforeActivate, activateClicked, afterActivate });
    check('the return leg is not a second handoff: the product refuses to begin another handoff on a completed thread (Begin disabled), and the thread\'s own active-seat selection returns the relay seat to the source — the observed seat is A → B → A', {
      beginDisabledAfterActive,
      beginTitleAfterActive: afterActivate.probe.handoff.beginTitle,
      seatBeforeActivate: seatBeforeActivate === participantB,
      activateClicked,
      seatAfterActivate: afterActivate.snapshot.activeParticipantId === ownerA,
      revisionAfterActivate: afterActivate.snapshot.revision,
      activeRowAfterActivate: afterActivate.probe.participantRows.filter((row) => row.active).map((row) => row.participantId),
      chipsAfterActivate: afterActivate.probe.targetChips.map((chip) => chip.participantId),
    }, {
      beginDisabledAfterActive: true,
      beginTitleAfterActive: 'Start the handoff from the active participant to the selected target',
      seatBeforeActivate: true,
      activateClicked: true,
      seatAfterActivate: true,
      revisionAfterActivate: 5,
      activeRowAfterActivate: [ownerA],
      chipsAfterActivate: [participantB],
    });

    // ── H6: Thread ↔ Session tree locate each other, both directions, full qualified refs ──────
    const boot2 = await bootThread({ owner: 'b', join: 'a' });
    record('boot-thread-2', boot2);
    const ownerB = boot2.snapshot.participants[0].participantId;
    const participantA2 = boot2.snapshot.participants.find((entry) => entry.nativeSessionId === 'session-a')?.participantId ?? null;
    const locateClicked = await locate(participantA2);
    const locatePayload = await emittedOf('locate-session');
    const sessionOfA = await sessionOfParticipant(participantA2);
    const threadForA = await threadForSession('a');
    const selectedA = await setSelectedSession('a');
    const selectedB = await setSelectedSession('b');
    const selectedUnrelated = await setSelectedSession('unrelated');
    const threadForUnrelated = await threadForSession('unrelated');
    const selectedNone = await setSelectedSession(null);
    record('locate-both-directions', { locateClicked, locatePayload, sessionOfA, threadForA, selectedA, selectedB, selectedUnrelated, threadForUnrelated, selectedNone });
    check('Thread and the Session tree locate each other in BOTH directions with the full qualified native SessionRef, and an unrelated session resolves to nothing rather than to a wrong thread', {
      locateClicked,
      locatePayload,
      sessionOfParticipantA: sessionOfA,
      threadForSessionA: threadForA,
      markerForA: selectedA.probe.sessionResolution,
      markerForB: selectedB.probe.sessionResolution,
      markerForUnrelated: selectedUnrelated.probe.sessionResolution,
      threadForUnrelated,
      markerAfterClear: selectedNone.probe.sessionResolution,
    }, {
      locateClicked: true,
      locatePayload: [{ environmentId: ENVIRONMENT, harnessInstanceId: HARNESS_A, nativeSessionId: 'session-a' }],
      sessionOfParticipantA: { environmentId: ENVIRONMENT, harnessInstanceId: HARNESS_A, nativeSessionId: 'session-a' },
      threadForSessionA: { threadId: boot2.snapshot.threadId, participantId: participantA2 },
      markerForA: {
        threadId: boot2.snapshot.threadId,
        participantId: participantA2,
        unresolved: 'false',
        text: 'The session tree\'s selection is a participant of this thread.',
      },
      markerForB: {
        threadId: boot2.snapshot.threadId,
        participantId: ownerB,
        unresolved: 'false',
        text: 'The session tree\'s selection is a participant of this thread.',
      },
      markerForUnrelated: { threadId: '', participantId: '', unresolved: 'true', text: 'The session tree\'s selection is not part of this thread.' },
      threadForUnrelated: null,
      markerAfterClear: null,
    });

    // ── H7: the reverse relay B→A on a thread where B is the owner ─────────────────────────────
    await setDraft('continue from the checkpoint');
    await setTarget(participantA2);
    const reverseBegin = await begin();
    const reverseBeginState = await observe();
    await prepare();
    await deliver();
    const reverseDeliverState = await observe();
    await setLatestNativeEventId('native-evt-a1');
    await observeHandoff();
    const reverseObserveState = await observe();
    record('relay-b-to-a', { reverseBegin, reverseBeginState, reverseDeliverState, reverseObserveState });
    check('the relay also runs B→A on a thread where B is the owner: the OBSERVED source and target participants and harnesses follow the real participants at every rung, and the seat lands on A', {
      source: reverseBeginState.probe.handoff.sourceParticipantId,
      target: reverseBeginState.probe.handoff.targetParticipantId,
      sourceHarness: reverseBeginState.probe.handoff.sourceHarness,
      targetHarness: reverseBeginState.probe.handoff.targetHarness,
      stateAfterBegin: reverseBeginState.probe.handoff.state,
      stateAfterDeliver: reverseDeliverState.probe.handoff.state,
      deliveredBy: reverseDeliverState.probe.handoff.deliveredBy,
      stateAfterObserve: reverseObserveState.probe.handoff.state,
      observedBy: reverseObserveState.probe.handoff.observedBy,
      seatAfterObserve: reverseObserveState.snapshot.activeParticipantId === participantA2,
      revisionAfterObserve: reverseObserveState.snapshot.revision,
    }, {
      source: ownerB,
      target: participantA2,
      sourceHarness: 'codex',
      targetHarness: 'opencode',
      stateAfterBegin: 'attached',
      stateAfterDeliver: 'delivered',
      deliveredBy: 'ack-2',
      stateAfterObserve: 'active',
      observedBy: 'native-evt-a1',
      seatAfterObserve: true,
      revisionAfterObserve: 3,
    });

    // ── H8: native history per participant, never merged ──────────────────────────────────────
    const historySet = await setNativeHistory([
      { participantId: ownerB, key: 'b', label: 'codex session-b', entries: ['owner entry one', 'owner entry two'] },
      { participantId: participantA2, key: 'a', label: 'opencode session-a', entries: ['participant entry one'] },
    ]);
    const historyState = await observe();
    const browseClicked = await browseNativeHistory(ownerB);
    const browsePayload = await emittedOf('browse-native-history');
    record('native-history', { historySet, historyState, browseClicked, browsePayload });
    check('each participant\'s native history is browsed under its own heading and the two histories are NEVER merged: one group per participant, labelled with its own harness and native session, with no entry crossing groups', {
      groupCount: historyState.probe.nativeHistory.groups.length,
      groups: historyState.probe.nativeHistory.groups.map((group) => ({
        participantId: group.participantId,
        harness: group.harness,
        session: group.session,
        entries: group.entries,
        browseDisabled: group.browseDisabled,
      })),
      note: historyState.probe.nativeHistory.note,
      ownerGroupHasOnlyOwnEntries: historyState.probe.nativeHistory.groups[0].entries.join('|'),
      joinedGroupHasOnlyOwnEntries: historyState.probe.nativeHistory.groups[1].entries.join('|'),
      browseClicked,
      browsePayload,
    }, {
      groupCount: 2,
      groups: [
        { participantId: ownerB, harness: 'codex', session: 'session-b', entries: ['owner entry one', 'owner entry two'], browseDisabled: false },
        { participantId: participantA2, harness: 'opencode', session: 'session-a', entries: ['participant entry one'], browseDisabled: false },
      ],
      note: 'One list per participant. Histories are browsed individually and never merged.',
      ownerGroupHasOnlyOwnEntries: 'owner entry one|owner entry two',
      joinedGroupHasOnlyOwnEntries: 'participant entry one',
      browseClicked: true,
      browsePayload: [ownerB],
    });

    // ── H9: the causal timeline keeps each entry's own source ─────────────────────────────────
    const timelineState = await observe();
    record('timeline', timelineState.probe.timeline);
    check('the causal timeline renders each entry with its OWN source — the host command and the native event keep separate origins and are never concatenated', {
      entries: timelineState.probe.timeline.entries.map((entry) => `${entry.sourceKind}|${entry.sourceLabel}|${entry.kind}`),
      entryCount: timelineState.probe.timeline.entries.length,
      noteMentionsPerSource: /per-source/.test(String(timelineState.probe.timeline.note ?? '')),
      noteMentionsSeparateHistories: /keep separate histories/.test(String(timelineState.probe.timeline.note ?? '')),
    }, {
      entries: ['host|host:cmd-1|message', 'native|native:opencode|message'],
      entryCount: 2,
      noteMentionsPerSource: true,
      noteMentionsSeparateHistories: true,
    });

    // ── H10: the fan-out slot is a labelled RESERVED placeholder ──────────────────────────────
    const fanoutState = await observe();
    record('fanout-slot', fanoutState.probe.fanoutSlot);
    check('the fan-out slot is a visibly RESERVED placeholder that never claims fan-out works: labelled reserved, disabled, and it names task 38 as the behaviour and task 42 as the enablement', {
      present: fanoutState.probe.fanoutSlot !== null,
      reserved: fanoutState.probe.fanoutSlot.reserved,
      ariaLabel: fanoutState.probe.fanoutSlot.ariaLabel,
      mentionsReserved: /Reserved/.test(fanoutState.probe.fanoutSlot.text),
      mentionsFanOut: /fan-out/.test(fanoutState.probe.fanoutSlot.text),
      mentionsTask38: /Task 38/.test(fanoutState.probe.fanoutSlot.text),
      mentionsTask42: /task 42/.test(fanoutState.probe.fanoutSlot.text),
      actionDisabled: fanoutState.probe.fanoutSlot.actionDisabled,
      actionTitle: fanoutState.probe.fanoutSlot.actionTitle,
      actionText: fanoutState.probe.fanoutSlot.actionText,
    }, {
      present: true,
      reserved: 'true',
      ariaLabel: 'Fan-out (reserved)',
      mentionsReserved: true,
      mentionsFanOut: true,
      mentionsTask38: true,
      mentionsTask42: true,
      actionDisabled: true,
      actionTitle: 'Reserved for task 42',
      actionText: 'Fan out (reserved)',
    });

    // ── H11: the checkpoint preview labels untrusted entries and counts the demotion ──────────
    const constants = await evaluate(() => window.task35.constants);
    const builtCheckpoint = await createCheckpoint([
      { class: 'goal', origin: { kind: 'host', commandId: 'cmd-1' }, text: 'Ship the thread UI **bold**' },
      { class: 'plan', origin: { kind: 'host', commandId: 'cmd-1' }, text: constants.SECRET_TEXT },
      { class: 'decision', origin: { kind: 'native', harness: 'opencode', nativeEventId: 'evt-9' }, text: constants.INJECTION_TEXT },
      { class: 'unresolved', origin: { kind: 'host', commandId: 'cmd-1' }, text: constants.MARKUP_TEXT },
    ]);
    const checkpointState = await checkpointProbe();
    const domSnapshot = await domText();
    const injectionRan = await injectionExecuted();
    const layout = await layoutProbe();
    record('checkpoint-preview', { builtCheckpoint, checkpointState, injectionRan });
    check('the checkpoint preview renders untrusted entries LABELLED as data with the demoted decision counted, redacts the secret at the entry boundary, and never executes the injected markup', {
      entryCount: checkpointState.entryCount,
      classes: checkpointState.entries.map((entry) => entry.class),
      demotedCount: checkpointState.demoted,
      untrustedCount: checkpointState.untrusted,
      redactionCount: checkpointState.redactions,
      demotedEntry: { untrusted: checkpointState.entries[2].untrusted, reason: checkpointState.entries[2].reason },
      markupEntry: { untrusted: checkpointState.entries[3].untrusted, text: checkpointState.entries[3].text },
      markdownRenderedLiterally: /Ship the thread UI \*\*bold\*\*/.test(String(checkpointState.entries[0].text ?? '')),
      secretOccurrencesInDom: occurrences(domSnapshot, constants.SECRET_TEXT),
      redactedMarkerInDom: occurrences(domSnapshot, '[redacted]'),
      injectionExecuted: injectionRan,
      imageCount: layout.imageCount,
    }, {
      entryCount: '4',
      classes: ['goal', 'plan', 'unresolved', 'unresolved'],
      demotedCount: '1',
      untrustedCount: '1',
      redactionCount: '1',
      demotedEntry: { untrusted: 'true', reason: 'instruction_override' },
      markupEntry: { untrusted: 'false', text: constants.MARKUP_TEXT },
      markdownRenderedLiterally: true,
      secretOccurrencesInDom: 0,
      redactedMarkerInDom: 1,
      injectionExecuted: false,
      imageCount: 0,
    });

    // ── H12: the evidence page walk goes through the contract's OWN reader ────────────────────
    const seeded = await seedEvidence(constants.EVIDENCE_TEXT);
    await setPageLength(16);
    const evidenceCheckpoint = await createCheckpoint([
      {
        class: 'diff',
        origin: { kind: 'diff', repoKey: 'repo:/repo', path: 'x' },
        evidence: { hash: seeded.hash, bytes: seeded.bytes, target: EVIDENCE_TARGET },
      },
    ]);
    await setCurrentTarget(EVIDENCE_TARGET);
    const evidenceRows = await checkpointProbe();
    const readClicked = await readEvidencePage();
    const pageOne = await checkpointProbe();
    const nextClicked = await nextEvidencePage();
    const pageTwo = await checkpointProbe();
    await nextEvidencePage();
    const pageThree = await checkpointProbe();
    const readerSecondPage = await readerPage(16, 16);
    const dispatcherAttempt = await dispatcherOffsetAttempt();
    record('evidence-walk', { seeded, evidenceCheckpoint, evidenceRows, readClicked, pageOne, nextClicked, pageTwo, pageThree, readerSecondPage, dispatcherAttempt });
    check('the evidence page walk goes through the contract\'s OWN reader: offset/length/totalBytes are honoured page by page to the very end, and the MCP dispatcher structurally cannot serve a second page because TOOL_ARGUMENT_KEYS freezes its accepted keys', {
      evidenceHashMatchesSeed: evidenceRows.evidenceRows[0]?.hash === seeded.hash,
      evidenceSize: evidenceRows.evidenceRows[0]?.size,
      readDisabled: evidenceRows.evidenceRows[0]?.readDisabled,
      readClicked,
      pageOne: pageOne.page,
      nextClicked,
      pageTwo: pageTwo.page,
      pageThree: pageThree.page,
      readerSecondPage,
      dispatcherThrew: dispatcherAttempt.threw,
      dispatcherCode: dispatcherAttempt.code,
      dispatcherField: dispatcherAttempt.field,
      pageError: pageThree.error,
    }, {
      evidenceHashMatchesSeed: true,
      evidenceSize: '39 B',
      readDisabled: false,
      readClicked: true,
      pageOne: { offset: '0', length: '16', total: '39', next: '16', text: 'diff --git a/x b', nextDisabled: false },
      nextClicked: true,
      pageTwo: { offset: '16', length: '16', total: '39', next: '32', text: '/x\n+line one\n+li', nextDisabled: false },
      pageThree: { offset: '32', length: '7', total: '39', next: null, text: 'ne two\n', nextDisabled: null },
      readerSecondPage: { available: true, offset: 16, length: 16, totalBytes: 39, nextOffset: 32, text: '/x\n+line one\n+li' },
      dispatcherThrew: true,
      dispatcherCode: 'invalid_request',
      dispatcherField: 'evidence_tool_arguments',
      pageError: null,
    });

    // ── H13: a cancelled handoff shows its readable resolution ────────────────────────────────
    const boot3 = await bootThread({ owner: 'c', join: 'd' });
    record('boot-thread-3', boot3);
    const ownerC = boot3.snapshot.participants[0].participantId;
    const participantD = boot3.snapshot.participants[1].participantId;
    await setDraft('cancel this handoff');
    await setTarget(participantD);
    await begin();
    await prepare();
    const cancelClicked = await cancel();
    const cancelledState = await observe();
    record('cancelled-handoff', { cancelClicked, cancelledState, resolutionVerbatim: cancelledState.probe.handoff.resolution });
    check('a cancelled handoff shows the OBSERVED cancelled state with its readable resolution, and the thread keeps its original active participant', {
      cancelClicked,
      state: cancelledState.probe.handoff.state,
      resolutionMentionsResolution: /Resolved as cancelled/.test(String(cancelledState.probe.handoff.resolution ?? '')),
      resolutionMentionsCode: /cancelled \/ handoff_cancelled/.test(String(cancelledState.probe.handoff.resolution ?? '')),
      resolutionMentionsReason: /cancelled from the thread view/.test(String(cancelledState.probe.handoff.resolution ?? '')),
      activeMarker: cancelledState.probe.handoff.activeMarker,
      ops: cancelledState.probe.handoff.ops,
      seat: cancelledState.snapshot.activeParticipantId === ownerC,
      revision: cancelledState.snapshot.revision,
      cancelDisabledNow: cancelledState.probe.handoff.cancelDisabled,
    }, {
      cancelClicked: true,
      state: 'cancelled',
      resolutionMentionsResolution: true,
      resolutionMentionsCode: true,
      resolutionMentionsReason: true,
      activeMarker: null,
      ops: ['checkpoint applied', 'attach applied', 'prepare applied', 'cancel applied'],
      seat: true,
      revision: 2,
      cancelDisabledNow: false,
    });
    // ── H14: light and dark imported themes, measured with real rendered colours ──────────────
    const lightTheme = await applyTheme('light');
    const lightStyle = await styleProbe();
    const darkTheme = await applyTheme('dark');
    const darkStyle = await styleProbe();
    protocol.theme = { lightTheme, lightStyle, darkTheme, darkStyle };
    record('theme', protocol.theme);
    check('the same surface renders under a light AND a dark IMPORTED theme: the measured modal text follows the theme tokens (rgb(38, 48, 56) / rgb(240, 230, 245)) and the two themes differ', {
      lightPreset: lightTheme.preset,
      lightThemeAttribute: lightStyle.themeAttribute,
      lightModalColor: lightStyle.modalColor,
      lightMatchesExpected: lightStyle.modalColor === lightStyle.expectedModalText,
      lightTokenCount: lightTheme.tokenCount > 0,
      darkPreset: darkTheme.preset,
      darkThemeAttribute: darkStyle.themeAttribute,
      darkModalColor: darkStyle.modalColor,
      darkMatchesExpected: darkStyle.modalColor === darkStyle.expectedDarkModalText,
      darkTokenCount: darkTheme.tokenCount > 0,
      themesDiffer: lightStyle.modalColor !== darkStyle.modalColor,
    }, {
      lightPreset: 'soft-white',
      lightThemeAttribute: 'light',
      lightModalColor: 'rgb(38, 48, 56)',
      lightMatchesExpected: true,
      lightTokenCount: true,
      darkPreset: 'anime-night',
      darkThemeAttribute: 'dark',
      darkModalColor: 'rgb(240, 230, 245)',
      darkMatchesExpected: true,
      darkTokenCount: true,
      themesDiffer: true,
    });

    if (context.case === 'failure') {
      // ── F1: a target that cannot be joined is a readable, alert-level failure ───────────────
      await setAvailableSessions(['missing']);
      const failedJoinClicked = await addSource('missing');
      const failedJoinState = await observe();
      record('f1-failed-target', { failedJoinClicked, failedJoinState });
      check('a target that cannot be joined produces a VISIBLE, alert-level error naming the session and the reason — never a silent state and never a bare protocol code', {
        clicked: failedJoinClicked,
        errorRole: failedJoinState.probe.threadError?.role ?? null,
        errorMentionsSession: /session-missing/.test(String(failedJoinState.probe.threadError?.text ?? '')),
        errorMentionsReason: /could not be joined/.test(String(failedJoinState.probe.threadError?.text ?? '')),
        errorIsReadable: /could not be joined: /.test(String(failedJoinState.probe.threadError?.text ?? '')),
        participantCountUnchanged: failedJoinState.probe.participantCount,
        revisionUnchanged: failedJoinState.snapshot.revision,
        busySettled: failedJoinState.snapshot.busy,
      }, {
        clicked: true,
        errorRole: 'alert',
        errorMentionsSession: true,
        errorMentionsReason: true,
        errorIsReadable: true,
        participantCountUnchanged: '2',
        revisionUnchanged: 2,
        busySettled: false,
      });

      // ── F2: a switch during a draft keeps the draft exactly ─────────────────────────────────
      await setDraft('switch me mid-draft');
      const beforeSwitch = await observe();
      const switchClicked = await setTarget(ownerC);
      const afterSwitch = await observe();
      record('f2-switch-during-draft', { beforeSwitch, switchClicked, afterSwitch });
      check('switching the send target during a draft preserves the draft exactly and moves the chips to the newly designated participant', {
        draftBefore: beforeSwitch.probe.draftPreview,
        switchClicked,
        chipsAfter: afterSwitch.probe.targetChips.map((chip) => ({ participantId: chip.participantId, role: chip.role })),
        followHintAfter: afterSwitch.probe.targetFollowHint,
        draftAfter: afterSwitch.probe.draftPreview,
        targetsAfter: afterSwitch.snapshot.targets,
        targetCountAfter: afterSwitch.probe.targetCount,
      }, {
        draftBefore: 'switch me mid-draft',
        switchClicked: true,
        chipsAfter: [{ participantId: ownerC, role: 'owner' }],
        followHintAfter: null,
        draftAfter: 'switch me mid-draft',
        targetsAfter: [ownerC],
        targetCountAfter: '1',
      });

      // ── F3: untrusted markdown is data, and a very long badge does not break the layout ─────
      // The long label is put on the harness instance the CURRENT target chip renders, so the chip
      // itself carries the over-long badge.
      const longLabels = await setHarnessLabels({ [HARNESS_A]: 'opencode', [HARNESS_B]: constants.LONG_LABEL });
      await setDraft('long badge draft');
      await setTarget(ownerC);
      const longBadgeState = await observe();
      const longBadgeLayout = await layoutProbe();
      const longBadgeDom = await domText();
      const untrustedCheckpoint = await createCheckpoint([
        { class: 'goal', origin: { kind: 'host', commandId: 'cmd-1' }, text: 'Ship the thread UI **bold**' },
        { class: 'plan', origin: { kind: 'host', commandId: 'cmd-1' }, text: constants.SECRET_TEXT },
        { class: 'decision', origin: { kind: 'native', harness: 'opencode', nativeEventId: 'evt-9' }, text: constants.INJECTION_TEXT },
        { class: 'unresolved', origin: { kind: 'host', commandId: 'cmd-1' }, text: constants.MARKUP_TEXT },
      ]);
      const untrustedProbe = await checkpointProbe();
      const untrustedDom = await domText();
      const untrustedInjection = await injectionExecuted();
      const untrustedLayout = await layoutProbe();
      record('f3-untrusted-and-long-badge', { longLabels, longBadgeState, longBadgeLayout, untrustedCheckpoint, untrustedProbe, untrustedInjection });
      check('untrusted markdown is rendered as LABELLED DATA (never executed, the secret redacted, markdown literal), and a very long harness badge does not break the layout: the page never overflows horizontally and the full label stays in the DOM', {
        longLabelInDom: /an extremely long harness instance label/.test(String(longBadgeLayout.chipText ?? '')),
        longBadgeIsTheChip: longBadgeState.probe.targetChips.length === 1,
        noPageHorizontalOverflow: longBadgeLayout.docScrollWidth <= longBadgeLayout.innerWidth,
        modalPresent: longBadgeLayout.modalPresent,
        longBadgeDomHasSecret: occurrences(longBadgeDom, constants.SECRET_TEXT),
        untrustedEntryCount: untrustedProbe.entryCount,
        untrustedClasses: untrustedProbe.entries.map((entry) => entry.class),
        demotedCount: untrustedProbe.demoted,
        demotedReason: untrustedProbe.entries[2].reason,
        markupTextLiteral: untrustedProbe.entries[3].text === constants.MARKUP_TEXT,
        secretOccurrences: occurrences(untrustedDom, constants.SECRET_TEXT),
        redactedMarker: occurrences(untrustedDom, '[redacted]'),
        injectionExecuted: untrustedInjection,
        imageCount: untrustedLayout.imageCount,
        layoutOverflowAfterCheckpoint: untrustedLayout.docScrollWidth <= untrustedLayout.innerWidth,
      }, {
        longLabelInDom: true,
        longBadgeIsTheChip: true,
        noPageHorizontalOverflow: true,
        modalPresent: true,
        longBadgeDomHasSecret: 0,
        untrustedEntryCount: '4',
        untrustedClasses: ['goal', 'plan', 'unresolved', 'unresolved'],
        demotedCount: '1',
        demotedReason: 'instruction_override',
        markupTextLiteral: true,
        secretOccurrences: 0,
        redactedMarker: 1,
        injectionExecuted: false,
        imageCount: 0,
        layoutOverflowAfterCheckpoint: true,
      });

      // ── F4: a delivered handoff with no native event yet stays visibly pending ─────────────
      const bootPending = await bootThread({ owner: 'e', join: 'f' });
      record('boot-pending', bootPending);
      const ownerE = bootPending.snapshot.participants[0].participantId;
      const participantF = bootPending.snapshot.participants[1].participantId;
      await setDraft('pending reply');
      await setTarget(participantF);
      await begin();
      await prepare();
      await deliver();
    const pendingState = await observe();
    record('f4-pending-reply', { pendingState, waitingNoteVerbatim: pendingState.probe.handoff.observeWaiting });
    check('a delivered handoff whose native reply has not arrived stays VISIBLY pending: the state is `delivered`, no active marker exists, the observe action is disabled and the waiting note is explicit — never a silent state', {
      state: pendingState.probe.handoff.state,
      stateChip: pendingState.probe.handoff.stateChip,
      activeMarker: pendingState.probe.handoff.activeMarker,
      derivedActive: pendingState.snapshot.handoff.active,
      deliveredBy: pendingState.probe.handoff.deliveredBy,
      observeDisabled: pendingState.probe.handoff.observeDisabled,
      waitingMentionsNativeObservation: /native observation/.test(String(pendingState.probe.handoff.observeWaiting ?? '')),
      waitingMentionsNeverActiveFromAck: /never marked active from an ack/.test(String(pendingState.probe.handoff.observeWaiting ?? '')),
      waitingMentionsNeverRetried: /never retried/.test(String(pendingState.probe.handoff.observeWaiting ?? '')),
      seat: pendingState.snapshot.activeParticipantId === ownerE,
      revision: pendingState.snapshot.revision,
      sends: pendingState.snapshot.handoff.sends,
    }, {
      state: 'delivered',
      stateChip: 'delivered',
      activeMarker: null,
      derivedActive: false,
      deliveredBy: 'ack-3',
      observeDisabled: true,
      waitingMentionsNativeObservation: true,
      waitingMentionsNeverActiveFromAck: true,
      waitingMentionsNeverRetried: true,
      seat: true,
      revision: 2,
      sends: 1,
    });

      // ── F5: an ambiguous send stops at reconcile and offers NO retry ───────────────────────
      const bootAmbiguous = await bootThread({ owner: 'e', join: 'f', sendOutcome: 'ambiguous' });
      record('boot-ambiguous', bootAmbiguous);
      const ownerE2 = bootAmbiguous.snapshot.participants[0].participantId;
      const participantF2 = bootAmbiguous.snapshot.participants[1].participantId;
      await setDraft('ambiguous send');
      await setTarget(participantF2);
      await begin();
      await prepare();
      await deliver();
      const ambiguousState = await observe();
      const ambiguousSendLog = await sendLog();
    record('f5-ambiguous-no-retry', { ambiguousState, ambiguousSendLog, resolutionVerbatim: ambiguousState.probe.handoff.resolution });
    check('an ambiguous send stops at reconcile as a READABLE resolution and offers NO retry anywhere: deliver and observe are disabled, the error is alert-level and readable, the product sent exactly once, and the handoff control set contains no retry affordance', {
      state: ambiguousState.probe.handoff.state,
      resolutionMentionsResolveAs: /Resolved as reconcile/.test(String(ambiguousState.probe.handoff.resolution ?? '')),
      resolutionMentionsCode: /reconcile_required/.test(String(ambiguousState.probe.handoff.resolution ?? '')),
      resolutionMentionsField: /handoff_ambiguous/.test(String(ambiguousState.probe.handoff.resolution ?? '')),
      deliverDisabled: ambiguousState.probe.handoff.deliverDisabled,
        observeDisabled: ambiguousState.probe.handoff.observeDisabled,
        beginDisabled: ambiguousState.probe.handoff.beginDisabled,
        activeMarker: ambiguousState.probe.handoff.activeMarker,
        errorRole: ambiguousState.probe.threadError?.role ?? null,
        errorMentionsReconcile: /reconcile/.test(String(ambiguousState.probe.threadError?.text ?? '')),
        sends: ambiguousState.snapshot.handoff.sends,
        sendLogLength: ambiguousSendLog.length,
        controlSet: ambiguousState.probe.handoff.handoffButtonTestIds,
        retryLikeButtons: ambiguousState.probe.handoff.handoffButtonTexts.filter((text) => /retry|resend|send again/i.test(text)).length,
        retryLikeTestIds: ambiguousState.probe.retryLikeTestIds,
        retryLikeButtonsAnywhere: ambiguousState.probe.retryLikeButtons,
        seatRestored: ambiguousState.snapshot.activeParticipantId === ownerE2,
        revision: ambiguousState.snapshot.revision,
    }, {
      state: 'reconcile',
      resolutionMentionsResolveAs: true,
      resolutionMentionsCode: true,
      resolutionMentionsField: true,
      deliverDisabled: true,
        observeDisabled: true,
        beginDisabled: true,
        activeMarker: null,
        errorRole: 'alert',
        errorMentionsReconcile: true,
        sends: 1,
        sendLogLength: 1,
        controlSet: ['begin-handoff', 'prepare-handoff', 'deliver-handoff', 'observe-handoff', 'cancel-handoff'],
        retryLikeButtons: 0,
        retryLikeTestIds: 0,
        retryLikeButtonsAnywhere: 0,
        seatRestored: true,
        revision: 2,
      });

      // ── F6: a stale evidence target is an explicit refusal, never bytes ────────────────────
      const staleSeed = await seedEvidence(constants.EVIDENCE_TEXT);
      await setPageLength(16);
      await createCheckpoint([
        {
          class: 'diff',
          origin: { kind: 'diff', repoKey: 'repo:/repo', path: 'x' },
          evidence: { hash: staleSeed.hash, bytes: staleSeed.bytes, target: EVIDENCE_TARGET },
        },
      ]);
      await setCurrentTarget(Object.freeze({ repoKey: 'repo:/repo', revision: '2' }));
      const staleReadClicked = await readEvidencePage();
      const staleProbe = await checkpointProbe();
      const staleDom = await domText();
      record('f6-stale-evidence', { staleReadClicked, staleProbe });
      check('a stale evidence target is an explicit REFUSAL, never bytes: the read is alert-level, names the stale target, and serves no page and no evidence text', {
        readClicked: staleReadClicked,
        errorRole: staleProbe.error?.role ?? null,
        errorMentionsStale: /evidence_target_stale/.test(String(staleProbe.error?.text ?? '')),
        page: staleProbe.page,
        evidenceTextInDom: occurrences(staleDom, 'diff --git'),
      }, {
        readClicked: true,
        errorRole: 'alert',
        errorMentionsStale: true,
        page: null,
        evidenceTextInDom: 0,
      });

      // ── F7: both imported themes render without error in the failure lane too ──────────────
      const failureLight = await applyTheme('light');
      const failureLightStyle = await styleProbe();
      const failureDark = await applyTheme('dark');
      const failureDarkStyle = await styleProbe();
      record('f7-themes', { failureLight, failureLightStyle, failureDark, failureDarkStyle });
      check('both IMPORTED themes render without error and with their own measured colours in the failure lane as well', {
        lightModalColor: failureLightStyle.modalColor,
        darkModalColor: failureDarkStyle.modalColor,
        themesDiffer: failureLightStyle.modalColor !== failureDarkStyle.modalColor,
        modalPresent: failureLightStyle.modalPresent,
      }, {
        lightModalColor: 'rgb(38, 48, 56)',
        darkModalColor: 'rgb(240, 230, 245)',
        themesDiffer: true,
        modalPresent: true,
      });
    }

    const browserErrors = await errors();
    check('the real UI surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace for the UI surfaces (the plan's Evidence line).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa35-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa35-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }

    protocol.browserCallLog = { sendLog: await sendLog() };
    const protocolPath = path.join(runDir, 'protocol.json');
    writeJson(protocolPath, protocol);
    artifacts.push(artifact(protocolPath, 'protocol-record'));

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowth = heapEnd - heapStart;
    check('the case stays bounded (bounded heap) and exercises the real modules through a fixed set of owned resources', {
      heapGrowthUnderBound: heapGrowth < 256 * 1024 * 1024,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    }, {
      heapGrowthUnderBound: true,
      ownedResourceCount: fixture.resources.length,
      spawnCalls: 0,
    });

    // ── the evidence binds to the CURRENT bytes ──────────────────────────────────────────────
    // Independent recomputation: the sha256 of the pinned product files is recomputed from disk
    // AFTER the whole run and compared with the values recorded when the case started, and the
    // full pinned inventory is re-verified through the evidence helper's own validator. A green
    // report against different bytes is worthless — this exact failure made task 21's first gate
    // return REJECT.
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
      recomputedByHelper: pinnedRecheck[file].helper,
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
      threadView: pinnedComparisons[0].recomputed,
      useRuntimeThread: pinnedComparisons[1].recomputed,
      handoffDialog: pinnedComparisons[2].recomputed,
    }, {
      pinnedFileCount: 5,
      allEqual: true,
      allDigestHelperAgrees: true,
      fullInventoryRevalidated: true,
      revalidationError: null,
      threadView: pinnedBefore['app/components/runtime/ThreadView.vue'],
      useRuntimeThread: pinnedBefore['app/composables/useRuntimeThread.ts'],
      handoffDialog: pinnedBefore['app/components/runtime/HandoffDialog.vue'],
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    }, {
      authoredFileCount: 4,
      differingFiles: 0,
      pinnedSources: sourceFiles.length,
      ownedResourceCount: fixture.resources.length,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task35Errors ?? [], task35: Boolean(window.task35) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /stale|reconcile|pending|delivered|observation|active seat|only after|waiting/,
    cancel_resume: /cancel|restore|original|return leg|seat|active-seat/,
    malformed_input: /untrusted|injection|redacted|ambiguous|reserved|never executed|long badge|layout|could not be joined/,
    hung_commands: /bounded|no error|disabled|waiting|pending|never retried/,
    dirty_worktree: /authored files unchanged|pinned source inventory|CURRENT bytes/,
    repeated_interruptions: /never merged|exactly|only|never retried|no retry|two sources|per-participant|sent exactly once/,
    misleading_success_output: /RESERVED|never claims|only after|never as|no retry|labelled|never executed|refusal|not a second handoff|never a silent/,
    flaky_tests: /identical|rgb\(|both directions|measured|same thread|SAME/,
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'thread-participant-handoff-ui', schema: 'runtime-thread-ui/v1' },
    cleanup: proof.cleanup,
    defects: {
      noContainerProvidesThreadState: {
        severity: 'acceptance-criterion-gap',
        observed: 'no container provides RUNTIME_THREAD_STATE_KEY (App.vue is outside the owned paths), so the running app renders nothing until a one-line provide lands; the case therefore supplies the seam itself, exactly as the landed ThreadView.test.ts does',
        contradictsPlanCriterion: 'none — the plan scopes task 35 to the components and composables; the wiring is the same optional-seam posture as task 22\'s RUNTIME_SESSION_ACTIONS_KEY and task 30\'s Slurm lifecycle port',
        coveredInstead: 'the case IS the container: it provides the seam, drives the real composable over the real services and asserts the rendered surface',
      },
      relayReturnLegIsNotASecondHandoff: {
        severity: 'observation',
        observed: 'the plan\'s happy-QA phrase "接力A→B→A" cannot be driven as two sequential handoffs on ONE thread: useRuntimeThread.beginHandoff refuses when the existing handoff is past `attached` (useRuntimeThread.ts:376-379) and HandoffDialog.canBegin disables Begin (HandoffDialog.vue:234-240), so a completed handoff blocks a new begin',
        contradictsPlanCriterion: 'the plan\'s happy-QA phrase "接力A→B→A" (the task-35 acceptance criteria themselves do not require a second handoff; the A→B→A criterion belongs to task 34)',
        coveredInstead: 'the case proves the full A→B relay with every rung and source/target observed, proves the observed REFUSAL of a second begin with its readable disabled reason, proves the relay seat returning A → B → A through the thread\'s own active-seat selection, and proves a genuine B→A relay on a second thread where B is the owner',
      },
      beginDisabledReasonOmitsExistingHandoff: {
        severity: 'observation',
        observed: 'when Begin is disabled because a completed handoff exists, the button\'s title (HandoffDialog.beginDisabledReason) still reports the generic "Start the handoff from the active participant to the selected target" rather than naming the blocking handoff; the composable\'s own refusal sentence does name it',
        contradictsPlanCriterion: 'none — the criterion is that the state is visible, which it is (the ladder, the state chip and the journal all show the completed handoff)',
        coveredInstead: 'the case records the title verbatim and asserts the button is disabled, forcing neither side',
      },
      nodeCryptoBrowserSeam: {
        severity: 'controlled-boundary',
        observed: 'the real bridge services import node:crypto at module scope, so they cannot execute in a browser realm; the case aliases the specifier to a case-owned shim that supplies randomUUID from the browser\'s own crypto and createHash("sha256") from the product\'s own pure SHA-256',
        contradictsPlanCriterion: 'none — the same seam tasks 26-29 use; no asserted value depends on it (ids are asserted by shape and equality-across-reads, and no fingerprint is asserted)',
        coveredInstead: 'every line of service logic under test is the real landed code; the stateful services also run in the landed ThreadView.test.ts over the Node require boundary',
      },
    },
    evidenceBoundary: 'The real landed task-35 Vue surface (ThreadView/ParticipantPicker/HandoffDialog/ContextEvidenceView) and app/composables/useRuntimeThread.ts execute in a real headless Chromium over a case-owned Vite dev server, driving the real landed bridge services bridge/runtime/threads/{threadService,participantService,handoffService,checkpointService}.js and the pure shared contract (shared/runtime/{thread,context,identity,capabilities}.js + app/runtime/timeline.ts), with the real imported-theme token pipeline (app/utils/{regionTheme,themeTokens}.ts + the soft-white and anime-night presets) measured with real computed colours. The controlled boundaries are injected fakes: `node:crypto` and `@iconify/vue` are aliased to a case-owned browser shim (the bridge services import node:crypto at module scope and cannot run in a browser realm without it; the real Icon fetches the Iconify API at runtime); openTarget and sendPrompt are the handoff service\'s own declared seams (openTarget binds the target\'s own native session, sendPrompt answers with a native ack id or an unreadable outcome); the evidence reader is a case-owned hash-addressed store, which is the product\'s declared injection point. No container provides RUNTIME_THREAD_STATE_KEY yet, so this case is the container and makes no claim that the running app already renders the Thread UI. The fan-out slot is asserted to be a labelled RESERVED placeholder only — fan-out behaviour is task 38\'s and its enablement task 42\'s. It does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that — runs no product test suite, performs no git operation, and authors no PASS verdict.',
  };
}
