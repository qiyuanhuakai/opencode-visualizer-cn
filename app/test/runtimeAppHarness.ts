import { createApp, h, nextTick } from 'vue';
import { onTestFinished, vi } from 'vitest';
import { randomUUID } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { once } from 'node:events';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fingerprint } from '../../bridge/runtime/operationJournal.js';
import { createInstanceOperations } from '../../shared/runtime/native/opencode/instanceOperations.js';
import { createRuntimeHost } from '../../bridge/runtime/runtimeHost.js';
import type { RuntimeDriverFactory } from '../../bridge/runtime/runtimeDriverFactories.js';
import { unavailableRegistration } from '../../bridge/runtime/runtimeDriverFactories.js';
import { createBridgeRuntime } from '../../bridge/bridgeRuntime.js';
import { createVisBridgeServer } from '../../vis_bridge.js';
import { parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import { NATIVE_EXTENSIONS } from '../../shared/runtime/nativeExtensions.js';
import type { NativeOperation } from '../../shared/runtime/nativeExtensions.js';
import { loopbackRuntimeSocket } from './loopbackRuntimeSocket';

vi.mock('@iconify/vue', () => ({ Icon: () => h('svg') }));
const draftFixture = vi.hoisted(() => ({ open: undefined as (() => Promise<unknown>) | undefined }));
// These tests cover App/wire/Bridge assembly. Browser IndexedDB migration and
// pin durability are covered by real-browser lanes, not this DOM environment.
vi.mock('../runtime/draftStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../runtime/draftStore')>();
  return { ...actual, DraftStore: { open: async () => draftFixture.open ? draftFixture.open() : ({ readCheckpoint: async () => null, close() {} }) } };
});
vi.mock('../runtime/pinStore', async importOriginal => {
  const actual = await importOriginal<typeof import('../runtime/pinStore')>();
  return { ...actual, PinStore: { open: async () => ({ get: async () => undefined, page: async () => ({ records: [], next: null, release() {} }), close() {}, usage: () => ({ residentBytes: 0, reservedBytes: 0, entries: 0 }) }) } };
});
vi.mock('../composables/useGlobalEvents', () => ({ useGlobalEvents: () => ({
  connect: async () => { throw new Error('Bridge-first App must not connect a legacy Agent transport'); },
  disconnect() {}, dispose() {}, sendToWorker: () => false, setWorkerMessageHandler() {},
  on: () => () => {}, session: () => ({ on: () => () => {}, dispose() {} }),
  mainSession: () => ({ on: () => () => {}, dispose() {} }),
}) }));

type NativeHistory = Readonly<{ info: Readonly<Record<string, JsonValue>>; parts: readonly JsonValue[] }>;

/** Real App + TCP/WebSocket + production Runtime/SQLite, controlled native harness boundary. */
export async function mountRuntimeApp(history: readonly NativeHistory[], options: { draftStore?: () => Promise<unknown>; childSessions?: readonly string[]; historyPageSize?: number; dshAccount?: JsonValue; bridgeToken?: string; managedBridge?: boolean; additionalModelId?: string; editableProvider?: boolean; beforeProviderWrite?: () => Promise<void>; beforeProviderRead?: () => Promise<void>; archivedAcpSession?: boolean; secondWorktree?: boolean; codexFactory?: RuntimeDriverFactory; readHistory?: (session: SessionRef) => Promise<readonly NativeHistory[]> } = {}) {
  // Load the Node worker owner without Vite's browser asset URL rewriting.
  // The worker itself still runs the production module in a real subprocess.
  const requireNodeModule = createRequire(path.resolve(process.cwd(), 'package.json'));
  const { createRuntimeServices } = requireNodeModule('./bridge/runtime/runtimeServices.js') as typeof import('../../bridge/runtime/runtimeServices.js');
  const root = await mkdtemp(path.join(tmpdir(), 'vis-runtime-app-'));
  const cleanups: Array<() => void | Promise<unknown>> = [() => rm(root, { recursive: true, force: true })];
  const previousDraftFactory = draftFixture.open;
  draftFixture.open = options.draftStore;
  cleanups.push(() => { draftFixture.open = previousDraftFactory; });
  let disposed = false;
  async function unmount() {
    if (disposed) return;
    disposed = true;
    const errors: unknown[] = [];
    for (const close of cleanups.reverse()) try { await close(); } catch (error) { errors.push(error); }
    if (errors.length) throw new AggregateError(errors, 'Runtime App fixture cleanup failed');
  }
  onTestFinished(unmount);
  const directory = path.join(root, 'workspace');
  await mkdir(directory);
  execFileSync('git', ['init', '--quiet'], { cwd: directory });
  execFileSync('git', ['-c', 'user.name=QA', '-c', 'user.email=qa@example.invalid', 'commit', '--quiet', '--allow-empty', '-m', 'base'], { cwd: directory });
  const secondDirectory = options.secondWorktree ? path.join(root, 'second-worktree') : directory;
  if (options.secondWorktree) execFileSync('git', ['worktree', 'add', '--quiet', '--detach', secondDirectory], { cwd: directory });
  const sessionDirectory = (id: string) => id === 'session-b' ? secondDirectory : directory;
  const historyOpens: SessionRef[] = [];
  const historyCloses: SessionRef[] = [];
  const historyPages: Array<{ session: SessionRef; cursor: string | null }> = [];
  const nativeQueries: Array<{ operation: string; session?: SessionRef }> = [];
  const supervisor = { start: async () => [], stop: async () => {}, getStatus: () => [] };
  const acp = { reconcile: async () => [], stopAll: async () => {}, getStatus: () => [], attach() { throw new Error('ACP disabled'); } };
  const stateRoot = path.join(root, 'state');
  const role = options.managedBridge ? 'manager' : 'local';
  const { createRemoteServices } = requireNodeModule('./bridge/runtime/remoteServices.js') as typeof import('../../bridge/runtime/remoteServices.js');
  const remoteServices = options.managedBridge ? createRemoteServices({ stateRoot }) : undefined;
  if (remoteServices) cleanups.push(() => remoteServices.close());
  const services = await createRuntimeServices({
    environmentId: randomUUID(), stateRoot, role, remoteServices,
    roots: [...new Set([directory, secondDirectory])].map(root => ({ root, permissions: ['read', 'write', 'command', 'pty'] })),
    config: { version: 1, nativeServices: { opencode: true, codex: Boolean(options.codexFactory), 'kimi-web': false, dsh: options.dshAccount !== undefined }, acpAgents: options.archivedAcpSession ? [{ id: 'fixture-acp', name: 'Fixture ACP', enabled: true, command: process.execPath, args: [], env: {} }] : [] },
    nativeSupervisor: supervisor, acpManager: acp, runtime: { mutate: action => action() },
    factories: { ...(options.codexFactory ? { codex: options.codexFactory } : {}), opencode: async context => {
      const identity = { environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'opencode' as const };
      const empty = unavailableRegistration(identity, 'starting');
      const session = (id: string) => ({ environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, nativeSessionId: id });
      const modelId = options.additionalModelId;
      const models: Record<string, JsonValue> = {
        'model-a': { id: 'model-a', name: 'QA model', limit: { context: 32000, output: 4000 } },
      };
      if (modelId) models[modelId] = { id: modelId, name: 'Slash Model' };
      const editableConfig = options.editableProvider ? createInstanceOperations({
        store: context.store,
        scope: { environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, ...context.authority() },
        current: context.authority, fingerprint, randomUUID,
      }) : undefined;
      let config: Record<string, JsonValue> = {
        model: 'provider-a/model-a',
        ...(options.editableProvider ? { disabled_providers: ['provider-a'] } : {}),
      };
      const queries: Record<string, JsonValue> = {
        listProviders: { all: [{ id: 'provider-a', name: 'QA provider', models, ...(options.editableProvider ? { source: 'config' } : {}) }], connected: ['provider-a'], default: { 'provider-a': 'model-a' } },
        getGlobalConfig: config,
        ...(options.editableProvider ? { updateGlobalConfig: null } : {}),
        listAgents: [{ name: 'build', mode: 'primary' }], listCommands: [], getSessionTodos: [],
        listPendingPermissions: [], listPendingQuestions: [],
      };
      return { registration: {
        manifest: { ...empty.manifest,
          core: { ...empty.manifest.core, inspect: { state: 'supported' }, listSessionPage: { state: 'supported' }, getSession: { state: 'supported' }, openHistory: { state: 'supported' } },
          extensions: Object.keys(queries).map(name => ({ name, owner: identity.harnessInstanceId, scope: NATIVE_EXTENSIONS[name as NativeOperation].scope, permission: 'harness.read', schemaVersion: 1, support: { state: 'supported' as const } })),
        },
        driver: { core: {
          inspect: () => ({ state: 'ready', protocolVersion: 1 }),
          listSessionPage: () => ({ items: ['session-a', 'session-b', ...(options.childSessions ?? [])].map((id, index) => ({ session: session(id), summary: { id, directory: sessionDirectory(id), title: index < 2 ? `Session ${index ? 'B' : 'A'}` : id, ...(index < 2 ? {} : { parentID: 'session-a' }), time: { created: 1, updated: 1 } }, revision: 1 })), cursor: null, completeness: 'complete' }),
          getSession: input => ({ id: input.session!.nativeSessionId, directory: sessionDirectory(input.session!.nativeSessionId), title: input.session!.nativeSessionId === 'session-a' ? 'Session A' : 'Session B', time: { created: 1, updated: 1 } }),
          openHistory: input => {
            const selected = input.session!;
            return {
              capabilities: { archive: 'paged', recordStream: false, live: 'unsupported' },
              open: async () => { historyOpens.push(selected); return { fence: { id: randomUUID(), sourceGeneration: 1 } }; },
              page: async (params: { cursor?: string | null }) => {
                historyPages.push({ session: selected, cursor: params.cursor ?? null });
                const rows = options.readHistory ? await options.readHistory(selected) : history.filter(row => row.info.sessionID === selected.nativeSessionId);
                const offset = Number(params.cursor ?? 0), limit = options.historyPageSize ?? rows.length;
                const end = Math.min(rows.length, offset + limit);
                return { pageId: randomUUID(), items: rows.slice(offset, end).map(row => ({ kind: 'inline', recordId: row.info.id, value: row })), cursor: end < rows.length ? String(end) : null, completeness: end < rows.length ? 'partial' : 'complete' };
              },
              chunk: async () => { throw new Error('No streamed fixture records'); },
              read: async () => { throw new Error('No fixture live history'); }, close: async () => { historyCloses.push(selected); },
            };
          },
        }, native: Object.fromEntries(Object.entries(queries).map(([operation, value]) => [operation, async input => {
          nativeQueries.push({ operation, ...(input.session ? { session: input.session } : {}) });
          if (operation === 'getGlobalConfig') {
            const read = config;
            await options.beforeProviderRead?.();
            return read;
          }
          if (operation === 'updateGlobalConfig' && editableConfig) {
            const params = input.params;
            if (!params || typeof params !== 'object' || Array.isArray(params)) throw new Error('Fixture config parameters required');
            const { body: patch, idempotencyKey } = params as Readonly<Record<string, JsonValue>>;
            if (!patch || typeof patch !== 'object' || Array.isArray(patch) || typeof idempotencyKey !== 'string') {
              throw new Error('Fixture config patch and idempotency key required');
            }
            const changes = patch as Readonly<Record<string, JsonValue>>;
            const accepted = await editableConfig.accept({ idempotencyKey, method: operation, payload: changes });
            return editableConfig.execute(accepted.operationId, async () => {
              await options.beforeProviderWrite?.();
              config = { ...config, ...changes };
              return config;
            });
          }
          return value;
        }])) },
      }, close: async () => { await editableConfig?.close(); } };
    }, acp: async context => {
      const identity = { environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'acp' as const };
      const empty = unavailableRegistration(identity, 'starting');
      const nativeSessionId = 'archived-acp-session';
      return { registration: {
        manifest: { ...empty.manifest, core: { ...empty.manifest.core, inspect: { state: 'supported' }, listSessionPage: { state: 'supported' } } },
        driver: { core: {
          inspect: () => ({ state: 'ready', protocolVersion: 1 }),
          listSessionPage: () => ({
            items: [{
              session: { environmentId: identity.environmentId, harnessInstanceId: identity.harnessInstanceId, nativeSessionId },
              native: { sessionId: nativeSessionId, cwd: directory, title: 'Archived ACP session', _meta: { archived: true } },
            }],
            cursor: null,
            status: 'complete',
          }),
        }, native: {} },
      }, close: async () => {} };
    }, dsh: async context => {
      const identity = { environmentId: parseEnvironmentId(context.environmentId), harnessInstanceId: parseHarnessInstanceId(context.harnessInstanceId), kind: 'dsh' as const };
      const empty = unavailableRegistration(identity, 'starting');
      const operation = 'dsh.ui.account.getState';
      return { registration: {
        manifest: { ...empty.manifest,
          core: { ...empty.manifest.core, inspect: { state: 'supported' } },
          extensions: [{ name: operation, owner: identity.harnessInstanceId, scope: 'instance', permission: 'harness.read', schemaVersion: 1, support: { state: 'supported' } }],
        },
        driver: { core: { inspect: () => ({ state: 'ready', protocolVersion: 1 }) }, native: {
          [operation]: input => {
            nativeQueries.push({ operation, ...(input.session ? { session: input.session } : {}) });
            return options.dshAccount ?? null;
          },
        } },
      }, close: async () => {} };
    } },
  });
  cleanups.push(() => services.close());
  await services.start();
  const host = createRuntimeHost({ environmentId: services.target, role, services });
  cleanups.push(() => host.stop());
  host.start();
  const bridge = createBridgeRuntime({ nativeSupervisor: supervisor, acpManager: acp });
  const serverOptions = {
    host: '127.0.0.1', path: '/codex', target: 'ws://127.0.0.1:1', bridgeToken: options.bridgeToken,
    remoteServices, profilePath: path.join(stateRoot, 'profiles.json'), runtime: { ...bridge, getRuntimeHost: async () => host },
  };
  const server = createVisBridgeServer(serverOptions);
  cleanups.push(async () => { await host.stop(); server.closeAllConnections(); await new Promise<void>(resolve => server.close(() => resolve())); });
  for (let attempt = 0; ; attempt++) {
    try {
      const listening = once(server, 'listening');
      server.listen(0, '127.0.0.1');
      await listening;
      break;
    } catch (error) {
      // The loopback bind can fail before any app request is sent.
      if ((error as NodeJS.ErrnoException).code !== 'EADDRINUSE' || attempt === 2) throw error;
    }
  }
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('No owned server port');
  const endpoint = `ws://127.0.0.1:${address.port}/runtime`;
  const transport = loopbackRuntimeSocket(endpoint);
  cleanups.push(() => transport.close());
  vi.stubGlobal('WebSocket', transport.Socket);
  cleanups.push(() => { vi.unstubAllGlobals(); localStorage.clear(); });
  localStorage.clear();
  localStorage.setItem('opencode.state.sidePanelCollapsed.v1', '0');
  const element = document.createElement('div');
  document.body.append(element);
  cleanups.push(() => element.remove());
  const [{ default: App }, { i18n }] = await Promise.all([import('../App.vue'), import('../i18n')]);
  const app = createApp(App);
  app.use(i18n);
  let rendererMounted = true;
  function unmountRenderer() {
    if (!rendererMounted) return;
    rendererMounted = false;
    app.unmount();
  }
  cleanups.push(unmountRenderer);
  app.mount(element);
  await vi.waitFor(() => expectLogin(element));
  async function submitBridgeLogin(token = options.bridgeToken ?? '') {
    const input = element.querySelector<HTMLInputElement>('#bridge-url')!;
    input.value = endpoint;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    const tokenInput = element.querySelector<HTMLInputElement>('#bridge-token')!;
    tokenInput.value = token;
    tokenInput.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    element.querySelector<HTMLFormElement>('[data-testid=bridge-login]')!.dispatchEvent(new Event('submit', { bubbles: true, cancelable: true }));
  }
  async function connect() {
    await submitBridgeLogin();
    await vi.waitFor(() => {
      if (!element.querySelector('.top-panel')) throw new Error(`${element.querySelector('[role=alert]')?.textContent ?? 'App is not ready'}; ${JSON.stringify(transport.frames.slice(-3))}`);
    }, { timeout: 10000 });
  }
  async function select(title: string) {
    await vi.waitFor(() => {
      if (!element.querySelector('[data-testid=unified-search-input]')) throw new Error(`Session tree is not available: ${element.querySelector('.side-panel')?.outerHTML.slice(0, 2500) ?? element.textContent?.slice(0, 1500)}`);
    }, { timeout: 10000 });
    const input = element.querySelector<HTMLInputElement>('[data-testid=unified-search-input]')!;
    input.value = title;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    await nextTick();
    input.dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
    await vi.waitFor(() => {
      const result = [...element.querySelectorAll<HTMLButtonElement>('[data-testid=search-result]')].find(row => row.textContent?.includes(title));
      if (!result) throw new Error(`Missing search result: ${title}`);
      result.click();
    }, { timeout: 10000 });
  }
  return { element, endpoint, directory, secondDirectory, workspaceTopology: () => services.index.topology({ collection: 'workspaces' }), environmentId: services.target, historyOpens, historyCloses, historyPages, nativeQueries, frames: transport.frames, submitBridgeLogin, connect, select, unmountRenderer, unmount };
}

function expectLogin(element: HTMLElement) {
  if (!element.querySelector('[data-testid=bridge-login]')) throw new Error('Bridge login is not visible');
  if (element.querySelector('.app-login-backend')) throw new Error('Legacy Agent login is still exposed');
}
