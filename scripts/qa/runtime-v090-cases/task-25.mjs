// Task 25 registered QA case — connection / execution profiles and the profile HTTP API.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty `sourceFiles` array and a
// `run(context)` returning a JSON-serialisable result whose scenarios each carry assertions with
// `observed === expected`. The runner re-invokes this module with VIS_RUNTIME_QA_WORKER=1, which
// calls `run(context)`; the parent asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: a REAL `createVisBridgeServer` request listener bound to a real loopback
//     port, served the REAL profile HTTP dispatch (`bridge/bridgeHttpRoutes.js` →
//     `bridge/runtime/transports/connectionManager.js` → `bridge/runtime/transports/profileStore.js`),
//     a REAL durable `profiles.json` under the private root, the REAL strict parser / target mapping
//     / secret guard in `shared/runtime/connectionProfile.js`, and the REAL transport contract in
//     `bridge/runtime/transports/transportContract.js`.
//   * In a real headless Chromium: the landed browser entry `app/dev/runtime-v090/task25.ts`, which
//     drives the REAL `createBridgeProfileClient` / `resolveRuntimeCapabilityEntry` /
//     `isDirectOnlyRuntime` from `app/composables/useRuntimeProfiles.ts` over real cross-origin HTTP
//     against the SAME bridge listener the Node worker owns (a bridge token is set, so the real
//     `isAllowedOrigin` / CORS preflight / bearer path runs).
//
// The ONLY controlled (injected fake) boundaries are:
//   * the transport edge (`openTransport`): the bridge's management connection returns a case-owned
//     handle whose environment equals the profile's own resolved environment — this is the managed
//     bridge the Browser uses. NO live SSH host and NO live Slurm cluster is ever contacted; the
//     default `openTransport` is exercised separately to prove it refuses a live transport in a
//     build without one (task 46 owns the live end-to-end check).
//   * the "native history" / "owned job" registries are REAL files on disk under the private root
//     that the case would delete if the product ever called the `resources` handles.
//
// This module authors NO PASS verdict and edits no product or test file. It covers the happy path
// (two SSH endpoints on one host / multiple profiles, lifecycle identity, no auto-enable, delete
// preserving native history + owned jobs, a secret-free serialized payload, Browser-on-managed-
// bridge capability entry, pure-static direct behaviour) and the failure path (a cross-profile
// target binding, a simultaneous connect, a stale-generation retired dial, an unsupported transport,
// a concurrent-write burst, an embedded-secret locator and the unwired-route / stale-dial findings).
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { request as httpRequest } from 'node:http';
import path from 'node:path';
import { createServer as createViteServer } from 'vite';
import { chromium } from 'playwright';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, closeServer, createFixture, listen, until } from './task-25-fixture.mjs';

import { createVisBridgeServer } from '../../../bridge/visBridgeServer.js';
import { createProfileStore } from '../../../bridge/runtime/transports/profileStore.js';
import { createConnectionManager } from '../../../bridge/runtime/transports/connectionManager.js';
import {
  assertTransportSupportsRole,
  isManagedTransport,
  transportCapabilities,
  transportLiveVerified,
} from '../../../bridge/runtime/transports/transportContract.js';
import {
  parseNewConnectionProfile,
  parseTransport,
  resolveProfileEnvironment,
} from '../../../shared/runtime/connectionProfile.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const FOREIGN_ENVIRONMENT = '55555555-5555-4555-8555-555555555555';
const TOKEN = 'task25-qa-bridge-token-4d1e9a';
const SECRET = 'sk-task25-credential-8f3a2c7e-NEVER-LOG';
// A fictional embedded password that deliberately avoids every secret KEYWORD, so a rejection must
// come from the locator grammar / secret-value marker, not from a key-name match.
const LOCATOR_MARKER = 'hunter2-zz25';
const CREDENTIAL_REF = 'cred-task25-01';

export const sourceFiles = [...new Set([
  // the profile store / lifecycle manager / transport contract the unit owns
  'bridge/runtime/transports/profileStore.js', 'bridge/runtime/transports/profileStore.d.ts',
  'bridge/runtime/transports/connectionManager.js', 'bridge/runtime/transports/connectionManager.d.ts',
  'bridge/runtime/transports/transportContract.js', 'bridge/runtime/transports/transportContract.d.ts',
  'bridge/runtime/transports/sshTransport.js', 'bridge/runtime/transports/sshTransport.d.ts',
  // the profile HTTP wiring (routes + server dispatch + bridge config location)
  'bridge/bridgeHttpRoutes.js', 'bridge/bridgeHttp.js', 'bridge/bridgeConfig.js',
  'bridge/visBridgeServer.js', 'vis_bridge.js',
  // the shared strict parser / identity / error contract the routes run
  'shared/runtime/connectionProfile.js', 'shared/runtime/connectionProfile.d.ts',
  'shared/runtime/identity.js', 'shared/runtime/identity.d.ts',
  'shared/runtime/capabilities.js', 'shared/runtime/capabilities.d.ts',
  // the owned tests and the browser consumer
  'app/runtime/transportProfiles.test.ts',
  'app/runtime/bridgeProfileRoutes.test.ts',
  'app/runtime/bridgeProfileHttpWiring.integration.test.ts',
  'app/composables/useRuntimeProfiles.ts',
  // the browser entry this case drives and the runner inputs
  'app/dev/runtime-v090/task25.ts',
  'scripts/qa/runtime-v090-cases/task-25.mjs',
  'scripts/qa/runtime-v090-cases/task-25-fixture.mjs',
  'package.json',
])];

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);
const uuid = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/iu;

/** A deferred, case-owned transport edge so the case controls exactly when a dial settles. */
function deferred() {
  let resolve;
  let reject;
  const promise = new Promise((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
}

function requestJson(port, requestPath, method, body, headers = {}) {
  return new Promise((resolve, reject) => {
    const payload = body === undefined ? '' : JSON.stringify(body);
    const request = httpRequest(
      {
        host: '127.0.0.1',
        port,
        path: requestPath,
        method,
        headers: {
          ...(payload ? { 'Content-Type': 'application/json', 'Content-Length': String(Buffer.byteLength(payload)) } : {}),
          ...headers,
        },
      },
      (response) => {
        const chunks = [];
        response.on('data', (chunk) => chunks.push(chunk));
        response.on('end', () => {
          const text = Buffer.concat(chunks).toString('utf8');
          let parsed = null;
          try { parsed = text.length === 0 ? null : JSON.parse(text); } catch { parsed = undefined; }
          resolve({ status: response.statusCode, headers: response.headers, text, body: parsed });
        });
      },
    );
    request.on('error', reject);
    if (payload) request.write(payload);
    request.end();
  });
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-25/qa-cases');
  const runDir = path.join(evidenceDir, `run-${context.case}-${Date.now()}-${process.pid}`);
  await mkdir(runDir, { recursive: true });
  const scenarios = [];
  const artifacts = [];
  const checks = [];
  const observations = {};
  const proof = { case: context.case, runDir, checks, observations };
  const persist = () => writeJson(path.join(runDir, 'proof.json'), proof);
  const scrub = (value) => (value === undefined ? undefined : JSON.parse(JSON.stringify(value)));
  const check = (name, observed, expected) => {
    const left = scrub(observed);
    const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({
      name,
      surface: 'real createVisBridgeServer listener + real profile HTTP routes/store/manager in the Node worker (injected transport edge, real durable files), plus the real useRuntimeProfiles browser client in a real headless Chromium over the same bridge',
      assertions: [{ name, observed: left, expected: right, passed: true }],
    });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };
  const capture = async (run) => {
    try { await run(); return { threw: false, code: null, field: null, message: null }; }
    catch (error) { return { threw: true, code: error?.code ?? null, field: error?.field ?? null, message: String(error?.message ?? error) }; }
  };
  const draft = (environmentId, endpoint, role = 'execution', overrides = {}) => ({
    name: 'Task 25 profile',
    transport: { kind: 'ssh', endpoint },
    target: { kind: 'ssh', environmentId },
    role,
    credentialRef: CREDENTIAL_REF,
    ...overrides,
  });

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const ownedFiles = [...sourceFiles];
  const sourceBefore = sourceSnapshot(context.root, ownedFiles);
  const heapStart = process.memoryUsage().heapUsed;

  // Real native-history / owned-job registries. The manager only ever reads `Object.keys(resources)`;
  // these handles would DELETE the real files if the product's delete path ever called them.
  const nativeHistoryPath = path.join(fixture.root, 'native-history.jsonl');
  const ownedJobPath = path.join(fixture.root, 'owned-jobs.json');
  let droppedNativeHistory = 0;
  let cancelledOwnedJobs = 0;
  const resources = {
    async dropNativeHistory() { droppedNativeHistory += 1; await rm(nativeHistoryPath, { force: true }); return { dropped: true }; },
    async cancelOwnedJobs() { cancelledOwnedJobs += 1; await rm(ownedJobPath, { force: true }); return { cancelled: 0 }; },
  };

  // The bridge's managed transport edge: a case-owned handle whose environment is the profile's own
  // resolved environment. No live SSH/Slurm is contacted — task 46 owns that.
  const dialedProfiles = [];
  const closeCalls = [];
  const openProfileTransport = async (profile) => {
    const environmentId = resolveProfileEnvironment(profile);
    dialedProfiles.push({ profileId: profile.profileId, kind: profile.transport.kind, environmentId });
    return Object.freeze({
      environmentId,
      connectionId: `${profile.transport.kind}-${profile.profileId}`,
      async close() { closeCalls.push(profile.profileId); },
    });
  };

  const profilePath = path.join(fixture.root, 'profiles.json');
  fixture.register({ kind: 'profiles-document-planned', path: profilePath, teardown: 'removed with the private root' });
  const store = createProfileStore({ profilePath });
  const manager = createConnectionManager({ store, openTransport: openProfileTransport, resources });
  fixture.register({ kind: 'bridge-http-planned', host: '127.0.0.1', teardown: 'server.close + closeAllConnections, then exclusive port rebind' });
  const bridgeServer = createVisBridgeServer({
    path: '/codex',
    target: 'ws://127.0.0.1:1',
    bridgeToken: TOKEN,
    profilePath,
    profileStore: store,
    profileManager: manager,
  });
  const bridgePort = await listen(bridgeServer);
  fixture.register({ kind: 'bridge-http-created', port: bridgePort });
  fixture.own('bridge-http', async () => {
    await closeServer(bridgeServer);
    await assertPortReleased(bridgePort);
    return { port: bridgePort, exclusiveRebind: true };
  });
  const bridgeBase = `http://127.0.0.1:${bridgePort}`;
  const auth = { Authorization: `Bearer ${TOKEN}` };
  record('bridgeBase', bridgeBase);

  let browser;
  let page;
  let vite;
  try {
    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Real profile HTTP API over the real bridge listener
    // ══════════════════════════════════════════════════════════════════════════════════════════

    // ── Finding #1 (delivered-then-fixed): the profile API was unwired and GET returned 404 ──
    const wiring = await requestJson(bridgePort, '/api/v1/profiles', 'GET', undefined, auth);
    record('wiring', { status: wiring.status, body: wiring.body });
    check('the REAL bridge request listener serves GET /api/v1/profiles with 200 and an empty profile list (the profile routes are wired, not 404)', {
      status: wiring.status,
      is404: wiring.status === 404,
      profilesIsArray: Array.isArray(wiring.body?.profiles),
      profileCount: Array.isArray(wiring.body?.profiles) ? wiring.body.profiles.length : -1,
    }, {
      status: 200,
      is404: false,
      profilesIsArray: true,
      profileCount: 0,
    });

    // ── Criterion 4 (Node): a NORMAL profile payload is secret-free and carries a REFERENCE ──
    const createdA = await requestJson(bridgePort, '/api/v1/profiles', 'POST', draft(ENVIRONMENT, 'cluster-a.example:22'), auth);
    const createdB = await requestJson(bridgePort, '/api/v1/profiles', 'POST', draft(ENVIRONMENT, 'cluster-b.example:22', 'manager'), auth);
    const profileA = createdA.body;
    const profileB = createdB.body;
    record('createdProfiles', { a: profileA, b: profileB });
    check('a normal profile create returns 201 with a stable UUID, an opt-in disabled default, a credential REFERENCE and a secret-free serialized payload', {
      statusA: createdA.status,
      statusB: createdB.status,
      profileIdIsUuid: uuid.test(String(profileA.profileId)),
      profileIdLength: String(profileA.profileId).length,
      enabledDefault: profileA.enabled,
      transportKind: profileA.transport?.kind,
      targetEnvironment: profileA.target?.environmentId,
      credentialRef: profileA.credentialRef,
      secretKeyPresent: Object.keys(profileA).some((key) => /password|secret|token|passphrase|privatekey/iu.test(key)),
      secretOccurrencesInResponse: occurrences(createdA.text, SECRET),
      profileIdsDistinct: String(profileA.profileId) !== String(profileB.profileId),
    }, {
      statusA: 201,
      statusB: 201,
      profileIdIsUuid: true,
      profileIdLength: 36,
      enabledDefault: false,
      transportKind: 'ssh',
      targetEnvironment: ENVIRONMENT,
      credentialRef: CREDENTIAL_REF,
      secretKeyPresent: false,
      secretOccurrencesInResponse: 0,
      profileIdsDistinct: true,
    });

    // ── Happy scope: two endpoints on the SAME host / multiple SSH profiles ──
    const listed = await requestJson(bridgePort, '/api/v1/profiles', 'GET', undefined, auth);
    const durable = JSON.parse(await readFile(profilePath, 'utf8'));
    const durableText = await readFile(profilePath, 'utf8');
    record('twoEndpointsSameHost', { listed: listed.body, durableCount: durable.profiles.length });
    check('two DISTINCT SSH profiles (different endpoints, different roles) on ONE host resolve to the SAME environment UUID with distinct profile UUIDs, and both persist', {
      listedCount: listed.body.profiles.length,
      endpoints: listed.body.profiles.map((profile) => profile.transport.endpoint).sort().join(','),
      roles: listed.body.profiles.map((profile) => profile.role).sort().join(','),
      environments: [...new Set(listed.body.profiles.map((profile) => profile.target.environmentId))].join(','),
      distinctProfileIds: new Set(listed.body.profiles.map((profile) => profile.profileId)).size,
      transportKinds: [...new Set(listed.body.profiles.map((profile) => profile.transport.kind))].join(','),
      durableCount: durable.profiles.length,
      durableSecretOccurrences: occurrences(durableText, SECRET),
    }, {
      listedCount: 2,
      endpoints: 'cluster-a.example:22,cluster-b.example:22',
      roles: 'execution,manager',
      environments: ENVIRONMENT,
      distinctProfileIds: 2,
      transportKinds: 'ssh',
      durableCount: 2,
      durableSecretOccurrences: 0,
    });

    // ── Real headless Chromium over the real browser entry ──
    const pageHtml = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 25 registered case</title>
<style>:root { color-scheme: light dark; } html, body { margin: 0; } body { font: 0.875rem/1.5 system-ui; padding: 8px; }</style></head>
<body>
<script type="module">
window.__task25PageErrors=[];
window.addEventListener('error',(e)=>window.__task25PageErrors.push({kind:'error',message:String(e.message)}));
window.addEventListener('unhandledrejection',(e)=>window.__task25PageErrors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));
window.__task25Config=${JSON.stringify({ baseUrl: bridgeBase, token: TOKEN, secret: SECRET, credentialRef: CREDENTIAL_REF, environmentId: ENVIRONMENT })};
</script>
<script type="module" src="/app/dev/runtime-v090/task25.ts"></script></body></html>`;

    fixture.register({ kind: 'Vite-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    vite = await createViteServer({
      configFile: false,
      appType: 'custom',
      root: context.root,
      optimizeDeps: { include: ['vue'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa25', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(pageHtml); });
    await vite.listen();
    const vitePort = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port: vitePort });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(vitePort); return { port: vitePort, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${vitePort}/qa25/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const chromiumProfile = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: chromiumProfile, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({
      browserPath: chromium.executablePath(),
      browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${chromiumProfile}`],
      storageRoot: runDir,
      commandTimeoutMs: 180000,
    });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task25 && window.task25.ready)), 'task25 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── Browser reads the SAME profiles the worker created, over real cross-origin HTTP ──
    const browserList = await evaluate(() => window.task25.list());
    record('browserList', browserList);
    check('the real browser profile client reads the worker-created profiles over the real bridge (managed bridge over a token-authenticated cross-origin request): two profiles, one environment, references only', {
      count: browserList.count,
      distinctIds: new Set(browserList.ids).size,
      environments: [...new Set(browserList.environmentIds)].join(','),
      credentialRefs: [...new Set(browserList.credentialRefs)].join(','),
      secretOccurrences: occurrences(JSON.stringify(browserList), SECRET),
    }, {
      count: 2,
      distinctIds: 2,
      environments: ENVIRONMENT,
      credentialRefs: CREDENTIAL_REF,
      secretOccurrences: 0,
    });

    // ── Happy scope: Browser uses a managed Bridge; Browser and Electron share the ONE entry ──
    const managedEntry = await evaluate(() => window.task25.capabilityEntry({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true, environmentId: window.task25.constants.environmentId }));
    const electronEntry = await evaluate(() => window.task25.capabilityEntry({ client: 'electron', transports: { direct: true, ssh: true, slurm: true }, managedTransport: true, environmentId: window.task25.constants.environmentId }));
    const noBridgeEntry = await evaluate(() => window.task25.capabilityEntry({ client: 'browser', transports: { direct: true, ssh: true, slurm: true }, managedTransport: false }));
    const directOnly = await evaluate(() => ({ without: window.task25.directOnly(false), with: window.task25.directOnly(true) }));
    record('capabilityEntry', { managedEntry, electronEntry, noBridgeEntry, directOnly });
    check('the ONE capability entry is identical for Browser and Electron and is a function of (transports, managedTransport): with a managed bridge SSH/Slurm are supported, without it only direct remains — the pure-static direct behaviour', {
      managedRows: managedEntry.map((row) => `${row.capability}:${row.state}`).join(','),
      electronEqualsBrowser: JSON.stringify(electronEntry) === JSON.stringify(managedEntry),
      noBridgeRows: noBridgeEntry.map((row) => `${row.capability}:${row.state}`).join(','),
      directOnlyWithoutBridge: directOnly.without,
      directOnlyWithBridge: directOnly.with,
      rowCount: managedEntry.length,
    }, {
      managedRows: 'direct:supported,managed-bridge:supported,ssh:supported,slurm:supported',
      electronEqualsBrowser: true,
      noBridgeRows: 'direct:supported,managed-bridge:unsupported,ssh:unsupported,slurm:unsupported',
      directOnlyWithoutBridge: true,
      directOnlyWithBridge: false,
      rowCount: 4,
    });

    // ── Criterion 4 (browser): the credential never becomes a value in payload / DOM / console / storage ──
    const browserCreated = await evaluate(() => window.task25.createNormal({ name: 'Browser normal' }));
    const httpCalls = await evaluate(() => window.task25.httpCalls());
    const consoleAfterCreate = await evaluate(() => window.task25.consoleEntries());
    const domAfterCreate = await evaluate(() => window.task25.domText());
    const storageAfterCreate = await evaluate(() => window.task25.storageSnapshot());
    const rendered = await evaluate(() => window.task25.rendered());
    const clientSecret = await evaluate(() => window.task25.attemptSecretViaClient());
    const httpSecret = await evaluate(() => window.task25.attemptSecretViaHttp());
    const consoleFinal = await evaluate(() => window.task25.consoleEntries());
    const domFinal = await evaluate(() => window.task25.domText());
    const storageFinal = await evaluate(() => window.task25.storageSnapshot());
    record('browserSecret', { browserCreated, clientSecret, httpSecret, callCount: httpCalls.length, rendered });
    check('the REAL serialized client payload never carries the secret: create returns a credential REFERENCE, the secret appears ZERO times in every recorded request/response, the DOM, the console and browser storage, and the client-side parser refuses a secret draft before it reaches the wire', {
      createdCredentialRef: browserCreated.credentialRef,
      createdTargetEnvironment: browserCreated.environmentId,
      createdTargetKind: browserCreated.targetKind,
      secretInRecordedCalls: occurrences(JSON.stringify(httpCalls), SECRET),
      renderedCredentialRefs: [...new Set(rendered.credentialRefs)].join(','),
      consoleSecret: consoleAfterCreate.filter((entry) => entry.text.includes(SECRET)).length,
      domSecret: occurrences(domAfterCreate, SECRET),
      storageSecret: occurrences(storageAfterCreate.local, SECRET) + occurrences(storageAfterCreate.session, SECRET),
      clientRejected: clientSecret.rejected,
      clientRejectedCode: clientSecret.code,
      serverStatus: httpSecret.status,
      serverSecretInResponse: httpSecret.secretInResponse,
      attackRequestCarriedSecret: httpSecret.requestHasSecret,
      finalConsoleSecret: consoleFinal.filter((entry) => entry.text.includes(SECRET)).length,
      finalDomSecret: occurrences(domFinal, SECRET),
      finalStorageSecret: occurrences(storageFinal.local, SECRET) + occurrences(storageFinal.session, SECRET),
    }, {
      createdCredentialRef: CREDENTIAL_REF,
      createdTargetEnvironment: ENVIRONMENT,
      createdTargetKind: 'ssh',
      secretInRecordedCalls: 0,
      renderedCredentialRefs: CREDENTIAL_REF,
      consoleSecret: 0,
      domSecret: 0,
      storageSecret: 0,
      clientRejected: true,
      clientRejectedCode: 'invalid_request',
      serverStatus: 400,
      serverSecretInResponse: 0,
      attackRequestCarriedSecret: 1,
      finalConsoleSecret: 0,
      finalDomSecret: 0,
      finalStorageSecret: 0,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Node lifecycle — acceptance criteria 1, 2, 3
    // ══════════════════════════════════════════════════════════════════════════════════════════

    // ── Criterion 2: a disabled source is never auto-enabled ──
    const connectDisabled = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}/connect`, 'POST', undefined, auth);
    const disabledAfter = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}`, 'GET', undefined, auth);
    const reconnectDisabled = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}/reconnect`, 'POST', undefined, auth);
    const disabledAfterReconnect = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}`, 'GET', undefined, auth);
    record('criterion2', { connectDisabled: connectDisabled.body, disabledAfter: disabledAfter.body?.enabled, reconnectDisabled: reconnectDisabled.body, disabledAfterReconnect: disabledAfterReconnect.body?.enabled });
    check('connect and reconnect on a DISABLED source are refused with 404/source_unavailable and never flip the profile to enabled', {
      connectStatus: connectDisabled.status,
      connectCode: connectDisabled.body?.code,
      enabledAfterConnect: disabledAfter.body?.enabled,
      reconnectStatus: reconnectDisabled.status,
      reconnectCode: reconnectDisabled.body?.code,
      enabledAfterReconnect: disabledAfterReconnect.body?.enabled,
    }, {
      connectStatus: 404,
      connectCode: 'source_unavailable',
      enabledAfterConnect: false,
      reconnectStatus: 404,
      reconnectCode: 'source_unavailable',
      enabledAfterReconnect: false,
    });

    // ── Criterion 1: create/edit/reconnect/delete never change the environment identity ──
    const enabledA = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}/enabled`, 'PUT', { enabled: true }, auth);
    const envBeforeLifecycle = enabledA.body?.target?.environmentId;
    const connectedA = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}/connect`, 'POST', undefined, auth);
    const editedA = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}`, 'PATCH', { name: 'Renamed while connected', credentialRef: 'cred-task25-02' }, auth);
    const reconnectedA = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}/reconnect`, 'POST', undefined, auth);
    const afterLifecycle = await requestJson(bridgePort, `/api/v1/profiles/${profileA.profileId}`, 'GET', undefined, auth);
    record('criterion1', { envBeforeLifecycle, connectedA: connectedA.body, editedA: editedA.body, reconnectedA: reconnectedA.body, afterLifecycle: afterLifecycle.body });
    check('create/edit/reconnect preserve the OBSERVED environment UUID and the stable profile UUID across a real connect+rename+reconnect lifecycle', {
      enabledStatus: enabledA.status,
      environmentBefore: envBeforeLifecycle,
      connectedState: connectedA.body?.state,
      connectedEnvironment: connectedA.body?.environmentId,
      connectedGeneration: connectedA.body?.generation,
      editStatus: editedA.status,
      editedProfileIdUnchanged: editedA.body?.profileId === profileA.profileId,
      editedEnvironmentUnchanged: editedA.body?.target?.environmentId === envBeforeLifecycle,
      editedCredentialRef: editedA.body?.credentialRef,
      reconnectStatus: reconnectedA.status,
      reconnectEnvironment: reconnectedA.body?.environmentId,
      reconnectState: reconnectedA.body?.state,
      afterEnvironment: afterLifecycle.body?.target?.environmentId,
      identityStable: [envBeforeLifecycle, connectedA.body?.environmentId, editedA.body?.target?.environmentId, reconnectedA.body?.environmentId, afterLifecycle.body?.target?.environmentId].every((value) => value === ENVIRONMENT),
    }, {
      enabledStatus: 200,
      environmentBefore: ENVIRONMENT,
      connectedState: 'connected',
      connectedEnvironment: ENVIRONMENT,
      connectedGeneration: 1,
      editStatus: 200,
      editedProfileIdUnchanged: true,
      editedEnvironmentUnchanged: true,
      editedCredentialRef: 'cred-task25-02',
      reconnectStatus: 200,
      reconnectEnvironment: ENVIRONMENT,
      reconnectState: 'connected',
      afterEnvironment: ENVIRONMENT,
      identityStable: true,
    });

    // ── Criterion 3: deleting a connection preserves native history and owned jobs ──
    fixture.register({ kind: 'native-history-planned', path: nativeHistoryPath, teardown: 'a product delete must NOT remove this; removed with the private root' });
    fixture.register({ kind: 'owned-job-record-planned', path: ownedJobPath, teardown: 'a product delete must NOT remove this; removed with the private root' });
    await writeFile(nativeHistoryPath, `${JSON.stringify({ environmentId: ENVIRONMENT, nativeSessionId: 'native-1', bytes: 42 })}\n`, 'utf8');
    await writeFile(ownedJobPath, `${JSON.stringify({ environmentId: ENVIRONMENT, jobId: '24680', ownership: 'owned' })}\n`, 'utf8');
    const createdD = await requestJson(bridgePort, '/api/v1/profiles', 'POST', draft(ENVIRONMENT, 'cluster-d.example:22'), auth);
    await requestJson(bridgePort, `/api/v1/profiles/${createdD.body.profileId}/enabled`, 'PUT', { enabled: true }, auth);
    await requestJson(bridgePort, `/api/v1/profiles/${createdD.body.profileId}/connect`, 'POST', undefined, auth);
    const deletedD = await requestJson(bridgePort, `/api/v1/profiles/${createdD.body.profileId}`, 'DELETE', undefined, auth);
    const historyStillThere = existsSync(nativeHistoryPath);
    const ownedJobStillThere = existsSync(ownedJobPath);
    record('criterion3', { deletedD: deletedD.body, historyStillThere, ownedJobStillThere, droppedNativeHistory, cancelledOwnedJobs });
    check('deleting a connected profile closes the transport, drops only the profile record, and leaves the REAL native-history file and owned-job record on disk with ZERO cancel signals and ZERO destructive handle calls', {
      deleteStatus: deletedD.status,
      removedMatches: deletedD.body?.removed === createdD.body.profileId,
      environmentIdentityPreserved: deletedD.body?.environmentId,
      nativeHistoryPreserved: deletedD.body?.nativeHistoryPreserved,
      ownedJobsPreserved: deletedD.body?.ownedJobsPreserved,
      cancelledJobs: deletedD.body?.cancelledJobs,
      preservedHandleCount: Array.isArray(deletedD.body?.preservedHandles) ? deletedD.body.preservedHandles.length : -1,
      historyFileStillExists: historyStillThere,
      ownedJobFileStillExists: ownedJobStillThere,
      dropNativeHistoryCalls: droppedNativeHistory,
      cancelOwnedJobsCalls: cancelledOwnedJobs,
      connectClosedTransport: closeCalls.includes(createdD.body.profileId),
      listAfterDelete: (await requestJson(bridgePort, '/api/v1/profiles', 'GET', undefined, auth)).body.profiles.some((profile) => profile.profileId === createdD.body.profileId),
    }, {
      deleteStatus: 200,
      removedMatches: true,
      environmentIdentityPreserved: ENVIRONMENT,
      nativeHistoryPreserved: true,
      ownedJobsPreserved: true,
      cancelledJobs: 0,
      preservedHandleCount: 2,
      historyFileStillExists: true,
      ownedJobFileStillExists: true,
      dropNativeHistoryCalls: 0,
      cancelOwnedJobsCalls: 0,
      connectClosedTransport: true,
      listAfterDelete: false,
    });

    // ── Managed vs direct distinction at the REAL transport contract ──
    const contract = {
      sshCapabilities: transportCapabilities('ssh'),
      directCapabilities: transportCapabilities('direct'),
      sshManaged: isManagedTransport('ssh'),
      directManaged: isManagedTransport('direct'),
      localLive: transportLiveVerified('local'),
      sshLive: transportLiveVerified('ssh'),
      slurmLive: transportLiveVerified('slurm'),
      badKind: await capture(() => transportCapabilities('tcp')),
      badRole: await capture(() => assertTransportSupportsRole('slurm', 'local')),
    };
    record('transportContract', contract);
    check('the REAL transport contract marks ssh/slurm as managed and NOT live-verified in this build, keeps direct/local live, and refuses an unknown transport kind or role with unsupported', {
      sshManaged: contract.sshManaged,
      directManaged: contract.directManaged,
      sshLive: contract.sshLive,
      slurmLive: contract.slurmLive,
      localLive: contract.localLive,
      sshDirect: contract.sshCapabilities.direct,
      sshSsh: contract.sshCapabilities.ssh,
      badKindCode: contract.badKind.code,
      badKindField: contract.badKind.field,
      badRoleCode: contract.badRole.code,
      badRoleField: contract.badRole.field,
    }, {
      sshManaged: true,
      directManaged: false,
      sshLive: false,
      slurmLive: false,
      localLive: true,
      sshDirect: false,
      sshSsh: true,
      badKindCode: 'unsupported',
      badKindField: 'transport.kind',
      badRoleCode: 'unsupported',
      badRoleField: 'transport.role',
    });

    if (context.case === 'failure') {
      // ════════════════════════════════════════════════════════════════════════════════════════
      // Failure classes + the four reviewer findings (all fixed after delivery)
      // ════════════════════════════════════════════════════════════════════════════════════════

      // ── Finding #2: concurrent creates lost updates (fixed by serializing writes) ──
      const beforeBurst = (await requestJson(bridgePort, '/api/v1/profiles', 'GET', undefined, auth)).body.profiles.length;
      const burst = await Promise.all(Array.from({ length: 10 }, (_value, index) => (
        requestJson(bridgePort, '/api/v1/profiles', 'POST', draft(ENVIRONMENT, `burst-${index}.example:22`), auth)
      )));
      const afterBurstList = (await requestJson(bridgePort, '/api/v1/profiles', 'GET', undefined, auth)).body.profiles;
      const durableBurst = JSON.parse(await readFile(profilePath, 'utf8')).profiles.length;
      const burstIds = burst.map((entry) => entry.body?.profileId);
      record('concurrentCreates', { beforeBurst, afterCount: afterBurstList.length, durableCount: durableBurst, distinctIds: new Set(burstIds).size });
      check('10 concurrent profile creates lose NO acknowledged update: every response is 201, the list and the durable document both grow by exactly 10, and all 10 UUIDs are distinct', {
        acceptedStatuses: burst.filter((entry) => entry.status === 201).length,
        totalCount: afterBurstList.length,
        delta: afterBurstList.length - beforeBurst,
        durableCount: durableBurst,
        durableDelta: durableBurst - beforeBurst,
        distinctBurstIds: new Set(burstIds).size,
      }, {
        acceptedStatuses: 10,
        totalCount: beforeBurst + 10,
        delta: 10,
        durableCount: beforeBurst + 10,
        durableDelta: 10,
        distinctBurstIds: 10,
      });

      // ── Finding #3 / class stale_generation: a pending dial is registered BEFORE the await and a
      //    disconnect during the wait retires it, closing the late handle instead of resurrecting ──
      const retirePath = path.join(fixture.root, 'retire-profiles.json');
      const retireStore = createProfileStore({ profilePath: retirePath });
      const pending = [];
      const lateClose = [];
      const retireManager = createConnectionManager({
        store: retireStore,
        openTransport: async (profile) => {
          const gate = deferred();
          pending.push({ profileId: profile.profileId, gate });
          return gate.promise.then(() => ({ environmentId: resolveProfileEnvironment(profile), connectionId: 'late', async close() { lateClose.push(profile.profileId); } }));
        },
      });
      const retireCreated = await retireManager.create(draft(ENVIRONMENT, 'retire.example:22'));
      await retireManager.setEnabled(retireCreated.profileId, true);
      const retireConnect = retireManager.connect(retireCreated.profileId);
      await until(() => pending.length === 1, 'retire dial started');
      const retireDisconnect = await retireManager.disconnect(retireCreated.profileId);
      pending[0].gate.resolve();
      const retireOutcome = await capture(() => retireConnect);
      const retireStatus = await retireManager.status(retireCreated.profileId);
      record('staleGeneration', { retireDisconnect, retireOutcome, retireStatus, lateCloseCount: lateClose.length });
      check('a disconnect landing while a dial is in flight retires the pending dial: the late handle is closed instead of registered, the connect is refused with conflict/profile.dial, and no live connection survives', {
        disconnectState: retireDisconnect.state,
        connectRejected: retireOutcome.threw,
        connectCode: retireOutcome.code,
        connectField: retireOutcome.field,
        lateHandleClosed: lateClose.filter((id) => id === retireCreated.profileId).length,
        statusState: retireStatus.state,
        liveConnections: (await retireManager.inspect()).profiles.filter((entry) => entry.state === 'connected').length,
      }, {
        disconnectState: 'disconnected',
        connectRejected: true,
        connectCode: 'conflict',
        connectField: 'profile.dial',
        lateHandleClosed: 1,
        statusState: 'disconnected',
        liveConnections: 0,
      });

      // ── Class simultaneous_connect: two parallel connects of one profile share a SINGLE dial ──
      const dedupPath = path.join(fixture.root, 'dedup-profiles.json');
      const dedupStore = createProfileStore({ profilePath: dedupPath });
      let dedupCalls = 0;
      const dedupGates = [];
      const dedupManager = createConnectionManager({
        store: dedupStore,
        openTransport: async (profile) => {
          dedupCalls += 1;
          const gate = deferred();
          dedupGates.push(gate);
          return gate.promise.then(() => ({ environmentId: resolveProfileEnvironment(profile), connectionId: 'dedup', async close() {} }));
        },
      });
      const dedupCreated = await dedupManager.create(draft(ENVIRONMENT, 'dedup.example:22'));
      await dedupManager.setEnabled(dedupCreated.profileId, true);
      const firstConnect = dedupManager.connect(dedupCreated.profileId);
      const secondConnect = dedupManager.connect(dedupCreated.profileId);
      await until(() => dedupCalls === 1, 'single dedup dial');
      dedupGates[0].resolve();
      const dedupResults = await Promise.all([firstConnect, secondConnect]);
      record('simultaneousConnect', { dedupCalls, dedupResults });
      check('two SIMULTANEOUS connects of one profile share a single dial (the transport edge is opened exactly once) and both resolve to the same connected generation', {
        openTransportCalls: dedupCalls,
        firstState: dedupResults[0].state,
        secondState: dedupResults[1].state,
        generationsEqual: dedupResults[0].generation === dedupResults[1].generation,
        environment: dedupResults[0].environmentId,
      }, {
        openTransportCalls: 1,
        firstState: 'connected',
        secondState: 'connected',
        generationsEqual: true,
        environment: ENVIRONMENT,
      });

      // ── Class cross_profile_binding: a transport that returns a FOREIGN environment is refused ──
      const foreignPath = path.join(fixture.root, 'foreign-profiles.json');
      const foreignStore = createProfileStore({ profilePath: foreignPath });
      const foreignClose = [];
      const foreignManager = createConnectionManager({
        store: foreignStore,
        openTransport: async () => ({ environmentId: FOREIGN_ENVIRONMENT, connectionId: 'foreign', async close() { foreignClose.push('foreign'); } }),
      });
      const foreignCreated = await foreignManager.create(draft(ENVIRONMENT, 'foreign.example:22'));
      await foreignManager.setEnabled(foreignCreated.profileId, true);
      const foreignOutcome = await capture(() => foreignManager.connect(foreignCreated.profileId));
      const foreignStatus = await foreignManager.status(foreignCreated.profileId);

      // cross-profile TARGET binding via edit: a profile's immutable target cannot be replaced with
      // another profile's binding.
      const otherCreated = await foreignManager.create(draft(OTHER_ENVIRONMENT, 'other.example:22'));
      const retarget = await capture(() => foreignManager.update(otherCreated.profileId, { target: { kind: 'ssh', environmentId: FOREIGN_ENVIRONMENT } }));
      const otherAfter = await foreignManager.get(otherCreated.profileId);
      record('crossProfileBinding', { foreignOutcome, foreignStatus, foreignClose, retarget, otherAfter: { target: otherAfter.target } });
      check('a dial that returns a FOREIGN environment (another profile\'s target binding) is refused with conflict/profile.environment and its handle closed, and a profile target cannot be re-bound to another environment through an edit', {
        foreignRejected: foreignOutcome.threw,
        foreignCode: foreignOutcome.code,
        foreignField: foreignOutcome.field,
        foreignHandleClosed: foreignClose.length,
        foreignStatusState: foreignStatus.state,
        foreignStatusEnvironment: foreignStatus.environmentId,
        retargetRejected: retarget.threw,
        retargetCode: retarget.code,
        otherTargetAfter: otherAfter.target.environmentId,
      }, {
        foreignRejected: true,
        foreignCode: 'conflict',
        foreignField: 'profile.environment',
        foreignHandleClosed: 1,
        foreignStatusState: 'failed',
        foreignStatusEnvironment: ENVIRONMENT,
        retargetRejected: true,
        retargetCode: 'invalid_request',
        otherTargetAfter: OTHER_ENVIRONMENT,
      });

      // ── Class unsupported_transport: parser, HTTP dispatch and the default live transport ──
      const badKindParse = await capture(() => parseTransport({ kind: 'tcp', endpoint: 'builder.example:22' }));
      const badKindHttp = await requestJson(bridgePort, '/api/v1/profiles', 'POST', { ...draft(ENVIRONMENT, 'x.example:22'), transport: { kind: 'tcp', endpoint: 'x.example:22' } }, auth);
      const badEndpointHttp = await requestJson(bridgePort, '/api/v1/profiles', 'POST', { ...draft(ENVIRONMENT, 'x.example:22'), transport: { kind: 'direct', endpoint: 'wss://bridge.test/runtime?token=topsecretvalue' }, target: { kind: 'direct', environmentId: ENVIRONMENT } }, auth);
      const defaultPath = path.join(fixture.root, 'default-profiles.json');
      const defaultStore = createProfileStore({ profilePath: defaultPath });
      const defaultManager = createConnectionManager({ store: defaultStore });
      const defaultCreated = await defaultManager.create(draft(ENVIRONMENT, 'live.example:22'));
      await defaultManager.setEnabled(defaultCreated.profileId, true);
      const defaultOutcome = await capture(() => defaultManager.connect(defaultCreated.profileId));
      record('unsupportedTransport', { badKindParse, badKindHttp: { status: badKindHttp.status, body: badKindHttp.body }, badEndpointHttp: { status: badEndpointHttp.status, body: badEndpointHttp.body }, defaultOutcome });
      check('an unknown transport kind is refused at the parser and by the HTTP dispatch (400/unsupported), and a build with no live transport refuses an ssh dial with unsupported/transport.live — no silent fallback', {
        parseCode: badKindParse.code,
        parseField: badKindParse.field,
        httpStatus: badKindHttp.status,
        httpCode: badKindHttp.body?.code,
        badEndpointStatus: badEndpointHttp.status,
        defaultRejected: defaultOutcome.threw,
        defaultCode: defaultOutcome.code,
        defaultField: defaultOutcome.field,
      }, {
        parseCode: 'unsupported',
        parseField: 'transport.kind',
        httpStatus: 400,
        httpCode: 'unsupported',
        badEndpointStatus: 400,
        defaultRejected: true,
        defaultCode: 'unsupported',
        defaultField: 'transport.live',
      });

      // ── Criterion 4 / finding #4: an embedded credential in ANY locator is refused and never echoed ──
      const markerLocators = [
        ['ssh', `demo:${LOCATOR_MARKER}@builder.example:22`],
        ['ssh', `ssh://demo:${LOCATOR_MARKER}@builder.example:22`],
        ['ssh', `builder.example:22?auth=${LOCATOR_MARKER}`],
        ['slurm', `demo:${LOCATOR_MARKER}@cluster.example:22`],
        ['direct', `wss://demo:${LOCATOR_MARKER}@bridge.test/runtime`],
      ];
      const locatorRejections = [];
      for (const [kind, endpoint] of markerLocators) {
        const target = kind === 'slurm' ? { kind: 'slurm', clusterEnvironmentId: ENVIRONMENT } : { kind, environmentId: ENVIRONMENT };
        const parsed = await capture(() => parseNewConnectionProfile({ name: 'Locator', transport: { kind, endpoint }, target, role: kind === 'slurm' ? 'manager' : 'execution', credentialRef: CREDENTIAL_REF }));
        const http = await requestJson(bridgePort, '/api/v1/profiles', 'POST', { name: 'Locator', transport: { kind, endpoint }, target, role: kind === 'slurm' ? 'manager' : 'execution', credentialRef: CREDENTIAL_REF }, auth);
        locatorRejections.push({ kind, rejected: parsed.threw, code: parsed.code, httpStatus: http.status, echoed: occurrences(http.text, LOCATOR_MARKER) });
      }
      const secretHttp = await requestJson(bridgePort, '/api/v1/profiles', 'POST', { ...draft(ENVIRONMENT, 'x.example:22'), password: SECRET }, auth);
      record('locatorRejections', { locatorRejections, secretHttp: { status: secretHttp.status, code: secretHttp.body?.code, echoed: occurrences(secretHttp.text, SECRET) } });
      check('a locator that embeds a credential or an auth parameter (with no secret keyword) is rejected for EVERY transport kind and never echoed, and a secret-bearing draft is refused with 0 secret occurrences in the response', {
        rejections: locatorRejections.map((entry) => (entry.rejected && entry.httpStatus === 400 && entry.echoed === 0 ? `${entry.kind}:ok` : `${entry.kind}:${entry.rejected}:${entry.httpStatus}:${entry.echoed}`)).join(','),
        secretStatus: secretHttp.status,
        secretCode: secretHttp.body?.code,
        secretEchoed: occurrences(secretHttp.text, SECRET),
      }, {
        rejections: 'ssh:ok,ssh:ok,ssh:ok,slurm:ok,direct:ok',
        secretStatus: 400,
        secretCode: 'invalid_request',
        secretEchoed: 0,
      });

      // ── Routing edges: an unknown profile is 404 and an unsupported method is 405 ──
      const unknownGet = await requestJson(bridgePort, '/api/v1/profiles/00000000-0000-4000-8000-000000000000', 'GET', undefined, auth);
      const unknownPatch = await requestJson(bridgePort, '/api/v1/profiles/00000000-0000-4000-8000-000000000000', 'PATCH', { name: 'x' }, auth);
      const badMethod = await requestJson(bridgePort, `/api/v1/profiles/${profileB.profileId}`, 'POST', {}, auth);
      record('routingEdges', { unknownGet: unknownGet.status, unknownPatch: unknownPatch.status, badMethod: badMethod.status, badMethodBody: badMethod.body });
      check('an unknown profile is 404 on read and edit, and a disallowed method on a profile item is 405 with an explicit error', {
        unknownGetStatus: unknownGet.status,
        unknownPatchStatus: unknownPatch.status,
        badMethodStatus: badMethod.status,
        badMethodError: badMethod.body?.error,
      }, {
        unknownGetStatus: 404,
        unknownPatchStatus: 404,
        badMethodStatus: 405,
        badMethodError: 'Method not allowed.',
      });
    }

    const browserErrors = await evaluate(() => window.task25.errors());
    const pageErrors = await evaluate(() => window.__task25PageErrors ?? []);
    record('browserErrors', { api: browserErrors, page: pageErrors });
    check('the real browser entry logged no error across the whole case', {
      apiErrors: browserErrors.length,
      pageErrors: pageErrors.length,
    }, {
      apiErrors: 0,
      pageErrors: 0,
    });

    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa25-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
    }

    const heapEnd = process.memoryUsage().heapUsed;
    const heapGrowth = heapEnd - heapStart;
    record('heap', { heapStart, heapEnd, heapGrowth });
    check('the whole case stays bounded (heap growth under 128 MiB) and no owned resource leaked', {
      heapGrowthUnderBound: heapGrowth < 128 * 1024 * 1024,
      ownedPids: fixture.resources.filter((entry) => entry.pid).length,
    }, {
      heapGrowthUnderBound: true,
      ownedPids: 1,
    });

    const sourceAfter = sourceSnapshot(context.root, ownedFiles);
    check('dirty worktree production sources are unchanged by the registered case', {
      status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0,
      unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore),
    }, {
      status: true,
      unchanged: true,
    });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task25PageErrors ?? [], task25: Boolean(window.task25) })).catch((value) => ({ unavailable: String(value) }));
      await page.screenshot({ path: path.join(runDir, 'failure.png') }).catch(() => undefined);
    }
    persist();
    throw error;
  } finally {
    const closed = await fixture.close().catch((error) => ({ error: String(error) }));
    proof.cleanup = closed;
    persist();
    artifacts.push(artifact(path.join(runDir, 'proof.json'), 'registered-case-proof'), artifact(path.join(evidenceDir, 'ownedresources.json'), 'resource-ledger'), artifact(path.join(runDir, 'resources.json'), 'run-resource-ledger'));
  }

  const classMatchers = {
    cross_profile_binding: /foreign|cross-profile|target binding|re-bound/i,
    simultaneous_connect: /simultaneous|single dial|opened exactly once/i,
    stale_generation: /retires the pending dial|profile\.dial|late handle/i,
    unsupported_transport: /unsupported|transport\.live|unknown transport/i,
    concurrent_writes: /concurrent profile creates|lose no acknowledged update/i,
    secret_in_payload: /secret|credential reference|embedded credential/i,
    profile_http_wiring: /not 404|request listener serves/i,
    native_history_preserved: /native-history|owned-job|destructive handle/i,
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
    versions: {
      browser: 'owned Chromium via omowright',
      chromium: chromium.executablePath(),
      model: 'connection-execution-profiles',
      schema: 'profiles/v1',
    },
    cleanup: proof.cleanup,
    evidenceBoundary: 'The real landed bridge modules execute directly in the Node worker: a real createVisBridgeServer request listener, the real profile HTTP dispatch (bridge/bridgeHttpRoutes.js) into the real connectionManager.js and profileStore.js, a real durable profiles.json under the private root, the real strict parser / target mapping / secret guard in shared/runtime/connectionProfile.js, and the real transport contract in transportContract.js. The browser half is the real app/dev/runtime-v090/task25.ts driving the real useRuntimeProfiles.ts client/capability entry in a real headless Chromium over real cross-origin HTTP against the same bridge listener. The ONLY controlled boundaries are: the transport edge (openTransport returns a case-owned managed handle whose environment equals the profile target — NO live SSH host and NO live Slurm cluster is contacted; the default openTransport is exercised separately to prove it refuses a live transport in this build, and task 46 owns the live end-to-end check), the case-owned Vite dev server that serves the browser entry, and the real native-history / owned-job files on disk that a defective delete would remove. This module authors no PASS verdict and edits no product or test file.',
  };
}
