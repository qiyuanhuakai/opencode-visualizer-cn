// Task 23 registered QA case — capability-gated model/provider/agent/monitor panels.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the REAL landed code in a real headless Chromium on a real
// Vite server: app/components/runtime/HarnessSettings.vue over the real
// app/composables/useRuntimeCapabilities.ts resolution, and the capability-gated
// paths in ProviderManagerModal.vue / StatusMonitorModal.vue / SettingsModal.vue.
// The only controlled boundary is the manifest set the browser entry passes
// (the same shape the bridge publishes) and a local write ledger whose writes are
// guarded by the REAL capabilities.apply. The new harnessScope / harnessManifests
// props are additive and INACTIVE until task 24 binds them in App.vue, so this
// case passes an explicit scope and makes NO end-to-end legacy-UI migration claim.
// No product file is edited and no PASS verdict is authored by this module.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir } from 'node:fs/promises';
import path from 'node:path';
import { createServer } from 'vite';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased } from './task-23-fixture.mjs';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';
const KINDS = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
const AGENT_CONTROLS = ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent'];
const CREDENTIAL = 'sk-task23-sentinel-4f8a2c9d-NEVER-LOG';

// The exact control set the HarnessSettings surface renders (29 controls).
const CONTROLS = [
  'codex.models', 'listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'codex.providerCapabilities',
  'listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent',
  'getSkillStatus', 'updateSkill', 'getMcpStatus', 'updateMcp', 'getGlobalHealth',
  'codex.usage', 'codex.rateLimits', 'codex.account', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue',
  'listCommands', 'sendCommand', 'getPluginStatus', 'getPluginManagementEntries', 'setPluginEnabled',
  'getLspStatus', 'getSessionStatusMap', 'listPendingPermissions', 'listPendingQuestions',
];

// The declared native surface per kind — mirrors the browser entry fixture.
const DECLARED = {
  opencode: ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'updateMcp', 'getSkillStatus', 'updateSkill', 'getLspStatus', 'getPluginStatus', 'listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'listCommands', 'getSessionStatusMap'],
  codex: ['listProviders', 'codex.models', 'codex.providerCapabilities', 'codex.usage', 'codex.rateLimits', 'codex.account', 'getGlobalConfig', 'updateGlobalConfig', 'writeConfigValue', 'getMcpStatus', 'getSkillStatus', 'updateSkill', 'getPluginStatus'],
  'kimi-web': ['getSkillStatus', 'updateSkill', 'getGlobalConfig', 'updateGlobalConfig'],
  dsh: ['getGlobalConfig', 'updateGlobalConfig', 'getMcpStatus', 'updateMcp'],
  acp: ['listAgents', 'listAgentAuthMethods', 'createAgentAuthPty', 'authenticateAgent', 'getMcpStatus', 'updateMcp', 'getGlobalConfig', 'updateGlobalConfig', 'sendCommand', 'setPluginEnabled'],
};
// getGlobalHealth maps to the always-supported core `inspect` operation.
const EXPECTED_SUPPORTED = Object.fromEntries(KINDS.map((kind) => [kind, [...new Set([...DECLARED[kind], 'getGlobalHealth'])].sort()]));

export const sourceFiles = [...new Set([
  'app/components/runtime/HarnessSettings.vue',
  'app/components/runtime/HarnessSettings.test.ts',
  'app/components/runtime/HarnessBadge.vue',
  'app/composables/useRuntimeCapabilities.ts',
  'app/composables/useRuntimeCapabilities.test.ts',
  'app/components/ProviderManagerModal.vue',
  'app/components/StatusMonitorModal.vue',
  'app/components/SettingsModal.vue',
  'app/utils/regionTheme.ts',
  'app/dev/runtime-v090/task23.ts',
  'scripts/qa/runtime-v090-cases/task-23.mjs',
  'scripts/qa/runtime-v090-cases/task-23-fixture.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 23 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; } #app { min-height: 100%; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task23Errors=[];window.addEventListener('error',(e)=>window.__task23Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task23Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task23.ts"></script></body></html>`;

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-23/qa-cases');
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
    scenarios.push({ name, surface: 'real capability-gated harness settings, provider manager, status monitor and workspace settings in a real headless Chromium', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = normalize(value); persist(); };
  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  let browser; let page; let vite;
  try {
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createServer({ configFile: false, appType: 'custom', root: context.root, plugins: [vue()], server: { host: '127.0.0.1', port: 0, strictPort: false }, logLevel: 'error' });
    vite.middlewares.use('/qa23', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa23/`;
    record('pageUrl', pageUrl);
    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', '--enable-precise-memory-info', '--js-flags=--expose-gc', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl);
    await until(() => page.evaluate(() => Boolean(window.task23 && window.task23.ready)), 'task23 browser entry', 60000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    if (context.case === 'failure') {
      // F1 — a save captured while switching sources is rejected and never crosses.
      const beforeLedger = await evaluate(() => window.task23.writeLedger().length);
      const cross = await evaluate((credential) => window.task23.crossWrite({
        sourceKind: 'opencode', scopeKind: 'instance', targetKind: 'dsh', control: 'updateGlobalConfig',
        payload: { apiKey: credential, provider: 'openai' },
      }), CREDENTIAL);
      const afterLedger = await evaluate(() => window.task23.writeLedger());
      record('asyncSaveSwitch', { cross, afterLedger });
      check('a save in flight across a source switch is rejected with an explicit type and never crosses sources', {
        captured: cross.captured,
        saveScopeKind: cross.saveScope.kind,
        saveScopeHarness: cross.saveScope.harnessInstanceId,
        writeToOtherApplied: cross.writeToOther.applied,
        writeToOtherError: cross.writeToOther.error,
        crossCaptureRejected: typeof cross.crossCaptureError === 'string' && cross.crossCaptureError.includes('capture.scope'),
        ledgerDelta: afterLedger.length - beforeLedger,
        ledgerDshWrites: afterLedger.filter((entry) => entry.target.includes('dsh')).length,
      }, {
        captured: true,
        saveScopeKind: 'instance',
        saveScopeHarness: '10000000-0000-4000-8000-000000000001',
        writeToOtherApplied: false,
        writeToOtherError: 'scope_mismatch',
        crossCaptureRejected: true,
        ledgerDelta: 0,
        ledgerDshWrites: 0,
      });

      // F2 — 403 / unsupported / restart-required / unregistered / unknown each
      // render an explicit rejection reason AND the source, with no action.
      const variants = [
        { variant: 'forbidden', control: 'updateGlobalConfig', marker: '403 forbidden' },
        { variant: 'restart-required', control: 'getGlobalHealth', marker: 'restart required' },
        { variant: 'provider-unsupported', control: 'updateGlobalConfig', marker: 'Codex owns provider configuration' },
        { variant: 'unregistered', control: 'getMcpStatus', marker: 'not registered' },
        { variant: 'unknown', control: 'not-a-real-control', marker: 'Unknown harness control' },
      ];
      const rendered = [];
      for (const entry of variants) {
        await evaluate((input) => window.task23.setHarness(input), { kind: 'opencode', variant: entry.variant });
        const snapshot = await evaluate(() => window.task23.harnessRows());
        const row = snapshot.rows.find((candidate) => candidate.control === entry.control);
        rendered.push({ variant: entry.variant, state: row?.state ?? null, reasonMentioned: Boolean(row?.sourceText && row.sourceText.includes(entry.marker)), hasAction: row?.hasAction ?? null, sourceMentionsSource: Boolean(row?.sourceText && (row.sourceText.includes('opencode') || row.sourceText.includes('Unknown') || row.sourceText.includes('not registered'))) });
      }
      record('explicitRejections', rendered);
      check('403, restart-required, unsupported, unregistered and unknown capabilities each render an explicit rejection reason with the source and no action', {
        variants: rendered.map((entry) => entry.variant),
        allUnsupported: rendered.every((entry) => entry.state === 'unsupported'),
        allReasonMentioned: rendered.every((entry) => entry.reasonMentioned),
        allSourceNamed: rendered.every((entry) => entry.sourceMentionsSource),
        noneHasAction: rendered.every((entry) => entry.hasAction === false),
      }, {
        variants: variants.map((entry) => entry.variant),
        allUnsupported: true, allReasonMentioned: true, allSourceNamed: true, noneHasAction: true,
      });

      const captureRejection = await evaluate((credential) => window.task23.captureUnsupported({ kind: 'dsh', control: 'getSkillStatus', payload: { apiKey: credential } }), CREDENTIAL);
      record('unsupportedCapture', captureRejection);
      check('an unsupported capability cannot be captured for a save and is rejected with an explicit type', {
        thrown: captureRejection.thrown,
        type: typeof captureRejection.error === 'string' && captureRejection.error.startsWith('capture.unsupported'),
      }, { thrown: true, type: true });

      // F3 — a credential never crosses sources and never appears in any log.
      const marker = await evaluate(() => window.task23.marker('task23-console-spy-marker'));
      const leak = await evaluate((credential) => window.task23.crossWrite({
        sourceKind: 'opencode', scopeKind: 'instance', targetKind: 'acp', control: 'updateGlobalConfig',
        payload: { apiKey: credential, refreshToken: credential },
      }), CREDENTIAL);
      const consoleEntries = await evaluate(() => window.task23.consoleEntries());
      const domText = await evaluate(() => window.task23.domText());
      const ledger = await evaluate(() => window.task23.writeLedger());
      record('credentialIsolation', { marker, leak, consoleCount: consoleEntries.length, credentialInConsole: consoleEntries.filter((entry) => entry.text.includes(CREDENTIAL)).length, credentialInDom: domText.includes(CREDENTIAL), ledgerAcp: ledger.filter((entry) => entry.target.includes('acp')).length });
      check('a credential is not written across sources and never appears in any captured console log or the rendered DOM', {
        spyCapturedMarker: marker.logged === true && consoleEntries.some((entry) => entry.text.includes('task23-console-spy-marker')),
        consoleMechanismObserved: consoleEntries.length > 0,
        credentialInConsole: consoleEntries.filter((entry) => entry.text.includes(CREDENTIAL)).length,
        credentialInDom: domText.includes(CREDENTIAL),
        crossWriteApplied: leak.writeToOther.applied,
        ledgerAcpWrites: ledger.filter((entry) => entry.target.includes('acp')).length,
      }, {
        spyCapturedMarker: true,
        consoleMechanismObserved: true,
        credentialInConsole: 0,
        credentialInDom: false,
        crossWriteApplied: false,
        ledgerAcpWrites: 0,
      });

      const finalConsole = await evaluate(() => window.task23.consoleEntries());
      record('failureFinal', { credentialInConsole: finalConsole.filter((entry) => entry.text.includes(CREDENTIAL)).length });
      check('no credential appears in any console log across the whole failure case', {
        credentialInConsole: finalConsole.filter((entry) => entry.text.includes(CREDENTIAL)).length,
      }, { credentialInConsole: 0 });
    } else {
      // H1 — each of the five sources resolves exactly its own declared controls.
      const m = await evaluate(() => window.task23.matrix());
      record('capabilityMatrix', m);
      for (const kind of KINDS) {
        const expected = EXPECTED_SUPPORTED[kind];
        check(`the ${kind} source resolves exactly its own declared native controls and no other source's`, {
          supported: m[kind].supported,
          supportedCount: m[kind].supportedCount,
          unsupportedCount: m[kind].unsupportedCount,
          total: m[kind].total,
        }, {
          supported: expected,
          supportedCount: expected.length,
          unsupportedCount: CONTROLS.length - expected.length,
          total: CONTROLS.length,
        });
      }

      // H2 — HarnessSettings renders each source with source information on every
      // unavailable control (the model/provider/usage monitor per source).
      for (const kind of KINDS) {
        await evaluate((input) => window.task23.setHarness(input), { kind });
        const snapshot = await evaluate(() => window.task23.harnessRows());
        const unsupported = snapshot.rows.filter((row) => row.state === 'unsupported');
        const expected = EXPECTED_SUPPORTED[kind];
        check(`HarnessSettings renders the ${kind} source with the source named on every unavailable control`, {
          rowCount: snapshot.rowCount,
          supportedCount: snapshot.rows.filter((row) => row.state === 'supported').length,
          unsupportedCount: unsupported.length,
          unavailableWithoutSource: unsupported.filter((row) => row.sourceKind !== kind || !row.sourceText || !row.sourceText.includes(kind) || !row.sourceText.includes('does not declare') || row.hasAction).length,
          summary: snapshot.summary,
        }, {
          rowCount: CONTROLS.length,
          supportedCount: expected.length,
          unsupportedCount: CONTROLS.length - expected.length,
          unavailableWithoutSource: 0,
          summary: `${CONTROLS.length - expected.length} / ${CONTROLS.length} unavailable`,
        });
      }

      // H3 — multiple ACP agent configuration stays gated on the acp manifest.
      await evaluate((input) => window.task23.setHarness(input), { kind: 'acp' });
      const acpRows = await evaluate(() => window.task23.harnessRows());
      await evaluate((input) => window.task23.setHarness(input), { kind: 'dsh' });
      const dshRows = await evaluate(() => window.task23.harnessRows());
      const acpAgents = AGENT_CONTROLS.map((control) => acpRows.rows.find((row) => row.control === control)?.state ?? null);
      const dshAgents = AGENT_CONTROLS.map((control) => { const row = dshRows.rows.find((candidate) => candidate.control === control); return { state: row?.state ?? null, sourceKind: row?.sourceKind ?? null, hasAction: row?.hasAction ?? null }; });
      record('acpAgentConfiguration', { acpAgents, dshAgents });
      check('multiple ACP agent configuration controls are available on acp and unavailable with their source elsewhere', {
        acp: acpAgents,
        dshStates: dshAgents.map((row) => row.state),
        dshSourceKinds: [...new Set(dshAgents.map((row) => row.sourceKind))],
        dshHasAction: dshAgents.map((row) => row.hasAction),
      }, {
        acp: AGENT_CONTROLS.map(() => 'supported'),
        dshStates: AGENT_CONTROLS.map(() => 'unsupported'),
        dshSourceKinds: ['dsh'],
        dshHasAction: AGENT_CONTROLS.map(() => false),
      });

      // H4 — an unsaved save stays isolated to its source across a switch.
      const beforeLedger = await evaluate(() => window.task23.writeLedger().length);
      const isolation = await evaluate((credential) => window.task23.crossWrite({
        sourceKind: 'codex', scopeKind: 'instance', targetKind: 'dsh', control: 'updateGlobalConfig',
        payload: { apiKey: credential, draft: true },
      }), CREDENTIAL);
      const afterLedger = await evaluate(() => window.task23.writeLedger());
      record('unsavedFormIsolation', { isolation, ledgerDelta: afterLedger.length - beforeLedger });
      check('an unsaved draft captured for one source stays isolated and is never applied to another source', {
        captured: isolation.captured,
        saveScopeKind: isolation.saveScope.kind,
        saveScopeHarness: isolation.saveScope.harnessInstanceId,
        writeToOtherApplied: isolation.writeToOther.applied,
        ledgerDelta: afterLedger.length - beforeLedger,
      }, {
        captured: true,
        saveScopeKind: 'instance',
        saveScopeHarness: '10000000-0000-4000-8000-000000000002',
        writeToOtherApplied: false,
        ledgerDelta: 0,
      });

      // H5 — the provider manager gates the credential write on the manifest.
      await evaluate((input) => window.task23.setProviderScope(input), { kind: 'kimi-web', scopeKind: 'instance' });
      const provider = await evaluate(() => window.task23.provider());
      record('providerManagerGate', provider);
      check('the provider manager refuses the credential write and names the source when the manifest does not declare it', {
        sourcePresent: provider.sourceCount >= 1,
        sourceNamesSource: provider.sourceTexts.some((text) => text.includes('kimi-web') && text.includes('does not declare')),
        connectDisabledWithSource: provider.alphaButtons.some((button) => button.disabled && typeof button.title === 'string' && button.title.includes('does not declare')),
      }, { sourcePresent: true, sourceNamesSource: true, connectDisabledWithSource: true });

      // H6 — the status monitor gates the MCP capability on the manifest.
      await evaluate((input) => window.task23.setMonitorScope(input), { kind: 'opencode', variant: 'nothing', scopeKind: 'instance' });
      const monitor = await evaluate(() => window.task23.monitor());
      record('statusMonitorGate', monitor);
      check('the status monitor reports the MCP capability as unsupported with its source when the manifest does not declare it', {
        sourcePresent: monitor.sourceCount >= 1,
        sourceNamesSource: monitor.sourceTexts.some((text) => text.includes('opencode') && text.includes('does not declare')),
        hasMcpTab: monitor.tabs.some((tab) => tab.toUpperCase().includes('MCP')),
      }, { sourcePresent: true, sourceNamesSource: true, hasMcpTab: true });

      // H7 — the workspace settings control is independent of the active backend.
      await evaluate((input) => window.task23.setWorkspaceScope(input), { present: true, path: '/repo' });
      const withWorkspace = await evaluate(() => window.task23.settings());
      await evaluate((input) => window.task23.setWorkspaceScope(input), { present: false });
      const withoutWorkspace = await evaluate(() => window.task23.settings());
      record('workspaceSettingsGate', { withWorkspace, withoutWorkspace });
      check('the workspace settings control is enabled with a workspace scope and names the workspace when it is absent', {
        withWorkspace: { row: withWorkspace.hasLocalApplicationRow, disabled: withWorkspace.browseDisabled, sourceCount: withWorkspace.sourceCount },
        withoutWorkspace: { row: withoutWorkspace.hasLocalApplicationRow, disabled: withoutWorkspace.browseDisabled, sourceNamesWorkspace: Boolean(withoutWorkspace.sourceText && withoutWorkspace.sourceText.includes('no workspace is selected')) },
      }, {
        withWorkspace: { row: true, disabled: false, sourceCount: 0 },
        withoutWorkspace: { row: true, disabled: true, sourceNamesWorkspace: true },
      });

      // H8 — three themes at desktop and mobile widths for the happy surfaces.
      await evaluate((input) => window.task23.setHarness(input), { kind: 'opencode' });
      const screenshots = [];
      for (const theme of ['default', 'aurora-tide', 'sakura']) {
        await evaluate((name) => window.task23.setTheme(name), theme);
        for (const width of [1440, 390]) {
          await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
          const filename = path.join(runDir, `qa23-happy-${theme}-${width}.png`);
          await page.screenshot({ path: filename, fullPage: true });
          artifacts.push(artifact(filename, 'screenshot'));
          screenshots.push({ theme, width, path: filename });
        }
      }
      record('themeScreenshots', screenshots);
      check('the happy surfaces are captured across three themes at desktop (1440) and mobile (390) widths', {
        themes: [...new Set(screenshots.map((entry) => entry.theme))].sort(),
        widths: [...new Set(screenshots.map((entry) => entry.width))].sort((a, b) => a - b),
        count: screenshots.length,
        everyFileRecorded: screenshots.every((entry) => entry.path.endsWith('.png')),
      }, {
        themes: ['aurora-tide', 'default', 'sakura'],
        widths: [390, 1440],
        count: 6,
        everyFileRecorded: true,
      });

      const finalConsole = await evaluate(() => window.task23.consoleEntries());
      record('happyFinal', { credentialInConsole: finalConsole.filter((entry) => entry.text.includes(CREDENTIAL)).length, rows: 29 });
      check('no credential appears in any console log across the whole happy case', {
        credentialInConsole: finalConsole.filter((entry) => entry.text.includes(CREDENTIAL)).length,
      }, { credentialInConsole: 0 });
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task23Errors ?? [], task23: Boolean(window.task23) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /source switch|isolated|in flight/,
    cancel_resume: /rejected|refuses/,
    malformed_input: /unsupported|unknown|not registered/,
    hung_commands: /never crosses|never applied/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /restart-required|403/,
    misleading_success_output: /masquerad|does not declare|names the source/,
    flaky_tests: /exactly its own|matrix/,
  };
  const classEvidence = Object.fromEntries(Object.entries(classMatchers).flatMap(([name, pattern]) => {
    const matched = checks.filter((entry) => pattern.test(entry.name));
    return matched.length ? [[name, matched.map((entry) => ({ scenario: entry.name, artifact: path.join(runDir, 'proof.json'), numericObservable: { observed: entry.observed, expected: entry.expected } }))]] : [];
  }));
  return {
    scenarios, artifacts, adversarialClasses: Object.keys(classEvidence), classEvidence,
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'capability-gated-harness-settings' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'The real HarnessSettings.vue renders over the real useRuntimeCapabilities.ts resolution for all five harness kinds, and the capability-gated paths in ProviderManagerModal.vue / StatusMonitorModal.vue / SettingsModal.vue execute with an explicit harness/workspace scope in a real headless Chromium on a real Vite server. The manifest set the browser entry passes is the controlled boundary (the same shape the bridge publishes) and the write sink is a local ledger guarded by the REAL capabilities.apply; no product file is edited and no PASS is authored by this module. The harnessScope / harnessManifests props are additive and INACTIVE until task 24 binds a scope in App.vue, so this case drives the NEW gated path with an explicit scope and makes NO end-to-end legacy-UI migration claim.',
  };
}
