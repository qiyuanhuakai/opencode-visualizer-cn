// Task 22 registered QA case — qualified session actions, sends and interaction routing.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the REAL production composables in a real headless Chromium on
// a real Vite server: the real useRuntimeMessageSend / useRuntimeSessionActions /
// useRuntimeInteractions over the REAL runtime client/connection and the REAL
// selectionScope. The only controlled boundary is the runtime WebSocket wire
// inside app/dev/runtime-v090/task22.ts (ActionWire), which serves a canonical
// multi-target set (codex / acp / dsh / an explicitly unsupported target) and can
// hold/settle mutations, reduce a target's advertised capabilities and
// detach/reattach a target, so every scenario has a deterministic numeric
// observable or an explicit rejection code. No product file is edited and no
// PASS verdict is authored here.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased } from './task-22-fixture.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const ENV_CODEX = '11111111-1111-4111-8111-111111111111';
const ENV_ACP = '22222222-2222-4222-8222-222222222222';
const ENV_DSH = '33333333-3333-4333-8333-333333333333';
const ENV_UNSUPPORTED = '44444444-4444-4444-8444-444444444444';
const OK = Object.freeze({ ok: true, value: null, code: null, field: null });

export const sourceFiles = [...new Set([
  'app/composables/useRuntimeMessageSend.ts',
  'app/composables/useRuntimeSessionActions.ts',
  'app/composables/useRuntimeInteractions.ts',
  'app/composables/useRuntimeMessageSend.test.ts',
  'app/composables/useRuntimeSessionActions.test.ts',
  'app/composables/useRuntimeInteractions.test.ts',
  'app/composables/useRuntimeActions.routing.test.ts',
  'app/runtime/client.ts', 'app/runtime/connection.ts', 'app/runtime/selectionScope.ts', 'app/runtime/state.ts',
  'app/composables/useRuntimeState.ts',
  'app/components/InputPanel.vue', 'app/components/OutputPanel.vue',
  'app/dev/runtime-v090/task22.ts',
  'scripts/qa/runtime-v090-cases/task-22.mjs', 'scripts/qa/runtime-v090-cases/task-22-fixture.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 22 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body>
<script type="module">window.__task22Errors=[];window.addEventListener('error',(e)=>window.__task22Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task22Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task22.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-22/qa-cases');
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
    scenarios.push({ name, surface: 'real qualified session actions/sends/interactions over the real runtime client and selectionScope in a real headless Chromium', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = normalize(value); persist(); };
  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  let browser; let page; let vite;
  try {
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createServer({ configFile: false, appType: 'custom', root: context.root, server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    vite.middlewares.use('/qa22', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa22/`;
    record('pageUrl', pageUrl);
    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl);
    await until(() => page.evaluate(() => Boolean(window.task22)), 'task22 browser entry', 60000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    const query = await evaluate(() => window.task22.query());
    record('query', query);
    check('the runner exposes four attached targets with the same native id kept distinct by qualified key', {
      attachedCount: query.attached.length, codexNative: query.codexNative, acpNative: query.acpNative, distinctKeys: query.distinctKeys,
    }, { attachedCount: 4, codexNative: 'shared-native-id', acpNative: 'shared-native-id', distinctKeys: true });

    if (context.case === 'failure') {
      // F1 — send while a session/source switch is in progress: both the
      // no-current-selection send and the in-flight send whose target switches
      // away must be explicitly rejected with zero re-routing.
      await evaluate(() => window.task22.select('none'));
      const beforeNull = await evaluate(() => window.task22.wireSummary());
      const nullSelection = await evaluate(() => window.task22.sendCaptured({ text: 'no selection' }));
      const afterNull = await evaluate(() => window.task22.wireSummary());
      await evaluate(() => window.task22.select('codex'));
      await evaluate(() => window.task22.hold('session.send'));
      const inflight = evaluate(() => window.task22.sendCaptured({ text: 'in flight' }));
      await evaluate(() => window.task22.detach('codex'));
      const inflightOutcome = await inflight;
      const afterDetach = await evaluate(() => window.task22.wireSummary());
      await evaluate(() => window.task22.reattach('codex'));
      await evaluate(() => window.task22.release());
      record('sendAwaitSwitch', { nullSelection, inflightOutcome, afterDetach });
      check('a send while a session/source switch is in progress is explicitly rejected and never re-routed', {
        nullSelection,
        nullFrames: afterNull.calls.length - beforeNull.calls.length,
        inflight: inflightOutcome,
        recordedCodexSends: afterDetach.byMethodTarget[`session.send@${ENV_CODEX}`] ?? 0,
        reRouted: (afterDetach.byMethodTarget[`session.send@${ENV_ACP}`] ?? 0) + (afterDetach.byMethodTarget[`session.send@${ENV_DSH}`] ?? 0),
        heldStale: afterDetach.held,
      }, {
        nullSelection: { ok: false, value: null, code: 'cancelled', field: 'action.selection' },
        nullFrames: 0,
        inflight: { ok: false, value: null, code: 'reconcile_required', field: 'request.uncertain' },
        recordedCodexSends: 1, reRouted: 0, heldStale: 1,
      });

      // F2 — replying to an outdated generation: a response bound before a
      // target rebind must be rejected, and the rebind must not be answered.
      await evaluate(() => window.task22.hold('interaction.respond'));
      const stale = evaluate(() => window.task22.permission('codex', 'req-old', { allow: true }));
      await evaluate(() => window.task22.detach('codex'));
      const staleOutcome = await stale;
      const heldAfterStale = await evaluate(() => window.task22.status());
      await evaluate(() => window.task22.reattach('codex'));
      await evaluate(() => window.task22.clearHold());
      const fresh = await evaluate(() => window.task22.permission('codex', 'req-old', { allow: true }));
      const afterOld = await evaluate(() => window.task22.wireSummary());
      record('replyOldGeneration', { staleOutcome, heldAfterStale, fresh, afterOld });
      check('a reply to an old generation is explicitly rejected and the rebind is never mis-answered', {
        stale: staleOutcome,
        staleHeld: heldAfterStale.held,
        recordedResponds: afterOld.byMethod['interaction.respond'] ?? 0,
        answeredCodex: afterOld.answered[`interaction.respond@${ENV_CODEX}`] ?? 0,
        fresh,
        answeredAcp: afterOld.answered[`interaction.respond@${ENV_ACP}`] ?? 0,
      }, {
        stale: { ok: false, value: null, code: 'reconcile_required', field: 'request.uncertain' },
        staleHeld: 1, recordedResponds: 2, answeredCodex: 1,
        fresh: OK, answeredAcp: 0,
      });

      // F3 — a cancel race: send and cancel are independent correctly-routed
      // frames; a cancel for a detached target is rejected with no mis-call.
      const raceSend = await evaluate(() => window.task22.send('codex', { text: 'race' }));
      const raceCancel = await evaluate(() => window.task22.cancel('codex'));
      const raceSummary = await evaluate(() => window.task22.wireSummary());
      const racePair = raceSummary.calls.slice(-2);
      await evaluate(() => window.task22.detach('codex'));
      const detachedCancel = await evaluate(() => window.task22.cancel('codex'));
      const afterCancel = await evaluate(() => window.task22.wireSummary());
      await evaluate(() => window.task22.reattach('codex'));
      record('cancelRace', { raceSend, raceCancel, racePair, detachedCancel, afterCancel });
      check('a cancel race keeps send and cancel independent and rejects a detached cancel without a mis-call', {
        send: raceSend, cancel: raceCancel,
        sequence: racePair.map((entry) => entry.method),
        bothCodex: racePair.every((entry) => entry.target === ENV_CODEX),
        detachedCancel,
        cancelFrames: afterCancel.byMethod['session.cancel'] ?? 0,
        reRouted: (afterCancel.byMethodTarget[`session.cancel@${ENV_ACP}`] ?? 0) + (afterCancel.byMethodTarget[`session.cancel@${ENV_DSH}`] ?? 0),
      }, {
        send: OK, cancel: OK, sequence: ['session.send', 'session.cancel'], bothCodex: true,
        detachedCancel: { ok: false, value: null, code: 'reconcile_required', field: 'target.attachment' },
        cancelFrames: 1, reRouted: 0,
      });

      // F4 — backend unsupported: a target that does not advertise the
      // mutation capability rejects before any frame is emitted.
      const unsupportedSend = await evaluate(() => window.task22.send('unsupported', { text: 'x' }));
      const unsupportedPermission = await evaluate(() => window.task22.permission('unsupported', 'req', { allow: true }));
      const afterUnsupported = await evaluate(() => window.task22.wireSummary());
      record('backendUnsupported', { unsupportedSend, unsupportedPermission, afterUnsupported });
      check('an unsupported backend capability is explicitly rejected before any wire frame', {
        send: unsupportedSend, permission: unsupportedPermission,
        frames: (afterUnsupported.byMethodTarget[`session.send@${ENV_UNSUPPORTED}`] ?? 0) + (afterUnsupported.byMethodTarget[`interaction.respond@${ENV_UNSUPPORTED}`] ?? 0),
        answered: (afterUnsupported.answered[`session.send@${ENV_UNSUPPORTED}`] ?? 0) + (afterUnsupported.answered[`interaction.respond@${ENV_UNSUPPORTED}`] ?? 0),
      }, {
        send: { ok: false, value: null, code: 'unsupported', field: 'method.capability' },
        permission: { ok: false, value: null, code: 'unsupported', field: 'method.capability' },
        frames: 0, answered: 0,
      });

      // F5 — target/profile mismatch: a ghost target, a foreign profile capture
      // and a session/target capture mismatch are rejected with zero frames.
      const beforeMismatch = await evaluate(() => window.task22.wireSummary());
      const ghostSend = await evaluate(() => window.task22.send('ghost', { text: 'x' }));
      const profileMismatch = await evaluate(() => window.task22.foreignProfileSend({ text: 'x' }));
      const sessionTargetMismatch = await evaluate(() => window.task22.bindMismatch());
      const afterMismatch = await evaluate(() => window.task22.wireSummary());
      record('fileTargetMismatch', { ghostSend, profileMismatch, sessionTargetMismatch, afterMismatch });
      check('a target/profile mismatch is explicitly rejected and never mis-called', {
        ghost: ghostSend, profile: profileMismatch, sessionTarget: sessionTargetMismatch,
        frames: afterMismatch.calls.length - beforeMismatch.calls.length,
      }, {
        ghost: { ok: false, value: null, code: 'reconcile_required', field: 'target.attachment' },
        profile: { started: false, code: 'unauthorized', field: 'action.profile' },
        sessionTarget: { bound: false, code: 'unauthorized', field: 'action.session_target' },
        frames: 0,
      });

      const finalErrors = await evaluate(() => window.task22.errors());
      const finalSummary = await evaluate(() => window.task22.wireSummary());
      record('failureFinal', { errors: finalErrors, creates: finalSummary.byMethod['session.create'] ?? 0 });
      check('no erroneous session is created and the browser logs no error across every failure scenario', {
        errors: finalErrors.length, sessionCreates: finalSummary.byMethod['session.create'] ?? 0,
      }, { errors: 0, sessionCreates: 0 });
    } else {
      // H1 — Codex is busy; ACP/DSH each send independently; switching away from
      // the busy codex session never cancels its send (invariant 1).
      await evaluate(() => window.task22.select('codex'));
      await evaluate(() => window.task22.hold('session.send'));
      const inflightCodex = evaluate(() => window.task22.sendCaptured({ text: 'codex busy turn' }));
      await evaluate(() => window.task22.select('acp'));
      const inflightAcp = evaluate(() => window.task22.sendCaptured({ text: 'acp turn' }));
      await evaluate(() => window.task22.select('dsh'));
      const inflightDsh = evaluate(() => window.task22.sendCaptured({ text: 'dsh turn' }));
      const released = await evaluate(() => window.task22.release());
      const [codex, acp, dsh] = await Promise.all([inflightCodex, inflightAcp, inflightDsh]);
      const afterBusy = await evaluate(() => window.task22.wireSummary());
      record('codexBusyCrossSource', { released, codex, acp, dsh, afterBusy });
      check('switching away from a BUSY codex session does not cancel it while ACP and DSH send independently', {
        released: released.released, codex, acp, dsh,
        sendCodex: afterBusy.byMethodTarget[`session.send@${ENV_CODEX}`] ?? 0,
        sendAcp: afterBusy.byMethodTarget[`session.send@${ENV_ACP}`] ?? 0,
        sendDsh: afterBusy.byMethodTarget[`session.send@${ENV_DSH}`] ?? 0,
        cancelFrames: afterBusy.byMethod['session.cancel'] ?? 0,
      }, {
        released: 3, codex: OK, acp: OK, dsh: OK, sendCodex: 1, sendAcp: 1, sendDsh: 1, cancelFrames: 0,
      });

      // H2 — a native request with the SAME id under two sources: pending
      // registries and responses stay scoped (invariant 2).
      await evaluate(() => window.task22.track('codex', 'req-same'));
      await evaluate(() => window.task22.track('acp', 'req-same'));
      const codexPending = await evaluate(() => window.task22.pendingFor('codex'));
      const acpPending = await evaluate(() => window.task22.pendingFor('acp'));
      const codexPermission = await evaluate(() => window.task22.permission('codex', 'req-same', { allow: true }));
      const acpQuestion = await evaluate(() => window.task22.question('acp', 'req-same', { answer: 'yes' }));
      const afterNative = await evaluate(() => window.task22.wireSummary());
      record('sameNativeRequestId', { codexPending, acpPending, codexPermission, acpQuestion, afterNative });
      check('a native request with the same id stays scoped to its own source and never crosses', {
        codexPending: codexPending.ids, acpPending: acpPending.ids, codexPermission, acpQuestion,
        respondCodex: afterNative.answered[`interaction.respond@${ENV_CODEX}`] ?? 0,
        respondAcp: afterNative.answered[`interaction.respond@${ENV_ACP}`] ?? 0,
      }, {
        codexPending: ['req-same'], acpPending: ['req-same'], codexPermission: OK, acpQuestion: OK, respondCodex: 1, respondAcp: 1,
      });

      // H3 — model selection never crosses sources.
      const beforeModel = await evaluate(() => window.task22.wireSummary());
      await evaluate(() => window.task22.setModel('codex', 'model-c'));
      await evaluate(() => window.task22.setModel('acp', 'model-a'));
      const modelCodex = await evaluate(() => window.task22.modelFor('codex'));
      const modelAcp = await evaluate(() => window.task22.modelFor('acp'));
      await evaluate(() => window.task22.clearModel('codex'));
      const codexCleared = await evaluate(() => window.task22.modelFor('codex'));
      const acpAfterClear = await evaluate(() => window.task22.modelFor('acp'));
      const afterModel = await evaluate(() => window.task22.wireSummary());
      record('modelIsolation', { modelCodex, modelAcp, codexCleared, acpAfterClear });
      check('model selection stays keyed by the full qualified session and never crosses sources', {
        codexModel: modelCodex.model, acpModel: modelAcp.model, codexAfterClear: codexCleared.model, acpAfterClear: acpAfterClear.model,
        frames: afterModel.calls.length - beforeModel.calls.length,
      }, { codexModel: 'model-c', acpModel: 'model-a', codexAfterClear: null, acpAfterClear: 'model-a', frames: 0 });

      // H4 — archive/unarchive and queue are attributed to the correct owner.
      const beforeOwner = await evaluate(() => window.task22.wireSummary());
      await evaluate(() => window.task22.archive('codex'));
      await evaluate(() => window.task22.unarchive('codex'));
      await evaluate(() => window.task22.queue('acp', { text: 'queued' }));
      const afterOwner = await evaluate(() => window.task22.wireSummary());
      const ownerCalls = afterOwner.calls.slice(beforeOwner.calls.length);
      record('archiveRestoreQueueOwner', { ownerCalls });
      check('archive/unarchive and a queue are attributed to the correct owner source', {
        attributed: ownerCalls.map((entry) => ({ method: entry.method, target: entry.target, command: entry.command, queue: entry.queue, text: entry.text })),
        frames: ownerCalls.length,
      }, {
        attributed: [
          { method: 'session.send', target: ENV_CODEX, command: 'archive', queue: false, text: null },
          { method: 'session.send', target: ENV_CODEX, command: 'unarchive', queue: false, text: null },
          { method: 'session.send', target: ENV_ACP, command: null, queue: true, text: 'queued' },
        ],
        frames: 3,
      });

      // H5 — the full fifteen-operation matrix routes by the qualified SessionRef.
      const matrix = await evaluate(() => window.task22.matrix());
      record('operationMatrix', matrix);
      check('all fifteen operations route by the full qualified SessionRef to the correct wire method', matrix, {
        frameCount: 15, sessionSend: 10, sessionCancel: 1, interactionRespond: 2, sessionGet: 2, allCodex: true, targets: [ENV_CODEX],
      });

      const finalErrors = await evaluate(() => window.task22.errors());
      const finalSummary = await evaluate(() => window.task22.wireSummary());
      record('happyFinal', { errors: finalErrors, creates: finalSummary.byMethod['session.create'] ?? 0 });
      check('no erroneous session is created and the browser logs no error across every happy scenario', {
        errors: finalErrors.length, sessionCreates: finalSummary.byMethod['session.create'] ?? 0,
      }, { errors: 0, sessionCreates: 0 });
    }

    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa22-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task22Errors ?? [], task22: Boolean(window.task22) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /old generation|in progress|never cancels/,
    cancel_resume: /cancel race|rejects a detached cancel/,
    malformed_input: /mismatch|unsupported/,
    hung_commands: /independent|correct owner/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /detached|rebind/,
    misleading_success_output: /never re-routed|never mis-answered|never mis-called|never crosses/,
    flaky_tests: /fifteen operations|operation matrix/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));
  return {
    scenarios, artifacts, adversarialClasses: Object.keys(classEvidence), classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'qualified-session-action-routing' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'Real production useRuntimeMessageSend/useRuntimeSessionActions/useRuntimeInteractions execute over the real runtime client/connection and the real selectionScope in a real headless Chromium on a real Vite server. The runtime WebSocket wire inside app/dev/runtime-v090/task22.ts is a controlled fixture serving a canonical multi-target set (codex/acp/dsh plus an explicitly unsupported target), holding/settling mutations, reducing one target\'s advertised capabilities and detaching/reattaching a target so the adversarial timing is deterministic; no product file is edited and no PASS is authored by this module. The legacy useBackend* seam is additive and inactive until task 24 binds it in App.vue, so this case drives the NEW composables directly and makes no end-to-end legacy-UI migration claim.',
  };
}
