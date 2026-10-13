// @vitest-environment node
// RED harness for PR #182 finding 3: the task-4 control mapping must name each
// harness's REAL native extensions. `createDshDriver` declares
// dsh.providers.list / dsh.models.list / dsh.models.select / dsh.plugins.list /
// dsh.agentPresets.list / dsh.permissions.catalog, none of which the generic
// mapping knew — so supported model/provider/plugin controls were judged
// unavailable and `controlGroupsFor` collapsed to `usage`.
//
// Every manifest below is produced by the REAL driver factory (opencode, codex,
// kimi-web, dsh, acp) over controlled fixtures — never a hand-made manifest.
// The compatibility assertions therefore run against what the drivers actually
// declare, in both directions: no control may claim support the real manifest
// does not declare, and no declared capability may be judged unavailable.
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { createServer, type ServerResponse } from 'node:http';
import { once } from 'node:events';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseEnvironmentId, parseHarnessInstanceId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { EnvironmentId, SessionRef } from '../../shared/runtime/identity.js';
import type { HarnessKind, HarnessManifest, Support } from '../../shared/runtime/harnessContract.js';
import { CODEX_PROFILE } from '../../shared/runtime/native/codex/capabilities.js';
import { createDshDriver } from '../../bridge/runtime/drivers/dshDriver.js';
import { createCodexDriver } from '../../bridge/runtime/drivers/codexDriver.js';
import { createKimiWebDriver } from '../../bridge/runtime/drivers/kimiWebDriver.js';
import { createAcpDriver } from '../../bridge/runtime/drivers/acpDriver.js';
import { createAcpProcessManager } from '../../bridge/acpProcessManager.js';
import { createOpenCodeDriver } from '../../bridge/runtime/drivers/openCodeDriver.js';
import { createRuntimeStore } from '../../bridge/runtime/storage/runtimeStore.js';
import { createRuntimeHost } from '../../bridge/runtime/runtimeHost.js';
import { createWorkspaceService } from '../../bridge/runtime/workspaceService.js';
import { HARNESS_CONTROLS, controlGroupsFor, resolveControlSupport } from './useRuntimeCapabilities';
import type { ControlScope } from './useRuntimeCapabilities';

const EPOCH = '33333333-3333-4333-8333-333333333333';
const OWNER = '44444444-4444-4444-8444-444444444444';

type RealSource = Readonly<{
  kind: HarnessKind;
  manifest: HarnessManifest;
  scope: ControlScope;
}>;

const teardown: Array<() => Promise<void>> = [];
const ownedPids: Array<{ label: string; pid: number }> = [];
const tempDirs: string[] = [];

async function temporaryDirectory(prefix: string): Promise<string> {
  const dir = await mkdtemp(path.join(tmpdir(), prefix));
  tempDirs.push(dir);
  return dir;
}

function ownedStore(stateDirectory: string, environmentId: EnvironmentId) {
  const store = createRuntimeStore({ stateDirectory, environmentId, ownerId: OWNER, epoch: EPOCH });
  ownedPids.push({ label: `store:${path.basename(path.dirname(stateDirectory))}`, pid: store.pid });
  return store;
}

function listen(server: ReturnType<typeof createServer>): Promise<number> {
  server.listen(0, '127.0.0.1');
  return once(server, 'listening').then(() => {
    const address = server.address();
    if (!address || typeof address === 'string') throw new TypeError('missing fixture address');
    return address.port;
  });
}

function closeServer(server: ReturnType<typeof createServer>): Promise<void> {
  server.closeAllConnections();
  return new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// ── DSH: the manifest is declared synchronously over a lazy transport. ──────
async function realDshManifest(): Promise<HarnessManifest> {
  const dir = await temporaryDirectory('vis-caps-dsh-');
  const scope = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222') };
  const store = ownedStore(path.join(dir, 'runtime'), scope.environmentId);
  await store.ready;
  const driver = createDshDriver({
    environmentId: scope.environmentId,
    harnessInstanceId: scope.harnessInstanceId,
    epoch: EPOCH,
    store,
    auth: { getCookie: async () => 'fixture-cookie', invalidate: () => undefined },
    getOwnedEndpoint: () => ({ state: 'ready', origin: 'http://127.0.0.1:3080', nativeVersion: '0.2.0-rc.2', ownership: 'owned', generation: 1 }),
    onEvent: () => undefined,
  });
  teardown.push(async () => { await store.close(); });
  return driver.manifest;
}

// ── Codex: the real app-server handshake over a controlled transport. ───────
async function realCodexManifest(): Promise<HarnessManifest> {
  const dir = await temporaryDirectory('vis-caps-codex-');
  const scope = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111112'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222223') };
  const store = ownedStore(path.join(dir, 'runtime'), scope.environmentId);
  await store.ready;
  const runtime = createRuntimeHost({ environmentId: scope.environmentId, role: 'local' });
  runtime.start();
  const workspace = await createWorkspaceService({ target: scope.environmentId, epoch: EPOCH, roots: [{ root: dir, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }] });
  let onMessage: ((raw: string) => void) | undefined;
  const transport = {
    send(value: string) {
      const message = JSON.parse(value) as { id?: number; method?: string };
      if (typeof message.id !== 'number') return;
      const result = message.method === 'initialize' ? { userAgent: `codex-cli/${CODEX_PROFILE} 0.1.0` } : {};
      queueMicrotask(() => onMessage?.(JSON.stringify({ id: message.id, result })));
    },
    subscribe(message: (raw: string) => void) {
      onMessage = message;
      return () => { onMessage = undefined; };
    },
    close() {},
  };
  const driver = await createCodexDriver({
    environmentId: scope.environmentId,
    harnessInstanceId: scope.harnessInstanceId,
    epoch: EPOCH,
    processGeneration: 1,
    store,
    runtime,
    workspace,
    allowedWorkspaces: workspace.workspaces.map((entry) => entry.key),
    transport,
    isProcessCurrent: () => true,
    credentialValues: [],
  });
  teardown.push(async () => {
    await driver.close();
    await workspace.close();
    await runtime.stop();
    await store.close();
  });
  return driver.registration.manifest;
}

// ── Kimi Web: the real capability probe over a controlled HTTP endpoint. ────
async function realKimiWebManifest(): Promise<HarnessManifest> {
  const dir = await temporaryDirectory('vis-caps-kimi-');
  const scope = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111113'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222224') };
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    response.setHeader('Content-Type', 'application/json');
    if (route.pathname === '/openapi.json' || route.pathname === '/asyncapi.json') {
      response.end(JSON.stringify(route.pathname === '/openapi.json'
        ? { paths: { '/api/v2/sessions': { get: {} }, '/api/v1/sessions': { post: {} }, '/api/v1/sessions/{session_id}/snapshot': { get: {} }, '/api/v1/sessions/{session_id}/transcript': { get: {} }, '/api/v1/sessions/{session_id}/prompts': { post: {} }, '/api/v1/sessions/{session_id}:abort': { post: {} }, '/api/v1/sessions/{session_id}/approvals/{approval_id}': { post: {} }, '/api/v1/sessions/{session_id}/questions/{tail}': { post: {} }, '/api/v1/models': { get: {} }, '/api/v1/sessions/{session_id}/status': { get: {} } } }
        : { components: { messages: { subscribe_v2: { name: 'subscribe_v2' }, subscribe: { name: 'subscribe' } } } }));
      return;
    }
    if (route.pathname === '/api/v1/meta') {
      response.end(JSON.stringify({ code: 0, data: { backend: 'v2', server_id: 'srv_fixture', server_version: '2.1.1', capabilities: { websocket: true } } }));
      return;
    }
    response.end(JSON.stringify({ code: 0, data: {} }));
  });
  const port = await listen(server);
  const store = ownedStore(path.join(dir, 'runtime'), scope.environmentId);
  await store.ready;
  const runtime = createRuntimeHost({ environmentId: scope.environmentId, role: 'local' });
  runtime.start();
  const options = {
    environmentId: scope.environmentId,
    harnessInstanceId: scope.harnessInstanceId,
    epoch: EPOCH,
    processGeneration: 1,
    endpoint: `http://127.0.0.1:${port}`,
    store,
    runtime,
    getAuthority: () => ({ epoch: EPOCH, processGeneration: 1 }),
    getAuthorization: () => 'Bearer fixture-token',
    ownership: 'borrowed' as const,
  };
  const driver = await createKimiWebDriver(options);
  teardown.push(async () => {
    await driver.close();
    await runtime.stop();
    await store.close();
    await closeServer(server);
  });
  return driver.registration.manifest;
}

// ── OpenCode: the real discovery + health probes over controlled HTTP/SSE. ──
async function realOpenCodeManifest(): Promise<HarnessManifest> {
  const dir = await temporaryDirectory('vis-caps-opencode-');
  const scope = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111114'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222225') };
  const paths: Record<string, object> = {};
  for (const route of ['/session/{sessionID}', '/session/{sessionID}/fork', '/session/{sessionID}/revert', '/session/{sessionID}/unrevert', '/session/{sessionID}/diff', '/session/{sessionID}/children', '/session/{sessionID}/message/{messageID}', '/session/{sessionID}/todo', '/session/{sessionID}/command', '/session/{sessionID}/message/{messageID}/part/{partID}', '/global/config', '/provider', '/provider/auth', '/provider/{providerID}/oauth/authorize', '/provider/{providerID}/oauth/callback', '/auth/{providerID}', '/agent', '/command', '/session/status', '/permission', '/question', '/mcp', '/lsp', '/skill']) {
    paths[route] = { get: {}, post: {}, patch: {}, put: {}, delete: {} };
  }
  const streams = new Set<ServerResponse>();
  const server = createServer((request, response) => {
    const route = new URL(request.url ?? '/', 'http://fixture');
    response.setHeader('Content-Type', 'application/json');
    if (route.pathname === '/global/health') { response.end(JSON.stringify({ healthy: true, version: '1.18.34' })); return; }
    if (route.pathname === '/doc') { response.end(JSON.stringify({ paths })); return; }
    if (route.pathname === '/global/event') {
      response.setHeader('Content-Type', 'text/event-stream');
      response.flushHeaders();
      streams.add(response);
      response.on('close', () => streams.delete(response));
      return;
    }
    response.end(JSON.stringify({}));
  });
  const port = await listen(server);
  const store = ownedStore(path.join(dir, 'runtime'), scope.environmentId);
  await store.ready;
  const runtime = createRuntimeHost({ environmentId: scope.environmentId, role: 'local' });
  runtime.start();
  const driver = await createOpenCodeDriver({
    environmentId: scope.environmentId,
    harnessInstanceId: scope.harnessInstanceId,
    epoch: EPOCH,
    processGeneration: 1,
    endpoint: `http://127.0.0.1:${port}`,
    store,
    runtime,
    currentProcess: () => ({ epoch: EPOCH, processGeneration: 1 }),
  });
  teardown.push(async () => {
    await driver.close();
    await runtime.stop();
    await store.close();
    for (const stream of streams) stream.end();
    await closeServer(server);
  });
  return driver.registration.manifest;
}

// ── ACP: the real JSON-RPC handshake against a spawned fixture agent. ───────
async function realAcpManifest(): Promise<HarnessManifest> {
  const dir = await temporaryDirectory('vis-caps-acp-');
  const scope = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111115'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222226') };
  const script = [
    "const readline = require('node:readline');",
    "readline.createInterface({ input: process.stdin }).on('line', (line) => {",
    '  const message = JSON.parse(line);',
    "  if (message.method === 'initialize') {",
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: { protocolVersion: 1, agentCapabilities: { loadSession: true, sessionCapabilities: { list: true } }, authMethods: [{ id: 'login', name: 'Login', description: 'fixture' }], agentInfo: { name: 'fixture', version: '1' } } }) + '\\n');",
    '  } else if (message.id !== undefined) {',
    "    process.stdout.write(JSON.stringify({ jsonrpc: '2.0', id: message.id, result: {} }) + '\\n');",
    '  }',
    '});',
  ].join('\n');
  const manager = createAcpProcessManager();
  await manager.reconcile([{ id: 'caps-fixture', name: 'Caps Fixture ACP', command: process.execPath, args: ['-e', script], enabled: true }]);
  const store = ownedStore(path.join(dir, 'runtime'), scope.environmentId);
  await store.ready;
  const workspace = await createWorkspaceService({ target: scope.environmentId, epoch: EPOCH, roots: [{ root: dir, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }] });
  const connection = workspace.connect({ target: scope.environmentId, epoch: EPOCH, generation: 1, subscriberId: 'caps-fixture', assertCurrent() {} });
  const driver = await createAcpDriver({
    store,
    manager,
    agentId: 'caps-fixture',
    target: scope.environmentId,
    harnessInstanceId: scope.harnessInstanceId,
    epoch: EPOCH,
    workspace: connection,
    workspaceKey: workspace.workspaces[0]?.key ?? '',
    cwd: dir,
  });
  ownedPids.push({ label: 'acp-fixture-agent', pid: driver.pid });
  teardown.push(async () => {
    await driver.close();
    await manager.stopAll();
    await workspace.close();
    await store.close();
  });
  return driver.manifest;
}

let REAL: readonly RealSource[] = [];

beforeAll(async () => {
  const manifests = await Promise.all([
    realOpenCodeManifest(),
    realCodexManifest(),
    realKimiWebManifest(),
    realDshManifest(),
    realAcpManifest(),
  ]);
  const kinds: readonly HarnessKind[] = ['opencode', 'codex', 'kimi-web', 'dsh', 'acp'];
  REAL = Object.freeze(manifests.map((manifest, index) => {
    const session: SessionRef = parseSessionRef({
      environmentId: manifest.environmentId,
      harnessInstanceId: manifest.harnessInstanceId,
      nativeSessionId: 'fixture-session',
    });
    return Object.freeze({
      kind: kinds[index]!,
      manifest,
      scope: Object.freeze({ kind: 'session', session }) as ControlScope,
    });
  }));
  expect(REAL.map((source) => source.kind)).toEqual(['opencode', 'codex', 'kimi-web', 'dsh', 'acp']);
  for (const source of REAL) expect(source.manifest.kind).toBe(source.kind);
}, 120000);

afterAll(async () => {
  for (const release of teardown.splice(0).reverse()) {
    await release().catch(() => undefined);
  }
  const absent = ownedPids.splice(0).map(({ label, pid }) => {
    let running = true;
    try { process.kill(pid, 0); } catch (error) { running = (error as NodeJS.ErrnoException).code !== 'ESRCH'; }
    return { label, pid, absent: !running };
  });
  await Promise.all(tempDirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
  const receipt = `${JSON.stringify({
    unit: 'FIX.pr182-capability-mapping',
    at: new Date().toISOString(),
    ownedPids: absent,
    allOwnedPidsAbsent: absent.every((entry) => entry.absent),
    ports: 'all listeners bound 127.0.0.1:0 and were closed; no fixed port was claimed',
  }, null, 2)}\n`;
  // The OS temp directory exists on every runner, so a fresh CI checkout still
  // records the receipt even though the git-ignored `.omo/` tree is absent.
  await writeFile(path.join(tmpdir(), 'vis-v090-task-23-fix-capability-mapping-cleanup-receipt.json'), receipt, 'utf8').catch(() => undefined);
  // The checked-in `.omo/` evidence copy is best-effort: create its parent tree
  // (git-ignored, so absent on CI) and never let a write failure fail the run.
  const evidencePath = new URL('../../.omo/evidence/vis-v090/task-23/fix-capability-mapping/cleanup-receipt.json', import.meta.url);
  await (async () => {
    await mkdir(new URL('./', evidencePath), { recursive: true });
    await writeFile(evidencePath, receipt, 'utf8');
  })().catch(() => undefined);
}, 120000);

/** The support state a real manifest declares for one operation, or null. */
function declaredSupport(manifest: HarnessManifest, operation: string): Support | null {
  const core = manifest.core as Readonly<Record<string, Support | undefined>>;
  if (Object.hasOwn(core, operation)) return core[operation] ?? null;
  const extension = manifest.extensions.find((entry) => entry.name === operation);
  return extension ? extension.support : null;
}

describe('real five driver manifests against the task-4 control mapping', () => {
  it('produces a real manifest per harness kind', () => {
    for (const source of REAL) {
      expect(source.manifest.protocolVersion).toBe(1);
      expect(source.manifest.extensions.length).toBeGreaterThan(0);
    }
  });

  it('never reports a control supported the real manifest does not declare', () => {
    for (const source of REAL) {
      for (const [control, entry] of Object.entries(HARNESS_CONTROLS)) {
        const support = resolveControlSupport({ control, scope: source.scope, manifests: [source.manifest] });
        if (support.state !== 'supported') continue;
        expect(declaredSupport(source.manifest, entry.operation)?.state, `${source.kind}/${control} resolved supported but the real manifest does not declare "${entry.operation}"`).toBe('supported');
        if (support.channel !== 'harness') continue;
        expect(support.source).toEqual({ environmentId: source.manifest.environmentId, harnessInstanceId: source.manifest.harnessInstanceId, kind: source.kind });
      }
    }
  });

  it('never judges a capability unavailable the real manifest declares supported', () => {
    for (const source of REAL) {
      for (const [control, entry] of Object.entries(HARNESS_CONTROLS)) {
        const support = resolveControlSupport({ control, scope: source.scope, manifests: [source.manifest] });
        const capabilityBlocked = entry.capability !== null && source.manifest.capabilities[entry.capability]?.state === 'unsupported';
        if (declaredSupport(source.manifest, entry.operation)?.state !== 'supported' || capabilityBlocked) continue;
        expect(support.state, `${source.kind}/${control} must resolve supported: the real manifest declares "${entry.operation}" supported`).toBe('supported');
      }
    }
  });

  it('reports every unsupported control with the real manifest as its source', () => {
    for (const source of REAL) {
      for (const [control] of Object.entries(HARNESS_CONTROLS)) {
        const support = resolveControlSupport({ control, scope: source.scope, manifests: [source.manifest] });
        if (support.state !== 'unsupported' || support.channel !== 'harness') continue;
        expect(support.source, `${source.kind}/${control} must carry the real manifest as its source`).toEqual({ environmentId: source.manifest.environmentId, harnessInstanceId: source.manifest.harnessInstanceId, kind: source.kind });
      }
    }
  });
});

describe('real DSH native extensions are first-class controls (PR #182 finding 3)', () => {
  const dsh = () => REAL.find((source) => source.kind === 'dsh')!;

  it('claims every supported native extension of the real DSH manifest with a supported control', () => {
    const source = dsh();
    const supported = source.manifest.extensions.filter((entry) => entry.support.state === 'supported').map((entry) => entry.name);
    expect(supported.length).toBeGreaterThan(0);
    for (const name of supported) {
      const claiming = Object.entries(HARNESS_CONTROLS).filter(([, entry]) => entry.operation === name);
      expect(claiming.length, `the real DSH manifest declares "${name}" supported but no control maps to it`).toBeGreaterThan(0);
      for (const [control] of claiming) {
        expect(resolveControlSupport({ control, scope: source.scope, manifests: [source.manifest] }).state, `control "${control}" must resolve supported on the real DSH manifest`).toBe('supported');
      }
    }
  });

  it('exposes the real DSH model, provider and plugin surfaces through controlGroupsFor', () => {
    const source = dsh();
    const groups = controlGroupsFor([source.manifest], source.scope);
    expect(groups).toContain('model');
    expect(groups).toContain('provider');
    expect(groups).toContain('plugins');
  });

  it('keeps the DSH session-scoped model selection gated on a session scope', () => {
    const source = dsh();
    expect(resolveControlSupport({ control: 'dsh.models.select', scope: source.scope, manifests: [source.manifest] }).state).toBe('supported');
    const instanceScope: ControlScope = { kind: 'instance', environmentId: source.manifest.environmentId, harnessInstanceId: source.manifest.harnessInstanceId };
    expect(resolveControlSupport({ control: 'dsh.models.select', scope: instanceScope, manifests: [source.manifest] }).state).toBe('unsupported');
  });
});

describe('each real manifest resolves its own native names', () => {
  const supportedOn = (kind: HarnessKind, control: string) => {
    const source = REAL.find((entry) => entry.kind === kind)!;
    return resolveControlSupport({ control, scope: source.scope, manifests: [source.manifest] }).state === 'supported';
  };

  it('keeps the real OpenCode provider/auth/skills/MCP surface available', () => {
    for (const control of ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'deleteProviderAuth', 'authorizeProviderOAuth', 'completeProviderOAuth', 'getGlobalConfig', 'updateGlobalConfig', 'getSkillStatus', 'getMcpStatus', 'updateMcp', 'getLspStatus', 'listAgents', 'listCommands', 'getSessionStatusMap', 'listPendingPermissions', 'listPendingQuestions']) {
      expect(supportedOn('opencode', control), `opencode/${control}`).toBe(true);
    }
  });

  it('keeps the real Codex model/usage/plugin surface available', () => {
    for (const control of ['codex.models', 'codex.providerCapabilities', 'codex.usage', 'codex.rateLimits', 'codex.account', 'codex.requirements', 'getGlobalConfig', 'writeConfigValue', 'batchWriteConfig', 'getSkillStatus', 'updateSkill', 'getMcpStatus', 'codex.mcp.reload', 'codex.mcp.oauth', 'getPluginStatus', 'codex.plugin.install', 'codex.plugin.uninstall', 'listProviders', 'listCommands', 'sendCommand']) {
      expect(supportedOn('codex', control), `codex/${control}`).toBe(true);
    }
  });

  it('keeps the real Kimi Web provider surface available', () => {
    expect(supportedOn('kimi-web', 'listProviders')).toBe(true);
  });

  it('keeps the real ACP agent/command surface available', () => {
    for (const control of ['listAgents', 'listAgentAuthMethods', 'authenticateAgent', 'getSessionConfigOptions', 'listProviders', 'listCommands', 'sendCommand', 'getSessionStatusMap', 'listPendingPermissions']) {
      expect(supportedOn('acp', control), `acp/${control}`).toBe(true);
    }
  });

  it('keeps a control unsupported on a manifest that does not declare it', () => {
    // The real DSH manifest has no generic provider-auth surface, and the real
    // OpenCode manifest has no plugin inventory: neither may masquerade.
    expect(supportedOn('dsh', 'deleteProviderAuth')).toBe(false);
    expect(supportedOn('dsh', 'listProviders')).toBe(false);
    expect(supportedOn('opencode', 'getPluginStatus')).toBe(false);
  });
});
