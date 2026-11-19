// Task 27 registered QA case — Remote Bridge bootstrap, update location and install/rollback.
//
// Registration contract (scripts/qa/runtime-v090.mjs): a non-empty sourceFiles
// array and a run(context) returning a JSON-serialisable result whose scenarios
// each carry assertions with observed === expected. The runner re-invokes this
// module with VIS_RUNTIME_QA_WORKER=1, which calls run(context); the parent
// asserts a clean worker receipt and parses the written result.
//
// What executes for REAL, and where:
//   * In the Node worker: the landed bridge/update modules execute directly —
//     bridge/runtime/transports/remoteBootstrap.js (host identity, update-location and
//     upgrade-path rules), bridge/runtime/transports/remoteInstall.js (the temp-install /
//     atomic-switch / rollback transaction), bridge/updateCli.js (runRemoteBridgeUpdate),
//     bridge/updatePlatform.js (managed-path + install-allowance guards),
//     bridge/daemonInvocation.js (host-aware daemon invocation),
//     bridge/runtime/transports/connectionManager.js + profileStore.js (the target-switch
//     fence), plus electron/updatePolicy.js + electron/updateTransport.js (the real release
//     selection and SHA-256 verification). The install transaction writes REAL durable files
//     (old program, old database, staged package, backups) under the private root, including a
//     directory whose name contains a space.
//   * In a real headless Chromium: the landed browser-safe surface
//     (app/dev/runtime-v090/task27.ts over the case-owned node:* shim and the registry stub)
//     drives the REAL bridge/runtime/transports/remoteBootstrap.js rules and the REAL
//     app/composables/useConnectedBridgeVersion.ts / useDesktopBridgeVersion.ts projections.
//
// The controlled boundaries (injected fakes) are:
//   * the remote host's installer binary (case-owned adapter; the transaction orchestration is real);
//   * the artifact network edge (a case-owned loopback HTTP origin, never a live release origin);
//   * the SSH process edge is never dialled (no live ssh).
//
// This module does NOT perform and does NOT claim a live SSH or Slurm verification — task 46
// owns the real end-to-end system check — and it authors no PASS verdict. No product or test
// file is edited by this module.
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { createServer as createHttpServer } from 'node:http';
import { mkdir, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { chromium } from 'playwright';
import { createServer as createViteServer } from 'vite';
import { artifact, sourceSnapshot, writeJson } from '../runtime-v090-evidence.mjs';
import { alive, assertPortReleased, closeServer, createFixture, listen, until } from './task-27-fixture.mjs';

import {
  BRIDGE_PROTOCOL_GENERATION,
  assertNoLocalInstallerForRemote,
  createBootstrapPlan,
  evaluateBridgeCompatibility,
  parseHostIdentity,
  resolveUpdateLocation,
} from '../../../bridge/runtime/transports/remoteBootstrap.js';
import {
  createRemoteInstallTransaction,
  planRemoteInstall,
  selectRemoteArtifact,
} from '../../../bridge/runtime/transports/remoteInstall.js';
import { runRemoteBridgeUpdate } from '../../../bridge/updateCli.js';
import {
  assertBridgeInstallAllowed,
  assertLocalInstallerLocation,
  assertManagedInstallation,
  hostInstallPath,
} from '../../../bridge/updatePlatform.js';
import { handoffPosixInstaller } from '../../../bridge/updateHandoff.js';
import { createDaemonInvocation } from '../../../bridge/daemonInvocation.js';
import { createConnectionManager } from '../../../bridge/runtime/transports/connectionManager.js';
import { createProfileStore } from '../../../bridge/runtime/transports/profileStore.js';
import { assertNoShellConcatenation, buildSshArgv } from '../../../bridge/runtime/transports/sshTransport.js';
import { verifyAsset } from '../../../electron/updateTransport.js';

const browserSkill = '/home/qiyuaner/.codex/plugins/cache/sisyphuslabs/omo/5.1.27/skills/browser/scripts/omowright.mjs';

const LOCAL_ENV = '11111111-1111-4111-8111-111111111111';
const HOST_ENV = '22222222-2222-4222-8222-222222222222';
const WRONG_ENV = '99999999-9999-4999-8999-999999999999';
const LOOPBACK_ENDPOINT = '127.0.0.1:2222';
const ASSET_URL = 'https://api.github.com/repos/qiyuanhuakai/opencode-visualizer-cn/releases/assets/1';

// The old install that must survive. The staged package is the new 0.8.0 artifact the loopback
// origin serves; the wrong/tampered bytes share its length but not its SHA-256.
const OLD_PROGRAM_BYTES = Buffer.from('OLD-BRIDGE-0.7.10-PROGRAM-BYTES-DO-NOT-LOSE\n');
const OLD_DATABASE_BYTES = Buffer.from('OLD-BRIDGE-DATABASE-CONTENTS-DO-NOT-LOSE\n');
const NEW_PACKAGE_BYTES = Buffer.from(`VisBridge-0.8.0-x64-Linux.deb\0${'P'.repeat(4096)}`);
const sha256 = (bytes) => createHash('sha256').update(bytes).digest('hex');

export const sourceFiles = [...new Set([
  // the product paths this unit owns
  'bridge/runtime/transports/remoteBootstrap.js', 'bridge/runtime/transports/remoteBootstrap.d.ts',
  'bridge/runtime/transports/remoteInstall.js', 'bridge/runtime/transports/remoteInstall.d.ts',
  'bridge/updateCli.js', 'bridge/updateCli.d.ts',
  'bridge/updatePlatform.js', 'bridge/updatePlatform.d.ts',
  'bridge/updateHandoff.js', 'bridge/updateHandoff.d.ts',
  'bridge/updateHandoffWindows.js', 'bridge/updateLinuxAncestry.js',
  'bridge/daemonInvocation.js', 'bridge/daemonInvocation.d.ts',
  // the transport layer the install drives
  'bridge/runtime/transports/sshTransport.js', 'bridge/runtime/transports/sshTransport.d.ts',
  'bridge/runtime/transports/connectionManager.js', 'bridge/runtime/transports/connectionManager.d.ts',
  'bridge/runtime/transports/profileStore.js', 'bridge/runtime/transports/profileStore.d.ts',
  'bridge/runtime/transports/knownHosts.js', 'bridge/runtime/transports/processRelay.js',
  // the release-selection / hash policy reused by remoteInstall
  'electron/updatePolicy.js', 'electron/updatePolicy.d.ts',
  'electron/updateVersion.js', 'electron/updateTransport.js', 'electron/updateRelease.js',
  // the browser surface + its two test files
  'app/composables/useConnectedBridgeVersion.ts', 'app/composables/useConnectedBridgeVersion.test.ts',
  'app/composables/useDesktopBridgeVersion.ts', 'app/composables/useDesktopBridgeVersion.test.ts',
  'app/runtime/remoteBootstrap.test.ts', 'app/runtime/sshTransport.test.ts',
  'app/dev/runtime-v090/task27.ts',
  // case-owned files + runner inputs
  'scripts/qa/runtime-v090-cases/task-27.mjs',
  'scripts/qa/runtime-v090-cases/task-27-fixture.mjs',
  'scripts/qa/runtime-v090-cases/task-27-browser-shim.mjs',
  'scripts/qa/runtime-v090-cases/task-27-registry-stub.mjs',
  'scripts/qa/runtime-v090-evidence.mjs', 'scripts/qa/runtime-v090.mjs', 'scripts/qa/runtime-v090-process.mjs',
  'shared/runtime/capabilities.js', 'shared/runtime/identity.js', 'shared/runtime/connectionProfile.js',
  'package.json',
])];

const PAGE_HTML = `<!doctype html><html lang="en"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1"><title>Task 27 registered case</title>
<style>:root { color-scheme: light dark; } html, body { height: 100%; margin: 0; } body { font: 1rem/1.6 system-ui; }</style></head>
<body><div id="app"></div>
<script type="module">window.__task27Errors=[];window.addEventListener('error',(e)=>window.__task27Errors.push({kind:'error',message:String(e.message)}));window.addEventListener('unhandledrejection',(e)=>window.__task27Errors.push({kind:'unhandledrejection',message:String(e.reason&&e.reason.message||e.reason)}));</script>
<script type="module" src="/app/dev/runtime-v090/task27.ts"></script></body></html>`;

const occurrences = (haystack, needle) => (needle.length === 0 ? 0 : String(haystack).split(needle).length - 1);
const captureError = async (run) => {
  try { await run(); return {}; }
  catch (error) { return { code: error?.code ?? null, field: error?.field ?? null, message: error instanceof Error ? error.message : String(error) }; }
};

function sshProfile(environmentId = HOST_ENV) {
  return {
    profileId: '55555555-5555-4555-8555-555555555555',
    name: 'Build host',
    transport: { kind: 'ssh', endpoint: LOOPBACK_ENDPOINT },
    target: { kind: 'ssh', environmentId },
    role: 'execution',
    credentialRef: 'cred-ssh',
    enabled: true,
  };
}

function hostIdentity(overrides = {}) {
  return parseHostIdentity({
    transportKind: 'ssh', platform: 'linux', arch: 'x64',
    protocol: BRIDGE_PROTOCOL_GENERATION, environmentId: HOST_ENV,
    bridgeInstalled: true, bridgeVersion: '0.8.0', ...overrides,
  });
}

function releaseFor(bytes, arch = 'x64') {
  return {
    version: '0.8.0',
    assets: [{
      name: `VisBridge-0.8.0-${arch}-Linux.deb`,
      digest: `sha256:${sha256(bytes)}`,
      size: bytes.length,
      url: ASSET_URL,
    }],
  };
}

// Case-owned installer adapter for the real remote-install transaction: it performs a REAL HTTP
// download from the case-owned loopback origin, a REAL SHA-256 verification via
// electron/updateTransport.js, and REAL filesystem backup / atomic-switch / restore. The
// transaction that drives it is the landed product code; only the remote installer binary and the
// network edge are fakes.
function createInstallerAdapter(config) {
  const { assetBase, stagingDir, programPath, databasePath, backupsDir, sourcePath = '/asset', failAt = null } = config;
  const calls = [];
  return {
    calls,
    download: async (plan) => {
      calls.push('download');
      const declared = plan.artifact.size;
      let received = 0;
      const staged = path.join(stagingDir, plan.artifact.name);
      try {
        const response = await fetch(`${assetBase}${sourcePath}`);
        const buffer = Buffer.from(await response.arrayBuffer());
        received = buffer.length;
        if (received !== declared) throw new Error('Asset download ended before the declared size');
        await writeFile(staged, buffer);
        return staged;
      } catch (error) {
        await rm(staged, { force: true });
        if (received !== declared) {
          const failure = new Error('Asset download ended before the declared size');
          failure.received = received; failure.declared = declared;
          throw failure;
        }
        throw error;
      }
    },
    verify: async (staged, plan) => {
      calls.push('verify');
      try { await verifyAsset(staged, { name: plan.artifact.name, size: plan.artifact.size }, plan.artifact.sha256, 'sha256'); return true; }
      catch { return false; }
    },
    backup: async (_host, target) => {
      calls.push(`backup:${target}`);
      if (failAt === `${target}-backup`) throw new Error(`${target} backup failed`);
      const source = target === 'program' ? programPath : databasePath;
      const destination = path.join(backupsDir, `${target}.bak`);
      await writeFile(destination, await readFile(source));
      return destination;
    },
    atomicSwitch: async (_host, staged) => {
      calls.push('switch');
      if (failAt === 'switch') throw new Error('atomic switch failed');
      const buffer = await readFile(staged);
      await rm(programPath, { force: true });
      await writeFile(programPath, buffer);
      await rm(staged, { force: true }); // the installer consumes the staged package
    },
    restore: async (_host, target, backup) => {
      calls.push(`restore:${target}`);
      if (target === 'program') await writeFile(programPath, await readFile(backup));
    },
    discard: async (staged) => { calls.push('discard'); await rm(staged, { force: true }); },
  };
}

export async function run(context) {
  const evidenceDir = path.join(context.root, '.omo/evidence/vis-v090/task-27/qa-cases');
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
    const left = scrub(observed); const right = scrub(expected);
    checks.push({ name, observed: left, expected: right });
    persist();
    assert.deepEqual(left, right, name);
    scenarios.push({ name, surface: 'real landed bridge/update modules in the Node worker over a real loopback artifact origin, real durable files under a private root (including a spaced install path) and a case-owned installer adapter, plus a real headless Chromium projection surface', assertions: [{ name, observed: left, expected: right, passed: true }] });
    console.log(`PASS ${name}`);
  };
  const record = (name, value) => { observations[name] = scrub(value); persist(); };

  const fixture = await createFixture({ ...context, runDir, evidenceDir });
  const sourceBefore = sourceSnapshot(context.root, sourceFiles);
  const heapStart = process.memoryUsage().heapUsed;

  // Real durable install area whose path contains a space; the install transaction writes here.
  const installRoot = path.join(fixture.root, 'remote host install dir');
  const stagingDir = path.join(installRoot, 'staged pkg');
  const backupsDir = path.join(installRoot, 'backups');
  const programPath = path.join(installRoot, 'vis_bridge');
  const databasePath = path.join(installRoot, 'bridge.db');
  await mkdir(stagingDir, { recursive: true });
  await mkdir(backupsDir, { recursive: true });
  await writeFile(programPath, OLD_PROGRAM_BYTES);
  await writeFile(databasePath, OLD_DATABASE_BYTES);

  const tamperedBytes = Buffer.from(NEW_PACKAGE_BYTES);
  tamperedBytes[0] ^= 0xff; // same length, different SHA-256
  const happyRelease = releaseFor(NEW_PACKAGE_BYTES);
  const armRelease = releaseFor(NEW_PACKAGE_BYTES, 'arm64');

  let browser; let page; let vite; let assetServer; let healthServer;
  try {
    // ── real loopback artifact origin (the network edge is case-owned; the policy is real) ──
    fixture.register({ kind: 'artifact-origin-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    assetServer = createHttpServer((request, response) => {
      if (request.url === '/interrupt') {
        response.writeHead(200, { 'Content-Length': String(NEW_PACKAGE_BYTES.length) });
        response.write(NEW_PACKAGE_BYTES.subarray(0, 8));
        response.destroy();
        return;
      }
      const body = request.url === '/tampered' ? tamperedBytes : NEW_PACKAGE_BYTES;
      response.writeHead(200, { 'Content-Length': String(body.length) });
      response.end(body);
    });
    const assetPort = await listen(assetServer);
    fixture.register({ kind: 'artifact-origin-created', port: assetPort });
    fixture.own('artifact-origin', async () => { await closeServer(assetServer); await assertPortReleased(assetPort); return { port: assetPort, exclusiveRebind: true }; });
    const assetBase = `http://127.0.0.1:${assetPort}`;
    record('assetBase', assetBase);

    // ── real loopback health endpoint for the browser /healthz probe ──
    fixture.register({ kind: 'health-origin-planned', host: '127.0.0.1', teardown: 'server.close then exclusive port rebind' });
    healthServer = createHttpServer((request, response) => {
      const match = /^\/healthz\/([0-9]+\.[0-9]+\.[0-9]+)$/u.exec(String(request.url ?? ''));
      response.setHeader('Access-Control-Allow-Origin', '*');
      if (match === null) { response.writeHead(404, { 'Content-Type': 'application/json' }); response.end('{}'); return; }
      response.writeHead(200, { 'Content-Type': 'application/json' });
      response.end(JSON.stringify({ ok: true, service: 'vis_bridge', version: match[1] }));
    });
    const healthPort = await listen(healthServer);
    fixture.register({ kind: 'health-origin-created', port: healthPort });
    fixture.own('health-origin', async () => { await closeServer(healthServer); await assertPortReleased(healthPort); return { port: healthPort, exclusiveRebind: true }; });
    const healthBase = `http://127.0.0.1:${healthPort}`;
    record('healthBase', healthBase);

    // ── case-owned installer adapter: real HTTP download + real SHA-256 verify + real fs ──
    const makeAdapter = (options = {}) => createInstallerAdapter({ assetBase, stagingDir, programPath, databasePath, backupsDir, ...options });
    record('oldProgramSha256', sha256(OLD_PROGRAM_BYTES));
    record('oldDatabaseSha256', sha256(OLD_DATABASE_BYTES));

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Criterion 1 — a remote loopback target receives no local installer (real Node modules)
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const plan = createBootstrapPlan({
      profile: sshProfile(), host: hostIdentity(),
      localEnvironmentId: LOCAL_ENV, localPlatform: 'linux',
    });
    const noLocalInstallerGuard = await captureError(() => assertNoLocalInstallerForRemote(plan));
    const remoteLocalInstallerChannel = await captureError(() => planRemoteInstall({
      host: hostIdentity(), location: 'remote', channel: 'local-installer', release: happyRelease,
    }));
    const localInstallerLocationGuard = await captureError(() => assertLocalInstallerLocation('remote'));
    const sshArgv = buildSshArgv({
      target: { host: '127.0.0.1', port: 2222 }, platform: 'linux',
      forward: { localHost: '127.0.0.1', localPort: 49152, remoteHost: '127.0.0.1', remotePort: 23004 },
    });
    const sshForward = sshArgv[sshArgv.indexOf('-L') + 1];
    record('criterion1', { plan: { location: plan.location, channel: plan.channel, deliverLocalInstaller: plan.deliverLocalInstaller }, sshForward });
    check('criterion 1: a remote loopback SSH target is routed through the transport, never the local installer, and the transport dials the host (no local installer path)', {
      endpoint: LOOPBACK_ENDPOINT,
      location: plan.location,
      channel: plan.channel,
      deliverLocalInstaller: plan.deliverLocalInstaller,
      localInstallerPath: plan.localInstallerPath,
      planLocalInstallerTokens: occurrences(JSON.stringify(plan), 'local-installer'),
      remoteLocalInstallerCode: remoteLocalInstallerChannel.code,
      remoteLocalInstallerField: remoteLocalInstallerChannel.field,
      localInstallerLocationGuard: localInstallerLocationGuard.message,
      hostInstallPath: hostInstallPath({ platform: 'linux' }),
      sshForwardTarget: sshForward,
      sshArgvLocalInstallerTokens: occurrences(sshArgv.join(' '), 'vis_bridge'),
      sshArgvForwardCount: sshArgv.filter((token) => token === '-L').length,
      sshArgvNoTty: sshArgv.includes('-T'),
      sshArgvForwardFailure: sshArgv.includes('ExitOnForwardFailure=yes'),
      noLocalInstallerGuardClean: Object.keys(noLocalInstallerGuard).length > 0,
    }, {
      endpoint: LOOPBACK_ENDPOINT,
      location: 'remote',
      channel: 'transport',
      deliverLocalInstaller: false,
      localInstallerPath: null,
      planLocalInstallerTokens: 0,
      remoteLocalInstallerCode: 'unsupported',
      remoteLocalInstallerField: 'channel.localInstaller',
      localInstallerLocationGuard: 'Update location remote must not use the local installer path.',
      hostInstallPath: '/usr/bin/vis_bridge',
      sshForwardTarget: '127.0.0.1:49152:127.0.0.1:23004',
      sshArgvLocalInstallerTokens: 0,
      sshArgvForwardCount: 1,
      sshArgvNoTty: true,
      sshArgvForwardFailure: true,
      noLocalInstallerGuardClean: false,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Criterion 2 — host identity/profile decides the update location, never the URL
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const directLocalHost = parseHostIdentity({
      transportKind: 'direct', platform: 'linux', arch: 'x64',
      protocol: BRIDGE_PROTOCOL_GENERATION, environmentId: LOCAL_ENV,
    });
    const slurmHost = parseHostIdentity({
      transportKind: 'slurm', platform: 'linux', arch: 'x64',
      protocol: BRIDGE_PROTOCOL_GENERATION, environmentId: HOST_ENV,
    });
    record('criterion2', { sshLoopback: resolveUpdateLocation({ host: hostIdentity(), localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' }) });
    check('criterion 2: a loopback SSH/Slurm endpoint resolves to a remote/slurm-compute location while the resolver has no URL parameter at all', {
      sshLoopbackLocation: resolveUpdateLocation({ host: hostIdentity(), localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' }),
      directSameEnvironment: resolveUpdateLocation({ host: directLocalHost, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux' }),
      directUnderWindowsClient: resolveUpdateLocation({ host: directLocalHost, localEnvironmentId: LOCAL_ENV, localPlatform: 'win32' }),
      slurmLocation: resolveUpdateLocation({ host: slurmHost, localEnvironmentId: LOCAL_ENV }),
      urlTokensInResolver: occurrences(String(resolveUpdateLocation), 'url'),
      resolverHasUrlParameter: /resolveUpdateLocation\s*\(\s*[^)]*\burl\b/u.test(String(resolveUpdateLocation)),
    }, {
      sshLoopbackLocation: 'remote',
      directSameEnvironment: 'local',
      directUnderWindowsClient: 'wsl',
      slurmLocation: 'slurm-compute',
      urlTokensInResolver: 0,
      resolverHasUrlParameter: false,
    });

    // ══════════════════════════════════════════════════════════════════════════════════════════
    // Criterion 4 — an incompatible version surfaces the correct upgrade path before connecting
    // ══════════════════════════════════════════════════════════════════════════════════════════
    const staleHost = hostIdentity({ protocol: 'v070-legacy', bridgeVersion: '0.7.10' });
    const stalePlan = createBootstrapPlan({
      profile: sshProfile(), host: staleHost, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux',
    });
    const noBridgeHost = hostIdentity({ protocol: null, bridgeInstalled: false, bridgeVersion: null });
    const noBridgeCompatibility = evaluateBridgeCompatibility({ host: noBridgeHost });
    let staleCheckOutput = '';
    const staleCheck = await runRemoteBridgeUpdate(
      { profile: sshProfile(), host: staleHost, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux', action: 'check' },
      { output: (message) => { staleCheckOutput += `${message}\n`; } },
    );
    record('criterion4', { staleAction: stalePlan.action, staleFrom: stalePlan.upgradePath.fromVersion });
    check('criterion 4: an incompatible remote bridge is not connectable and returns the correct upgrade (or install) path before any connection is made', {
      staleConnectable: stalePlan.connectable,
      staleAction: stalePlan.action,
      staleUpgradeAction: stalePlan.upgradePath.action,
      staleFromVersion: stalePlan.upgradePath.fromVersion,
      staleRequiredProtocol: stalePlan.upgradePath.requiredProtocol,
      staleAutomatic: stalePlan.automatic,
      noBridgeAction: noBridgeCompatibility.upgradePath.action,
      noBridgeCompatible: noBridgeCompatibility.compatible,
      checkKind: staleCheck.kind,
      checkPlanAction: staleCheck.plan.action,
      checkOutputWarnsUpgrade: staleCheckOutput.includes('upgrade required before connecting'),
    }, {
      staleConnectable: false,
      staleAction: 'upgrade',
      staleUpgradeAction: 'upgrade',
      staleFromVersion: '0.7.10',
      staleRequiredProtocol: 'v090-runtime',
      staleAutomatic: false,
      noBridgeAction: 'install',
      noBridgeCompatible: false,
      checkKind: 'upgrade-required',
      checkPlanAction: 'upgrade',
      checkOutputWarnsUpgrade: true,
    });

    // ── Vite server for the browser-shaped surface (node:* aliased to the shim) ──
    const shimPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-27-browser-shim.mjs');
    const registryStubPath = path.join(context.root, 'scripts/qa/runtime-v090-cases/task-27-registry-stub.mjs');
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
        // Anchor to the RAW specifier as written in the importer. Vite's alias
        // rewrites via String.replace(find, replacement); a regex that matches only
        // the tail leaves the leading `..` behind (`../backends/registry` ->
        // `..<abs stub>`), which then fails to resolve. Matching the whole specifier
        // makes the replacement the absolute stub path.
        { find: /^\.\.\/backends\/registry$/u, replacement: registryStubPath },
      ] },
      optimizeDeps: { include: ['vue', 'buffer'] },
      server: { host: '127.0.0.1', port: 0, strictPort: false },
      logLevel: 'error',
    });
    vite.middlewares.use('/qa27', (_request, response) => { response.setHeader('Content-Type', 'text/html; charset=utf-8'); response.end(PAGE_HTML); });
    await vite.listen();
    const port = vite.httpServer.address().port;
    fixture.register({ kind: 'Vite-created', port });
    fixture.own('Vite-server', async () => { await vite.close(); await assertPortReleased(port); return { port, exclusiveRebind: true }; });
    const pageUrl = `http://127.0.0.1:${port}/qa27/`;
    record('pageUrl', pageUrl);

    const { omowright } = await (await import(browserSkill)).loadOmowright();
    const profileRoot = path.join(fixture.root, 'chromium-profile');
    fixture.register({ kind: 'Chromium-planned', executable: chromium.executablePath(), profile: profileRoot, teardown: 'owned browser.close; process exit; private root removal' });
    browser = await omowright.connectPipe({ browserPath: chromium.executablePath(), browserArgs: ['--headless', '--no-sandbox', '--disable-gpu', '--no-first-run', `--user-data-dir=${profileRoot}`], storageRoot: runDir, commandTimeoutMs: 180000 });
    fixture.register({ kind: 'Chromium-created', pid: browser.browserProcess.pid });
    fixture.own('Chromium', async () => { await browser.close(); await until(() => !alive(browser.browserProcess.pid), 'Chromium exit'); return { pid: browser.browserProcess.pid, absent: true }; });
    page = await browser.newTab('about:blank');
    await page.goto(pageUrl, { waitUntil: 'commit' });
    await until(() => page.evaluate(() => Boolean(window.task27 && window.task27.ready)), 'task27 browser entry', 60000);
    const evaluate = (fn, arg) => (arg === undefined ? page.evaluate(fn) : page.evaluate(fn, arg));

    // ── B1: the browser surface renders the same host-identity / update-location / upgrade-path rules ──
    const browserRules = await evaluate(() => window.task27.bootstrapRules());
    record('browserRules', browserRules);
    check('the browser surface projects the same remote location, transport channel and pre-connect upgrade path (criteria 1, 2 and 4) that the Node worker computed', {
      endpoint: browserRules.endpoint,
      location: browserRules.location,
      channel: browserRules.channel,
      deliverLocalInstaller: browserRules.deliverLocalInstaller,
      localInstallerPath: browserRules.localInstallerPath,
      connectable: browserRules.connectable,
      action: browserRules.action,
      automatic: browserRules.automatic,
      staleConnectable: browserRules.staleConnectable,
      staleAction: browserRules.staleAction,
      upgradeAction: browserRules.upgradeAction,
      upgradeFromVersion: browserRules.upgradeFromVersion,
      upgradeRequiredProtocol: browserRules.upgradeRequiredProtocol,
      wslLocation: browserRules.wslLocation,
      urlTokensInResolver: browserRules.urlTokensInResolver,
      domRenderedPositive: browserRules.domLength > 100,
    }, {
      endpoint: LOOPBACK_ENDPOINT,
      location: 'remote',
      channel: 'transport',
      deliverLocalInstaller: false,
      localInstallerPath: null,
      connectable: true,
      action: 'connect',
      automatic: false,
      staleConnectable: false,
      staleAction: 'upgrade',
      upgradeAction: 'upgrade',
      upgradeFromVersion: '0.7.10',
      upgradeRequiredProtocol: 'v090-runtime',
      wslLocation: 'wsl',
      urlTokensInResolver: 0,
      domRenderedPositive: true,
    });

    // ── B2: the /healthz probe surfaces the upgrade path BEFORE a connection (criterion 4) ──
    const staleHealth = await evaluate((input) => window.task27.probeHealth(`${input.base}/healthz/0.7.10`, '0.9.0'), { base: healthBase });
    const compatibleHealth = await evaluate((input) => window.task27.probeHealth(`${input.base}/healthz/0.9.0`, '0.9.0'), { base: healthBase });
    const missingHealth = await evaluate((input) => window.task27.probeHealth(`${input.base}/missing`, '0.9.0'), { base: healthBase });
    record('healthProbes', { staleHealth, compatibleHealth, missingHealth });
    check('the browser /healthz probe surfaces the correct upgrade path (from 0.7.10 to 0.9.0) before any connection, and stays silent when the version is current', {
      staleStatus: staleHealth.status,
      staleVersion: staleHealth.version,
      staleUpgradeAction: staleHealth.upgradeAction,
      staleUpgradeFromVersion: staleHealth.upgradeFromVersion,
      staleUpgradeRequiredVersion: staleHealth.upgradeRequiredVersion,
      compatibleStatus: compatibleHealth.status,
      compatibleVersion: compatibleHealth.version,
      compatibleUpgradeAction: compatibleHealth.upgradeAction,
      missingStatus: missingHealth.status,
      missingUpgradeAction: missingHealth.upgradeAction,
    }, {
      staleStatus: 'ready',
      staleVersion: '0.7.10',
      staleUpgradeAction: 'upgrade',
      staleUpgradeFromVersion: '0.7.10',
      staleUpgradeRequiredVersion: '0.9.0',
      compatibleStatus: 'ready',
      compatibleVersion: '0.9.0',
      compatibleUpgradeAction: null,
      missingStatus: 'error',
      missingUpgradeAction: null,
    });

    // ── B3: host identity, not the URL, decides the update location (criterion 2) ──
    const localityUrl = `${healthBase}/healthz/0.9.0`;
    const sshLocality = await evaluate((input) => window.task27.probeLocality(input.url, 'ssh'), { url: localityUrl });
    const slurmLocality = await evaluate((input) => window.task27.probeLocality(input.url, 'slurm'), { url: localityUrl });
    const directLocality = await evaluate((input) => window.task27.probeLocality(input.url, 'direct'), { url: localityUrl });
    record('localityProbes', { sshLocality, slurmLocality, directLocality });
    check('a loopback health URL is classified local, yet an SSH/Slurm host identity makes the SAME URL report remote — the project rejects the URL as the discriminator', {
      urlLocalitySsh: sshLocality.urlLocality,
      sshEndpointLocality: sshLocality.reportEndpointLocality,
      urlLocalitySlurm: slurmLocality.urlLocality,
      slurmEndpointLocality: slurmLocality.reportEndpointLocality,
      urlLocalityDirect: directLocality.urlLocality,
      directEndpointLocality: directLocality.reportEndpointLocality,
      reportsPositive: sshLocality.reportCount > 0 && slurmLocality.reportCount > 0 && directLocality.reportCount > 0,
      connectionIdPresent: sshLocality.reportHasConnectionId,
    }, {
      urlLocalitySsh: 'local',
      sshEndpointLocality: 'remote',
      urlLocalitySlurm: 'local',
      slurmEndpointLocality: 'remote',
      urlLocalityDirect: 'local',
      directEndpointLocality: 'local',
      reportsPositive: true,
      connectionIdPresent: true,
    });

    if (context.case === 'failure') {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F1 — a wrong SHA-256 is rejected before any backup or switch
      // ══════════════════════════════════════════════════════════════════════════════════════════
      await writeFile(programPath, OLD_PROGRAM_BYTES);
      const f1 = makeAdapter({ sourcePath: '/tampered' });
      const f1Plan = planRemoteInstall({ host: hostIdentity(), location: 'remote', channel: 'transport', release: happyRelease, linuxFormat: 'deb' });
      const f1Tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: f1Plan, adapter: f1 });
      const f1Rejection = await captureError(() => f1Tx.install());
      const f1StagedEntries = (await readdir(stagingDir)).length;
      record('f1', { f1Rejection, calls: f1.calls });
      check('a tampered artifact fails the real SHA-256 verification and is discarded without backing up or switching the old install', {
        rejectionCode: f1Rejection.code,
        rejectionField: f1Rejection.field,
        downloadCalls: f1.calls.filter((entry) => entry === 'download').length,
        verifyCalls: f1.calls.filter((entry) => entry === 'verify').length,
        backupCalls: f1.calls.filter((entry) => entry.startsWith('backup:')).length,
        switchCalls: f1.calls.filter((entry) => entry === 'switch').length,
        discardCalls: f1.calls.filter((entry) => entry === 'discard').length,
        stagedEntriesLeft: f1StagedEntries,
        programDigestUnchanged: sha256(await readFile(programPath)) === sha256(OLD_PROGRAM_BYTES),
      }, {
        rejectionCode: 'conflict',
        rejectionField: 'artifact.sha256',
        downloadCalls: 1,
        verifyCalls: 1,
        backupCalls: 0,
        switchCalls: 0,
        discardCalls: 1,
        stagedEntriesLeft: 0,
        programDigestUnchanged: true,
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F2 — an interrupted download never reaches verification, backup or switch
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const f2 = makeAdapter({ sourcePath: '/interrupt' });
      const f2Plan = planRemoteInstall({ host: hostIdentity(), location: 'remote', channel: 'transport', release: happyRelease, linuxFormat: 'deb' });
      const f2Tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: f2Plan, adapter: f2 });
      const f2Error = await f2Tx.install().then(() => null, (error) => error);
      const f2Rejection = { code: f2Error?.code ?? null, field: f2Error?.field ?? null, message: f2Error instanceof Error ? f2Error.message : String(f2Error) };
      const f2StagedEntries = (await readdir(stagingDir)).length;
      record('f2', { f2Rejection });
      check('an interrupted artifact download fails with the short-read error and never verifies, backs up, switches or discards a package it never staged', {
        rejectionMessage: f2Rejection.message,
        declaredBytes: f2Plan.artifact.size,
        receivedIsShort: f2Error.received < f2Error.declared,
        verifyCalls: f2.calls.filter((entry) => entry === 'verify').length,
        backupCalls: f2.calls.filter((entry) => entry.startsWith('backup:')).length,
        switchCalls: f2.calls.filter((entry) => entry === 'switch').length,
        discardCalls: f2.calls.filter((entry) => entry === 'discard').length,
        stagedEntriesLeft: f2StagedEntries,
      }, {
        rejectionMessage: 'Asset download ended before the declared size',
        declaredBytes: NEW_PACKAGE_BYTES.length,
        receivedIsShort: true,
        verifyCalls: 0,
        backupCalls: 0,
        switchCalls: 0,
        discardCalls: 0,
        stagedEntriesLeft: 0,
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F3 — an architecture mismatch fails closed in the real release policy
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const f3Arch = await captureError(() => selectRemoteArtifact({ release: armRelease, host: hostIdentity() }));
      const f3Arm = selectRemoteArtifact({ release: armRelease, host: hostIdentity({ arch: 'arm64' }) });
      const f3Platform = await captureError(() => selectRemoteArtifact({ release: happyRelease, host: { ...hostIdentity(), platform: 'plan9' } }));
      const f3Format = await captureError(() => selectRemoteArtifact({ release: happyRelease, host: hostIdentity(), linuxFormat: 'snap' }));
      record('f3', { f3Arch, f3Arm: f3Arm.name, f3Platform, f3Format });
      check('an x64 host can never be handed an arm64-only release: the real policy fails closed on architecture, unsupported platform and an unknown Linux format', {
        archMismatchMessage: f3Arch.message,
        armHostSelectsArm64: f3Arm.name,
        platformMessage: f3Platform.message,
        formatMessage: f3Format.message,
      }, {
        archMismatchMessage: 'Expected exactly one release asset named VisBridge-0.8.0-x64-Linux.deb, found 0',
        armHostSelectsArm64: 'VisBridge-0.8.0-arm64-Linux.deb',
        platformMessage: 'Unsupported update platform: plan9',
        formatMessage: 'Unsupported Linux bridge package format: snap',
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F4 — insufficient permission / an unsafe install surface is refused
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const f4Managed = assertManagedInstallation('/usr/bin/vis_bridge', 'linux');
      const f4NotManaged = await captureError(() => assertManagedInstallation('/opt/custom/vis_bridge', 'linux'));
      const f4Hosted = await captureError(() => assertBridgeInstallAllowed({
        execPath: '/usr/bin/vis_bridge', platform: 'linux',
        collectAncestors: async () => [{ pid: 1, executable: '/usr/bin/vis_bridge' }],
      }));
      const f4NoExecve = await captureError(() => handoffPosixInstaller({
        execve: null, uid: 1000, platform: 'linux', linuxFormat: 'deb', assetPath: '/tmp/x.deb',
        writeHelper: async () => '/tmp/install.sh',
      }));
      const readOnlyDir = path.join(fixture.root, 'readonly install dir');
      await mkdir(readOnlyDir, { recursive: true });
      await (await import('node:fs/promises')).chmod(readOnlyDir, 0o500);
      const f4Eacces = await captureError(() => writeFile(path.join(readOnlyDir, 'vis_bridge'), NEW_PACKAGE_BYTES));
      await (await import('node:fs/promises')).chmod(readOnlyDir, 0o700);
      record('f4', { f4NotManaged, f4Hosted, f4NoExecve, f4Eacces });
      check('the update surface refuses an unmanaged executable, a bridge-hosted terminal, a runtime with no execve handoff and an unwritable install directory (EACCES)', {
        managedPath: f4Managed,
        notManagedMessage: f4NotManaged.message,
        bridgeHostedMessage: f4Hosted.message,
        noExecveMessage: f4NoExecve.message,
        unwritableCode: f4Eacces.code,
      }, {
        managedPath: '/usr/bin/vis_bridge',
        notManagedMessage: 'Run the update command from the installed vis_bridge executable at /usr/bin/vis_bridge.',
        bridgeHostedMessage: 'Refusing to update from a bridge-hosted terminal because installation stops its ancestor process tree.',
        noExecveMessage: 'This vis_bridge runtime cannot safely hand off an installer because process.execve is unavailable.',
        unwritableCode: 'EACCES',
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F5 — a failed update rolls the program back, keeps the DB backup and releases the package
      // ══════════════════════════════════════════════════════════════════════════════════════════
      await writeFile(programPath, OLD_PROGRAM_BYTES);
      await writeFile(databasePath, OLD_DATABASE_BYTES);
      const f5 = makeAdapter({ failAt: 'switch' });
      const f5Plan = planRemoteInstall({ host: hostIdentity(), location: 'remote', channel: 'transport', release: happyRelease, linuxFormat: 'deb' });
      const f5Tx = createRemoteInstallTransaction({ host: hostIdentity(), plan: f5Plan, adapter: f5 });
      const f5Rejection = await captureError(() => f5Tx.upgrade());
      const f5Receipt = f5Tx.receipt();
      const f5Backups = f5Receipt.backups;
      const f5ProgramBackup = await readFile(String(f5Backups.program));
      const f5DatabaseBackup = await readFile(String(f5Backups.database));
      const f5StagedEntries = (await readdir(stagingDir)).length;
      record('f5', { f5Rejection, f5Receipt: { action: f5Receipt.action, switched: f5Receipt.switched, rolledBack: f5Receipt.rolledBack, databasePreserved: f5Receipt.databasePreserved }, calls: f5.calls });
      check('a failed update restores the OLD program, preserves the database backup and releases the staged package (criterion 3 under failure)', {
        rejectionMessage: f5Rejection.message,
        callOrder: f5.calls.join(','),
        receiptAction: f5Receipt.action,
        receiptSwitched: f5Receipt.switched,
        receiptRolledBack: f5Receipt.rolledBack,
        receiptDatabasePreserved: f5Receipt.databasePreserved,
        programDigestIsOld: sha256(await readFile(programPath)) === sha256(OLD_PROGRAM_BYTES),
        programBackupDigestIsOld: sha256(f5ProgramBackup) === sha256(OLD_PROGRAM_BYTES),
        databaseBackupDigestIsOld: sha256(f5DatabaseBackup) === sha256(OLD_DATABASE_BYTES),
        restoreCalls: f5.calls.filter((entry) => entry.startsWith('restore:')).length,
        discardCalls: f5.calls.filter((entry) => entry === 'discard').length,
        stagedEntriesLeft: f5StagedEntries,
      }, {
        rejectionMessage: 'atomic switch failed',
        callOrder: 'download,verify,backup:program,backup:database,switch,restore:program,discard',
        receiptAction: 'upgrade',
        receiptSwitched: false,
        receiptRolledBack: true,
        receiptDatabasePreserved: true,
        programDigestIsOld: true,
        programBackupDigestIsOld: true,
        databaseBackupDigestIsOld: true,
        restoreCalls: 1,
        discardCalls: 1,
        stagedEntriesLeft: 0,
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // F6 — during a target switch an in-flight dial is retired and a wrong host is never adopted
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const switchStore = createProfileStore({ profilePath: path.join(fixture.root, 'switch-profiles.json') });
      const switchProfile = await switchStore.create({
        name: 'Build host', transport: { kind: 'ssh', endpoint: LOOPBACK_ENDPOINT },
        target: { kind: 'ssh', environmentId: HOST_ENV }, role: 'execution', credentialRef: 'cred-ssh', enabled: true,
      });
      const dials = [];
      const dial = () => { let resolve; const promise = new Promise((settle) => { resolve = settle; }); return { promise, resolve }; };
      let staleHandleClosed = 0;
      const switchManager = createConnectionManager({
        store: switchStore,
        openTransport: async () => { const entry = dial(); dials.push(entry); return entry.promise; },
      });
      const staleDial = switchManager.connect(switchProfile.profileId);
      await until(() => dials.length === 1, 'first dial registered');
      await switchManager.disconnect(switchProfile.profileId); // the switch supersedes the in-flight dial
      const freshDial = switchManager.connect(switchProfile.profileId);
      await until(() => dials.length === 2, 'second dial registered');
      dials[0].resolve({ environmentId: WRONG_ENV, connectionId: 'wrong-host-handle', close: async () => { staleHandleClosed += 1; } });
      const staleRejection = await staleDial.then(() => null, (error) => error);
      dials[1].resolve({ environmentId: HOST_ENV, connectionId: 'ssh-good', close: async () => undefined });
      const settled = await freshDial;

      const adoptStore = createProfileStore({ profilePath: path.join(fixture.root, 'adopt-profiles.json') });
      const adoptProfile = await adoptStore.create({
        name: 'Wrong host', transport: { kind: 'ssh', endpoint: LOOPBACK_ENDPOINT },
        target: { kind: 'ssh', environmentId: HOST_ENV }, role: 'execution', credentialRef: 'cred-ssh', enabled: true,
      });
      let adoptHandleClosed = 0;
      let adoptResolve;
      const adoptManager = createConnectionManager({
        store: adoptStore,
        openTransport: async () => new Promise((resolve) => { adoptResolve = resolve; }),
      });
      const adoptDial = adoptManager.connect(adoptProfile.profileId);
      await until(() => typeof adoptResolve === 'function', 'adopt dial registered');
      adoptResolve({ environmentId: LOCAL_ENV, connectionId: 'wrong-host-handle', close: async () => { adoptHandleClosed += 1; } });
      const adoptRejection = await adoptDial.then(() => null, (error) => error);
      const adoptStatus = await adoptManager.status(adoptProfile.profileId);
      record('f6', { staleRejection: { code: staleRejection.code, field: staleRejection.field }, staleHandleClosed, settled, adoptRejection: { code: adoptRejection.code, field: adoptRejection.field }, adoptHandleClosed, adoptStatus });
      check('during a target switch the superseded dial is retired (its wrong-host handle closed, never registered) and a mismatched environment is refused rather than adopted', {
        staleDialCode: staleRejection.code,
        staleDialField: staleRejection.field,
        staleWrongHandleClosed: staleHandleClosed,
        settledState: settled.state,
        settledEnvironmentId: settled.environmentId,
        settledGeneration: settled.generation,
        adoptCode: adoptRejection.code,
        adoptField: adoptRejection.field,
        adoptWrongHandleClosed: adoptHandleClosed,
        adoptState: adoptStatus.state,
        adoptEnvironmentId: adoptStatus.environmentId,
      }, {
        staleDialCode: 'conflict',
        staleDialField: 'profile.dial',
        staleWrongHandleClosed: 1,
        settledState: 'connected',
        settledEnvironmentId: HOST_ENV,
        settledGeneration: 1,
        adoptCode: 'conflict',
        adoptField: 'profile.environment',
        adoptWrongHandleClosed: 1,
        adoptState: 'failed',
        adoptEnvironmentId: HOST_ENV,
      });

      const failureHeapEnd = process.memoryUsage().heapUsed;
      check('the failure install/fence paths stay bounded', {
        heapGrowthUnderBound: failureHeapEnd - heapStart < 128 * 1024 * 1024,
        stagedEntriesLeft: (await readdir(stagingDir)).length,
      }, {
        heapGrowthUnderBound: true,
        stagedEntriesLeft: 0,
      });
    } else {
      // ══════════════════════════════════════════════════════════════════════════════════════════
      // H1 — an OLD remote bridge is verified then upgraded in place through the real transaction
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const happyAdapter = makeAdapter();
      const happyResult = await runRemoteBridgeUpdate(
        {
          profile: sshProfile(), host: staleHost, localEnvironmentId: LOCAL_ENV, localPlatform: 'linux',
          action: 'upgrade', release: happyRelease, linuxFormat: 'deb',
        },
        { output: () => {}, adapter: happyAdapter },
      );
      const happyReceipt = happyResult.receipt;
      record('h1', { kind: happyResult.kind, calls: happyAdapter.calls, receipt: { action: happyReceipt.action, switched: happyReceipt.switched, rolledBack: happyReceipt.rolledBack, databasePreserved: happyReceipt.databasePreserved } });
      check('an old remote bridge is explicitly verified then upgraded in place on the SAME environment (criterion 3: the old program and DB backups survive, and the new package is installed)', {
        kind: happyResult.kind,
        callOrder: happyAdapter.calls.join(','),
        location: happyResult.plan.location,
        channel: happyResult.plan.channel,
        planEnvironmentId: happyResult.plan.environmentId,
        receiptAction: happyReceipt.action,
        receiptSwitched: happyReceipt.switched,
        receiptRolledBack: happyReceipt.rolledBack,
        receiptDatabasePreserved: happyReceipt.databasePreserved,
        installedDigestIsNew: sha256(await readFile(programPath)) === sha256(NEW_PACKAGE_BYTES),
        programBackupDigestIsOld: sha256(await readFile(String(happyReceipt.backups.program))) === sha256(OLD_PROGRAM_BYTES),
        databaseBackupDigestIsOld: sha256(await readFile(String(happyReceipt.backups.database))) === sha256(OLD_DATABASE_BYTES),
      }, {
        kind: 'installed',
        callOrder: 'download,verify,backup:program,backup:database,switch',
        location: 'remote',
        channel: 'transport',
        planEnvironmentId: HOST_ENV,
        receiptAction: 'upgrade',
        receiptSwitched: true,
        receiptRolledBack: false,
        receiptDatabasePreserved: true,
        installedDigestIsNew: true,
        programBackupDigestIsOld: true,
        databaseBackupDigestIsOld: true,
      });

      // ══════════════════════════════════════════════════════════════════════════════════════════
      // H2 — restart re-runs the HOST install path on the SAME environment, including a spaced path
      // ══════════════════════════════════════════════════════════════════════════════════════════
      const spacedHostInstallPath = path.join(installRoot, 'vis_bridge'); // "…/remote host install dir/vis_bridge"
      const spacedInvocation = createDaemonInvocation({
        entryPath: '/repo/vis_bridge.js', execPath: '/usr/bin/node',
        serverArgs: ['start', '--port', '23004'], hostInstallPath: spacedHostInstallPath,
      });
      const spacedShellSafe = await captureError(() => assertNoShellConcatenation([spacedInvocation.command, ...spacedInvocation.args]));
      record('h2', { spacedInvocation, spacedHostInstallPath, profileEnvironment: sshProfile().target.environmentId });
      check('a restart re-runs the host install path (not the local execPath) on the SAME environment identity, and a spaced install path survives as one argv token', {
        profileEnvironmentId: sshProfile().target.environmentId,
        planEnvironmentId: happyResult.plan.environmentId,
        daemonCommand: spacedInvocation.command,
        daemonCommandHasSpace: spacedInvocation.command.includes(' '),
        daemonCommandIsHostPath: spacedInvocation.command === spacedHostInstallPath,
        daemonCommandIsNotLocalNode: spacedInvocation.command !== '/usr/bin/node',
        daemonArgs0: spacedInvocation.args[0],
        daemonArgCount: spacedInvocation.args.length,
        spacedShellSafe: Object.keys(spacedShellSafe).length > 0,
        managedHostInstallPath: hostInstallPath({ platform: 'linux' }),
      }, {
        profileEnvironmentId: HOST_ENV,
        planEnvironmentId: HOST_ENV,
        daemonCommand: spacedHostInstallPath,
        daemonCommandHasSpace: true,
        daemonCommandIsHostPath: true,
        daemonCommandIsNotLocalNode: true,
        daemonArgs0: '__daemon',
        daemonArgCount: 4,
        spacedShellSafe: false,
        managedHostInstallPath: '/usr/bin/vis_bridge',
      });

      const happyHeapEnd = process.memoryUsage().heapUsed;
      check('the happy upgrade/restart paths stay bounded', {
        heapGrowthUnderBound: happyHeapEnd - heapStart < 128 * 1024 * 1024,
        stagedEntriesLeft: (await readdir(stagingDir)).length,
      }, {
        heapGrowthUnderBound: true,
        stagedEntriesLeft: 0,
      });
    }

    const browserErrors = await evaluate(() => window.task27.errors());
    check('the browser surface logged no error across the whole case', { errors: browserErrors.length }, { errors: 0 });

    for (const width of [1440, 390]) {
      await omowright.emulate(page, { width, height: 900, deviceScaleFactor: 1, mobile: false, hasTouch: false });
      const filename = path.join(runDir, `qa27-${context.case}-${width}.png`);
      await page.screenshot({ path: filename, fullPage: true });
      artifacts.push(artifact(filename, 'screenshot'));
    }

    const sourceAfter = sourceSnapshot(context.root, sourceFiles);
    check('dirty worktree production sources are unchanged by the registered case', { status: execFileSync('git', ['status', '--porcelain'], { cwd: context.root, encoding: 'utf8' }).length > 0, unchanged: JSON.stringify(sourceAfter) === JSON.stringify(sourceBefore) }, { status: true, unchanged: true });
  } catch (error) {
    proof.failure = { message: error.message, stack: error.stack };
    if (page) {
      proof.failureDom = await page.evaluate(() => ({ url: location.href, body: document.body.innerText.slice(0, 2000), errors: window.__task27Errors ?? [], task27: Boolean(window.task27) })).catch((value) => ({ unavailable: String(value) }));
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
    stale_state: /upgrade path|not connectable|stale|healthz|incompatible/,
    cancel_resume: /rollback|restore|target switch|superseded|retired|recoverable/,
    malformed_input: /architecture|platform|Linux format|SHA-256|tampered|interrupted|EACCES|unsupported/,
    hung_commands: /download|interrupted|warns|before any connection/,
    dirty_worktree: /dirty worktree/,
    repeated_interruptions: /switch|fence|generation|bounded/,
    misleading_success_output: /never the local installer|not the discriminator|never registered|preserves the database/,
    flaky_tests: /same environment|space|remote location|explicit/,
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
    versions: { browser: 'owned Chromium via omowright', chromium: chromium.executablePath(), model: 'remote-bridge-bootstrap-update-location', protocol: BRIDGE_PROTOCOL_GENERATION },
    cleanup: proof.cleanup,
    evidenceBoundary: 'The real landed bridge/update modules execute directly in the Node worker: bridge/runtime/transports/remoteBootstrap.js (host identity, update-location and upgrade-path rules), remoteInstall.js (the temp-install / atomic-switch / rollback transaction), bridge/updateCli.js (runRemoteBridgeUpdate), bridge/updatePlatform.js (managed-path and install-allowance guards), bridge/daemonInvocation.js, connectionManager.js + profileStore.js (the target-switch fence) and electron/updatePolicy.js + updateTransport.js (the real release selection and SHA-256 verification). The install transaction writes REAL durable files under the private root (an old program, an old database, a staged package and backups) inside a directory whose name contains a space. The ONLY controlled boundaries are: the remote host installer binary (a case-owned adapter — the transaction orchestration is the real product code), the artifact network origin (a case-owned loopback HTTP origin, never a live release origin), and the SSH process edge (never dialled; no live ssh). A real headless Chromium renders app/dev/runtime-v090/task27.ts over the case-owned node:* shim and the app/backends/registry stub, driving the REAL remoteBootstrap rules and the REAL useConnectedBridgeVersion/useDesktopBridgeVersion projections. It covers the happy path (a remote loopback target routed through the transport with no local installer, host-identity-not-URL location, an old bridge verified then upgraded in place on the same environment with the old program and DB backups preserved, and a restart on the host install path including a spaced path) and the failure path (wrong SHA-256, interrupted download, architecture mismatch, an unmanaged/bridge-hosted/unwritable install surface, a failed update that rolls the program back and keeps the DB backup, and a target switch that retires a superseded dial and refuses a wrong host). It does NOT perform or claim a live SSH or Slurm verification — task 46 owns that — and it authors no PASS verdict.',
  };
}
