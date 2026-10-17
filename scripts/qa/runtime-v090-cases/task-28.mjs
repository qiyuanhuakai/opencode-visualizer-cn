// Task 28 registered QA case — Recoverable Slurm jobs and the durable control store.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// The case drives the REAL landed Node modules directly in the worker process:
//   bridge/runtime/transports/slurmJobs.js, slurmControlStore.js, slurmBootstrap.js
//   (plus their .d.ts companions) and the control-store role in bridge/visBridgeCli.js.
// The ONLY controlled boundaries are:
//   * the scheduler edge (sbatch/squeue/scontrol/scancel is a fake, so no real Slurm
//     is ever contacted);
//   * the filesystem-type probe (injected statfs; the store itself writes REAL durable
//     files under the private root);
//   * the "native transcript" the case re-indexes is a REAL file on disk read back
//     with node:fs, not a cached summary;
//   * a small browser entry (app/dev/runtime-v090/task28.ts over case-owned node:*
//     shims) proves the resource-preview/queue/handshake projections a renderer sees.
//
// This module does NOT claim a live Slurm verification and does NOT author a PASS
// verdict — task 46 owns the real end-to-end controller/worker-node check. No product
// file is edited by this module.
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';
import { mkdir, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { createFixture, alive, until, assertPortReleased } from './task-28-fixture.mjs';

import {
  SLURM_HANDSHAKE_KIND,
  buildResourcePreview,
  createSlurmHandshake,
  createSlurmJobController,
  mapQueueState,
  normalizeSlurmResources,
  parseSbatchOutput,
  parseScontrolShowJob,
  parseSqueueOutput,
} from '../../../bridge/runtime/transports/slurmJobs.js';
import {
  CONTROL_STORE_SCHEMA_VERSION,
  createSlurmControlStore,
  filesystemClass,
  isNetworkFilesystem,
  verifyLocalFilesystem,
} from '../../../bridge/runtime/transports/slurmControlStore.js';
import {
  COMPUTE_DELIVERY_CHANNELS,
  assertIndependentRoots,
  parseSlurmHostProbe,
  planComputeDelivery,
  planSlurmBootstrap,
} from '../../../bridge/runtime/transports/slurmBootstrap.js';
import { parseCliOptions, runControlStoreCommand } from '../../../bridge/visBridgeCli.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const CLUSTER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const INTENT = '33333333-3333-4333-8333-333333333333';
const SENTINEL = 'sk-task28-credential-9f3a1c7e-NEVER-LOG';
const EXT4 = 0xef53;
const NFS = 0x6969;
const LUSTRE = 0x0bd00bd0;

const RESOURCES = Object.freeze({ partition: 'cpu', account: 'research', cpus: 4, memory: '8G', time: '01:00:00', gres: 'none' });

export const sourceFiles = [...new Set([
  'bridge/runtime/transports/slurmJobs.js', 'bridge/runtime/transports/slurmJobs.d.ts',
  'bridge/runtime/transports/slurmControlStore.js', 'bridge/runtime/transports/slurmControlStore.d.ts',
  'bridge/runtime/transports/slurmBootstrap.js', 'bridge/runtime/transports/slurmBootstrap.d.ts',
  'bridge/runtime/transports/sshTransport.js', 'bridge/visBridgeCli.js',
  'app/runtime/slurmJobs.test.ts',
  'app/dev/runtime-v090/task28.ts',
  'scripts/qa/runtime-v090-cases/task-28.mjs',
  'scripts/qa/runtime-v090-cases/task-28-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-28-browser-shim.mjs',
  'shared/runtime/capabilities.js', 'shared/runtime/identity.js', 'shared/runtime/connectionProfile.js',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 28 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task28Errors=[];window.addEventListener('error',(e)=>window.__task28Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task28Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task28.ts"></script></body></html>`;

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

const captureError = async (run) => {
  try { await run(); return {}; }
  catch (error) { return { code: error?.code, field: error?.field, message: error instanceof Error ? error.message : String(error) }; }
};

const localStatfs = () => ({ type: EXT4 });

function createScheduler(overrides = {}) {
  const submitCalls = [];
  const queryCalls = [];
  const cancelCalls = [];
  let matches = overrides.matches ?? [];
  let submit = overrides.submit;
  let queryThrows = overrides.queryThrows === true;
  const scheduler = {
    async submit(request) {
      submitCalls.push(request);
      if (submit === 'throw') throw new Error('submit acknowledgement lost');
      if (typeof submit === 'function') return submit(request);
      return { stdout: `${overrides.jobId ?? '24680'}\n` };
    },
    async query(request) {
      queryCalls.push(request);
      if (queryThrows) throw new Error('scheduler unreachable');
      return { matches };
    },
    async cancel(request) { cancelCalls.push(request); return { cancelled: true }; },
  };
  return {
    scheduler, submitCalls, queryCalls, cancelCalls,
    setMatches: (next) => { matches = next; },
    setSubmit: (next) => { submit = next; },
    setQueryThrows: (next) => { queryThrows = next; },
  };
}

function makeStore(root, ownerInstanceId, extra = {}) {
  return createSlurmControlStore({
    root,
    environmentId: ENVIRONMENT,
    ownerInstanceId,
    platform: 'linux',
    statfs: localStatfs,
    isProcessAlive: () => true,
    ...extra,
  });
}

async function openOwnerStore(root, ownerInstanceId = 'owner-qa', extra = {}) {
  const store = makeStore(root, ownerInstanceId, extra);
  await store.open('owner');
  return store;
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-28/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { case: context.case, runDir, checks, observations };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => value === undefined ? undefined : JSON.parse(JSON.stringify(value));
  const check = (name, observed, expected) => {
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface: 'real landed Slurm job/control-store modules in the Node worker over a controlled scheduler fake and a real durable store under a private root, plus a real headless Chromium projection surface', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  const heapStart = process.memoryUsage().heapUsed;
  let browser; let page; let vite;
  try {
    // ── Vite server for the browser-shaped surface (node:* aliased to the shim) ──
    const shimPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-28-browser-shim.mjs');
    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      resolve: { alias: [
        { find: /^node:crypto$/, replacement: shimPath },
        { find: /^node:child_process$/, replacement: shimPath },
        { find: /^node:fs\/promises$/, replacement: shimPath },
        { find: /^node:fs$/, replacement: shimPath },
        { find: /^node:os$/, replacement: shimPath },
        { find: /^node:path$/, replacement: shimPath },
        { find: /^node:net$/, replacement: shimPath },
      ] },
      optimizeDeps: { include: ['buffer'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa28', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa28/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task28 && window.task28.ready)), 'task28 browser entry', 60000);
    const evaluate = (fn, arg) => arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg);

    // ── browser-shaped surface: resource preview, queue projection, credential handshake ──
    const browserResources = await evaluate(() => window.task28.resources());
    record('browserResources', browserResources);
    check('the browser surface renders the explicit resource preview and rejects a resource request that hides time or gres', {
      cpus: browserResources.cpus, memoryMiB: browserResources.memoryMiB, timeSeconds: browserResources.timeSeconds, gres: browserResources.gres,
      noneRequestsGpu: browserResources.previewNoneRequestsGpu, gpuRequestsGpu: browserResources.previewGpuRequestsGpu,
      timeDirectiveCount: browserResources.timeDirectiveCount, gresNoneDirectiveCount: browserResources.gresNoneDirectiveCount,
      cpusDirectiveCount: browserResources.cpusDirectiveCount, execLineCount: browserResources.execLineCount,
      missingTimeCode: browserResources.missingTimeCode, missingTimeField: browserResources.missingTimeField,
      missingGresCode: browserResources.missingGresCode, missingGresField: browserResources.missingGresField,
    }, {
      cpus: 4, memoryMiB: 8192, timeSeconds: 3600, gres: 'none',
      noneRequestsGpu: false, gpuRequestsGpu: true,
      timeDirectiveCount: 1, gresNoneDirectiveCount: 1, cpusDirectiveCount: 1, execLineCount: 1,
      missingTimeCode: 'invalid_request', missingTimeField: 'resources.time',
      missingGresCode: 'invalid_request', missingGresField: 'resources.gres',
    });

    const browserScheduler = await evaluate(() => window.task28.scheduler());
    record('browserScheduler', browserScheduler);
    check('the browser surface projects the sbatch/squeue/scontrol output and the queue-state tuples a renderer draws', {
      jobId: browserScheduler.jobId, cluster: browserScheduler.cluster,
      badSbatchCode: browserScheduler.badSbatchCode, badSbatchField: browserScheduler.badSbatchField,
      squeueCount: browserScheduler.squeueCount, squeueRunning: browserScheduler.squeueRunning, squeuePending: browserScheduler.squeuePending,
      scontrolJobState: browserScheduler.scontrolJobState,
      pendingRequeued: browserScheduler.pendingRequeued, runningTerminal: browserScheduler.runningTerminal,
      completedTerminal: browserScheduler.completedTerminal, preemptQueue: browserScheduler.preemptQueue,
      preemptRequeued: browserScheduler.preemptRequeued, nodeFailRequeued: browserScheduler.nodeFailRequeued,
      outOfMemoryTerminal: browserScheduler.outOfMemoryTerminal,
    }, {
      jobId: '24680', cluster: 'cluster-a',
      badSbatchCode: 'invalid_request', badSbatchField: 'sbatch.jobId',
      squeueCount: 2, squeueRunning: 'RUNNING', squeuePending: 'PENDING',
      scontrolJobState: 'COMPLETED',
      pendingRequeued: false, runningTerminal: null,
      completedTerminal: 'COMPLETED', preemptQueue: 'PENDING',
      preemptRequeued: true, nodeFailRequeued: true,
      outOfMemoryTerminal: 'FAILED',
    });

    const browserHandshake = await evaluate((input) => window.task28.handshake(input.credential, input.intent), { credential: SENTINEL, intent: INTENT });
    const consoleAfterHandshake = await evaluate(() => window.task28.consoleEntries());
    const browserDom = await evaluate(() => window.task28.domText());
    record('browserHandshake', browserHandshake);
    check('the browser surface renders the credential-protected bridge hello without leaking the credential into the DOM or the console', {
      kind: browserHandshake.kind, expectedKind: browserHandshake.expectedKind, credentialProtected: browserHandshake.credentialProtected,
      verifyCorrect: browserHandshake.verifyCorrect, verifyForgedCredential: browserHandshake.verifyForgedCredential,
      verifyTamperedToken: browserHandshake.verifyTamperedToken,
      credentialInChallengeJson: browserHandshake.credentialInChallengeJson, credentialInDom: browserHandshake.credentialInDom,
      consoleOccurrences: consoleAfterHandshake.filter((entry) => entry.text.includes(SENTINEL)).length,
      domOccurrences: occurrences(browserDom, SENTINEL),
      tokenHexLength: browserHandshake.tokenHexLength, challengeKeyCount: browserHandshake.challengeKeyCount,
    }, {
      kind: SLURM_HANDSHAKE_KIND, expectedKind: SLURM_HANDSHAKE_KIND, credentialProtected: true,
      verifyCorrect: true, verifyForgedCredential: false, verifyTamperedToken: false,
      credentialInChallengeJson: 0, credentialInDom: 0, consoleOccurrences: 0, domOccurrences: 0,
      tokenHexLength: 64, challengeKeyCount: 5,
    });

    const browserBootstrap = await evaluate(() => window.task28.bootstrap());
    record('browserBootstrap', browserBootstrap);
    check('the browser surface shows control on login and execution on compute with independent roots and both delivery channels', {
      environmentId: browserBootstrap.environmentId, controlHost: browserBootstrap.controlHost,
      executionHost: browserBootstrap.executionHost, submitControlHost: browserBootstrap.submitControlHost,
      agentExecutionHost: browserBootstrap.agentExecutionHost, rootsIndependent: browserBootstrap.rootsIndependent,
      loginControlRoot: browserBootstrap.loginControlRoot, computeWorkingRoot: browserBootstrap.computeWorkingRoot,
      automatic: browserBootstrap.automatic, sharedChannel: browserBootstrap.sharedChannel,
      controlledChannel: browserBootstrap.controlledChannel, channelCount: browserBootstrap.channelCount,
      loginProgramsReady: browserBootstrap.loginProgramsReady,
      collisionCode: browserBootstrap.collisionCode, collisionField: browserBootstrap.collisionField,
    }, {
      environmentId: CLUSTER_ENVIRONMENT, controlHost: 'login',
      executionHost: 'compute', submitControlHost: 'login',
      agentExecutionHost: 'compute', rootsIndependent: true,
      loginControlRoot: '/home/user/.local/state/vis/bridge', computeWorkingRoot: '/scratch/user/run',
      automatic: false, sharedChannel: 'slurm-shared-root',
      controlledChannel: 'slurm-controlled-channel', channelCount: COMPUTE_DELIVERY_CHANNELS.length,
      loginProgramsReady: true,
      collisionCode: 'conflict', collisionField: 'slurm.roots',
    });

    // ── control-store CLI role (bridge/visBridgeCli.js) ──
    const cli = parseCliOptions(['control-store', '--state-root', path.join(fixture.root, 'cli-control'), '--environment', ENVIRONMENT], {});
    const cliHelp = parseCliOptions(['control-store', '--help'], {});
    const cliBad = await captureError(() => parseCliOptions(['control-store', '--environment', 'not-a-uuid', '--state-root', '/tmp/x'], {}));
    const cliRole = await runControlStoreCommand({ stateRoot: path.join(fixture.root, 'cli-role'), environmentId: ENVIRONMENT }, { ownerInstanceId: 'qa-cli-role' });
    const cliRoleStatus = cliRole.status();
    await cliRole.close();
    record('cliRole', { cli, cliHelp: cliHelp.help, cliBad, status: cliRoleStatus });
    check('the control-store CLI role parses its state root/environment, opens the durable login-local store and holds the single-owner fence', {
      command: cli.command, role: cli.role, stateRoot: cli.stateRoot, environmentId: cli.environmentId, help: cliHelp.help,
      cliBadIncludesEnvironment: String(cliBad.message ?? '').includes('environment'),
      opened: cliRoleStatus.opened, writable: cliRoleStatus.writable, epoch: cliRoleStatus.epoch,
      roleEnvironment: cliRoleStatus.environmentId, rootMatches: cliRoleStatus.root === path.join(fixture.root, 'cli-role'),
    }, {
      command: 'control-store', role: 'control-store', stateRoot: path.join(fixture.root, 'cli-control'), environmentId: ENVIRONMENT, help: true,
      cliBadIncludesEnvironment: true,
      opened: true, writable: true, epoch: 0,
      roleEnvironment: ENVIRONMENT, rootMatches: true,
    });

    // ── real scheduler-output parsers (shared by both cases) ──
    const parseSbatch = parseSbatchOutput('24680;cluster-a');
    const parseBad = await captureError(() => parseSbatchOutput('not-a-job'));
    const parseSqueue = parseSqueueOutput('24680|intent-a|RUNNING|intent-a|cpu|node-1\n24681|intent-b|PENDING|intent-b|cpu|\n');
    const parseScontrol = parseScontrolShowJob('JobId=24680 JobName=intent-a JobState=COMPLETED Partition=cpu Comment=intent-a NodeList=node-1 ExitCode=0:0\n');
    const parseMapped = { PENDING: mapQueueState('PENDING'), RUNNING: mapQueueState('RUNNING'), COMPLETED: mapQueueState('COMPLETED'), CANCELLED: mapQueueState('CANCELLED'), PREEMPTED: mapQueueState('PREEMPTED'), NODE_FAIL: mapQueueState('NODE_FAIL'), OUT_OF_MEMORY: mapQueueState('OUT_OF_MEMORY') };
    record('schedulerParsers', { parseSbatch, parseBad, parseSqueue, parseScontrol, parseMapped });
    check('the real scheduler-output parsers read the parsed sbatch id, squeue rows, scontrol fields and every queue-state tuple', {
      jobId: parseSbatch.jobId, cluster: parseSbatch.cluster, badCode: parseBad.code, badField: parseBad.field,
      squeueCount: parseSqueue.length, firstState: parseSqueue[0]?.state, secondState: parseSqueue[1]?.state,
      scontrolJobState: parseScontrol.jobState, scontrolExitCode: parseScontrol.exitCode,
      pendingQueue: parseMapped.PENDING.queue, runningQueue: parseMapped.RUNNING.queue, completedTerminal: parseMapped.COMPLETED.terminal,
      cancelledTerminal: parseMapped.CANCELLED.terminal, preemptQueue: parseMapped.PREEMPTED.queue, preemptRequeued: parseMapped.PREEMPTED.requeued,
      nodeFailRequeued: parseMapped.NODE_FAIL.requeued, outOfMemoryTerminal: parseMapped.OUT_OF_MEMORY.terminal,
    }, {
      jobId: '24680', cluster: 'cluster-a', badCode: 'invalid_request', badField: 'sbatch.jobId',
      squeueCount: 2, firstState: 'RUNNING', secondState: 'PENDING',
      scontrolJobState: 'COMPLETED', scontrolExitCode: '0:0',
      pendingQueue: 'PENDING', runningQueue: 'RUNNING', completedTerminal: 'COMPLETED',
      cancelledTerminal: 'CANCELLED', preemptQueue: 'PENDING', preemptRequeued: true,
      nodeFailRequeued: true, outOfMemoryTerminal: 'FAILED',
    });

    if (context.case === 'failure') {
      // ── F1: lost ack, zero match, multiple UUID matches, unconfirmable query — reconcile without resubmit ──
      const f1Store = await openOwnerStore(path.join(fixture.root, 'control-f1'), 'owner-f1');
      const f1Fake = createScheduler({ submit: 'throw' });
      const f1 = createSlurmJobController({ store: f1Store, scheduler: f1Fake.scheduler, environmentId: ENVIRONMENT });
      const f1Submit = await f1.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      f1Fake.setMatches([]);
      const f1Unconfirmed = await f1.reconcile(f1Submit.intentId);
      f1Fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: f1Submit.intentId }, { jobId: '24681', state: 'RUNNING', comment: f1Submit.intentId }]);
      const f1Ambiguous = await f1.reconcile(f1Submit.intentId);
      f1Fake.setQueryThrows(true);
      const f1Unreachable = await f1.reconcile(f1Submit.intentId);
      f1Fake.setQueryThrows(false);
      f1Fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: f1Submit.intentId }]);
      const f1Adopted = await f1.reconcile(f1Submit.intentId);
      const f1IntentCount = (await f1Store.listIntents()).length;
      record('f1', { f1Submit, f1Unconfirmed, f1Ambiguous, f1Unreachable, f1Adopted, f1IntentCount });
      check('a lost submit ack, a zero match, a multi-UUID match and an unconfirmable query all reconcile to an explicit state without ever resubmitting', {
        submitState: f1Submit.state, submitReconcile: f1Submit.reconcile, submitJobId: f1Submit.jobId,
        unconfirmedState: f1Unconfirmed.state, unconfirmedReconcile: f1Unconfirmed.reconcile,
        ambiguousState: f1Ambiguous.state, ambiguousReconcile: f1Ambiguous.reconcile,
        unreachableReconcile: f1Unreachable.reconcile,
        adoptedReconcile: f1Adopted.reconcile, adoptedJobId: f1Adopted.jobId, adoptedQueue: f1Adopted.queue,
        submitCalls: f1Fake.submitCalls.length, queryCalls: f1Fake.queryCalls.length, intentCount: f1IntentCount,
      }, {
        submitState: 'submitted', submitReconcile: 'unconfirmed', submitJobId: null,
        unconfirmedState: 'submitted', unconfirmedReconcile: 'unconfirmed',
        ambiguousState: 'reconciling', ambiguousReconcile: 'ambiguous',
        unreachableReconcile: 'unconfirmed',
        adoptedReconcile: null, adoptedJobId: '24680', adoptedQueue: 'RUNNING',
        submitCalls: 1, queryCalls: 4, intentCount: 1,
      });

      // ── F3: unreachable store / un-writable durable write / submit before open ──
      const f3Blocker = path.join(fixture.root, 'f3-blocker');
      fixture.register({ kind: 'blocker-file-planned', path: f3Blocker, teardown: 'removed with the private root' });
      await writeFile(f3Blocker, 'not a directory\n', 'utf8');
      const f3UnreachableStore = makeStore(path.join(f3Blocker, 'control'), 'unreachable');
      const f3Unreachable = await captureError(() => f3UnreachableStore.open('owner'));
      const f3RootCreated = existsSync(path.join(f3Blocker, 'control'));

      const f3Root = path.join(fixture.root, 'control-f3');
      const f3Store = await openOwnerStore(f3Root, 'owner-f3');
      const f3Before = await f3Store.verifyIntegrity();
      await rm(path.join(f3Root, 'intents'), { recursive: true, force: true });
      await writeFile(path.join(f3Root, 'intents'), 'blocked\n', 'utf8');
      const f3Write = await captureError(() => f3Store.writeIntent({ intentId: 'f3-intent', uuid: 'f3-intent' }));
      const f3Entries = await readdir(f3Root);
      const f3TempFiles = f3Entries.filter((name) => name.includes('.tmp-')).length;
      const f3After = await f3Store.verifyIntegrity();

      const f3ClosedStore = makeStore(path.join(fixture.root, 'control-f3-closed'), 'closed');
      const f3ClosedFake = createScheduler({ jobId: '24680' });
      const f3ClosedController = createSlurmJobController({ store: f3ClosedStore, scheduler: f3ClosedFake.scheduler, environmentId: ENVIRONMENT });
      const f3ClosedSubmit = await captureError(() => f3ClosedController.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' }));
      record('f3', { f3Unreachable, f3RootCreated, f3Write, f3Entries, f3TempFiles, before: f3Before, after: f3After, f3ClosedSubmit, closedSubmitCalls: f3ClosedFake.submitCalls.length });
      check('an unreachable store rejects with an explicit OS error, a durable write that cannot complete leaves no partial file or journal record, and submit never reaches the scheduler', {
        unreachableCode: f3Unreachable.code, unreachableField: f3Unreachable.field ?? null, unreachableRootCreated: f3RootCreated,
        writeCode: f3Write.code, writeField: f3Write.field ?? null,
        tempFilesLeft: f3TempFiles, entriesAfterFailedWrite: f3Entries.length,
        recordsBefore: f3Before.records, recordsAfter: f3After.records, journalBounded: f3Before.records === f3After.records,
        closedSubmitCode: f3ClosedSubmit.code, closedSubmitField: f3ClosedSubmit.field ?? null,
        closedSubmitCalls: f3ClosedFake.submitCalls.length,
      }, {
        unreachableCode: 'ENOTDIR', unreachableField: null, unreachableRootCreated: false,
        writeCode: 'ENOTDIR', writeField: null,
        tempFilesLeft: 0, entriesAfterFailedWrite: 3,
        recordsBefore: 1, recordsAfter: 1, journalBounded: true,
        closedSubmitCode: 'unauthorized', closedSubmitField: 'store.open',
        closedSubmitCalls: 0,
      });

      // ── F4: preempt / requeue and node-replacement fencing ──
      const f4Root = path.join(fixture.root, 'control-f4');
      const f4Store = await openOwnerStore(f4Root, 'owner-f4');
      const f4Fake = createScheduler({ jobId: '24680' });
      const f4 = createSlurmJobController({ store: f4Store, scheduler: f4Fake.scheduler, environmentId: ENVIRONMENT });
      const f4Submit = await f4.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      f4Fake.setMatches([{ jobId: '24680', state: 'PREEMPTED', comment: f4Submit.intentId }]);
      const f4Preempted = await f4.reconcile(f4Submit.intentId);
      const f4Epoch1 = await f4Store.bumpEpoch({ reason: 'requeue' });
      const f4Competitor = makeStore(f4Root, 'owner-f4-b');
      const f4CompetitorOpen = await captureError(() => f4Competitor.open('owner'));
      const f4Reader = makeStore(f4Root, 'owner-f4-c');
      await f4Reader.open('readonly');
      const f4ReaderStatus = f4Reader.status();
      const f4ReaderWrite = await captureError(() => f4Reader.writeIntent({ intentId: 'x' }));
      const f4Epoch2 = await f4Store.bumpEpoch({ reason: 'requeue-again' });
      record('f4', { f4Preempted, f4Epoch1, f4CompetitorOpen, f4ReaderStatus, f4ReaderWrite, f4Epoch2 });
      check('a preempt / requeue lands in the queue and a node replacement bumps the epoch so the previous owner is fenced out with conflict/store.fence', {
        preemptQueue: f4Preempted.queue, preemptState: f4Preempted.state, preemptTerminal: f4Preempted.terminal, preemptRequeued: f4Preempted.requeued,
        epoch1: f4Epoch1, competitorCode: f4CompetitorOpen.code, competitorField: f4CompetitorOpen.field,
        readerWritable: f4ReaderStatus.writable, readerEpoch: f4ReaderStatus.epoch,
        readerWriteCode: f4ReaderWrite.code, readerWriteField: f4ReaderWrite.field,
        epoch2: f4Epoch2, monotonicEpoch: f4Epoch2 > f4Epoch1,
      }, {
        preemptQueue: 'PENDING', preemptState: 'PENDING', preemptTerminal: null, preemptRequeued: true,
        epoch1: 1, competitorCode: 'conflict', competitorField: 'store.fence',
        readerWritable: false, readerEpoch: 1,
        readerWriteCode: 'unauthorized', readerWriteField: 'store.readonly',
        epoch2: 2, monotonicEpoch: true,
      });

      // ── F5: borrowed stop, no-job stop, terminal stop ──
      const f5Root = path.join(fixture.root, 'control-f5');
      const f5Store = await openOwnerStore(f5Root, 'owner-f5');
      const f5Fake = createScheduler({ jobId: '24680' });
      const f5 = createSlurmJobController({ store: f5Store, scheduler: f5Fake.scheduler, environmentId: ENVIRONMENT });
      const f5Borrowed = await f5.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'borrowed' });
      const f5BorrowedStop = await f5.stop(f5Borrowed.intentId);
      const f5CancelAfterBorrowed = f5Fake.cancelCalls.length;

      const f5Fake2 = createScheduler({ submit: 'throw' });
      const f5Controller2 = createSlurmJobController({ store: f5Store, scheduler: f5Fake2.scheduler, environmentId: ENVIRONMENT });
      const f5NoJob = await f5Controller2.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const f5NoJobStop = await f5.stop(f5NoJob.intentId);

      const f5Fake3 = createScheduler({ jobId: '24680' });
      const f5Controller3 = createSlurmJobController({ store: f5Store, scheduler: f5Fake3.scheduler, environmentId: ENVIRONMENT });
      const f5Owned = await f5Controller3.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      f5Fake3.setMatches([{ jobId: '24680', state: 'COMPLETED', comment: f5Owned.intentId }]);
      await f5Controller3.reconcile(f5Owned.intentId);
      const f5TerminalStop = await f5Controller3.stop(f5Owned.intentId);
      const f5IntentCount = (await f5Store.listIntents()).length;
      record('f5', { f5Borrowed, f5BorrowedStop, f5CancelAfterBorrowed, f5NoJobStop, f5TerminalStop, f5IntentCount });
      check('a borrowed allocation is never signalled, a job without a scheduler id errors no-job, and an already-terminal job errors terminal', {
        borrowedOwnership: f5Borrowed.ownership, borrowedSignalled: f5BorrowedStop.signalled, borrowedCancelled: f5BorrowedStop.cancelled,
        borrowedReason: f5BorrowedStop.reason, borrowedJobId: f5BorrowedStop.jobId, cancelAfterBorrowed: f5CancelAfterBorrowed,
        noJobReason: f5NoJobStop.reason, noJobSignalled: f5NoJobStop.signalled, noJobJobId: f5NoJobStop.jobId,
        terminalReason: f5TerminalStop.reason, terminalSignalled: f5TerminalStop.signalled,
        cancelCalls: f5Fake.cancelCalls.length + f5Fake3.cancelCalls.length, intentCount: f5IntentCount,
      }, {
        borrowedOwnership: 'borrowed', borrowedSignalled: false, borrowedCancelled: false,
        borrowedReason: 'borrowed', borrowedJobId: '24680', cancelAfterBorrowed: 0,
        noJobReason: 'no-job', noJobSignalled: false, noJobJobId: null,
        terminalReason: 'terminal', terminalSignalled: false,
        cancelCalls: 0, intentCount: 3,
      });

      // ── F6: duplicate start — a second owner start and a repeated submit ──
      const f6Root = path.join(fixture.root, 'control-f6');
      const f6Owner = await openOwnerStore(f6Root, 'owner-A');
      const f6Duplicate = makeStore(f6Root, 'owner-B');
      const f6DuplicateOpen = await captureError(() => f6Duplicate.open('owner'));
      const f6Fake = createScheduler({ jobId: '24680' });
      const f6 = createSlurmJobController({ store: f6Owner, scheduler: f6Fake.scheduler, environmentId: ENVIRONMENT });
      const f6First = await f6.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const f6Second = await f6.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const f6FirstScript = f6Fake.submitCalls[0]?.script ?? '';
      const f6SecondScript = f6Fake.submitCalls[1]?.script ?? '';
      f6Fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: f6First.intentId }]);
      await f6.reconcile(f6First.intentId);
      const f6IntentCount = (await f6Owner.listIntents()).length;
      record('f6', { f6DuplicateOpen, first: f6First, second: f6Second, f6IntentCount });
      check('a duplicate start is refused by the single-owner fence and a repeated submit creates a distinct UUID that is never resubmitted during reconcile', {
        duplicateCode: f6DuplicateOpen.code, duplicateField: f6DuplicateOpen.field,
        distinctIntents: f6First.intentId !== f6Second.intentId,
        firstInOwnScript: occurrences(f6FirstScript, f6First.intentId), secondInOwnScript: occurrences(f6SecondScript, f6Second.intentId),
        secondInFirstScript: occurrences(f6FirstScript, f6Second.intentId),
        submitCalls: f6Fake.submitCalls.length, submitCallsAfterReconcile: f6Fake.submitCalls.length, intentCount: f6IntentCount,
      }, {
        duplicateCode: 'conflict', duplicateField: 'store.fence',
        distinctIntents: true, firstInOwnScript: 3, secondInOwnScript: 3, secondInFirstScript: 0,
        submitCalls: 2, submitCallsAfterReconcile: 2, intentCount: 2,
      });

      // ── F7: a tampered journal is detected, not trusted ──
      const f7Root = path.join(fixture.root, 'control-f7');
      const f7Store = await openOwnerStore(f7Root, 'owner-f7');
      await f7Store.writeIntent({ intentId: 'intent-a', uuid: 'intent-a' });
      await f7Store.writeIntent({ intentId: 'intent-b', uuid: 'intent-b' });
      const f7JournalPath = path.join(f7Root, 'journal.jsonl');
      const f7Original = await readFile(f7JournalPath, 'utf8');
      await writeFile(f7JournalPath, `${f7Original}${JSON.stringify({ seq: 99, type: 'intent.written', intentId: 'forged' })}\n`, 'utf8');
      const f7Tamper = await captureError(() => f7Store.verifyIntegrity());
      record('f7', { f7Tamper, f7JournalLines: f7Original.split('\n').filter((line) => line.length > 0).length });
      check('a tampered journal is detected as conflict/store.integrity instead of being trusted', {
        code: f7Tamper.code, field: f7Tamper.field, journalLines: f7Original.split('\n').filter((line) => line.length > 0).length,
      }, {
        code: 'conflict', field: 'store.integrity', journalLines: 3,
      });

      // ── boundedness: fixed intent counts, monotonic epoch, zero borrowed cancels, bounded heap ──
      const heapEnd = process.memoryUsage().heapUsed;
      const heapGrowth = heapEnd - heapStart;
      record('heap', { heapStart, heapEnd, heapGrowth });
      check('the failure reconcile/error paths stay bounded (fixed intent counts, monotonic epoch, zero borrowed cancels, bounded heap)', {
        f1IntentCount, f5IntentCount, f6IntentCount,
        epochMonotonic: f4Epoch2 > f4Epoch1, borrowedCancelCalls: f5Fake.cancelCalls.length,
        heapGrowthUnderBound: heapGrowth < 128 * 1024 * 1024,
      }, {
        f1IntentCount: 1, f5IntentCount: 3, f6IntentCount: 2,
        epochMonotonic: true, borrowedCancelCalls: 0,
        heapGrowthUnderBound: true,
      });
    } else {

      // ── H1: submit returns the explicit submitted state without waiting for ready ──
      const h1Store = await openOwnerStore(path.join(fixture.root, 'control-h1'), 'owner-h1');
      const h1Fake = createScheduler({ jobId: '24680' });
      const h1 = createSlurmJobController({ store: h1Store, scheduler: h1Fake.scheduler, environmentId: ENVIRONMENT });
      const h1Submit = await h1.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', args: ['start'], sharedRoot: '/shared/vis', computeWorkingRoot: '/scratch/user/work' });
      const h1Persisted = await h1.state(h1Submit.intentId);
      const h1Script = h1Fake.submitCalls[0]?.script ?? '';
      record('h1', { h1Submit, h1Persisted });
      check('submit returns the explicit submitted state without waiting for ready and persists the pre-submit intent with the UUID on its job name/comment/output', {
        state: h1Submit.state, reconcile: h1Submit.reconcile, jobId: h1Submit.jobId, ownership: h1Submit.ownership,
        cpus: h1Submit.preview.cpus, memoryMiB: h1Submit.preview.memoryMiB, timeSeconds: h1Submit.preview.timeSeconds,
        gres: h1Submit.preview.gres, requestsGpu: h1Submit.preview.requestsGpu,
        submitCalls: h1Fake.submitCalls.length, queryCalls: h1Fake.queryCalls.length,
        scriptIntentOccurrences: occurrences(h1Script, h1Submit.intentId),
        persistedState: h1Persisted.state, persistedQueue: h1Persisted.queue, persistedOwnership: h1Persisted.ownership,
      }, {
        state: 'submitted', reconcile: null, jobId: '24680', ownership: 'owned',
        cpus: 4, memoryMiB: 8192, timeSeconds: 3600, gres: 'none', requestsGpu: false,
        submitCalls: 1, queryCalls: 0, scriptIntentOccurrences: 3,
        persistedState: 'submitted', persistedQueue: 'PENDING', persistedOwnership: 'owned',
      });

      // ── H2: Pending -> Running -> Completed through real reconciles + credential-protected bridge hello ──
      const h2Store = await openOwnerStore(path.join(fixture.root, 'control-h2'), 'owner-h2');
      const h2Fake = createScheduler({ jobId: '24680' });
      const h2 = createSlurmJobController({ store: h2Store, scheduler: h2Fake.scheduler, environmentId: ENVIRONMENT });
      const h2Submit = await h2.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      h2Fake.setMatches([{ jobId: '24680', state: 'PENDING', comment: h2Submit.intentId }]);
      const h2Pending = await h2.reconcile(h2Submit.intentId);
      h2Fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: h2Submit.intentId }]);
      const h2Running = await h2.reconcile(h2Submit.intentId);
      h2Fake.setMatches([{ jobId: '24680', state: 'COMPLETED', comment: h2Submit.intentId }]);
      const h2Completed = await h2.reconcile(h2Submit.intentId);
      const h2Handshake = createSlurmHandshake({ credential: SENTINEL });
      const h2Challenge = h2Handshake.challenge(h2Submit.intentId);
      const h2Attacker = createSlurmHandshake({ credential: `${SENTINEL}-wrong` });
      const h2Forged = h2Attacker.challenge(h2Submit.intentId);
      record('h2', { h2Pending, h2Running, h2Completed, challenge: { kind: h2Challenge.kind, tokenHexLength: h2Challenge.token.length } });
      check('a controlled scheduler advances PENDING -> RUNNING -> COMPLETED through real reconciles and the bridge hello is credential-protected without a resubmit', {
        pendingQueue: h2Pending.queue, pendingState: h2Pending.state, pendingTerminal: h2Pending.terminal,
        runningQueue: h2Running.queue, runningState: h2Running.state, runningTerminal: h2Running.terminal,
        completedQueue: h2Completed.queue, completedState: h2Completed.state, completedTerminal: h2Completed.terminal,
        submitCalls: h2Fake.submitCalls.length, queryCalls: h2Fake.queryCalls.length,
        handshakeKind: h2Challenge.kind, credentialProtected: h2Challenge.credentialProtected,
        verifyCorrect: h2Handshake.verify({ intentId: h2Challenge.intentId, nonce: h2Challenge.nonce, token: h2Challenge.token }),
        verifyForgedCredential: h2Handshake.verify({ intentId: h2Forged.intentId, nonce: h2Forged.nonce, token: h2Forged.token }),
        verifyTamperedToken: h2Handshake.verify({ intentId: h2Challenge.intentId, nonce: h2Challenge.nonce, token: 'deadbeef' }),
        credentialInChallengeJson: occurrences(JSON.stringify(h2Challenge), SENTINEL),
        tokenHexLength: h2Challenge.token.length, tokenIsHex64: /^[0-9a-f]{64}$/u.test(h2Challenge.token),
      }, {
        pendingQueue: 'PENDING', pendingState: 'PENDING', pendingTerminal: null,
        runningQueue: 'RUNNING', runningState: 'RUNNING', runningTerminal: null,
        completedQueue: 'COMPLETED', completedState: 'COMPLETED', completedTerminal: 'COMPLETED',
        submitCalls: 1, queryCalls: 3,
        handshakeKind: SLURM_HANDSHAKE_KIND, credentialProtected: true,
        verifyCorrect: true, verifyForgedCredential: false, verifyTamperedToken: false,
        credentialInChallengeJson: 0, tokenHexLength: 64, tokenIsHex64: true,
      });

      // ── H3: a manager restart finds the ORIGINAL job by UUID ──
      const h3Root = path.join(fixture.root, 'control-h3');
      const h3A = await openOwnerStore(h3Root, 'manager-A');
      const h3Fake = createScheduler({ jobId: '24680' });
      const h3ControllerA = createSlurmJobController({ store: h3A, scheduler: h3Fake.scheduler, environmentId: ENVIRONMENT });
      const h3Submit = await h3ControllerA.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const h3Uuid = h3Submit.intentId;
      await h3A.close();
      const h3B = await openOwnerStore(h3Root, 'manager-B');
      const h3Recovered = await h3B.readIntent(h3Uuid);
      const h3List = await h3B.listIntents();
      const h3Integrity = await h3B.verifyIntegrity();
      h3Fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: h3Uuid }]);
      const h3ControllerB = createSlurmJobController({ store: h3B, scheduler: h3Fake.scheduler, environmentId: ENVIRONMENT });
      const h3Resumed = await h3ControllerB.reconcile(h3Uuid);
      record('h3', { h3Uuid, h3Recovered, intentCount: h3List.length, integrity: h3Integrity, resumed: h3Resumed });
      check('a manager restart reopens the same durable store and finds the ORIGINAL job by UUID, landing it in the state the scheduler reports', {
        recoveredIntentId: h3Recovered.intentId, recoveredUuid: h3Recovered.uuid, recoveredJobId: h3Recovered.jobId,
        recoveredState: h3Recovered.state, recoveredQueue: h3Recovered.queue, recoveredOwnership: h3Recovered.ownership,
        uuidMatchesIntent: h3Recovered.intentId === h3Uuid, recoveredEnvironment: h3Recovered.environmentId,
        intentCount: h3List.length, integrityOk: h3Integrity.ok, integrityRecords: h3Integrity.records,
        epoch: h3B.status().epoch, resumedState: h3Resumed.state, resumedQueue: h3Resumed.queue, resumedReconcile: h3Resumed.reconcile,
      }, {
        recoveredIntentId: h3Uuid, recoveredUuid: h3Uuid, recoveredJobId: '24680',
        recoveredState: 'submitted', recoveredQueue: 'PENDING', recoveredOwnership: 'owned',
        uuidMatchesIntent: true, recoveredEnvironment: ENVIRONMENT,
        intentCount: 1, integrityOk: true, integrityRecords: 5,
        epoch: 0, resumedState: 'RUNNING', resumedQueue: 'RUNNING', resumedReconcile: null,
      });

      // ── H4: job expiry / node replacement re-reads the ACTUAL native transcript and re-indexes it ──
      const h4Root = path.join(fixture.root, 'control-h4');
      const h4Store = await openOwnerStore(h4Root, 'owner-h4');
      const h4Fake = createScheduler({ jobId: '24680' });
      const h4 = createSlurmJobController({ store: h4Store, scheduler: h4Fake.scheduler, environmentId: ENVIRONMENT });
      const h4Submit = await h4.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const h4Intent = h4Submit.intentId;
      const staleDigest = 'a'.repeat(64);
      await h4Store.updateIntent(h4Intent, { transcript: { digest: staleDigest, lines: 0, bytes: 0, source: 'cached-summary' } });
      const transcriptPath = path.join(fixture.root, `slurm-${h4Intent}-24680.out`);
      fixture.register({ kind: 'slurm-transcript-planned', path: transcriptPath, teardown: 'removed with the private root' });
      const transcriptBody = [
        '#SBATCH job 24680 on node-a',
        `bridge hello {"kind":"${SLURM_HANDSHAKE_KIND}","intent":"${h4Intent}"}`,
        'compute started on node-a',
        'node-a preempted at 2026-10-13T09:00:00Z',
        '',
      ].join('\n');
      await writeFile(transcriptPath, transcriptBody, 'utf8');
      const transcriptBytes = await readFile(transcriptPath);
      const statBytes = (await stat(transcriptPath)).size;
      const freshDigest = sha256(transcriptBytes);
      const freshLines = transcriptBody.split('\n').filter((line) => line.length > 0).length;
      h4Fake.setMatches([{ jobId: '24680', state: 'PREEMPTED', comment: h4Intent }]);
      const h4Preempted = await h4.reconcile(h4Intent);
      const h4Epoch = await h4Store.bumpEpoch({ reason: 'node-replacement' });
      const reread = await readFile(transcriptPath);
      const rereadText = reread.toString('utf8');
      const h4Reindexed = await h4Store.updateIntent(h4Intent, {
        transcript: { digest: sha256(reread), lines: freshLines, bytes: statBytes, source: 'native-transcript-reindex' },
      });
      const h4Integrity = await h4Store.verifyIntegrity();
      record('h4', { transcriptBytes: statBytes, freshLines, freshDigest, h4Preempted, h4Epoch, reindexed: h4Reindexed.transcript, integrity: h4Integrity });
      check('after an expiry / node replacement the ACTUAL native transcript is re-read from disk and re-indexed, not the cached summary', {
        transcriptBytes: statBytes, rereadBytes: reread.length, transcriptLines: freshLines,
        freshDigestMatchesFile: sha256(reread) === freshDigest, staleDigestDiffersFromFresh: staleDigest !== freshDigest,
        preemptRequeued: h4Preempted.requeued, preemptQueue: h4Preempted.queue, preemptState: h4Preempted.state,
        epoch: h4Epoch, storedDigestIsFresh: h4Reindexed.transcript.digest === freshDigest,
        storedDigestIsStale: h4Reindexed.transcript.digest === staleDigest, storedLines: h4Reindexed.transcript.lines,
        storedBytes: h4Reindexed.transcript.bytes, storedSource: h4Reindexed.transcript.source,
        markerOccurrences: occurrences(rereadText, 'bridge hello'), helloIntentOccurrences: occurrences(rereadText, h4Intent),
        integrityOk: h4Integrity.ok, integrityRecords: h4Integrity.records,
      }, {
        transcriptBytes: Buffer.byteLength(transcriptBody, 'utf8'), rereadBytes: Buffer.byteLength(transcriptBody, 'utf8'), transcriptLines: 4,
        freshDigestMatchesFile: true, staleDigestDiffersFromFresh: true,
        preemptRequeued: true, preemptQueue: 'PENDING', preemptState: 'PENDING',
        epoch: 1, storedDigestIsFresh: true, storedDigestIsStale: false, storedLines: 4, storedBytes: Buffer.byteLength(transcriptBody, 'utf8'),
        storedSource: 'native-transcript-reindex', markerOccurrences: 1, helloIntentOccurrences: 1,
        integrityOk: true, integrityRecords: 7,
      });

      // ── H5: explicit resources, localFS verification, independent roots, bootstrap plan ──
      const h5Root = path.join(fixture.root, 'control-h5');
      const h5Normal = normalizeSlurmResources(RESOURCES);
      const h5MissingTime = await captureError(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', gres: 'none' }));
      const h5MissingGres = await captureError(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', time: '01:00:00' }));
      const h5Preview = buildResourcePreview({ ...RESOURCES, gres: 'gpu:1' });
      const h5Local = await verifyLocalFilesystem({ root: h5Root, platform: 'linux', statfs: localStatfs });
      const h5Unsupported = await captureError(() => verifyLocalFilesystem({ root: h5Root, platform: 'linux', statfs: () => ({ type: NFS }) }));
      const h5StoreNetwork = makeStore(h5Root, 'nfs-owner', { statfs: () => ({ type: LUSTRE }) });
      const h5NetworkOpen = await captureError(() => h5StoreNetwork.open('owner'));
      const h5Plan = planSlurmBootstrap({
        profile: { target: { kind: 'slurm', clusterEnvironmentId: CLUSTER_ENVIRONMENT } },
        login: { role: 'login', platform: 'linux', programs: { sbatch: true, squeue: true, scontrol: true }, controlRoot: '/home/user/.local/state/vis/bridge', workspaceRoot: '/home/user/work', nativeDataRoot: '/home/user/.local/share/vis/native' },
        compute: { role: 'compute', platform: 'linux', programs: { bridge: true }, bridgeInstalled: true, controlRoot: '/home/user/.local/state/vis/bridge', workspaceRoot: '/scratch/user/run', nativeDataRoot: '/scratch/user/native' },
        sharedRootAvailable: true,
      });
      const h5Collision = await captureError(() => assertIndependentRoots({ controlRoot: '/shared/vis-control', workspaceRoot: '/shared/vis-control', nativeDataRoot: '/scratch/native' }));
      const h5BadRole = await captureError(() => parseSlurmHostProbe({ role: 'gpu', platform: 'linux', programs: {} }));
      const h5Shared = planComputeDelivery({ sharedRootAvailable: true });
      const h5Controlled = planComputeDelivery({ sharedRootAvailable: false });
      record('h5', { h5Normal, h5Preview, h5Local, h5Unsupported, h5NetworkOpen, plan: { controlHost: h5Plan.controlHost, executionHost: h5Plan.executionHost, roots: [h5Plan.loginControlRoot, h5Plan.computeWorkingRoot] } });
      check('resources require explicit time/gres, the store verifies a local disk and refuses a network mount, and the bootstrap plan keeps control and compute roots independent', {
        normalCpus: h5Normal.cpus, normalMemoryMiB: h5Normal.memoryMiB, normalTimeSeconds: h5Normal.timeSeconds, normalGres: h5Normal.gres,
        previewGres: h5Preview.gres, previewRequestsGpu: h5Preview.requestsGpu,
        missingTimeCode: h5MissingTime.code, missingTimeField: h5MissingTime.field,
        missingGresCode: h5MissingGres.code, missingGresField: h5MissingGres.field,
        localClass: h5Local.filesystemClass, extClass: filesystemClass(EXT4), nfsClass: filesystemClass(NFS), lustreClass: filesystemClass(LUSTRE),
        isNetworkLustre: isNetworkFilesystem(LUSTRE), isNetworkExt4: isNetworkFilesystem(EXT4),
        unsupportedCode: h5Unsupported.code, unsupportedField: h5Unsupported.field, networkOpenCode: h5NetworkOpen.code,
        planControlHost: h5Plan.controlHost, planExecutionHost: h5Plan.executionHost,
        planSubmitControlHost: h5Plan.submitControlHost, planAgentExecutionHost: h5Plan.agentExecutionHost, planAutomatic: h5Plan.automatic,
        rootsIndependent: h5Plan.loginControlRoot !== h5Plan.computeWorkingRoot,
        loginControlRoot: h5Plan.loginControlRoot, computeWorkingRoot: h5Plan.computeWorkingRoot,
        deliveryChannel: h5Plan.delivery.channel, sharedChannel: h5Shared.channel, controlledChannel: h5Controlled.channel,
        collisionCode: h5Collision.code, collisionField: h5Collision.field, badRoleCode: h5BadRole.code, badRoleField: h5BadRole.field,
      }, {
        normalCpus: 4, normalMemoryMiB: 8192, normalTimeSeconds: 3600, normalGres: 'none',
        previewGres: 'gpu:1', previewRequestsGpu: true,
        missingTimeCode: 'invalid_request', missingTimeField: 'resources.time',
        missingGresCode: 'invalid_request', missingGresField: 'resources.gres',
        localClass: 'local', extClass: 'local', nfsClass: 'network', lustreClass: 'network',
        isNetworkLustre: true, isNetworkExt4: false,
        unsupportedCode: 'unsupported', unsupportedField: 'store.filesystem', networkOpenCode: 'unsupported',
        planControlHost: 'login', planExecutionHost: 'compute',
        planSubmitControlHost: 'login', planAgentExecutionHost: 'compute', planAutomatic: false,
        rootsIndependent: true,
        loginControlRoot: '/home/user/.local/state/vis/bridge', computeWorkingRoot: '/scratch/user/run',
        deliveryChannel: 'slurm-shared-root', sharedChannel: 'slurm-shared-root', controlledChannel: 'slurm-controlled-channel',
        collisionCode: 'conflict', collisionField: 'slurm.roots', badRoleCode: 'unsupported', badRoleField: 'slurm.role',
      });

      // ── H6: detach does not cancel and stop cancels exactly the owned job ──
      const h6Store = await openOwnerStore(path.join(fixture.root, 'control-h6'), 'owner-h6');
      const h6Fake = createScheduler({ jobId: '24680' });
      const h6 = createSlurmJobController({ store: h6Store, scheduler: h6Fake.scheduler, environmentId: ENVIRONMENT });
      const h6Owned = await h6.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
      const h6Detach = await h6.detach(h6Owned.intentId);
      const h6CancelAfterDetach = h6Fake.cancelCalls.length;
      const h6Stop = await h6.stop(h6Owned.intentId);
      const h6AfterStop = await h6.state(h6Owned.intentId);
      record('h6', { h6Detach, h6CancelAfterDetach, h6Stop, h6AfterStop });
      check('detach only stops tracking and stop cancels exactly the owned job (never a borrowed one)', {
        detachAttached: h6Detach.attached, detachCancelled: h6Detach.cancelled, detachSignalled: h6Detach.signalled,
        cancelAfterDetach: h6CancelAfterDetach,
        stopSignalled: h6Stop.signalled, stopCancelled: h6Stop.cancelled, stopJobId: h6Stop.jobId,
        cancelCalls: h6Fake.cancelCalls.length, cancelledJobId: h6Fake.cancelCalls[0]?.jobId,
        terminalAfterStop: h6AfterStop.terminal, queueAfterStop: h6AfterStop.queue, attachedAfterStop: h6AfterStop.attached,
      }, {
        detachAttached: false, detachCancelled: false, detachSignalled: false,
        cancelAfterDetach: 0,
        stopSignalled: true, stopCancelled: true, stopJobId: '24680',
        cancelCalls: 1, cancelledJobId: '24680',
        terminalAfterStop: 'CANCELLED', queueAfterStop: 'CANCELLED', attachedAfterStop: false,
      });

      // ── boundedness: monotonic epoch, fixed intent counts, bounded heap ──
      const heapEnd = process.memoryUsage().heapUsed;
      const heapGrowth = heapEnd - heapStart;
      record('heap', { heapStart, heapEnd, heapGrowth });
      check('the happy reconcile paths stay bounded (monotonic epoch, fixed intent counts, bounded heap)', {
        h3Epoch: h3B.status().epoch, h4Epoch: h4Epoch, h6IntentCount: (await h6Store.listIntents()).length,
        heapGrowthUnderBound: heapGrowth < 128 * 1024 * 1024,
      }, {
        h3Epoch: 0, h4Epoch: 1, h6IntentCount: 1,
        heapGrowthUnderBound: true,
      });
    }

    const browserErrors = await evaluate(() => window.task28.errors());
    check('the browser surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa28-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task28Errors ?? [], task28: Boolean(window.task28) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /submitted|queue|PENDING|RUNNING|COMPLETED|state|terminal/,
    cancel_resume: /detach|stop|cancel|requeue|preempt|borrowed/,
    malformed_input: /invalid_request|unsupported|ENOTDIR|tamper|conflict|no-job|terminal/,
    hung_commands: /hello|handshake|unconfirmable|unreachable|ambiguous/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /resubmit|duplicate|fence|epoch|bounded/,
    misleading_success_output: /never resubmitting|never reaches the scheduler|not the cached summary|without leaking/,
    flaky_tests: /distinct UUID|monotonic|explicit submitted state|independent/,
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'recoverable-slurm-job-control-store', schema: CONTROL_STORE_SCHEMA_VERSION === 1 ? 'control-store/v1' : 'unknown' },
    cleanup: proof.cleanup,
    evidenceBoundary: 'The real landed bridge/runtime/transports modules (slurmJobs.js, slurmControlStore.js, slurmBootstrap.js) and the control-store role in bridge/visBridgeCli.js execute directly in the Node worker. The only controlled boundaries are: the scheduler edge (sbatch/squeue/scontrol/scancel is a fake, so no real Slurm runs), the filesystem-type probe (injected statfs; the store itself writes real durable files under the private root), the "native transcript" (a REAL file on disk read back with node:fs), and a real headless Chromium projection surface over case-owned node:* shims (app/dev/runtime-v090/task28.ts + scripts/qa/runtime-v090-cases/task-28-browser-shim.mjs). It covers the happy path (no-wait submit, Pending->Running->Completed, a manager restart finding the original job by UUID, an expiry/node replacement re-reading the actual native transcript and re-indexing it, explicit time/gres, localFS/fencing, independent control/compute roots) and the failure path (lost ack, zero/multi-UUID match, unconfirmable query, unreachable/un-writable store, preempt/requeue with epoch fencing, borrowed/no-job/terminal stop, duplicate start, tampered journal). It does NOT perform or claim a live Slurm verification — task 46 owns that — and it authors no PASS verdict.',
  };
}

