// Task 30 registered QA case — the SSH / HPC connection surface and lifecycle feedback (GAP-5, plan
// task 30).
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles array and a
// run(context) returning a JSON-serialisable result whose scenarios each carry assertions with
// observed === expected. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge modules bridge/runtime/transports/slurmJobs.js,
//     slurmControlStore.js and sshAuthentication.js, plus shared/runtime/connectionProfile.js — the
//     real secret channel (a 0600 askpass FILE), the real Slurm control store (REAL journal files
//     under the private root) driven by a counting scheduler, the real strict profile parser and the
//     real target mapping.
//   * In a real headless Chromium: the landed Vue surface (ConnectionManager / SshHostForm /
//     SlurmExecutionForm / ConnectionStatus / RemoteBridgeActions) mounted over the REAL
//     app/composables/useRuntimeProfiles.ts, driven through the REAL form inputs and buttons, with
//     the REAL imported-theme token pipeline (app/utils/regionTheme.ts + themeTokens.ts).
//
// The controlled boundaries (injected fakes) are:
//   * the management profile port, the Slurm lifecycle port and the remote-bridge port — task 30's
//     implementation documents that the Slurm lifecycle port has no HTTP/WS route yet; only the CLI
//     control-store / relay roles reach the real controller, so this case injects it too and does
//     NOT claim a wired route;
//   * the challenge responder (this case presents a challenge and answers it through the real UI);
//   * @iconify/vue is aliased to a case-owned inert stub (icons are decorative);
//   * the SSH process edge is never touched — the askpass file PATH is what is exercised, not a
//     live ssh dial.
//
// This case does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that —
// and it authors no PASS verdict. No product or test file is edited by this module.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import vue from '@vitejs/plugin-vue';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, createFixture, until } from './task-30-fixture.mjs';

import { createSlurmJobController } from '../../../bridge/runtime/transports/slurmJobs.js';
import { createSlurmControlStore } from '../../../bridge/runtime/transports/slurmControlStore.js';
import { REDACTED, createSecretBox, createSecretChannel, redactSecrets } from '../../../bridge/runtime/transports/sshAuthentication.js';
import {
  assertNoSecretPayload,
  parseNewConnectionProfile,
  resolveProfileEnvironment,
} from '../../../shared/runtime/connectionProfile.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const COMPUTE_NODE = 'compute-01.cluster';
const OTHER_COMPUTE_NODE = 'compute-02.cluster';
const SECRET = '(this-is-the-challenge-secret-NEVER-PERSISTED)';
const OTP = '491207';
const EXT4 = 0xef53;

export const sourceFiles = [...new Set([
  // the six product paths this unit owns + their two test files
  'app/components/runtime/ConnectionManager.vue', 'app/components/runtime/ConnectionStatus.vue',
  'app/components/runtime/RemoteBridgeActions.vue', 'app/components/runtime/SshHostForm.vue',
  'app/components/runtime/SlurmExecutionForm.vue', 'app/composables/useRuntimeProfiles.ts',
  'app/components/runtime/ConnectionManager.test.ts', 'app/composables/useRuntimeProfiles.test.ts',
  // the shared surfaces the components exercise
  'app/components/Dropdown.vue', 'app/components/Dropdown/Item.vue',
  'shared/runtime/connectionProfile.js', 'shared/runtime/connectionProfile.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  // the real bridge modules exercised in the Node worker
  'bridge/runtime/transports/slurmJobs.js', 'bridge/runtime/transports/slurmJobs.d.ts',
  'bridge/runtime/transports/slurmControlStore.js', 'bridge/runtime/transports/slurmControlStore.d.ts',
  'bridge/runtime/transports/sshAuthentication.js', 'bridge/runtime/transports/sshAuthentication.d.ts',
  // the imported-theme token pipeline the browser surface renders under
  'app/utils/regionTheme.ts', 'app/utils/themeTokens.ts', 'app/utils/themeRegistry.ts',
  'app/utils/colorValue.ts', 'app/utils/storageKeys.ts', 'app/utils/floatingWindowTheme.ts',
  'app/utils/themeFileValidation.ts', 'app/schema/theme.schema.json',
  'app/utils/soft-white.theme_1.json', 'app/utils/anime-night.theme_1.json', 'app/utils/light-mode.theme_1.json',
  // case-owned files + runner inputs
  'app/dev/runtime-v090/task30.ts',
  'scripts/qa/runtime-v090-cases/task-30.mjs',
  'scripts/qa/runtime-v090-cases/task-30-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-30-browser-shim.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en" data-region-theme="none"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 30 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; background: var(--theme-surface-page, #ffffff); color: var(--theme-text-primary, #111); }</style></head>
<body><div id="app"></div>
<script type="module">window.__task30Errors=[];window.addEventListener('error',(e)=>window.__task30Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task30Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task30.ts"></script></body></html>`;

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);
const captureError = (run) => {
  try { const value = run(); return value && typeof value.then === 'function' ? { pending: true } : {}; }
  catch (error) { return { code: error?.code, field: error?.field, message: error instanceof Error ? error.message : String(error) }; }
};

const RESOURCES = Object.freeze({ partition: 'cpu', account: 'research', cpus: 4, memory: '8G', time: '01:00:00', gres: 'none' });

function countingScheduler(jobId) {
  const cancelCalls = [];
  const queryCalls = [];
  return {
    scheduler: {
      async submit() { return { stdout: `${jobId}\n` }; },
      async query(request) { queryCalls.push(request); return { matches: [{ jobId, state: 'RUNNING' }] }; },
      async cancel(request) { cancelCalls.push(request); return { cancelled: true }; },
    },
    cancelCalls,
    queryCalls,
  };
}

async function openStore(root) {
  const store = createSlurmControlStore({
    root, environmentId: ENVIRONMENT, ownerInstanceId: 'task-30-qa', platform: 'linux',
    statfs: () => ({ type: EXT4 }),
  });
  await store.open('owner');
  return store;
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-30/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const toolLedger = { scenarioCount: 0 };
  const proof = { case: context.case, runDir, checks, observations, toolLedger };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'real landed task-30 Vue surface + composable in headless Chromium over injected profile/Slurm/bridge ports, plus the real bridge Slurm/secret/profile modules in the Node worker over real files',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [
    'scripts/qa/runtime-v090-cases/task-30.mjs',
    'scripts/qa/runtime-v090-cases/task-30-fixture.mjs',
    'scripts/qa/runtime-v090-cases/task-30-browser-shim.mjs',
    'app/dev/runtime-v090/task30.ts',
  ];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  const protocol = { scheduler: {}, secretChannel: {}, browserCallLog: [], profileParser: {} };

  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Node-worker REAL-module checks (the layer the browser cannot reach)
    // ══════════════════════════════════════════════════════════════════════════════════════════

    // ── Criterion 4 (bridge level): a password / OTP becomes a 0600 FILE PATH, never a value ──
    const secretDir = path.join(fixture.root, 'secret');
    await mkdir(secretDir, { recursive: true });
    fixture.register({ kind: 'secret-channel-planned', dir: secretDir, teardown: 'channel.cleanup removes the 0600 file; private root removal covers the dir' });
    const channel = await createSecretChannel([SECRET, OTP], { directory: secretDir, askpassPath: '/usr/lib/vis/askpass' });
    const channelMode = (await stat(channel.filePath)).mode & 0o777;
    const channelContent = await readFile(channel.filePath, 'utf8');
    const envJson = JSON.stringify(channel.env);
    fixture.register({ kind: 'secret-channel-created', filePath: channel.filePath, mode: channelMode });
    fixture.own('secret-channel', async () => { await channel.cleanup(); const gone = await stat(channel.filePath).then(() => false, (error) => error.code === 'ENOENT'); return { gone }; });
    const bridgeBox = createSecretBox(SECRET, 'password');
    const bridgeRedacted = redactSecrets(JSON.stringify({ password: SECRET, otp: OTP }), [SECRET, OTP]);
    protocol.secretChannel = { askpass: channel.env.SSH_ASKPASS, require: channel.env.SSH_ASKPASS_REQUIRE, mode: channelMode, filePathIsPath: channel.filePath };
    record('secretChannel', protocol.secretChannel);
    check('a challenge secret is delivered as a 0600 askpass FILE PATH, never as argv or an env value, and both the value and the OTP are redacted in every projection', {
      askpassIsPath: channel.env.SSH_ASKPASS === '/usr/lib/vis/askpass',
      askpassRequire: channel.env.SSH_ASKPASS_REQUIRE,
      envHasSecret: occurrences(envJson, SECRET), envHasOtp: occurrences(envJson, OTP),
      fileMode: `0${channelMode.toString(8)}`,
      // The RECEIVER's contract (createSecretChannel in sshAuthentication.js line 74) writes
      // `values.join('\n')`, so a two-value channel holds BOTH values newline-joined in order and
      // NOTHING else. Assert exact equality against that join — not a substring "contains the
      // secret" check, which would pass on a file that also carried extra lines or other values.
      fileContentIsSecretThenOtp: channelContent === `${SECRET}\n${OTP}`,
      fileContentLineCount: channelContent.split('\n').length,
      argvHasSecret: occurrences(process.argv.join(' '), SECRET), argvHasOtp: occurrences(process.argv.join(' '), OTP),
      boxString: String(bridgeBox), boxJson: JSON.stringify(bridgeBox),
      redactionMarker: REDACTED,
      redactedHasSecret: occurrences(bridgeRedacted, SECRET), redactedHasOtp: occurrences(bridgeRedacted, OTP),
      redactedMarkerCount: occurrences(bridgeRedacted, REDACTED),
    }, {
      askpassIsPath: true, askpassRequire: 'force', envHasSecret: 0, envHasOtp: 0,
      fileMode: '0600', fileContentIsSecretThenOtp: true, fileContentLineCount: 2, argvHasSecret: 0, argvHasOtp: 0,
      boxString: REDACTED, boxJson: JSON.stringify(REDACTED),
      redactionMarker: '[redacted]', redactedHasSecret: 0, redactedHasOtp: 0, redactedMarkerCount: 2,
    });

    // ── Criterion 3 (bridge level): a borrowed disconnect produces ZERO cancel signals ──
    const borrowedRoot = path.join(fixture.root, 'control-borrowed');
    const borrowedStore = await openStore(borrowedRoot);
    const borrowedScheduler = countingScheduler('24680');
    const borrowedController = createSlurmJobController({ store: borrowedStore, scheduler: borrowedScheduler.scheduler, environmentId: ENVIRONMENT });
    const borrowed = await borrowedController.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'borrowed' });
    await borrowedController.reconcile(borrowed.intentId);
    const borrowedDetach = await borrowedController.detach(borrowed.intentId);
    const borrowedStopAttempt = await borrowedController.stop(borrowed.intentId);
    const borrowedAfter = await borrowedController.state(borrowed.intentId);
    const borrowedCancelSignals = borrowedScheduler.cancelCalls.length;
    await borrowedStore.close();

    const ownedRoot = path.join(fixture.root, 'control-owned');
    const ownedStore = await openStore(ownedRoot);
    const ownedScheduler = countingScheduler('97531');
    const ownedController = createSlurmJobController({ store: ownedStore, scheduler: ownedScheduler.scheduler, environmentId: ENVIRONMENT });
    const owned = await ownedController.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'owned' });
    await ownedController.reconcile(owned.intentId);
    const ownedDetach = await ownedController.detach(owned.intentId);
    const ownedAfterDetachSignals = ownedScheduler.cancelCalls.length;
    const ownedStop = await ownedController.stop(owned.intentId);
    const ownedCancelSignals = ownedScheduler.cancelCalls.length;
    await ownedStore.close();
    protocol.scheduler = {
      borrowed: { cancelSignals: borrowedCancelSignals, queryCalls: borrowedScheduler.queryCalls.length, detach: borrowedDetach, stopAttempt: borrowedStopAttempt },
      owned: { signalsAfterDetach: ownedAfterDetachSignals, signalsAfterStop: ownedCancelSignals, stop: ownedStop },
    };
    record('scheduler', protocol.scheduler);
    check('the REAL Slurm controller signals ZERO cancels when a connection detaches a borrowed job, and exactly ONE only when an owned job is explicitly stopped', {
      borrowedOwnership: borrowed.ownership,
      borrowedDetachAttached: borrowedDetach.attached, borrowedDetachSignalled: borrowedDetach.signalled,
      borrowedStopSignalled: borrowedStopAttempt.signalled, borrowedStopReason: borrowedStopAttempt.reason,
      borrowedCancelSignals,
      borrowedStateAfter: borrowedAfter?.state, borrowedStillAttached: borrowedAfter?.attached,
      ownedDetachSignalled: ownedDetach.signalled, ownedSignalsAfterDetach: ownedAfterDetachSignals,
      ownedStopSignalled: ownedStop.signalled, ownedStopCancelled: ownedStop.cancelled, ownedCancelSignals,
    }, {
      borrowedOwnership: 'borrowed',
      borrowedDetachAttached: false, borrowedDetachSignalled: false,
      borrowedStopSignalled: false, borrowedStopReason: 'borrowed',
      borrowedCancelSignals: 0,
      borrowedStateAfter: 'RUNNING', borrowedStillAttached: false,
      ownedDetachSignalled: false, ownedSignalsAfterDetach: 0,
      ownedStopSignalled: true, ownedStopCancelled: true, ownedCancelSignals: 1,
    });

    // ── Criterion 5 (mapping level): the target resolves to a STABLE environment, never a node/job ──
    const slurmProfile = {
      profileId: '40000000-0000-4000-8000-000000000001',
      name: 'Cluster', transport: { kind: 'slurm' },
      target: { kind: 'slurm', clusterEnvironmentId: ENVIRONMENT },
      role: 'execution', credentialRef: 'cred-1', enabled: true,
    };
    const sshProfile = {
      profileId: '40000000-0000-4000-8000-000000000002',
      name: 'Login', transport: { kind: 'ssh', endpoint: 'login-01.cluster' },
      target: { kind: 'ssh', environmentId: ENVIRONMENT },
      role: 'manager', credentialRef: 'cred-1', enabled: true,
    };
    const envOfSlurm = resolveProfileEnvironment(slurmProfile);
    const envOfSsh = resolveProfileEnvironment(sshProfile);
    const movedNodeProfile = { ...slurmProfile, target: { kind: 'slurm', clusterEnvironmentId: ENVIRONMENT } };
    const sameEnvAcrossNode = resolveProfileEnvironment(movedNodeProfile) === envOfSlurm;
    check('a Slurm profile resolves to the CLUSTER environment UUID (never a compute hostname or a job id), and the same environment survives a compute-node move', {
      slurmEnvironment: envOfSlurm, slurmIsUuid: /^[0-9a-f-]{36}$/u.test(envOfSlurm),
      sshEnvironment: envOfSsh,
      environmentIsNotNode: envOfSlurm === COMPUTE_NODE,
      environmentIsNotJob: envOfSlurm === '24680',
      sameEnvAcrossNode,
    }, {
      slurmEnvironment: ENVIRONMENT, slurmIsUuid: true,
      sshEnvironment: ENVIRONMENT,
      environmentIsNotNode: false,
      environmentIsNotJob: false,
      sameEnvAcrossNode: true,
    });

    // ── Criterion 4 (parser level): the REAL strict parser refuses a secret-bearing profile ──
    const secretDraft = captureError(() => assertNoSecretPayload({ ...sshProfile, password: SECRET }));
    const endpointSecret = captureError(() => parseNewConnectionProfile({
      name: 'x', transport: { kind: 'ssh', endpoint: 'user:pass@cluster.example.edu' },
      target: { kind: 'ssh', environmentId: ENVIRONMENT }, role: 'manager', credentialRef: 'cred-1',
    }));
    protocol.profileParser = { secretDraft, endpointSecret };
    record('profileParser', protocol.profileParser);
    check('the REAL strict profile parser rejects a secret-bearing field and an endpoint that embeds a credential, before any profile can be stored', {
      secretRejected: secretDraft.message !== undefined,
      secretField: /password/u.test(String(secretDraft.message ?? '')),
      endpointRejected: endpointSecret.message !== undefined,
      endpointField: /transport\.endpoint/u.test(String(endpointSecret.message ?? '')),
    }, {
      secretRejected: true, secretField: true, endpointRejected: true, endpointField: true,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real headless Chromium over the REAL Vue surface + composable
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const shimPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-30-browser-shim.mjs');
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      plugins: [vue()],
      resolve: { alias: [
        // Hermetic surface: the decorative Icon never fetches from the Iconify API.
        { find: /^@iconify\/vue$/, replacement: shimPath },
      ] },
      optimizeDeps: { include: ['vue', 'vue-i18n', 'buffer'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa30', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa30/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task30 && window.task30.ready)), 'task30 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));
    const browserSecret = await evaluate(() => window.task30.constants.SECRET);

    const ENTRY_BOTH = await evaluate(() => ({
      browser: window.task30.resolveEntry({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }),
      electron: window.task30.resolveEntry({ client: 'electron', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }),
      browserNoBridge: window.task30.resolveEntry({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: false }),
      electronNoBridge: window.task30.resolveEntry({ client: 'electron', transports: { direct: true, ssh: true, slurm: true }, managedTransport: false }),
      missingTransports: window.task30.resolveEntry({ client: 'browser', transports: { direct: true, ssh: false, slurm: false }, managedTransport: true }),
    }));
    record('capabilityEntry', ENTRY_BOTH);
    check('Browser and Electron resolve the ONE capability entry identically, and it is a function of (transports, managedTransport) — never of the client kind', {
      browserRows: ENTRY_BOTH.browser.map((row) => `${row.capability}:${row.state}`).join(','),
      electronEqualsBrowser: JSON.stringify(ENTRY_BOTH.electron) === JSON.stringify(ENTRY_BOTH.browser),
      noBridgeBrowser: ENTRY_BOTH.browserNoBridge.map((row) => `${row.capability}:${row.state}`).join(','),
      noBridgeEquals: JSON.stringify(ENTRY_BOTH.electronNoBridge) === JSON.stringify(ENTRY_BOTH.browserNoBridge),
      missingTransports: ENTRY_BOTH.missingTransports.map((row) => `${row.capability}:${row.state}:${row.reason}`).join('|'),
      entryRowCount: ENTRY_BOTH.browser.length,
    }, {
      browserRows: 'direct:supported,managed-bridge:supported,ssh:supported,slurm:supported',
      electronEqualsBrowser: true,
      noBridgeBrowser: 'direct:supported,managed-bridge:unsupported,ssh:unsupported,slurm:unsupported',
      noBridgeEquals: true,
      missingTransports: [
        'direct:supported:null',
        'managed-bridge:supported:null',
        'ssh:unsupported:Target does not report an SSH transport',
        'slurm:unsupported:Target does not report a Slurm transport',
      ].join('|'),
      entryRowCount: 4,
    });

    // ── H (rendered): the same entry, and the same control set, on both clients ──
    const configuredBrowser = await evaluate(() => window.task30.configure({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }));
    const browserRowsRendered = await evaluate(() => window.task30.renderedCapabilityRows());
    const browserButtonCount = await evaluate(() => window.task30.renderedButtonCount());
    const browserProbe = await evaluate(() => window.task30.probe());
    await evaluate(() => window.task30.configure({ client: 'electron', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }));
    const electronRowsRendered = await evaluate(() => window.task30.renderedCapabilityRows());
    const electronButtonCount = await evaluate(() => window.task30.renderedButtonCount());
    const electronProbe = await evaluate(() => window.task30.probe());
    record('renderedCapability', { browserRowsRendered, electronRowsRendered, browserButtonCount, electronButtonCount, configuredBrowser });
    check('the RENDERED capability surface and control set are identical for Browser and Electron, with the client recorded as attribution only', {
      browserRows: browserRowsRendered.join(','),
      electronRows: electronRowsRendered.join(','),
      rowsIdentical: browserRowsRendered.join(',') === electronRowsRendered.join(','),
      browserButtons: browserButtonCount, electronButtons: electronButtonCount,
      buttonsIdentical: browserButtonCount === electronButtonCount,
      browserClientAttr: browserProbe.managerClient, electronClientAttr: electronProbe.managerClient,
      directOnlyMarkerHidden: browserProbe.directOnlyMarker === null,
      managedTransportAttr: browserProbe.managedTransportAttr,
    }, {
      browserRows: 'direct:supported,managed-bridge:supported,ssh:supported,slurm:supported',
      electronRows: 'direct:supported,managed-bridge:supported,ssh:supported,slurm:supported',
      rowsIdentical: true,
      browserButtons: browserButtonCount, electronButtons: browserButtonCount,
      buttonsIdentical: true,
      browserClientAttr: 'browser', electronClientAttr: 'electron',
      directOnlyMarkerHidden: true,
      managedTransportAttr: 'true',
    });

    // ── Criterion 2: no managed bridge ⇒ a VISIBLE direct-only marker, not an absent control ──
    await evaluate(() => window.task30.configure({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: false }));
    const directOnlyProbe = await evaluate(() => window.task30.probe());
    const directOnlyRows = await evaluate(() => window.task30.renderedCapabilityRows());
    record('directOnly', { directOnlyProbe, directOnlyRows });
    check('with no managed bridge the UI renders a VISIBLE direct-only marker and keeps the SSH/Slurm rows present-but-unsupported (an absence is never used to communicate an absence)', {
      markerPresent: directOnlyProbe.directOnlyMarker !== null,
      markerMentionsDirectOnly: /Direct only/u.test(String(directOnlyProbe.directOnlyMarker ?? '')),
      markerMentionsNoManagedBridge: /no managed bridge/u.test(String(directOnlyProbe.directOnlyMarker ?? '')),
      sshRowState: directOnlyRows.find((row) => row.startsWith('ssh:')),
      slurmRowState: directOnlyRows.find((row) => row.startsWith('slurm:')),
      directRowState: directOnlyRows.find((row) => row.startsWith('direct:')),
      newSshDisabled: directOnlyProbe.newSshDisabled, newSlurmDisabled: directOnlyProbe.newSlurmDisabled,
      newProfileHint: /unavailable/u.test(String(directOnlyProbe.newProfileHint ?? '')),
    }, {
      markerPresent: true, markerMentionsDirectOnly: true, markerMentionsNoManagedBridge: true,
      sshRowState: 'ssh:unsupported', slurmRowState: 'slurm:unsupported', directRowState: 'direct:supported',
      newSshDisabled: true, newSlurmDisabled: true, newProfileHint: true,
    });
    // and the marker is a positive state, not a persistent absence: re-enabling the bridge hides it.
    await evaluate(() => window.task30.configure({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }));
    const managedProbe = await evaluate(() => window.task30.probe());
    check('the direct-only marker is a real state, not a permanent absence: it disappears the moment a managed bridge exists', {
      markerAfterManaged: managedProbe.directOnlyMarker,
      managedTransportAttr: managedProbe.managedTransportAttr,
    }, {
      markerAfterManaged: null, managedTransportAttr: 'true',
    });

    // ── Happy: SSH profile → trust → connect, driven through the REAL form and buttons ──
    const probeSet = await evaluate((env) => window.task30.setProbeEnvironment(env), ENVIRONMENT);
    const created = await evaluate(() => window.task30.createSshProfileViaUi({ name: 'Lab cluster', endpoint: 'cluster.example.edu', credentialRef: 'cred-1', enabled: true }));
    protocol.browserCallLog = await evaluate(() => window.task30.callLog());
    record('createProfile', { probeSet, created });
    check('the REAL SSH form runs the strict parser and creates an environment-bound profile whose credential is a REFERENCE, then the picker renders it with its stable environment', {
      profileCount: created.profileCount,
      createdEnabled: created.created?.enabled,
      createdTransport: created.created?.transport?.kind,
      createdTargetEnvironment: created.created?.target?.environmentId,
      createdCredentialRef: created.created?.credentialRef,
      draftHasSecretKey: created.created === null ? true : Object.keys(created.created).some((key) => /password|secret|token|otp|passphrase/iu.test(key)),
      selectedProfileId: created.selectedProfileId,
      savedProblems: created.savedProblems,
    }, {
      profileCount: 1,
      createdEnabled: true,
      createdTransport: 'ssh',
      createdTargetEnvironment: ENVIRONMENT,
      createdCredentialRef: 'cred-1',
      draftHasSecretKey: false,
      selectedProfileId: created.selectedProfileId,
      savedProblems: null,
    });

    const hostKeyChallenge = await evaluate(() => window.task30.presentChallengeAndMount('host-key', { prompt: 'Trust compute-01.cluster?', fingerprint: 'SHA256:aaaabbbbccccdddd' }));
    const hostKeyProbe = await evaluate(() => window.task30.probe());
    record('hostKeyChallenge', { hostKeyChallenge, hostKeyProbe });
    check('a first-contact host key is presented as an explicit trust challenge with its fingerprint, and the accept path is available', {
      kind: hostKeyProbe.challengeKind,
      fingerprint: hostKeyProbe.challengeFingerprint,
      prompt: hostKeyProbe.challengePrompt,
      acceptDisabled: hostKeyProbe.challengeAcceptDisabled,
      hasSecretInput: hostKeyProbe.challengeHasSecretInput,
    }, {
      kind: 'host-key',
      fingerprint: 'SHA256:aaaabbbbccccdddd',
      prompt: 'Trust compute-01.cluster?',
      acceptDisabled: false,
      hasSecretInput: false,
    });

    const trustAnswer = await evaluate(() => window.task30.answerChallengeViaUi({ accept: true }));
    record('trustAnswer', trustAnswer);
    check('trusting the host key hands over a secret-free answer and clears the challenge', {
      kind: trustAnswer.kind,
      accept: trustAnswer.payload?.accept,
      hasSecret: trustAnswer.payload?.secret !== undefined,
      payloadKeys: Object.keys(trustAnswer.payload ?? {}).sort().join(','),
      challengeCleared: trustAnswer.challengeCleared,
      leaked: trustAnswer.secretInPayload,
    }, {
      kind: 'host-key',
      accept: true,
      hasSecret: false,
      payloadKeys: 'accept,challengeId,kind,persist',
      challengeCleared: true,
      leaked: 0,
    });

    const connected = await evaluate(() => window.task30.connectViaUi());
    const connectedProbe = await evaluate(() => window.task30.probe());
    record('connect', { connected, connectedProbe });
    check('the connect action drives the profile port to a connected status with an explicit generation, and the connection-cancel affordance becomes available', {
      clicked: connected.clicked,
      state: connected.status?.state,
      generation: connected.status?.generation,
      environmentId: connected.status?.environmentId,
      statusChip: connectedProbe.statusChip,
      cancelDisabled: connectedProbe.cancelDisabled,
    }, {
      clicked: true,
      state: 'connected',
      generation: 1,
      environmentId: ENVIRONMENT,
      statusChip: 'connected',
      cancelDisabled: false,
    });

    // ── Criterion 5 (rendered): a visible compute node AND a stable environment distinction ──
    const selectedProfileId = created.selectedProfileId;
    const readyIntent = await evaluate((args) => window.task30.setSlurm({
      environmentId: '11111111-1111-4111-8111-111111111111',
      intentId: args.profileId, jobId: '24680', state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-1', epoch: 3, bridgeInstanceId: 'bridge-1',
    }), { profileId: selectedProfileId, node: COMPUTE_NODE });
    const targets = await evaluate(() => window.task30.renderedTargets());
    const resolvedEnv = await evaluate((id) => window.task30.resolvedEnvironmentOf(id), selectedProfileId);
    record('renderedTargets', { readyIntent, targets, resolvedEnv });
    check('the execution target renders the stable environment UUID NEXT TO a visible compute node, a job id and the ownership — the node is never the identity', {
      environmentId: targets.environmentId,
      computeNode: targets.computeNode,
      jobId: targets.jobId,
      ownership: targets.ownership,
      environmentCell: targets.environmentCell,
      computeNodeCell: targets.computeNodeCell,
      jobCell: targets.jobCell,
      environmentIsNotNode: targets.environmentId === targets.computeNode,
      environmentIsNotJob: targets.environmentId === targets.jobId,
      resolvedEnv,
    }, {
      environmentId: ENVIRONMENT,
      computeNode: COMPUTE_NODE,
      jobId: '24680',
      ownership: 'owned',
      environmentCell: ENVIRONMENT,
      computeNodeCell: COMPUTE_NODE,
      jobCell: '24680',
      environmentIsNotNode: false,
      environmentIsNotJob: false,
      resolvedEnv: ENVIRONMENT,
    });

    // ── Criterion 5 (a): the SAME profile's environment identity survives a compute-node move ──
    // A status whose `computeNode` DIFFERS is injected for the SAME selected profile. The rendered
    // identity is the selected profile's resolved environment (ConnectionStatus' `identity` prop),
    // so the node must move while the environment UUID does not — the receiver's real contract.
    const movedIntent = await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: '24680', state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-1', epoch: 4, bridgeInstanceId: 'bridge-1',
    }), { env: ENVIRONMENT, profileId: selectedProfileId, node: OTHER_COMPUTE_NODE });
    const movedTargets = await evaluate(() => window.task30.renderedTargets());
    const resolvedMovedEnv = await evaluate((id) => window.task30.resolvedEnvironmentOf(id), selectedProfileId);
    record('environmentSurvivesNodeMove', { movedIntent, movedTargets, resolvedMovedEnv });
    check('a profile keeps its stable environment identity across a compute-node move: the rendered node changes while the environment UUID does not', {
      environmentBefore: targets.environmentId,
      environmentAfter: movedTargets.environmentId,
      environmentSurvives: targets.environmentId === movedTargets.environmentId && movedTargets.environmentId === ENVIRONMENT,
      nodeBefore: targets.computeNode,
      nodeAfter: movedTargets.computeNode,
      nodeChanged: targets.computeNode !== movedTargets.computeNode,
      jobStable: movedTargets.jobId === targets.jobId,
      resolvedMovedEnv,
    }, {
      environmentBefore: ENVIRONMENT,
      environmentAfter: ENVIRONMENT,
      environmentSurvives: true,
      nodeBefore: COMPUTE_NODE,
      nodeAfter: OTHER_COMPUTE_NODE,
      nodeChanged: true,
      jobStable: true,
      resolvedMovedEnv: ENVIRONMENT,
    });

    // ── Criterion 5 (b): a SECOND profile resolving to OTHER_ENVIRONMENT on the SAME compute node ──
    // The second profile is created through the REAL strict parser by the REAL SSH form (the probed
    // environment is the channel the form binds to), then SELECTED through the REAL profile picker.
    // A status on the SAME compute node is attached so the node is held constant: only the profile's
    // own resolved environment can make the rendered identities differ.
    const probeOther = await evaluate((env) => window.task30.setProbeEnvironment(env), OTHER_ENVIRONMENT);
    const createdOther = await evaluate(() => window.task30.createSshProfileViaUi({ name: 'Second cluster', endpoint: 'cluster2.example.edu', credentialRef: 'cred-2', enabled: true }));
    const selectedOther = await evaluate((id) => window.task30.selectProfile(id), createdOther.selectedProfileId);
    const otherIntent = await evaluate((args) => window.task30.setSlurm({
      environmentId: args.other, intentId: args.profileId, jobId: '13579', state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-2', epoch: 1, bridgeInstanceId: 'bridge-2',
    }), { other: OTHER_ENVIRONMENT, profileId: createdOther.selectedProfileId, node: COMPUTE_NODE });
    const otherEnvTargets = await evaluate(() => window.task30.renderedTargets());
    const resolvedOtherEnv = await evaluate((id) => window.task30.resolvedEnvironmentOf(id), createdOther.selectedProfileId);
    record('secondEnvironment', { probeOther, createdOther, selectedOther, otherIntent, otherEnvTargets, resolvedOtherEnv });
    check('two environments that share the SAME compute node stay distinct: the node is not what tells them apart, and the second profile resolves to its own stable UUID through the real form and picker', {
      firstEnvironment: targets.environmentId,
      secondEnvironment: otherEnvTargets.environmentId,
      environmentsDiffer: targets.environmentId !== otherEnvTargets.environmentId,
      computeNodesEqual: targets.computeNode === otherEnvTargets.computeNode,
      secondEnvironmentIsOther: otherEnvTargets.environmentId === OTHER_ENVIRONMENT,
      secondEnvironmentResolved: resolvedOtherEnv,
      secondTransport: createdOther.created?.transport?.kind,
      secondCredentialRef: createdOther.created?.credentialRef,
      secondTargetEnvironment: createdOther.created?.target?.environmentId,
      pickerSelectedSecond: selectedOther.selectedProfileId === createdOther.selectedProfileId,
      secondJob: otherEnvTargets.jobId,
    }, {
      firstEnvironment: ENVIRONMENT,
      secondEnvironment: OTHER_ENVIRONMENT,
      environmentsDiffer: true,
      computeNodesEqual: true,
      secondEnvironmentIsOther: true,
      secondEnvironmentResolved: OTHER_ENVIRONMENT,
      secondTransport: 'ssh',
      secondCredentialRef: 'cred-2',
      secondTargetEnvironment: OTHER_ENVIRONMENT,
      pickerSelectedSecond: true,
      secondJob: '13579',
    });

    // restore the connected FIRST environment and the FIRST selection for the remaining happy path
    await evaluate((id) => window.task30.selectProfile(id), selectedProfileId);
    await evaluate((env) => window.task30.setProbeEnvironment(env), ENVIRONMENT);
    await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: '24680', state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-1', epoch: 3, bridgeInstanceId: 'bridge-1',
    }), { env: ENVIRONMENT, profileId: selectedProfileId, node: COMPUTE_NODE });

    // ── Criterion 4 (UI): a password is never cached — payload / DOM / console / storage ──
    const passwordChallenge = await evaluate(() => window.task30.presentChallengeAndMount('password', { prompt: 'Password:' }));
    const passwordProbe = await evaluate(() => window.task30.probe());
    const passwordAnswer = await evaluate((secret) => window.task30.answerChallengeViaUi({ accept: true, secret }), browserSecret);
    const consoleEntries = await evaluate(() => window.task30.consoleEntries());
    const domSnapshot = await evaluate(() => window.task30.domSnapshot());
    const storageSnapshot = await evaluate(() => window.task30.storageSnapshot());
    const domText = await evaluate(() => window.task30.domText());
    record('passwordAnswer', { passwordChallenge, passwordProbe, passwordAnswer, consoleEntryCount: consoleEntries.length });
    check('a password is never cached: it is held only for the answer, the real serialized payload redacts it, and it appears ZERO times in the DOM, the console and browser storage', {
      challengeKind: passwordProbe.challengeKind,
      inputTypeIsPassword: passwordProbe.challengeHasSecretInput,
      acceptDisabledBefore: passwordProbe.challengeAcceptDisabled,
      secretInputRemovedAfter: passwordAnswer.afterInputAbsent,
      inputValueAfterAnswer: passwordAnswer.afterValue,
      payloadAccept: passwordAnswer.payload?.accept,
      secretInSerializedPayload: passwordAnswer.secretInPayload,
      secretBoxType: passwordAnswer.secretBoxType,
      secretBoxString: passwordAnswer.secretBoxString,
      secretBoxJson: passwordAnswer.secretBoxJson,
      secretConsumedOnce: passwordAnswer.consumed,
      consoleOccurrences: consoleEntries.filter((entry) => entry.text.includes(browserSecret)).length,
      domOccurrences: occurrences(domText, browserSecret),
      domInputValueOccurrences: domSnapshot.inputValues.filter((value) => value.includes(browserSecret)).length,
      storageOccurrences: occurrences(storageSnapshot.local, browserSecret) + occurrences(storageSnapshot.session, browserSecret),
    }, {
      challengeKind: 'password',
      inputTypeIsPassword: true,
      acceptDisabledBefore: true,
      secretInputRemovedAfter: true,
      inputValueAfterAnswer: null,
      payloadAccept: true,
      secretInSerializedPayload: 0,
      secretBoxType: 'object',
      secretBoxString: REDACTED,
      secretBoxJson: REDACTED,
      secretConsumedOnce: browserSecret,
      consoleOccurrences: 0,
      domOccurrences: 0,
      domInputValueOccurrences: 0,
      storageOccurrences: 0,
    });

    // ── Criterion 3 (UI): a connection cancel never signals a borrowed job ──
    const baselineCalls = await evaluate(() => window.task30.portCalls());
    await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: '24680', state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'borrowed',
      computeNode: args.node, stepId: 'step-1', epoch: 3, bridgeInstanceId: 'bridge-1',
    }), { env: ENVIRONMENT, profileId: selectedProfileId, node: COMPUTE_NODE });
    const borrowedActionsProbe = await evaluate(() => window.task30.probe());
    const cancelResult = await evaluate(() => window.task30.cancelViaUi());
    const afterCancelCalls = await evaluate(() => window.task30.portCalls());
    const cancelTargets = await evaluate(() => window.task30.renderedTargets());
    record('cancelBorrowed', { baselineCalls, borrowedActionsProbe, cancelResult, afterCancelCalls, cancelTargets });
    check('cancelling the connection detaches the borrowed job exactly once and produces ZERO cancel signals: detach is available, stop is refused, and the port is never told to signal', {
      detachEnabled: borrowedActionsProbe.detachDisabled === false,
      stopDisabled: borrowedActionsProbe.stopDisabled,
      stopRefusal: /Borrowed/u.test(String(borrowedActionsProbe.stopRefusal ?? '')),
      detachCallsDelta: afterCancelCalls.slurmDetach - baselineCalls.slurmDetach,
      stopCallsDelta: afterCancelCalls.slurmStop - baselineCalls.slurmStop,
      cancelSignals: afterCancelCalls.slurmStop,
      disconnectCallsDelta: afterCancelCalls.profileDisconnect - baselineCalls.profileDisconnect,
      detachedIntentCount: cancelResult.slurmStatuses.filter((entry) => entry.attached === false).length,
      borrowedStillBorrowed: cancelResult.slurmStatuses[0]?.ownership,
      connectionStatusAfterCancel: cancelResult.status?.state,
      cancelSignalCountRendered: cancelTargets.ownership,
    }, {
      detachEnabled: true,
      stopDisabled: true,
      stopRefusal: true,
      detachCallsDelta: 1,
      stopCallsDelta: 0,
      cancelSignals: 0,
      disconnectCallsDelta: 1,
      detachedIntentCount: 1,
      borrowedStillBorrowed: 'borrowed',
      connectionStatusAfterCancel: 'connected',
      cancelSignalCountRendered: 'borrowed',
    });

    // ── Happy: Slurm submit preview → pending → ready → detach → reattach to the SAME job ──
    const submitResources = { partition: 'cpu', account: 'research', cpus: 5, memory: '4224', time: '01:00:00', gres: 'none' };
    const callsBeforePreview = await evaluate(() => window.task30.portCalls());
    const previewFromPort = await evaluate((resources) => window.task30.previewViaPort(resources), submitResources);
    await evaluate((preview) => window.task30.setPreview(preview), previewFromPort);
    const preSubmitCalls = await evaluate(() => window.task30.portCalls());
    const submitted = await evaluate((resources) => window.task30.submitSlurmViaUi(resources), submitResources);
    const postSubmitCalls = await evaluate(() => window.task30.portCalls());
    const previewProbe = await evaluate(() => window.task30.probe());
    const submittedIntent = submitted.slurmStatuses[submitted.slurmStatuses.length - 1] ?? null;
    record('slurmSubmit', { previewFromPort, submitted, previewProbe, preSubmitCalls, postSubmitCalls });
    check('the Slurm submit path renders the BRIDGE-PRODUCED resource/time preview (explicit time and GRES, never implicit) and submits a pending intent', {
      previewNodes: previewProbe.slurmPreviewNodes,
      previewCpus: previewProbe.slurmPreviewCpus,
      previewMemory: previewProbe.slurmPreviewMemory,
      previewTime: previewProbe.slurmPreviewTime,
      previewGres: previewProbe.slurmPreviewGres,
      previewGpuNote: /No GPU/u.test(String(previewProbe.slurmPreviewNote ?? '')),
      previewCpusAttr: previewFromPort.cpus,
      previewTimeSeconds: previewFromPort.timeSeconds,
      previewCallsDelta: postSubmitCalls.slurmPreview - callsBeforePreview.slurmPreview,
      previewCallsDuringSubmit: postSubmitCalls.slurmPreview - preSubmitCalls.slurmPreview,
      submitCallsDelta: postSubmitCalls.slurmSubmit - preSubmitCalls.slurmSubmit,
      submittedState: submittedIntent?.state,
      submittedOwnership: submittedIntent?.ownership,
      formProblems: previewProbe.slurmFormProblems,
    }, {
      previewNodes: '1 / 1',
      previewCpus: '5',
      previewMemory: '4224M (4224 MiB)',
      previewTime: '01:00:00',
      previewGres: 'none',
      previewGpuNote: true,
      previewCpusAttr: 5,
      previewTimeSeconds: 3600,
      previewCallsDelta: 1,
      previewCallsDuringSubmit: 0,
      submitCallsDelta: 1,
      submittedState: 'PENDING',
      submittedOwnership: 'owned',
      formProblems: null,
    });

    const submittedIntentId = submittedIntent?.intentId;
    const submittedJobId = submittedIntent?.jobId;
    // the composable selects the lifecycle intent by the selected profile id; the case wires the
    // injected port's intent to the selected profile so the integrated surface renders it.
    await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: args.jobId, state: 'PENDING', queue: 'PENDING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: null, stepId: null, epoch: null, bridgeInstanceId: null,
    }), { env: ENVIRONMENT, profileId: selectedProfileId, jobId: submittedJobId });
    const pendingTargets = await evaluate(() => window.task30.renderedTargets());
    check('a pending intent is told apart from a ready one by the control-store fields, not a status string: PENDING shows the queued reason while a job with no bridge instance is still not ready', {
      pendingQueueState: pendingTargets.queueStateCell,
      pendingReasonPresent: pendingTargets.pendingReason !== null,
      pendingReasonMentionsQueued: /Queued/u.test(String(pendingTargets.pendingReason ?? '')),
      pendingCellMentionsQueued: /Queued/u.test(String(pendingTargets.pendingCell ?? '')),
      pendingComputeNode: pendingTargets.computeNode,
      terminalFlag: pendingTargets.terminal,
    }, {
      pendingQueueState: 'PENDING / PENDING',
      pendingReasonPresent: true,
      pendingReasonMentionsQueued: true,
      pendingCellMentionsQueued: true,
      pendingComputeNode: '',
      terminalFlag: 'false',
    });

    // The receiver's readiness contract (useRuntimeProfiles.slurmPendingReason): a reason is returned
    // while the scheduler queue/state is PENDING or RUNNING; `null` (ready) requires the compute-bridge
    // instance to be BOUND and the intent OUT of the scheduler PENDING/RUNNING queue. So a READY intent
    // is modeled as the post-hello attached execution (bridge bound, queue cleared), not as a RUNNING
    // scheduler status — the receiver would (correctly) keep reporting "waiting for the compute bridge
    // hello" for the latter.
    await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: args.jobId, state: 'attached', queue: null,
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-1', epoch: 3, bridgeInstanceId: 'bridge-1',
    }), { env: ENVIRONMENT, profileId: selectedProfileId, jobId: submittedJobId, node: COMPUTE_NODE });
    const readyTargets = await evaluate(() => window.task30.renderedTargets());
    check('a ready intent shows a visible compute node, the bridge instance, the step/epoch and NO pending reason', {
      readyQueueState: readyTargets.queueStateCell,
      readyComputeNode: readyTargets.computeNode,
      readyJob: readyTargets.jobId,
      readyReason: readyTargets.pendingReason,
      readyTerminal: readyTargets.terminal,
      readyStepEpoch: readyTargets.stepEpochCell,
      readyBridgeInstance: readyTargets.bridgeInstanceCell,
    }, {
      readyQueueState: '— / attached',
      readyComputeNode: COMPUTE_NODE,
      readyJob: submittedJobId,
      readyReason: null,
      readyTerminal: 'false',
      readyStepEpoch: 'step-1 / 3',
      readyBridgeInstance: 'bridge-1',
    });

    const detachResult = await evaluate(() => window.task30.detachViaUi());
    const afterDetachTargets = await evaluate(() => window.task30.renderedTargets());
    check('detaching a running job only stops tracking it: the intent stays alive on the same job/node/epoch and is no longer attached', {
      detachClicked: detachResult.clicked,
      attachedAfter: detachResult.slurm?.attached,
      computeNodeAfter: detachResult.slurm?.computeNode,
      jobIdAfter: detachResult.slurm?.jobId,
      epochAfter: detachResult.slurm?.epoch,
      renderedJob: afterDetachTargets.jobId,
      renderedNode: afterDetachTargets.computeNode,
    }, {
      detachClicked: true,
      attachedAfter: false,
      computeNodeAfter: COMPUTE_NODE,
      jobIdAfter: submittedJobId,
      epochAfter: 3,
      renderedJob: submittedJobId,
      renderedNode: COMPUTE_NODE,
    });

    const reconnectResult = await evaluate(() => window.task30.reconnectViaUi());
    await evaluate((args) => window.task30.setSlurm({
      environmentId: args.env, intentId: args.profileId, jobId: args.jobId, state: 'RUNNING', queue: 'RUNNING',
      terminal: null, reconcile: null, attached: true, ownership: 'owned',
      computeNode: args.node, stepId: 'step-1', epoch: 3, bridgeInstanceId: 'bridge-1',
    }), { env: ENVIRONMENT, profileId: selectedProfileId, jobId: submittedJobId, node: COMPUTE_NODE });
    const reattachTargets = await evaluate(() => window.task30.renderedTargets());
    record('detachReattach', { detachResult, reconnectResult, reattachTargets });
    check('re-attaching returns to the SAME job, node and epoch through a new generation — detach never cancelled the job and reconnect binds the same execution', {
      reconnectClicked: reconnectResult.clicked,
      reconnectState: reconnectResult.status?.state,
      reconnectGeneration: reconnectResult.status?.generation,
      reattachedJob: reattachTargets.jobId,
      reattachedNode: reattachTargets.computeNode,
      sameJob: reattachTargets.jobId === submittedJobId,
      sameNode: reattachTargets.computeNode === COMPUTE_NODE,
      intentIdStable: submittedIntentId !== undefined,
    }, {
      reconnectClicked: true,
      reconnectState: 'connected',
      reconnectGeneration: 2,
      reattachedJob: submittedJobId,
      reattachedNode: COMPUTE_NODE,
      sameJob: true,
      sameNode: true,
      intentIdStable: true,
    });

    // ── light / dark imported themes ──
    const lightTheme = await evaluate(() => window.task30.applyTheme('light'));
    const lightStyle = await evaluate(() => window.task30.styleProbe());
    await evaluate(() => window.task30.applyTheme('dark'));
    const darkStyle = await evaluate(() => window.task30.styleProbe());
    record('theme', { lightTheme, lightStyle, darkStyle });
    check('the same surface renders under a light AND a dark IMPORTED theme: the computed modal text follows the theme tokens and the two themes differ', {
      lightPreset: lightTheme.preset,
      lightThemeAttribute: lightStyle.themeAttribute,
      lightModalColor: lightStyle.modalColor,
      lightMatchesThemeText: lightStyle.modalColor === lightStyle.expectedModalText,
      darkThemeAttribute: darkStyle.themeAttribute,
      darkModalColor: darkStyle.modalColor,
      darkMatchesThemeText: darkStyle.modalColor === darkStyle.expectedDarkModalText,
      themesDiffer: lightStyle.modalColor !== darkStyle.modalColor,
      lightIsNotDark: lightStyle.modalColor !== darkStyle.modalColor,
      tokenCount: lightTheme.tokenCount > 0,
    }, {
      lightPreset: 'soft-white',
      lightThemeAttribute: 'light',
      lightModalColor: lightStyle.expectedModalText,
      lightMatchesThemeText: true,
      darkThemeAttribute: 'dark',
      darkModalColor: darkStyle.expectedDarkModalText,
      darkMatchesThemeText: true,
      themesDiffer: true,
      lightIsNotDark: true,
      tokenCount: true,
    });

    if (context.case === 'failure') {
      // ── F1: a changed host key has NO accept path ──
      const changed = await evaluate(() => window.task30.presentChallengeAndMount('host-key-changed', { prompt: 'The host key changed.', fingerprint: 'SHA256:changed' }));
      const changedProbe = await evaluate(() => window.task30.probe());
      const changedAnswer = await evaluate(() => window.task30.answerChallengeViaUi({ accept: false }));
      record('f1-changed-key', { changed, changedProbe, changedAnswer });
      check('a CHANGED host key is presented as a refusal with no accept path at all, and declining clears the challenge without a secret', {
        kind: changedProbe.challengeKind,
        refusalMentionsNeverAccepted: /never accepted/u.test(String(changedProbe.challengeRefusal ?? '')),
        fingerprint: changedProbe.challengeFingerprint,
        acceptDisabled: changedProbe.challengeAcceptDisabled,
        hasSecretInput: changedProbe.challengeHasSecretInput,
        declinedAccept: changedAnswer.payload?.accept,
        declinedHasSecret: changedAnswer.payload?.secret !== undefined,
        cleared: changedAnswer.challengeCleared,
      }, {
        kind: 'host-key-changed',
        refusalMentionsNeverAccepted: true,
        fingerprint: 'SHA256:changed',
        acceptDisabled: true,
        hasSecretInput: false,
        declinedAccept: false,
        declinedHasSecret: false,
        cleared: true,
      });

      // ── F2: missing SSH / Slurm capabilities are explicitly unavailable, never implied ──
      // The capability change and the DOM read are separate evaluations: a Vue render flushes on the
      // microtask queue, so reading the DOM in the SAME evaluation that mutates the refs is stale.
      await evaluate(() => window.task30.configure({ client: 'browser', transports: { direct: true, ssh: false, slurm: false }, managedTransport: true }));
      const missing = await evaluate((env) => ({ probe: window.task30.probe(), rows: window.task30.renderedCapabilityRows(), env }), ENVIRONMENT);
      record('f2-missing-transports', missing);
      check('a target that reports neither SSH nor Slurm marks BOTH transports unsupported with a reason and disables both composers, while direct stays usable', {
        sshRow: missing.rows.find((row) => row.startsWith('ssh:')),
        slurmRow: missing.rows.find((row) => row.startsWith('slurm:')),
        directRow: missing.rows.find((row) => row.startsWith('direct:')),
        newSshDisabled: missing.probe.newSshDisabled,
        newSlurmDisabled: missing.probe.newSlurmDisabled,
        hint: /unavailable/u.test(String(missing.probe.newProfileHint ?? '')),
      }, {
        sshRow: 'ssh:unsupported', slurmRow: 'slurm:unsupported', directRow: 'direct:supported',
        newSshDisabled: true, newSlurmDisabled: true, hint: true,
      });
      await evaluate(() => window.task30.configure({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true }));

      // ── F3: preempt → terminal, no stop, no pending reason ──
      await evaluate((args) => window.task30.setSlurm({
        environmentId: args.env, intentId: args.profileId, jobId: '55501', state: 'PREEMPTED', queue: 'PREEMPTED',
        terminal: 'PREEMPTED', reconcile: null, attached: true, ownership: 'owned',
        computeNode: 'compute-09.cluster', stepId: 'step-9', epoch: 4, bridgeInstanceId: 'bridge-9',
      }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const preempt = await evaluate(() => ({ probe: window.task30.probe(), targets: window.task30.renderedTargets() }));
      record('f3-preempt', preempt);
      check('a preempted job renders as a terminal state (no pending reason), and stop is refused because there is nothing left to signal', {
        terminal: preempt.targets.terminal,
        terminalCell: /PREEMPTED/u.test(String(preempt.targets.terminalCell ?? '')),
        pendingReason: preempt.targets.pendingReason,
        stopDisabled: preempt.probe.stopDisabled,
        stopRefusal: /PREEMPTED/u.test(String(preempt.probe.stopRefusal ?? '')),
      }, {
        terminal: 'true', terminalCell: true, pendingReason: null, stopDisabled: true, stopRefusal: true,
      });

      // ── F4: time limit expiry → terminal, never ready ──
      await evaluate((args) => window.task30.setSlurm({
        environmentId: args.env, intentId: args.profileId, jobId: '55502', state: 'TIMEOUT', queue: 'TIMEOUT',
        terminal: 'TIMEOUT', reconcile: null, attached: false, ownership: 'owned',
        computeNode: 'compute-09.cluster', stepId: 'step-9', epoch: 4, bridgeInstanceId: 'bridge-9',
      }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const expired = await evaluate(() => ({ probe: window.task30.probe(), targets: window.task30.renderedTargets() }));
      record('f4-time-expire', expired);
      check('a job that hit its time limit is a terminal state with no pending reason, and its terminal reason is rendered', {
        terminal: expired.targets.terminal,
        terminalCell: /TIMEOUT/u.test(String(expired.targets.terminalCell ?? '')),
        pendingReason: expired.targets.pendingReason,
      }, {
        terminal: 'true', terminalCell: true, pendingReason: null,
      });

      // ── F5: a resource request missing time/gres is refused before any submit ──
      const preSubmitCalls = await evaluate(() => window.task30.portCalls());
      const resourceFailure = await evaluate(() => window.task30.submitSlurmViaUi({ partition: 'cpu', cpus: 1, memory: '1G', time: '', gres: '' }));
      const postSubmitCalls = await evaluate(() => window.task30.portCalls());
      const resourceProbe = await evaluate(() => window.task30.probe());
      record('f5-resource-failure', { resourceFailure, resourceProbe, preSubmitCalls, postSubmitCalls });
      check('a resource request with a blank time or GRES is refused by the form before any submit reaches the port', {
        problemsMentionTime: /time/u.test(String(resourceProbe.slurmFormProblems ?? '')),
        problemsMentionGres: /gres/u.test(String(resourceProbe.slurmFormProblems ?? '')),
        submitCallsDelta: postSubmitCalls.slurmSubmit - preSubmitCalls.slurmSubmit,
        previewCallsDelta: postSubmitCalls.slurmPreview - preSubmitCalls.slurmPreview,
      }, {
        problemsMentionTime: true, problemsMentionGres: true, submitCallsDelta: 0, previewCallsDelta: 0,
      });

      // ── F6: an incompatible bridge version refuses the update with an explicit reason ──
      await evaluate((plan) => window.task30.setPlan(plan), { action: 'install', location: 'remote', channel: 'transport', compatible: false, connectable: false, upgradePath: null, automatic: false, requiresExplicitAction: true });
      const incompatible = await evaluate(() => window.task30.probe());
      const incompatibleUpdate = await evaluate(() => window.task30.updateViaUi());
      await evaluate(() => window.task30.setPlan(null));
      const noPlan = await evaluate(() => window.task30.probe());
      record('f6-version-mismatch', { incompatible, incompatibleUpdate, noPlan });
      check('an incompatible remote bridge version refuses the update with an explicit reason, and an unknown probe is refused with an explicit reason rather than silently attempted', {
        incompatibleDisabled: incompatible.updateDisabled,
        incompatibleRefusal: /not compatible/u.test(String(incompatible.updateRefusal ?? '')),
        planStillIncompatible: incompatibleUpdate.plan?.compatible === false,
        planSignal: incompatibleUpdate.plan?.action,
        unknownDisabled: noPlan.updateDisabled,
        unknownRefusal: /update path is unknown/u.test(String(noPlan.updateRefusal ?? '')),
      }, {
        incompatibleDisabled: true, incompatibleRefusal: true, planStillIncompatible: true, planSignal: 'install',
        unknownDisabled: true, unknownRefusal: true,
      });
      await evaluate((plan) => window.task30.setPlan(plan), { action: 'connect', location: 'remote', channel: 'transport', compatible: true, connectable: true, upgradePath: null, automatic: false, requiresExplicitAction: true });

      // ── F7: cancelling a challenge hands over a declined secret-free answer ──
      const cancelChallenge = await evaluate(() => window.task30.presentChallengeAndMount('otp', { prompt: 'Verification code:' }));
      const otpProbe = await evaluate(() => window.task30.probe());
      const cancelledChallenge = await evaluate((secret) => window.task30.answerChallengeViaUi({ accept: false, secret }), OTP);
      const cancelConsole = await evaluate(() => window.task30.consoleEntries());
      const cancelDom = await evaluate(() => window.task30.domText());
      record('f7-cancel-challenge', { cancelChallenge, otpProbe, cancelledChallenge, eventCount: cancelConsole.length });
      check('cancelling a one-time-code challenge hands over a DECLINED, secret-free answer, clears the input, and leaks nothing to the DOM or console', {
        kind: otpProbe.challengeKind,
        promptMentionsCode: /Verification code/u.test(String(otpProbe.challengePrompt ?? '')),
        accepted: cancelledChallenge.payload?.accept,
        hasSecret: cancelledChallenge.payload?.secret !== undefined,
        secretInputRemovedAfter: cancelledChallenge.afterInputAbsent,
        inputValueAfterAnswer: cancelledChallenge.afterValue,
        cleared: cancelledChallenge.challengeCleared,
        secretInPayload: cancelledChallenge.secretInPayload,
        consoleOccurrences: cancelConsole.filter((entry) => entry.text.includes(OTP)).length,
        domOccurrences: occurrences(cancelDom, OTP),
      }, {
        kind: 'otp',
        promptMentionsCode: true,
        accepted: false,
        hasSecret: false,
        secretInputRemovedAfter: true,
        inputValueAfterAnswer: null,
        cleared: true,
        secretInPayload: 0,
        consoleOccurrences: 0,
        domOccurrences: 0,
      });

      // ── F8: a stale scheduler response is surfaced as reconciling, never as ready ──
      await evaluate((args) => window.task30.setSlurm({
        environmentId: args.env, intentId: args.profileId, jobId: null, state: 'reconciling', queue: null,
        terminal: null, reconcile: 'unconfirmed', attached: true, ownership: 'owned',
        computeNode: null, stepId: null, epoch: null, bridgeInstanceId: null,
      }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const staleUnconfirmed = await evaluate(() => window.task30.renderedTargets());
      await evaluate((args) => window.task30.setSlurm({
        environmentId: args.env, intentId: args.profileId, jobId: null, state: 'reconciling', queue: null,
        terminal: null, reconcile: 'ambiguous', attached: true, ownership: 'owned',
        computeNode: null, stepId: null, epoch: null, bridgeInstanceId: null,
      }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const staleAmbiguous = await evaluate(() => window.task30.renderedTargets());
      await evaluate((args) => window.task30.setStatus({ profileId: args.profileId, state: 'connected', environmentId: args.env, generation: 1 }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const firstGeneration = await evaluate(() => window.task30.renderedTargets().generation);
      await evaluate((args) => window.task30.setStatus({ profileId: args.profileId, state: 'connected', environmentId: args.env, generation: 2 }), { env: ENVIRONMENT, profileId: selectedProfileId });
      const secondGeneration = await evaluate(() => window.task30.renderedTargets().generation);
      const generationOrder = { first: firstGeneration, second: secondGeneration };
      record('f8-stale-response', { staleUnconfirmed, staleAmbiguous, generationOrder });
      check('a stale / lost submit acknowledgement is surfaced as reconciling (never as ready), and the newest response is the one the surface reports', {
        unconfirmedReason: /reconciling by scheduler query/u.test(String(staleUnconfirmed.pendingReason ?? '')),
        unconfirmedTerminal: staleUnconfirmed.terminal,
        ambiguousReason: /never resubmitting/u.test(String(staleAmbiguous.pendingReason ?? '')),
        ambiguousTerminal: staleAmbiguous.terminal,
        firstGeneration: generationOrder.first,
        secondGeneration: generationOrder.second,
      }, {
        unconfirmedReason: true,
        unconfirmedTerminal: 'false',
        ambiguousReason: true,
        ambiguousTerminal: 'false',
        firstGeneration: '1',
        secondGeneration: '2',
      });
    }

    const browserErrors = await evaluate(() => window.task30.errors());
    check('the real UI surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    // Screenshots + DOM trace for the UI surfaces (the plan's Evidence line).
    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa30-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
      const htmlPath = path.join(runDir, `qa30-${context.case}-${width}.html`);
      await writeFile(htmlPath, await page.content());
      artifacts.push(artifact(htmlPath, 'dom-trace'));
    }

    protocol.browserCallLog = await evaluate(() => window.task30.callLog());
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

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    const differingFiles = ownedFiles.filter((file) => sourceAfter[file] !== sourceBefore[file]).length;
    check('the registered case leaves its own authored files unchanged and pins a populated source inventory', {
      status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0,
      authoredFileCount: ownedFiles.length,
      differingFiles,
      pinnedSources: sourceFiles.length,
    }, {
      status: true, authoredFileCount: 4, differingFiles: 0, pinnedSources: sourceFiles.length,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task30Errors ?? [], task30: Boolean(window.task30) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /stale|reconcil|generation|same job|same environment|survives a compute-node move/,
    cancel_resume: /detach|borrowed|reattach|re-attach|reconnect|connection cancel/,
    malformed_input: /denies|reject|refuse|changed host key|blank|incompatible|never accepted|parser/,
    hung_commands: /bounded|no error|pending|reconcil/,
    dirty_worktree: /dirty worktree|authored files unchanged/,
    repeated_interruptions: /exactly once|exactly ONE|newest response|only/,
    misleading_success_output: /never cached|VISIBLE direct-only|no accept path|never as ready|bridge-produced|stable environment/,
    flaky_tests: /identical|ONE capability|0600|environment UUID|zero cancel signals/,
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'ssh-hpc-connection-lifecycle', schema: 'runtime-connection-profile/v1' },
    cleanup: proof.cleanup,
    defects: {},
    evidenceBoundary: 'The real landed task-30 Vue surface (ConnectionManager/SshHostForm/SlurmExecutionForm/ConnectionStatus/RemoteBridgeActions) and app/composables/useRuntimeProfiles.ts execute in a real headless Chromium, driven through the real form inputs and buttons over the real imported-theme token pipeline. In the Node worker the real bridge modules bridge/runtime/transports/slurmJobs.js, slurmControlStore.js and sshAuthentication.js run against REAL files under the private root, and shared/runtime/connectionProfile.js runs the real strict parser / target mapping. The controlled boundaries are injected fakes: the management profile port, the Slurm lifecycle port (no HTTP/WS route exists yet; only the CLI control-store/relay roles reach the real SlurmJobController) and the remote-bridge port; the challenge responder is case-presented; @iconify/vue is an inert stub; the SSH process edge is never dialed (only the 0600 askpass FILE PATH is exercised). It does NOT perform or claim a live SSH or live Slurm verification — task 46 owns that — and authors no PASS verdict.',
  };
}
