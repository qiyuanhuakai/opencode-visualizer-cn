// @vitest-environment node
import { execFileSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { createInteractionStore } from '../../bridge/runtime/interactionStore.js';
import { createOperationJournal } from '../../bridge/runtime/operationJournal.js';
import { objectFields, textValue } from '../../shared/runtime/capabilities.js';
import { encodeWorkspaceKey, decodeWorkspaceKey } from '../../shared/runtime/identity.js';
import { METHODS } from '../../shared/runtime/capabilities.js';
import { decodeRepoKey } from '../../shared/runtime/identity.js';
import { randomUUID, createHash } from 'node:crypto';
import { request as httpRequest } from 'node:http';
import type { Duplex } from 'node:stream';
import { mkdtemp, rm, readFile, readdir, writeFile, symlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';
import { createRuntimeServices } from '../../bridge/runtime/runtimeServices.js';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { createRuntimeHost } from '../../bridge/runtime/runtimeHost.js';
import { createVisBridgeServer } from '../../vis_bridge.js';
import { createBridgeRuntime } from '../../bridge/bridgeRuntime.js';
import { createBridgeConfigStore } from '../../bridge/bridgeConfig.js';
import { encodeBinary, type Frame, type Hello, type Result, type Request } from '../../shared/runtime/protocol.js';
import type { RuntimeMethod } from '../../shared/runtime/runtimeWire.js';
import { createHarnessRegistry, unsupported } from '../../shared/runtime/harnessContract.js';
import type { InternalNativeHistoryHandle } from '../../bridge/runtime/historyService.js';
import { encodeSessionKey, parseSessionRef, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { decodeWebSocketFrames } from '../../bridge/webSocketFrames.js';

import type { RemoteServices, RemoteTarget } from '../../bridge/runtime/remoteServices.js';

import { createRuntimeClient } from './client';
import { createRuntimeConnection } from './connection';

const { openRemoteRuntime }: {
  openRemoteRuntime(options: { endpoint: string; environmentId: string }): Promise<RemoteTarget>;
} = createRequire(import.meta.url)('../../bridge/runtime/transports/remoteRuntimeClient.js');

const cleanups: (() => Promise<unknown>)[] = [];
afterEach(async () => { for (const cleanup of cleanups.splice(0).reverse()) await cleanup(); });
const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
const acp = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach: (): never => { throw new Error('Disabled ACP must not attach'); } };
const config = { version: 1 as const, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] };
function gate() { let release = () => {}; const promise = new Promise<void>(resolve => { release = resolve; }); return { release, promise }; }
async function graph(role: 'local' | 'manager' | 'execution' = 'local') {
  const root = await mkdtemp(path.join(tmpdir(), 'vis-wire-test-'));
  cleanups.push(() => rm(root, { recursive: true, force: true }));
  const services = await createRuntimeServices({ environmentId: randomUUID(), stateRoot: root, role, roots: [{ root, permissions: ['read', 'write', 'command', 'pty'] }], config, nativeSupervisor: supervisor, acpManager: acp, runtime: { mutate: operation => operation() } });
  cleanups.push(() => services.close()); await services.start(); return { services, root };
}
async function client(host: ReturnType<typeof createRuntimeHost>) {
  const server = createVisBridgeServer({ host: '127.0.0.1', path: '/codex', target: 'ws://127.0.0.1:1', runtime: { ...createBridgeRuntime({ nativeSupervisor: supervisor, acpManager: acp }), getRuntimeHost: async () => host } });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  cleanups.push(() => new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())));
  const address = server.address(); if (!address || typeof address === 'string') throw new Error('Missing socket address');
  const socket = new WebSocket(`ws://127.0.0.1:${address.port}/runtime`);
  cleanups.push(() => new Promise<void>(resolve => { if (socket.readyState === WebSocket.CLOSED) return resolve(); socket.addEventListener('close', () => resolve(), { once: true }); socket.close(); }));
  const frames: Frame[] = []; const waiters = new Set<() => void>();
  socket.addEventListener('message', message => { if (typeof message.data === 'string') { frames.push(JSON.parse(message.data)); for (const wake of waiters) wake(); } });
  function next<T extends Frame>(predicate: (frame: Frame) => frame is T): Promise<T> {
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => { waiters.delete(check); reject(new Error('Socket response timeout')); }, 5000);
      function check() { const index = frames.findIndex(predicate); if (index < 0) return; clearTimeout(timer); waiters.delete(check); resolve(frames.splice(index, 1)[0] as T); }
      waiters.add(check); check();
    });
  }
  const hello = await next((frame): frame is Hello => frame.kind === 'hello');
  let serial = 0;
  return { socket, hello, frames, terminal: (id: string) => next((frame): frame is Result => frame.kind === 'result' && frame.id === id && (!frame.ok || frame.phase !== 'durable-accepted')), url: `http://127.0.0.1:${address.port}/runtime`, async request(method: RuntimeMethod, params: object, override: { target?: string; epoch?: string; generation?: number } = {}, id = 'request-' + ++serial) {
    const current = { ...hello, ...override };
    socket.send(JSON.stringify({ version: 1, kind: 'request', target: current.target, epoch: current.epoch, generation: current.generation, id, method, params, ...(METHODS[method] === 'mutation' ? { idempotencyKey: id } : {}) }));
    return next((frame): frame is Result => frame.kind === 'result' && frame.id === id);
  } };
}
async function runtime(role: 'local' | 'manager' = 'local') {
  const context = await graph(role); const host = createRuntimeHost({ environmentId: context.services.target, role, services: context.services }); host.start(); cleanups.push(() => host.stop()); return { ...context, host, connection: await client(host) };
}
async function historyRuntime(options: { readonly openGate?: Promise<void>; readonly closeGate?: Promise<void> } = {}) {
  const { services } = await graph(); const registry = createHarnessRegistry();
  const session = parseSessionRef({ environmentId: services.target, harnessInstanceId: randomUUID(), nativeSessionId: 'controlled-history' });
  const no = unsupported('controlled fixture only'); let generation = 1, opened = 0, closed = 0;
  const producer: InternalNativeHistoryHandle = {
    capabilities: { archive: 'paged', recordStream: false, live: 'invalidate' },
    async open() { opened++; await options.openGate; return { fence: { id: randomUUID(), sourceGeneration: generation } }; },
    async page() { return { pageId: randomUUID(), items: [{ recordId: 'record', kind: 'inline', value: { nativeUnknown: 'preserved' } }], cursor: null, completeness: 'complete' }; },
    async chunk() { throw new TypeError('No stream in controlled wire fixture'); },
    async read({ after }) { return { through: after + 1, changed: true, status: 'current' }; },
    async close() { closed++; await options.closeGate; },
  };
  registry.register({ manifest: { kind: 'codex', environmentId: session.environmentId, harnessInstanceId: session.harnessInstanceId, protocolVersion: 1, core: { inspect: no, listSessionPage: no, getSession: no, readHistoryPage: { state: 'supported' }, openHistory: { state: 'supported' }, createSession: no, send: no, cancel: no, respondInteraction: no, subscribe: no, close: no }, extensions: [], capabilities: {} }, driver: { core: { openHistory: () => producer, readHistoryPage: () => ({ legacy: true }) }, native: {} } });
  await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(session), value: { session, workspaceKey: services.workspace.workspaces[0].key } }] });
  const configured = { ...services, registry, authority: () => ({ epoch: services.epoch, processGeneration: generation }) };
  const host = createRuntimeHost({ environmentId: services.target, role: 'local', services: configured }); host.start(); cleanups.push(() => host.stop());
  return { services, host, session, counts: () => ({ opened, closed }), changeGeneration: () => generation++ };
}

async function rawClient(url: string) {
  const frames: Frame[] = []; const controls: number[] = []; let buffer = Buffer.alloc(0);
  const socket = await new Promise<Duplex>((resolve, reject) => {
    const request = httpRequest(url, { headers: { Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64') } });
    request.on('error', reject); request.on('upgrade', (_response, socket, head) => {
      const consume = (bytes: Buffer) => { buffer = Buffer.concat([buffer, bytes]); const decoded = decodeWebSocketFrames(buffer); buffer = Buffer.from(decoded.remaining); for (const frame of decoded.frames) if (frame.opcode === 1) frames.push(JSON.parse(frame.payload.toString())); else controls.push(frame.opcode); };
      socket.on('data', consume); if (head.length) consume(head); resolve(socket);
    }); request.end();
  });
  const closed = new Promise<void>(resolve => socket.once('close', resolve));
  cleanups.push(async () => { if (!socket.destroyed) socket.end(encode(Buffer.alloc(0), 8)); await closed; });
  await expect.poll(() => frames.some(frame => frame.kind === 'hello')).toBe(true);
  const hello = frames.find((frame): frame is Hello => frame.kind === 'hello')!; let serial = 0;
  const encode = (payload: Uint8Array, opcode = 2, fin = true) => {
    const extended = payload.length < 126 ? 0 : payload.length <= 65535 ? 2 : 8;
    const header = Buffer.alloc(2 + extended + 4); header[0] = (fin ? 128 : 0) | opcode; header[1] = 128 | (extended === 0 ? payload.length : extended === 2 ? 126 : 127);
    if (extended === 2) header.writeUInt16BE(payload.length, 2); if (extended === 8) header.writeBigUInt64BE(BigInt(payload.length), 2);
    return Buffer.concat([header, payload]);
  };
  const send = (method: RuntimeMethod, params: object) => { const id = 'raw-' + ++serial; socket.write(encode(Buffer.from(JSON.stringify({ version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation, id, method, params })), 1)); return id; };
  const take = async (id: string) => { await expect.poll(() => frames.find(frame => frame.kind === 'result' && frame.id === id)).toBeDefined(); return frames.find((frame): frame is Result => frame.kind === 'result' && frame.id === id)!; };
  return { socket, closed, frames, controls, encode, send, take, request: async (method: RuntimeMethod, params: object) => take(send(method, params)) };
}
describe('runtime real WebSocket dispatch', () => {
  it.each([false, true])('retries an initially failed native factory with explicit grants=%s', async restricted => {
    const root = await mkdtemp(path.join(tmpdir(), 'vis-wire-startup-retry-'));
    cleanups.push(() => rm(root, { recursive: true, force: true }));
    let attempts = 0;
    const services = await createRuntimeServices({
      environmentId: randomUUID(), stateRoot: root, role: 'local', roots: [{ root, permissions: ['read'] }],
      config: { ...config, nativeServices: { ...config.nativeServices, codex: true } },
      nativeSupervisor: supervisor, acpManager: acp, runtime: { mutate: action => action() },
      factories: { codex: async context => {
        attempts++;
        if (attempts === 1) throw new Error('Controlled initial connection failure');
        const registration = unavailableRegistration({ environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'codex' }, 'starting');
        return {
          registration: {
            manifest: { ...registration.manifest, core: { ...registration.manifest.core, listSessionPage: { state: 'supported' } },
              extensions: [{ owner: registration.manifest.harnessInstanceId, name: 'listProviders', scope: 'instance', permission: 'startup:read', schemaVersion: 1, support: { state: 'supported' } }],
            },
            driver: { core: { inspect: () => ({ state: 'ready', protocolVersion: 1 }), listSessionPage: () => ({ items: [], cursor: null, completeness: 'complete' }) }, native: { listProviders: () => ({ ready: true }) } },
          },
          close: async () => {},
        };
      } },
    });
    cleanups.push(() => services.close());
    await services.start();
    const host = createRuntimeHost({ environmentId: services.target, role: 'local', services, ...(restricted ? { grants: [services.grant] } : {}) });
    host.start(); cleanups.push(() => host.stop());
    const connection = await client(host);
    const manifest = services.registry.list().find(item => item.kind === 'codex');
    if (!manifest) throw new Error('Codex registration is missing');
    expect(manifest.core.listSessionPage.state).toBe('unsupported');
    const params = { harnessInstanceId: manifest.harnessInstanceId, args: {} };
    const results = await Promise.all([connection.request('session.list', params), connection.request('session.list', params)]);
    for (const result of results) expect(result).toMatchObject({ ok: true, result: { items: [], completeness: 'complete' } });
    expect(attempts).toBe(2);
    expect(services.index.state.sources).toBe(1);
    const inspection = await connection.request('runtime.inspect', {});
    if (restricted) {
      expect(inspection).toMatchObject({ ok: true, result: { targets: [expect.objectContaining({ capabilities: expect.objectContaining({ extensions: [] }) })] } });
      expect(await connection.request('native.query', { harnessInstanceId: manifest.harnessInstanceId, operation: 'listProviders', args: {} })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    } else {
      expect(inspection).toMatchObject({ ok: true, result: { targets: [expect.objectContaining({
        capabilities: expect.objectContaining({ extensions: expect.arrayContaining([expect.objectContaining({ owner: manifest.harnessInstanceId, name: 'listProviders' })]) }),
        permissions: expect.arrayContaining(['startup:read']),
      })] } });
      expect(await connection.request('native.query', { harnessInstanceId: manifest.harnessInstanceId, operation: 'listProviders', args: {} })).toMatchObject({ ok: true, result: { ready: true } });
    }
    if (!inspection.ok) throw new Error('Runtime inspection failed');
    expect(inspection.result).not.toHaveProperty('treeBootstrap');
    const bootstrapped = await connection.request('runtime.inspect', { bootstrapTree: true });
    if (!bootstrapped.ok) throw new Error(bootstrapped.typedError.message);
    const pages = (bootstrapped.result as unknown as { treeBootstrap: import('../../shared/runtime/protocol.js').Snapshot[] }).treeBootstrap;
    expect(pages).toHaveLength(3);
    expect(pages[0].items.length).toBeGreaterThan(0);
    for (const page of pages) expect(page).toMatchObject({
      target: connection.hello.target, epoch: connection.hello.epoch, generation: connection.hello.generation,
      token: pages[0].token, revision: pages[0].revision, watermark: pages[0].watermark,
    });
    expect(await connection.request('runtime.snapshot', { collection: 'workspaces', token: pages[0].token })).toMatchObject({
      ok: true, result: { token: pages[0].token, items: pages[1].items },
    });
    const disabled = services.registry.list().find(item => item.kind === 'opencode');
    if (!disabled) throw new Error('Disabled OpenCode registration is missing');
    expect(await connection.request('session.list', { harnessInstanceId: disabled.harnessInstanceId, args: {} })).toMatchObject({ ok: false, typedError: { code: 'source_unavailable' } });
    expect(attempts).toBe(2);
  });
  it('finishes inspection while the optional snapshot stalls and releases its late token', async () => {
    const { services } = await graph();
    const resume = Promise.withResolvers<void>();
    const started = Promise.withResolvers<void>();
    const released = Promise.withResolvers<string>();
    let attempts = 0;
    const host = createRuntimeHost({
      environmentId: services.target, role: 'local',
      services: { ...services, snapshots: { async connect(binding, isCurrent) {
        const snapshots = await services.snapshots.connect(binding, isCurrent);
        return {
          ...snapshots,
          async page(input) {
            if (input?.collection === 'harnesses' && !input.token) {
              attempts++;
              started.resolve();
              await resume.promise;
            }
            return snapshots.page(input);
          },
          async release(input) {
            const result = await snapshots.release(input);
            if (result.released) released.resolve(input.token);
            return result;
          },
        };
      } } },
    });
    host.start(); cleanups.push(() => host.stop());
    const connection = await client(host);
    try {
      const pending = connection.request('runtime.inspect', { bootstrapTree: true });
      await started.promise;
      const inspection = await pending;
      if (!inspection.ok) throw new Error(inspection.typedError.message);
      expect(inspection.result).not.toHaveProperty('treeBootstrap');
      const repeated = await connection.request('runtime.inspect', { bootstrapTree: true });
      if (!repeated.ok) throw new Error(repeated.typedError.message);
      expect(repeated.result).not.toHaveProperty('treeBootstrap');
      expect(attempts).toBe(1);
      expect(await connection.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: true });
    } finally {
      resume.resolve();
    }
    await expect(released.promise).resolves.toEqual(expect.any(String));
  });
  it('frees an owned startup token before admitting paging while its optional continuation stalls', async () => {
    const { services } = await graph();
    const resume = Promise.withResolvers<void>();
    const continuation = Promise.withResolvers<string>();
    const host = createRuntimeHost({
      environmentId: services.target, role: 'local',
      services: { ...services, snapshots: { async connect(binding, isCurrent) {
        const snapshots = await services.snapshots.connect(binding, isCurrent);
        return { ...snapshots, async page(input) {
          if (input?.collection === 'workspaces' && input.token) {
            continuation.resolve(input.token);
            await resume.promise;
          }
          return snapshots.page(input);
        } };
      } } },
    });
    host.start(); cleanups.push(() => host.stop());
    const connection = await client(host);
    await connection.request('runtime.snapshot', { collection: 'workspaces' });
    await connection.request('runtime.snapshot', { collection: 'workspaces' });
    try {
      const opening = connection.request('runtime.inspect', { bootstrapTree: true });
      const token = await continuation.promise;
      const inspection = await opening;
      if (!inspection.ok) throw new Error(inspection.typedError.message);
      expect(inspection.result).not.toHaveProperty('treeBootstrap');
      expect(await connection.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: true });
      expect(await connection.request('runtime.snapshot', { collection: 'harnesses', token })).toMatchObject({
        ok: false, typedError: { code: 'replay_required' },
      });
    } finally { resume.resolve(); }
  });
  it('reads pending interaction details only for the captured authorized session and current native generation', async () => {
    const fixture = await historyRuntime();
    const connection = await client(fixture.host);
    const interactions = createInteractionStore({ store: fixture.services.store });
    const scope = { target: fixture.session.environmentId, session: fixture.session, epoch: fixture.services.epoch, processGeneration: 1 };
    await interactions.bindProcess(scope);
    const interactionId = await interactions.pending({ scope, nativeRequestId: 'approval', payload: { method: 'item/commandExecution/requestApproval', params: { command: 'pwd' } } });
    const read = await connection.request('runtime.interaction.read', { session: fixture.session, interactionId });
    expect(read).toMatchObject({ ok: true, result: { interactionId, session: fixture.session, phase: 'pending', payload: { params: { command: 'pwd' } } } });
    const other = parseSessionRef({ ...fixture.session, nativeSessionId: 'other' });
    await fixture.services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(other), value: { session: other, workspaceKey: fixture.services.workspace.workspaces[0].key } }] });
    expect(await connection.request('runtime.interaction.read', { session: other, interactionId })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    const large = await interactions.pending({ scope, nativeRequestId: 'large', payload: { text: 'x'.repeat(50000) } });
    expect(await connection.request('runtime.interaction.read', { session: fixture.session, interactionId: large })).toMatchObject({ ok: false, typedError: { code: 'source_unavailable' } });
    fixture.changeGeneration();
    expect(await connection.request('runtime.interaction.read', { session: fixture.session, interactionId })).toMatchObject({ ok: false, typedError: { code: 'reconcile_required' } });
  });

  it('executes a declared native rename through its durable journal and refuses mutation through query', async () => {
    const { services } = await graph();
    const registry = createHarnessRegistry(), harnessInstanceId = randomUUID();
    const session = parseSessionRef({ environmentId: services.target, harnessInstanceId, nativeSessionId: 'native-lifecycle' });
    const no = unsupported('fixture'), nativeNames: string[] = [];
    const scope = { target: services.target, harnessInstanceId, session, epoch: services.epoch, processGeneration: 1 };
    const journal = createOperationJournal({ store: services.acceptance.store, isProcessCurrent: () => true });
    registry.register({ manifest: { kind: 'codex', environmentId: session.environmentId, harnessInstanceId: session.harnessInstanceId, protocolVersion: 1, core: { inspect: no, listSessionPage: no, getSession: no, readHistoryPage: no, openHistory: no, createSession: no, send: no, cancel: no, respondInteraction: no, subscribe: no, close: no }, extensions: [
      { name: 'updateSession', owner: session.harnessInstanceId, scope: 'session', permission: 'native:write', schemaVersion: 1, support: { state: 'supported' } },
      { name: 'getGlobalConfig', owner: session.harnessInstanceId, scope: 'instance', permission: 'native:read', schemaVersion: 1, support: { state: 'supported' } },
    ], capabilities: {} }, driver: { core: {}, native: {
      getGlobalConfig: () => ({ theme: 'fixture' }),
      updateSession: async context => {
        const params = objectFields(context.params, ['native', 'idempotencyKey']);
        const native = objectFields(params.native, ['name']);
        const name = textValue(native.name, 'native.name');
        const accepted = await journal.accept({ scope, method: 'thread/name/set', idempotencyKey: textValue(params.idempotencyKey, 'native.idempotencyKey'), payload: { name } });
        return journal.execute(accepted.operationId, scope, () => { nativeNames.push(name); return { renamed: name }; });
      },
    } } });
    const workspace = services.workspace.workspaces[0]; if (!workspace) throw new Error('Missing workspace');
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(session), value: { session, workspaceKey: workspace.key } }] });
    const configured = { ...services, registry, authority: () => ({ epoch: services.epoch, processGeneration: 1 }), grant: { ...services.grant, permissions: [...services.grant.permissions, 'native:read', 'native:write'] } };
    const host = createRuntimeHost({ environmentId: services.target, role: 'local', services: configured }); host.start(); cleanups.push(() => host.stop());
    const peer = await client(host);
    expect(await peer.request('native.query', { harnessInstanceId, operation: 'getGlobalConfig', args: {} })).toMatchObject({ ok: true, result: { theme: 'fixture' } });
    expect(await peer.request('native.query', { harnessInstanceId, session, operation: 'updateSession', args: { native: { name: 'forged' } } })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    const accepted = await peer.request('native.extension', { harnessInstanceId, session, operation: 'updateSession', args: { native: { name: 'renamed' } } });
    expect(accepted).toMatchObject({ ok: true, phase: 'durable-accepted' });
    expect(await peer.terminal(accepted.id)).toMatchObject({ ok: true, phase: 'native-executed', result: { value: { renamed: 'renamed' } } });
    expect(nativeNames).toEqual(['renamed']);
    expect(await peer.request('native.extension', { harnessInstanceId, session, operation: 'unregistered', args: {} })).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
  });

  it.each([true, false])('shares durable Thread and Team records between windows and restores them with verified imports after restart (committed repository: %s)', async (committed) => {
    const { services, root, host, connection } = await runtime();
    execFileSync('git', ['init', root], { stdio: 'ignore' });
    execFileSync('git', ['-C', root, 'config', 'user.name', 'Evidence Test']);
    execFileSync('git', ['-C', root, 'config', 'user.email', 'evidence@localhost']);
    await writeFile(path.join(root, 'evidence.txt'), 'original evidence\n');
    execFileSync('git', ['-C', root, 'add', 'evidence.txt']);
    if (committed) execFileSync('git', ['-C', root, 'commit', '-m', 'evidence base'], { stdio: 'ignore' });
    await writeFile(path.join(root, 'evidence.txt'), 'verified evidence\n');
    const workspace = services.workspace.workspaces[0];
    if (!workspace) throw new Error('Missing granted workspace');
    await services.index.probeWorkspace(encodeWorkspaceKey(decodeWorkspaceKey(workspace.key)), { visible: true });
    const row = await services.store.get({ collection: 'workspaces', key: workspace.key });
    const repositoryRecord = objectFields(row?.value, ['kind', 'workspace', 'sources', 'orphan', 'gitKind', 'repoKey'], ['repository', 'head', 'worktrees', 'state', 'reason']);
    const repo = decodeRepoKey(textValue(repositoryRecord.repoKey, 'repoKey'));
    const manifest = services.registry.list()[0];
    if (!manifest) throw new Error('Missing registered harness');
    const session = parseSessionRef({ environmentId: services.target, harnessInstanceId: manifest.harnessInstanceId, nativeSessionId: 'durable-session' });
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(session), value: { session, workspaceKey: workspace.key, archived: false } }] });
    const second = await client(host);
    async function mutate(peer: Awaited<ReturnType<typeof client>>, domain: string, operation: string, args: object) {
      const first = await peer.request('runtime.host.mutate', { domain, operation, args }, {}, randomUUID());
      if (!first.ok || first.phase !== 'durable-accepted') throw new Error(JSON.stringify(first));
      const last = await peer.terminal(first.id);
      if (!last.ok || last.phase !== 'native-executed') throw new Error(JSON.stringify(last));
      return JSON.parse(JSON.stringify(last.result)).value;
    }
    const [left, right] = await Promise.all([mutate(connection, 'thread', 'bind', { session, repo }), mutate(second, 'thread', 'bind', { session, repo })]);
    expect(right.threadId).toBe(left.threadId);
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'snapshot', args: { threadId: left.threadId } })).toMatchObject({ ok: true, result: { thread: { threadId: left.threadId } } });
    const joinedManifest = services.registry.list()[1];
    if (!joinedManifest) throw new Error('Missing second harness');
    const joinedSession = parseSessionRef({ ...session, harnessInstanceId: joinedManifest.harnessInstanceId, nativeSessionId: 'joined-durable-session' });
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(joinedSession), value: { session: joinedSession, workspaceKey: workspace.key, archived: false } }] });
    const participant = await mutate(second, 'thread', 'join', { threadId: left.threadId, session: joinedSession, repo });
    expect(participant.session).toEqual(joinedSession);
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'resolveSession', args: { threadId: left.threadId, session: joinedSession } })).toMatchObject({ ok: true, result: { participantId: participant.participantId, session: joinedSession } });
    const otherOwnerSession = parseSessionRef({ ...joinedSession, harnessInstanceId: session.harnessInstanceId });
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(otherOwnerSession), value: { session: otherOwnerSession, workspaceKey: workspace.key, archived: false } }] });
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'resolveSession', args: { threadId: left.threadId, session: otherOwnerSession } })).toMatchObject({ ok: true, result: null });
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'snapshot', args: { threadId: left.threadId, limit: 1 } })).toMatchObject({ ok: true, result: { thread: { participants: [{ session }] }, participantsPagination: { cursor: 1, counts: { participants: 2 } } } });
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'participants', args: { threadId: left.threadId, cursor: 1, limit: 1 } })).toMatchObject({ ok: true, result: { participants: [{ session: joinedSession }], pagination: { cursor: null, counts: { participants: 2 } } } });
    const captured = await mutate(connection, 'handoff', 'captureEvidence', { threadId: left.threadId, kind: 'file', path: 'evidence.txt' });
    const diff = await mutate(connection, 'handoff', 'captureEvidence', { threadId: left.threadId, kind: 'diff', path: 'evidence.txt' });
    const evidenceRef = { hash: captured.hash, bytes: captured.bytes, target: captured.target };
    const diffRef = { hash: diff.hash, bytes: diff.bytes, target: diff.target };
    const handoffRecord = await mutate(connection, 'handoff', 'begin', {
      threadId: left.threadId, sourceParticipantId: left.activeParticipantId, targetParticipantId: participant.participantId,
      entries: [
        { class: 'artifact', text: 'Captured file', origin: captured.origin, evidence: evidenceRef },
        { class: 'diff', text: 'Captured diff', origin: diff.origin, evidence: diffRef },
      ],
    });
    const evidenceArgs = { handoffId: handoffRecord.handoffId, ref: evidenceRef, currentTarget: captured.target, offset: 0, length: 8 };
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'checkpoint', args: { handoffId: handoffRecord.handoffId } })).toMatchObject({ ok: true, result: { scope: { threadId: left.threadId, environmentId: services.target }, evidence: expect.arrayContaining([evidenceRef, diffRef]) } });
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidenceTarget', args: { handoffId: handoffRecord.handoffId } })).toMatchObject({ ok: true, result: captured.target });
    const filePage = await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: evidenceArgs });
    expect(filePage).toMatchObject({ ok: true, result: { available: true, encoding: 'base64', data: Buffer.from('verified').toString('base64'), nextOffset: 8 } });
    const diffPage = await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: { ...evidenceArgs, ref: diffRef, length: 65536 } });
    expect(diffPage).toMatchObject({ ok: true, result: { available: true, hash: diff.hash, totalBytes: diff.bytes, nextOffset: null } });
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: { ...evidenceArgs, length: 65537 } })).toMatchObject({ ok: false, typedError: { code: 'invalid_request' } });
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: { ...evidenceArgs, currentTarget: { ...captured.target, revision: '0'.repeat(40) } } })).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: { ...evidenceArgs, ref: { ...evidenceRef, hash: 'f'.repeat(64) } } })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    await writeFile(path.join(root, 'evidence.txt'), 'changed after capture\n');
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: evidenceArgs })).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    await rm(path.join(root, 'evidence.txt'));
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: evidenceArgs })).toMatchObject({ ok: true, result: { available: false, unavailableReason: 'evidence_missing' } });
    await symlink(tmpdir(), path.join(root, 'evidence.txt'), process.platform === 'win32' ? 'junction' : 'dir');
    expect(await connection.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: evidenceArgs })).toMatchObject({ ok: false });
    await rm(path.join(root, 'evidence.txt'));
    await writeFile(path.join(root, 'evidence.txt'), 'verified evidence\n');
    const team = await mutate(connection, 'collaboration', 'createTeam', { name: 'Durable team' });
    const visible = await second.request('runtime.host.read', { domain: 'collaboration', operation: 'team', args: { teamId: team.teamId } });
    expect(visible).toMatchObject({ ok: true, result: { name: 'Durable team', members: [] } });
    const lead = await mutate(connection, 'collaboration', 'addMember', { teamId: team.teamId, participantId: left.activeParticipantId, session, role: 'lead', harnessKind: manifest.kind });
    const worker = await mutate(second, 'collaboration', 'addMember', { teamId: team.teamId, participantId: participant.participantId, session: joinedSession, role: 'worker', harnessKind: joinedManifest.kind });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'membersPage', args: { teamId: team.teamId, limit: 1 } })).toMatchObject({ ok: true, result: { members: [{ memberId: lead.memberId }], pagination: { cursor: 1, counts: { members: 2 } } } });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'membersPage', args: { teamId: team.teamId, limit: 1, cursor: 1 } })).toMatchObject({ ok: true, result: { members: [{ memberId: worker.memberId }], pagination: { cursor: null, counts: { members: 2 } } } });
    const task = await mutate(connection, 'collaboration', 'createTask', { teamId: team.teamId, title: 'Durable task', criteria: [{ id: 'persist', text: 'Restored after restart', required: true }], owner: { participantId: left.activeParticipantId, session } });
    const nextTask = await mutate(second, 'collaboration', 'createTask', { teamId: team.teamId, title: 'Second task', criteria: [{ id: 'persist', text: 'Successive aggregate flush', required: true }], owner: { participantId: left.activeParticipantId, session } });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'tasks', args: { teamId: team.teamId } })).toMatchObject({ ok: true, result: [{ taskId: task.taskId }, { taskId: nextTask.taskId }] });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'snapshot', args: { teamId: team.teamId, limit: 1 } })).toMatchObject({ ok: true, result: { tasks: [{ taskId: task.taskId }], pagination: { cursor: 1, counts: { tasks: 2 } } } });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'snapshot', args: { teamId: team.teamId, limit: 1, cursor: 1 } })).toMatchObject({ ok: true, result: { tasks: [{ taskId: nextTask.taskId }], pagination: { cursor: null, counts: { tasks: 2 } } } });
    expect(await second.request('runtime.host.read', { domain: 'collaboration', operation: 'snapshot', args: { teamId: team.teamId, limit: 101 } })).toMatchObject({ ok: false, typedError: { code: 'invalid_request' } });
    const nativeScope = { target: services.target, harnessInstanceId: session.harnessInstanceId, epoch: services.epoch, processGeneration: 1, session };
    const nativeJournal = createOperationJournal({ store: services.acceptance.store, isProcessCurrent: () => true });
    const nativeReceipt = await nativeJournal.accept({ scope: nativeScope, method: 'send', idempotencyKey: 'host-observed-send', payload: { text: 'fixture' } });
    await nativeJournal.execute(nativeReceipt.operationId, nativeScope, () => ({ sent: true }));
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'snapshot', args: { threadId: left.threadId } })).toMatchObject({ ok: true, result: { turns: [{ sourceNativeId: nativeReceipt.operationId, accepted: true, sent: true, observed: false, terminal: false }] } });
    await nativeJournal.terminal(nativeReceipt.operationId, nativeScope, 'completed');
    expect(await second.request('runtime.host.read', { domain: 'thread', operation: 'snapshot', args: { threadId: left.threadId } })).toMatchObject({ ok: true, result: { turns: [{ sourceNativeId: nativeReceipt.operationId, terminal: true, terminalReason: 'completed' }] } });
    const content = 'original unknown fields retained';
    const batch = { importId: 'a'.repeat(64), environmentId: services.target, sourceRevision: 'b'.repeat(64), offset: 0, nextOffset: 1, total: 1, chunks: [{ sourceKey: 'c'.repeat(64), offset: 0, content, end: true, checksum: createHash('sha256').update(content).digest('hex'), authority: 'sqlite-imported', binding: { environmentId: services.target, harnessInstanceId: manifest.harnessInstanceId, nativeSessionId: session.nativeSessionId, profileId: services.connectionProfileId } }] };
    expect(await mutate(connection, 'migration', 'accept', batch)).toMatchObject({ phase: 'durable-accepted' });
    await host.stop(); await services.close();
    const restarted = await createRuntimeServices({ environmentId: services.target, stateRoot: root, role: 'local', roots: [{ root, permissions: ['read', 'write', 'command', 'pty'] }], config, nativeSupervisor: supervisor, acpManager: acp, runtime: { mutate: operation => operation() } });
    cleanups.push(() => restarted.close()); await restarted.start();
    const nextHost = createRuntimeHost({ environmentId: restarted.target, role: 'local', services: restarted }); nextHost.start(); cleanups.push(() => nextHost.stop());
    const nextClient = await client(nextHost);
    const restoredPage = await nextClient.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: evidenceArgs });
    expect(restoredPage).toMatchObject({ ok: true, result: { available: true, data: Buffer.from('verified').toString('base64') } });
    execFileSync('git', ['-C', root, 'add', 'evidence.txt']);
    execFileSync('git', ['-C', root, 'commit', '-m', 'advance evidence target'], { stdio: 'ignore' });
    const movedTarget = await nextClient.request('runtime.host.read', { domain: 'handoff', operation: 'evidenceTarget', args: { handoffId: handoffRecord.handoffId } });
    if (!movedTarget.ok) throw new Error('Missing moved target');
    expect(await nextClient.request('runtime.host.read', { domain: 'handoff', operation: 'evidencePage', args: { ...evidenceArgs, currentTarget: movedTarget.result } })).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    if (process.env.VIS_RUNTIME_QA_EVIDENCE) await writeFile(path.join(process.env.VIS_RUNTIME_QA_EVIDENCE, committed ? 'handoff-evidence-trace.json' : 'handoff-evidence-unborn-trace.json'), JSON.stringify({ captured, diff, handoffRecord, filePage, diffPage, restoredPage, movedTarget, movedHeadRefused: true, changedContentRefused: true, deletedFileUnavailable: true, escapedSymlinkRefused: true, forgedReferenceRefused: true, forgedTargetRefused: true, oversizedPageRefused: true }, null, 2));
    expect(await nextClient.request('runtime.host.read', { domain: 'thread', operation: 'get', args: { threadId: left.threadId } })).toMatchObject({ ok: true, result: { threadId: left.threadId, participants: [{ session }, { session: joinedSession }] } });
    expect(await nextClient.request('runtime.host.read', { domain: 'collaboration', operation: 'team', args: { teamId: team.teamId } })).toMatchObject({ ok: true, result: { name: 'Durable team' } });
    expect(await nextClient.request('runtime.host.read', { domain: 'collaboration', operation: 'tasks', args: { teamId: team.teamId } })).toMatchObject({ ok: true, result: [{ taskId: task.taskId }, { taskId: nextTask.taskId }] });
    expect(await nextClient.request('runtime.host.read', { domain: 'thread', operation: 'snapshot', args: { threadId: left.threadId } })).toMatchObject({ ok: true, result: { turns: [{ sourceNativeId: nativeReceipt.operationId, terminal: true, terminalReason: 'completed' }] } });
    expect(await mutate(nextClient, 'migration', 'verify', { importId: batch.importId, sourceRevision: batch.sourceRevision, expectedRecords: 1, expectedChunks: 1 })).toMatchObject({ phase: 'durable-accepted' });
    const imported = (await restarted.store.page({ collection: 'imports', limit: 100 })).items.find(item => item.key.startsWith('chunk:'));
    expect(imported).toMatchObject({ value: { content } });
    const refused = await nextClient.request('runtime.host.mutate', { domain: 'thread', operation: 'bind', args: { session: { ...session, environmentId: randomUUID() }, repo } });
    expect(refused).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    expect(await nextClient.request('runtime.host.mutate', { domain: 'handoff', operation: 'observe', args: { nativeEventId: 'forged' } })).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
  });

  it('reconnects after releasing one of three live subscriber snapshots without invalidating the other windows', async () => {
    const { connection, host } = await runtime(); const second = await client(host), third = await client(host);
    const pages = await Promise.all([connection, second, third].map(client => client.request('runtime.snapshot', { collection: 'workspaces' })));
    expect(pages.every(page => page.ok)).toBe(true);
    expect(await second.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    await new Promise<void>(resolve => { connection.socket.addEventListener('close', () => resolve(), { once: true }); connection.socket.close(); });
    const replacement = await client(host);
    expect(await replacement.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: true });
    for (const [index, client] of [second, third].entries()) { const page = pages[index + 1]; if (!page.ok) throw new Error('Snapshot failed'); const snapshot = page.result as { token: string; revision: number; watermark: number }; expect(await client.request('runtime.snapshot', { collection: 'workspaces', token: snapshot.token })).toMatchObject({ ok: true, result: { token: snapshot.token, revision: snapshot.revision, watermark: snapshot.watermark } }); }
  });
  it('withholds fragmented-upload ACK until disk completion and cleans up a failed write ACK', async () => {
    const { services, root } = await graph(); const diskGate = gate(); let entered = 0;
    const delayed = { ...services, workspace: { ...services.workspace, connect(...args: Parameters<typeof services.workspace.connect>) { const workspace = services.workspace.connect(...args); return { ...workspace, files: { ...workspace.files, async append(input: Parameters<typeof workspace.files.append>[0]) { const result = await workspace.files.append(input); entered++; await diskGate.promise; if (input.data[0] === 2) throw new Error('Controlled disk failure'); return result; } } }; } } };
    const host = createRuntimeHost({ environmentId: services.target, role: 'local', services: delayed }); host.start(); cleanups.push(() => host.stop());
    const connection = await client(host), raw = await rawClient(connection.url); const channels: number[] = [], acks: string[] = [];
    try {
      for (const byte of [1, 2]) { const data = Buffer.alloc(65536, byte); const opened = await raw.request('runtime.channel.open', { service: 'file', workspaceKey: services.workspace.workspaces[0].key, path: `disk-${byte}`, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }); if (!opened.ok) throw new Error(JSON.stringify(opened)); const channelId = (opened.result as { channelId: number }).channelId; channels.push(channelId); const binary = encodeBinary({ channelId, offset: 0, data }); raw.socket.write(Buffer.concat([raw.encode(binary.subarray(0, 63136), 2, false), raw.encode(binary.subarray(63136), 0)])); acks.push(raw.send('runtime.channel.ack', { channelId, offset: 0, length: data.length })); }
      await expect.poll(() => entered).toBe(2);
      expect(await raw.request('runtime.inspect', {})).toMatchObject({ ok: true });
      expect(raw.frames.filter(frame => frame.kind === 'result' && acks.includes(frame.id))).toHaveLength(0);
      diskGate.release(); expect(await raw.take(acks[0])).toMatchObject({ ok: true }); expect(await raw.take(acks[1])).toMatchObject({ ok: false });
      expect(await raw.request('runtime.channel.finish', { channelId: channels[0] })).toMatchObject({ ok: true });
      expect(await raw.request('runtime.channel.cancel', { channelId: channels[1] })).toMatchObject({ ok: true });
      expect(await readFile(path.join(root, 'disk-1'))).toEqual(Buffer.alloc(65536, 1));
      await expect(readFile(path.join(root, 'disk-2'))).rejects.toMatchObject({ code: 'ENOENT' });
      expect((await readdir(root)).filter(name => name.startsWith('.vis-upload-'))).toHaveLength(0);
    } finally { diskGate.release(); }
  });
  it.each<[string, (encode: Awaited<ReturnType<typeof rawClient>>['encode']) => Buffer]>([
    ['unexpected continuation', encode => encode(Buffer.from('x'), 0)],
    ['interleaved data message', encode => Buffer.concat([encode(Buffer.from('x'), 2, false), encode(Buffer.from('y'), 2)])],
    ['binary aggregate over 65560', encode => Buffer.concat([encode(Buffer.alloc(65560), 2, false), encode(Buffer.from('x'), 0)])],
    ['JSON aggregate over 1MiB', encode => Buffer.concat([encode(Buffer.alloc(1048576), 1, false), encode(Buffer.from('x'), 0)])],
    ['fragmented control', encode => encode(Buffer.from('x'), 9, false)],
    ['oversized control', encode => encode(Buffer.alloc(126), 9)],
    ['reserved opcode', encode => encode(Buffer.from('x'), 3)],
    ['reserved bits', encode => { const frame = encode(Buffer.from('x')); frame[0] |= 0x40; return frame; }],
    ['unmasked frame', () => Buffer.from([0x82, 1, 120])],
  ])('closes invalid fragmented transport: %s', async (_name, make) => {
    const { connection } = await runtime(); const raw = await rawClient(connection.url);
    raw.socket.write(make(raw.encode)); await raw.closed;
    expect(raw.frames.filter(frame => frame.kind === 'result')).toHaveLength(0);
    expect(await connection.request('runtime.inspect', {})).toMatchObject({ ok: true });
  });
  it('reassembles Chromium-sized fragments for four channels of four 64KiB chunks before disk ACK', async () => {
    const { connection, services, root } = await runtime(); const raw = await rawClient(connection.url);
    const channels: number[] = [], data = Buffer.alloc(4 * 65536, 7);
    for (let index = 0; index < 4; index++) { const opened = await raw.request('runtime.channel.open', { service: 'file', workspaceKey: services.workspace.workspaces[0].key, path: `fragment-${index}`, size: data.length, sha256: createHash('sha256').update(data).digest('hex') }); if (!opened.ok) throw new Error(JSON.stringify(opened)); channels.push((opened.result as { channelId: number }).channelId); }
    const acks: string[] = [];
    for (const channelId of channels) for (let part = 0; part < 4; part++) {
      const bytes = encodeBinary({ channelId, offset: part * 65536, data: data.subarray(part * 65536, (part + 1) * 65536) });
      raw.socket.write(Buffer.concat([raw.encode(bytes.subarray(0, 63136), 2, false), raw.encode(Buffer.from('ping'), 9), raw.encode(bytes.subarray(63136), 0)]));
      acks.push(raw.send('runtime.channel.ack', { channelId, offset: part * 65536, length: 65536 }));
    }
    expect((await Promise.all(acks.map(raw.take))).every(frame => frame.ok)).toBe(true);
    expect(raw.controls.filter(opcode => opcode === 10)).toHaveLength(16);
    for (const [index, channelId] of channels.entries()) { expect(await raw.request('runtime.channel.finish', { channelId })).toMatchObject({ ok: true }); expect(await readFile(path.join(root, `fragment-${index}`))).toEqual(data); }
    expect(await raw.request('runtime.inspect', {})).toMatchObject({ ok: true });
  });
  it('rejects a foreign browser Origin before upgrade while preserving the authorized subscriber', async () => {
    const { connection } = await runtime();
    const status = await new Promise<number | undefined>((resolve, reject) => { const request = httpRequest(connection.url, { headers: { Origin: 'https://foreign.example', Connection: 'Upgrade', Upgrade: 'websocket', 'Sec-WebSocket-Version': '13', 'Sec-WebSocket-Key': Buffer.alloc(16).toString('base64') } }, response => { response.resume(); resolve(response.statusCode); }); request.on('error', reject); request.end(); });
    expect(status).toBe(403); expect(await connection.request('runtime.inspect', {})).toMatchObject({ ok: true });
  });
  it('serves persistent identity, truthful five disabled registrations and coherent SQLite snapshot/replay', async () => {
    const { connection, services } = await runtime();
    expect(connection.hello.epoch).toBe((await services.store.inspect()).epoch);
    const result = await connection.request('runtime.inspect', {}); expect(result.ok).toBe(true);
    if (!result.ok) throw new Error('Missing inspection');
    expect(result.result).toMatchObject({ connectionProfileId: services.connectionProfileId, transports: { direct: true, ssh: false, slurm: false } });
    expect((result.result as { harnesses: { inspection: object }[] }).harnesses.map(entry => entry.inspection)).toEqual(Array(5).fill({ state: 'disabled', protocolVersion: 1 }));
    const page = await connection.request('runtime.snapshot', { collection: 'workspaces' }); expect(page.ok).toBe(true);
    if (!page.ok) throw new Error('Missing page');
    expect(page.result).toMatchObject({ kind: 'snapshot', epoch: connection.hello.epoch, items: [{ collection: 'workspaces', key: services.workspace.workspaces[0].key }] });
    const replay = await connection.request('runtime.replay', { after: 0 }); expect(replay.ok).toBe(true);
  });
  it('rejects unknown targets, stale epochs/generations, duplicate ids and malformed method params', async () => {
    const { connection } = await runtime();
    for (const override of [{ target: randomUUID() }, { epoch: randomUUID() }, { generation: 900 }]) expect(await connection.request('runtime.inspect', {}, override)).toMatchObject({ ok: false });
    expect(await connection.request('runtime.inspect', {}, {}, 'duplicate')).toMatchObject({ ok: true });
    expect(await connection.request('runtime.inspect', {}, {}, 'duplicate')).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    expect(await connection.request('runtime.snapshot', { collection: 'threads' })).toMatchObject({ ok: false, typedError: { code: 'invalid_request' } });
  });
  it('roundtrips real file bytes with four-credit wire ids and rejects duplicate ACK and path escapes', async () => {
    const { connection, services, root } = await runtime(); const data = Buffer.from('runtime wire file bytes');
    const params = { service: 'file', workspaceKey: services.workspace.workspaces[0].key, path: 'wire.txt', size: data.length, sha256: createHash('sha256').update(data).digest('hex') };
    expect(await connection.request('runtime.channel.open', { ...params, path: '../escape.txt' })).toMatchObject({ ok: false });
    const opened = await connection.request('runtime.channel.open', params); if (!opened.ok) throw new Error(JSON.stringify(opened));
    const { channelId } = opened.result as { channelId: number }; connection.socket.send(Uint8Array.from(encodeBinary({ channelId, offset: 0, data })));
    const chunk = { channelId, offset: 0, length: data.length };
    expect(await connection.request('runtime.channel.ack', chunk)).toMatchObject({ ok: true, result: chunk });
    expect(await connection.request('runtime.channel.ack', chunk)).toMatchObject({ ok: false, typedError: { code: 'conflict' } });
    expect(await connection.request('runtime.channel.finish', { channelId })).toMatchObject({ ok: true, result: { size: data.length } });
    expect(await readFile(path.join(root, 'wire.txt'), 'utf8')).toBe(data.toString());
  });
  it('fences observer ownership and snapshot tokens across independent subscribers', async () => {
    const { connection, host } = await runtime(); const second = await client(host);
    const opened = await connection.request('runtime.observer.open', { after: 0 }); if (!opened.ok) throw new Error('Observer failed');
    expect(await second.request('runtime.observer.read', opened.result as object)).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    expect(await connection.request('runtime.observer.close', opened.result as object)).toMatchObject({ ok: true });
    const page = await connection.request('runtime.snapshot', { collection: 'workspaces' }); if (!page.ok) throw new Error('Snapshot failed');
    expect(await second.request('runtime.snapshot', { collection: 'workspaces', token: (page.result as { token: string }).token })).toMatchObject({ ok: false, typedError: { code: 'replay_required' } });
  });
  it('attaches a qualified summary only when the observer opts in', async () => {
    const { connection, services } = await runtime();
    const session = parseSessionRef({ environmentId: services.target, harnessInstanceId: services.registry.list()[0].harnessInstanceId, nativeSessionId: 'observer-summary' });
    const key = encodeSessionKey(session);
    const snapshot = await connection.request('runtime.snapshot', { collection: 'session_summaries' });
    if (!snapshot.ok) throw new Error('Snapshot unavailable');
    const opened = await connection.request('runtime.observer.open', { after: (snapshot.result as { watermark: number }).watermark });
    if (!opened.ok) throw new Error('Missing observer');
    for (const resolveSummary of [true, undefined]) {
      const value = { session, title: resolveSummary ? 'resolved' : 'legacy' };
      const pending = connection.request('runtime.observer.read', { ...opened.result as object, ...(resolveSummary ? { resolveSummary } : {}) });
      await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key, value }] });
      const result = await pending;
      expect(result).toMatchObject({ ok: true, result: { kind: 'event', frame: { payload: { key } } } });
      if (!result.ok) throw new Error('Observer read failed');
      if (resolveSummary) expect(result.result).toMatchObject({ canonical: { collection: 'session_summaries', key, value } });
      else expect(result.result).not.toHaveProperty('canonical');
    }
  });
  it('attaches workspace metadata only for a consumer that opted in', async () => {
    const { connection, services } = await runtime();
    const { key } = services.workspace.workspaces[0];
    const row = await services.store.get({ collection: 'workspaces', key });
    if (!row?.value || typeof row.value !== 'object' || Array.isArray(row.value)) throw new Error('Missing workspace record');
    const snapshot = await connection.request('runtime.snapshot', { collection: 'workspaces' });
    if (!snapshot.ok) throw new Error('Snapshot unavailable');
    const opened = await connection.request('runtime.observer.open', { after: (snapshot.result as { watermark: number }).watermark });
    if (!opened.ok) throw new Error('Missing observer');
    for (const resolveWorkspace of [undefined, true]) {
      const value = { ...row.value, orphan: resolveWorkspace === true };
      const pending = connection.request('runtime.observer.read', {
        ...opened.result as object, resolveSummary: true, ...(resolveWorkspace ? { resolveWorkspace } : {}),
      });
      await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'workspaces', key, value }] });
      const result = await pending;
      expect(result).toMatchObject({ ok: true, result: { kind: 'event', frame: { payload: { key, collection: 'workspaces' } } } });
      if (!result.ok) throw new Error('Observer read failed');
      if (resolveWorkspace) expect(result.result).toMatchObject({ canonical: { collection: 'workspaces', key, value } });
      else expect(result.result).not.toHaveProperty('canonical');
    }
  });
  it('enforces trusted permission grants before file and native invocation', async () => {
    const { services } = await graph();
    const host = createRuntimeHost({ environmentId: services.target, role: 'local', services, grants: [{ ...services.grant, permissions: ['runtime:read'] }] }); host.start(); cleanups.push(() => host.stop());
    const connection = await client(host);
    expect(await connection.request('runtime.channel.open', { service: 'file', workspaceKey: services.workspace.workspaces[0].key, path: 'denied', size: 0, sha256: createHash('sha256').update('').digest('hex') })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    expect(await connection.request('session.list', { harnessInstanceId: services.registry.list()[0].harnessInstanceId, args: {} })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
  });
  it('bounds admission at 496 normal plus 12 recovery and 4 native-control slots', async () => {
    const { services } = await graph(); const normalGate = gate(), diskGate = gate(), cancelGate = gate(); let entered = 0, disk = 0, cancel = 0;
    const graphWithDelayedIo = { ...services,
      snapshots: { async connect(...args: Parameters<typeof services.snapshots.connect>) { const connection = await services.snapshots.connect(...args); return { ...connection, async page(input: Parameters<typeof connection.page>[0]) { entered++; await normalGate.promise; return connection.page(input); } }; } },
      workspace: { ...services.workspace, connect(...args: Parameters<typeof services.workspace.connect>) { const connection = services.workspace.connect(...args); return { ...connection, files: { ...connection.files, async append(input: Parameters<typeof connection.files.append>[0]) { const chunk = await connection.files.append(input); disk++; await diskGate.promise; return chunk; } } }; } },
      store: { ...services.store, async get(input: Parameters<typeof services.store.get>[0]) { const row = await services.store.get(input); if (input.collection === 'session_summaries') { cancel++; await cancelGate.promise; } return row; } },
    };
    const host = createRuntimeHost({ environmentId: services.target, role: 'local', services: graphWithDelayedIo }); host.start(); cleanups.push(() => host.stop());
    const connection = await client(host); const observer = await connection.request('runtime.observer.open', { after: 0 }); if (!observer.ok) throw new Error('Missing observer');
    const session = parseSessionRef({ environmentId: services.target, harnessInstanceId: services.registry.list()[0].harnessInstanceId, nativeSessionId: 'admission' });
    await services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(session), value: { session, workspaceKey: services.workspace.workspaces[0].key } }] });
    const chunks: { channelId: number; offset: number; length: number }[] = [];
    for (let index = 0; index < 4; index++) {
      const data = Buffer.from('abcd'); const opened = await connection.request('runtime.channel.open', { service: 'file', workspaceKey: services.workspace.workspaces[0].key, path: `pressure-${index}`, size: 4, sha256: createHash('sha256').update(data).digest('hex') }); if (!opened.ok) throw new Error('Missing channel');
      const channelId = (opened.result as { channelId: number }).channelId;
      for (let offset = 0; offset < 4; offset++) { connection.socket.send(Uint8Array.from(encodeBinary({ channelId, offset, data: data.subarray(offset, offset + 1) }))); chunks.push({ channelId, offset, length: 1 }); }
    }
    await expect.poll(() => disk).toBe(16);
    const requests = Array.from({ length: 496 }, () => connection.request('runtime.snapshot', { collection: 'workspaces' }));
    let recovery: Promise<Result>[] = [], controls: Promise<Result>[] = [];
    try {
      await expect.poll(() => entered).toBe(496);
      expect(await connection.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: false, typedError: { code: 'source_unavailable' } });
      expect(await connection.request('runtime.observer.read', observer.result as object)).toMatchObject({ ok: true });
      recovery = chunks.slice(0, 12).map(chunk => connection.request('runtime.channel.ack', chunk));
      expect(await connection.request('runtime.channel.ack', chunks[12])).toMatchObject({ ok: false, typedError: { code: 'source_unavailable' } });
      expect(await connection.request('runtime.history.close', { historyId: randomUUID() })).toMatchObject({ ok: true, result: { closed: true } });
      controls = Array.from({ length: 4 }, () => connection.request('session.cancel', { harnessInstanceId: session.harnessInstanceId, session, args: {} }));
      await expect.poll(() => cancel).toBe(4);
      expect(await connection.request('session.cancel', { harnessInstanceId: session.harnessInstanceId, session, args: {} })).toMatchObject({ ok: false, typedError: { code: 'source_unavailable' } });
      cancelGate.release(); expect(await Promise.all(controls)).toEqual(Array.from({ length: 4 }, () => expect.objectContaining({ ok: false, typedError: expect.objectContaining({ code: 'unsupported' }) })));
      diskGate.release(); expect((await Promise.all(recovery)).every(result => result.ok)).toBe(true);
      for (const chunk of chunks.slice(12)) expect(await connection.request('runtime.channel.ack', chunk)).toMatchObject({ ok: true });
    } finally { normalGate.release(); diskGate.release(); cancelGate.release(); await Promise.all([...requests, ...recovery, ...controls]); }
    for (const channelId of new Set(chunks.map(chunk => chunk.channelId))) expect(await connection.request('runtime.channel.finish', { channelId })).toMatchObject({ ok: true });
  });
  it('keeps manager read-only and obtains separate attached target generations', async () => {
    const manager = await graph('manager'), execution = await graph('execution');
    const host = createRuntimeHost({ environmentId: manager.services.target, role: 'manager', services: manager.services, targets: [execution.services] }); host.start(); cleanups.push(() => host.stop());
    const connection = await client(host); expect(await connection.request('runtime.snapshot', { collection: 'workspaces' })).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
    expect(await connection.request('runtime.host.read', { domain: 'thread', operation: 'state', args: {} })).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
    expect(await connection.request('runtime.host.mutate', { domain: 'collaboration', operation: 'createTeam', args: { name: 'Refused manager team' } })).toMatchObject({ ok: false, typedError: { code: 'unsupported' } });
    const attached = await connection.request('runtime.target.attach', { target: execution.services.target }); if (!attached.ok) throw new Error('Attach failed');
    const hello = (attached.result as unknown as { hello: Hello }).hello;
    expect(hello.generation).toBeGreaterThan(connection.hello.generation);
    expect(await connection.request('runtime.snapshot', { collection: 'workspaces' }, hello)).toMatchObject({ ok: true });
    expect(await connection.request('runtime.target.detach', { target: execution.services.target })).toMatchObject({ ok: true });
    expect(await connection.request('runtime.inspect', {}, hello)).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
  });
  it('keeps the renderer observer live through a manager forwarding to an older execution Bridge', async () => {
    const manager = await graph('manager'), execution = await graph('execution');
    const executionHost = createRuntimeHost({ environmentId: execution.services.target, role: 'execution', services: execution.services });
    executionHost.start();
    cleanups.push(() => executionHost.stop());
    let refused = 0;
    const legacyHost = {
      ...executionHost,
      connect(id: string) {
        const scoped = executionHost.connect(id);
        return { ...scoped, openRuntime(transport: Parameters<typeof scoped.openRuntime>[0]) {
          const dispatcher = scoped.openRuntime(transport);
          if (!dispatcher) return null;
          return { ...dispatcher, async request(frame: Parameters<typeof dispatcher.request>[0]) {
            if (frame.method === 'runtime.observer.read' && 'resolveSummary' in (frame.params as object)) {
              refused++;
              const { id, target, epoch, generation } = frame;
              transport.send({ version: 1, kind: 'result', id, target, epoch, generation,
                ok: false, typedError: { code: 'invalid_request', message: 'invalid_request: fields' } });
            } else await dispatcher.request(frame);
          } };
        } };
      },
    };
    const endpoint = (await client(legacyHost)).url.replace(/^http:/, 'ws:');
    const remote = await openRemoteRuntime({ endpoint, environmentId: execution.services.target });
    cleanups.push(async () => remote.close());
    const target = remote.grant.target;
    const remoteServices: RemoteServices = {
      capabilities: { direct: true, ssh: false, slurm: false },
      getTarget: requested => requested === target ? remote : undefined,
      listTargets: () => [remote.grant],
      async refreshTargets() {},
      async openProfileTransport() { throw new Error('Unexpected managed transport request'); },
      configureProfiles() { throw new Error('Unexpected profile configuration'); },
      async read() { throw new Error('Unexpected manager read'); },
      async mutate() { throw new Error('Unexpected manager write'); },
      async close() { remote.close(); },
    };
    const host = createRuntimeHost({ environmentId: manager.services.target, role: 'manager', services: { ...manager.services, remoteServices } });
    host.start();
    cleanups.push(() => host.stop());
    const url = (await client(host)).url.replace(/^http:/, 'ws:');
    const connection = createRuntimeConnection({ reference: { url }, resolveAuthentication: async () => ({}), createWebSocket: address => new WebSocket(address) });
    const renderer = createRuntimeClient({ connection });
    cleanups.push(async () => { renderer.dispose(); connection.dispose(); });
    await connection.connect();
    await renderer.inspect();
    await renderer.attach(target);
    const holder = await client(executionHost);
    const held = await Promise.all(Array.from({ length: 3 }, () => holder.request('runtime.snapshot', { collection: 'workspaces' })));
    const last = held.at(-1);
    if (!last?.ok || held.some(page => !page.ok)) throw new Error('Failed to occupy execution Bridge snapshot slots');
    const token = (last.result as { token: string }).token;
    await expect(renderer.request(target, 'runtime.snapshot', { collection: 'workspaces' }))
      .rejects.toMatchObject({ code: 'conflict', field: 'runtime.store.snapshot_limit' });
    expect(await holder.request('runtime.snapshot.release', { token })).toMatchObject({ ok: true });
    const session = parseSessionRef({ environmentId: target, harnessInstanceId: execution.services.registry.list()[0].harnessInstanceId, nativeSessionId: 'old-execution' });
    const key = encodeSessionKey(session);
    const delivered: number[] = [];
    const { observer } = await renderer.snapshot(target, 'session_summaries', {
      onPage: () => {},
      onDelivery: delivery => {
        const frame = delivery?.kind === 'event' ? delivery.frame : null;
        if (frame?.type === 'entity.patch' && (frame.payload as { key?: string }).key === key) delivered.push(frame.seq);
      },
    });
    for (const [index, title] of ['Legacy execution', 'Still live'].entries()) {
      await execution.services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key, value: { session, title } }] });
      // A concurrent index write can legitimately require replay. The
      // production callback receives both live and recovered deliveries.
      for (let attempt = 0; attempt < 5 && delivered.length <= index; attempt++) await observer.read();
      expect(delivered).toHaveLength(index + 1);
    }
    expect(delivered[1]).toBeGreaterThan(delivered[0]);
    expect(refused).toBe(2);
    await observer.close();
  });
  it('persists connection and harness identities across bridge restart while refreshing store epoch', async () => {
    const root = await mkdtemp(path.join(tmpdir(), 'vis-wire-restart-')); cleanups.push(() => rm(root, { recursive: true, force: true }));
    const configStore = createBridgeConfigStore({ configPath: path.join(root, 'bridge.json') });
    await configStore.load();
    const { writeFile } = await import('node:fs/promises'); await writeFile(configStore.configPath, JSON.stringify(config));
    const seen = [];
    for (let index = 0; index < 2; index++) {
      const bridge = createBridgeRuntime({ stateRoot: root, configStore: createBridgeConfigStore({ configPath: configStore.configPath }), nativeSupervisor: supervisor, acpManager: acp, localWorkspaceRoots: [{ root, permissions: ['read'] }] });
      try { const host = await bridge.getRuntimeHost!(); await host.sourcesReady; const scope = host.connect('probe'); const frames: Result[] = []; const dispatch = scope.openRuntime({ send: frame => frames.push(frame), sendBinary: () => {}, canSend: () => true })!; const hello = dispatch.hello(); await dispatch.request({ version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation, id: 'inspect', method: 'runtime.inspect', params: {} }); seen.push({ hello, result: frames[0] }); scope.disconnect(); }
      finally { await bridge.stop(); }
    }
    expect(seen[0].hello.target).toBe(seen[1].hello.target); expect(seen[0].hello.epoch).not.toBe(seen[1].hello.epoch);
    expect(seen[0].result).toMatchObject({ ok: true }); expect(seen[1].result).toMatchObject({ ok: true });
    if (seen[0].result.ok && seen[1].result.ok) { const first = seen[0].result.result as { connectionProfileId: string; harnesses: unknown[] }; const second = seen[1].result.result as typeof first; expect(first.connectionProfileId).toBe(second.connectionProfileId); expect(first.harnesses).toEqual(second.harnesses); }
  });
});

describe('history wire through real RuntimeHost, WebSocket and SQLite scope checks', () => {
  it('routes the five additive history methods with repeated source and workspace authorization', async () => {
    const context = await historyRuntime(), connection = await client(context.host), foreign = await client(context.host);
    const historyId = randomUUID(), params = { historyId, session: context.session };
    expect(await connection.request('runtime.history.open', params)).toMatchObject({ ok: true, result: { historyId, session: context.session, capabilities: { archive: 'paged' } } });
    expect(await foreign.request('runtime.history.page', { historyId })).toMatchObject({ ok: false, typedError: { code: 'replay_required' } });
    expect(await connection.request('runtime.history.page', { historyId })).toMatchObject({ ok: true, result: { items: [{ value: { nativeUnknown: 'preserved' } }] } });
    expect(await connection.request('runtime.history.read', { historyId, after: 0 })).toMatchObject({ ok: true, result: { through: 1, changed: true } });
    expect(await connection.request('session.history', { harnessInstanceId: context.session.harnessInstanceId, session: context.session, args: {} })).toMatchObject({ ok: true, result: { legacy: true } });
    context.changeGeneration();
    expect(await connection.request('runtime.history.page', { historyId })).toMatchObject({ ok: false, typedError: { code: 'replay_required' } });
    expect(context.counts().closed).toBe(1);
    const reopened = { ...params, historyId: randomUUID() }; expect(await connection.request('runtime.history.open', reopened)).toMatchObject({ ok: true });
    await context.services.store.mutate({ intentId: randomUUID(), changes: [{ collection: 'session_summaries', key: encodeSessionKey(context.session), value: { session: context.session } }] });
    expect(await connection.request('runtime.history.page', { historyId: reopened.historyId })).toMatchObject({ ok: false, typedError: { code: 'unauthorized' } });
    expect(context.counts().closed).toBe(2);
  });
  it('closes a held native open before any late result can publish a handle', async () => {
    const held = gate(), context = await historyRuntime({ openGate: held.promise }), connection = await client(context.host);
    const historyId = randomUUID(); const opening = connection.request('runtime.history.open', { historyId, session: context.session });
    try {
      await expect.poll(() => context.counts().opened).toBe(1);
      const closing = connection.request('runtime.history.close', { historyId });
      await expect.poll(() => context.counts().closed).toBe(1); held.release();
      expect(await opening).toMatchObject({ ok: false, typedError: { code: 'cancelled' } });
      expect(await closing).toMatchObject({ ok: true, result: { closed: true } });
      expect(await connection.request('runtime.history.open', { historyId, session: context.session })).toMatchObject({ ok: false, typedError: { code: 'cancelled' } });
    } finally { held.release(); await opening; }
  });
  it('retains disconnected dispatcher cleanup until Host.stop has awaited native close', async () => {
    const held = gate(), context = await historyRuntime({ closeGate: held.promise });
    const scope = context.host.connect('history-cleanup'); const frames: Result[] = [];
    const dispatcher = scope.openRuntime({ send: frame => frames.push(frame), sendBinary() {}, canSend: () => true });
    if (!dispatcher) throw new TypeError('Missing dispatcher'); const hello = dispatcher.hello();
    await dispatcher.request({ version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation, id: 'history-open', method: 'runtime.history.open', params: { historyId: randomUUID(), session: context.session } });
    expect(frames[0]).toMatchObject({ ok: true }); scope.disconnect();
    let stopped = false; const stopping = context.host.stop().then(() => { stopped = true; });
    try { await expect.poll(() => context.counts().closed).toBe(1); expect(stopped).toBe(false); }
    finally { held.release(); await stopping; }
    expect(stopped).toBe(true); expect(context.counts().closed).toBe(1);
  });
});

it('closes live WebSockets after Host shutdown drains its owned resources', async () => {
  const context = await runtime();
  let closed = false;
  const closing = new Promise<void>(resolve => context.connection.socket.addEventListener('close', () => { closed = true; resolve(); }, { once: true }));
  await context.host.stop();
  await expect.poll(() => closed).toBe(true);
  await closing;
});

it('physically retires only the exhausted history socket after awaited producer cleanup', async () => {
  const held = gate(), context = await historyRuntime({ closeGate: held.promise }), connection = await client(context.host), survivor = await client(context.host);
  const historyId = randomUUID(); expect(await connection.request('runtime.history.open', { historyId, session: context.session })).toMatchObject({ ok: true });
  for (let index = 0; index < 1023; index++) expect(await connection.request('runtime.history.close', { historyId: randomUUID() })).toMatchObject({ ok: true });
  let closed = false; const socketClosed = new Promise<void>(resolve => connection.socket.addEventListener('close', () => { closed = true; resolve(); }, { once: true }));
  try {
    expect(await connection.request('runtime.history.close', { historyId: randomUUID() })).toMatchObject({ ok: false, typedError: { code: 'reconcile_required' } });
    await expect.poll(() => context.counts().closed).toBe(1); expect(closed).toBe(false);
    held.release(); await socketClosed; expect(context.counts().closed).toBe(1);
    expect(await survivor.request('runtime.inspect', {})).toMatchObject({ ok: true });
    await expect.poll(() => context.host.inspect().subscribers).toBe(1);
  } finally { held.release(); }
});

it('retires once and surfaces awaited cleanup failure after making the dispatcher inactive', async () => {
  const held = Promise.withResolvers<void>(), context = await historyRuntime({ closeGate: held.promise });
  const scope = context.host.connect('history-retire-failure'); const frames: Result[] = []; let retired = 0;
  const dispatcher = scope.openRuntime({ send: frame => frames.push(frame), sendBinary() {}, canSend: () => true, retire: () => { retired++; } });
  if (!dispatcher) throw new TypeError('Missing dispatcher'); const hello = dispatcher.hello(); let serial = 0;
  const request = (method: RuntimeMethod, params: Request['params']) => dispatcher.request({ version: 1, kind: 'request', target: hello.target, epoch: hello.epoch, generation: hello.generation, id: 'retire-' + ++serial, method, params });
  await request('runtime.history.open', { historyId: randomUUID(), session: context.session }); expect(frames.at(-1)).toMatchObject({ ok: true });
  for (let index = 0; index < 1023; index++) await request('runtime.history.close', { historyId: randomUUID() });
  const exhaustion = request('runtime.history.close', { historyId: randomUUID() });
  const failure = expect(exhaustion).rejects.toThrow('Runtime connection cleanup failed');
  try {
    await expect.poll(() => context.counts().closed).toBe(1); expect(retired).toBe(0);
    expect(frames.at(-1)).toMatchObject({ ok: false, typedError: { code: 'reconcile_required' } });
    const count = frames.length; await request('runtime.inspect', {}); expect(frames).toHaveLength(count);
  } finally { held.reject(new Error('Controlled producer close failure')); await failure; }
  expect(retired).toBe(1); await expect(dispatcher.close()).rejects.toThrow('Runtime connection cleanup failed');
  expect(retired).toBe(1); expect(context.counts().closed).toBe(1); scope.disconnect();
});
