/**
 * Todo 33 — App.vue dsh wiring integration (source-extraction pattern from
 * `kimiWebComposer.integration.test.ts`: the real setup-block fragments are
 * transpiled and executed against doubles, so the assertions run the actual
 * wiring text rather than a re-implementation of it).
 *
 * The four water bodies asserted here:
 *   1. messages   — the bridge construction (options + dual-stream surface)
 *                   and its single-instance lifecycle
 *   2. sessions   — the bootstrap pipeline call + event routing
 *   3. popup      — the three live callbacks + the reconcile callback
 *   4. lifecycle  — activation hooks, login surface, backend identity
 *
 * Adversarial guards:
 *   - stale_state: an orphaned bootstrap commits nothing and disposes its
 *     transport; a re-activation disposes the previous pair BEFORE the new
 *     bridge is constructed.
 *   - misleading_success_output: `currentBackendIdentity` is exhaustive (every
 *     kind returns a defined identity string — never `undefined`).
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { createContext, runInContext, runInNewContext } from 'node:vm';
import ts from 'typescript';
import { type Mock, afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { computed } from 'vue';

import { createDshRpcClient, deriveDshBridgeHttpUrl } from './utils/dshRpc';
import { appendCodexBridgeToken, codexBridgeHttpUrl } from './backends/codex/bridgeUrl';
import { normalizeDshHistoryPage, readDshHistoryPage } from './backends/dsh/history';
import { upsertDshSessionIntoProjects, mapDshSessionItem, mapDshSessionsToProjects } from './backends/dsh/dshAdapter';
import { createDshSelectionPersistence } from './composables/dshSelectionPersistence';
import { createDshSessionEventHub } from './composables/dshSessionEvents';
import { createDshPermissions, parseDshApprovalRequestId } from './composables/dshPermissions';
import { parseKimiWebApprovalRequestId } from './backends/kimiWeb/interactions';
import type { DshNormalizeOp } from './backends/dsh/ops';

const APP_SOURCE = readFileSync(join(process.cwd(), 'app', 'App.vue'), 'utf8');
const APP_SCRIPT_SOURCE = APP_SOURCE.match(/<script lang="ts" setup>([\s\S]*?)<\/script>/)?.[1];

if (!APP_SCRIPT_SOURCE) throw new Error('App.vue script setup block was not found');

const APP_SCRIPT = ts.createSourceFile(
  'App.vue.ts',
  APP_SCRIPT_SOURCE,
  ts.ScriptTarget.Latest,
  true,
  ts.ScriptKind.TS,
);

function appVariableDeclaration(name: string): string {
  for (const statement of APP_SCRIPT.statements) {
    if (!ts.isVariableStatement(statement)) continue;
    const declaration = statement.declarationList.declarations.find(
      (candidate) => ts.isIdentifier(candidate.name) && candidate.name.text === name,
    );
    if (declaration) {
      const keyword = statement.declarationList.flags & ts.NodeFlags.Const ? 'const' : 'let';
      return `${keyword} ${declaration.getText(APP_SCRIPT)};`;
    }
  }
  throw new Error(`App.vue variable ${name} was not found`);
}

function appFunctionDeclaration(name: string): string {
  const declaration = APP_SCRIPT.statements.find(
    (statement) => ts.isFunctionDeclaration(statement) && statement.name?.text === name,
  );
  if (!declaration) throw new Error(`App.vue function ${name} was not found`);
  return declaration.getText(APP_SCRIPT);
}

/** Every call expression to `callee`, wherever it appears at statement level. */
function appCalls(callee: string): ts.CallExpression[] {
  const found: ts.CallExpression[] = [];
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(APP_SCRIPT) === callee) {
      found.push(node);
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(APP_SCRIPT, visit);
  return found;
}

/** The object-literal argument text of a top-level call (optionally filtered). */
function appCallArgumentText(callee: string, contains?: string): string {
  const call = appCalls(callee).find((candidate) =>
    contains === undefined
      ? true
      : candidate.arguments.some((argument) => argument.getText(APP_SCRIPT).includes(contains)),
  );
  if (!call) throw new Error(`App.vue call ${callee}${contains ? ` containing ${contains}` : ''} was not found`);
  const argument = call.arguments[0];
  if (!argument) throw new Error(`App.vue call ${callee} has no argument`);
  return argument.getText(APP_SCRIPT);
}

/** A named property initializer inside a top-level call's object argument. */
function appCallPropertyInitializer(callee: string, property: string): string {
  const argumentText = appCallArgumentText(callee);
  const reparsed = ts.createSourceFile(
    'argument.ts',
    `(${argumentText})`,
    ts.ScriptTarget.Latest,
    true,
    ts.ScriptKind.TS,
  );
  const object = (reparsed.statements[0] as ts.ExpressionStatement)
    .expression as ts.ParenthesizedExpression;
  if (!ts.isObjectLiteralExpression(object.expression)) {
    throw new Error(`App.vue call ${callee} argument is not an object literal`);
  }
  const property_ = object.expression.properties.find(
    (candidate) =>
      (ts.isPropertyAssignment(candidate) || ts.isShorthandPropertyAssignment(candidate)) &&
      candidate.name?.getText(reparsed) === property,
  );
  if (!property_ || !ts.isPropertyAssignment(property_)) {
    throw new Error(`App.vue call ${callee} has no ${property} property`);
  }
  return property_.initializer.getText(reparsed);
}

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function shallowRefDouble() {
  return function shallowRef<T>(value?: T) {
    return { value };
  };
}

function box<T>(value: T): { value: T } {
  return { value };
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

const DSH_BRIDGE_URL = 'ws://localhost:23004/dsh/ws';
const DSH_BRIDGE_TOKEN = 'dsh-bridge-token';

/** A follow snapshot carrying a user message (so the normalization yields an entry). */
const SNAPSHOT = {
  type: 'snapshot',
  header: { id: 'session-entry', version: 4, createdAt: 1, cwd: '/repo', agentPreset: 'standard' },
  cursor: 5,
  hasMore: false,
  records: [
    { type: 'event', event: { type: 'session/title', seq: 0, time: 1, data: { title: 'entry' } } },
    {
      type: 'event',
      event: {
        type: 'agent/inbox/spliced',
        seq: 1,
        time: 2,
        data: {
          target: 'next-turn',
          inserted: [{ id: 'm-1', role: 'user', content: 'hi', source: { kind: 'user', rpcId: 'rpc-1' } }],
        },
      },
    },
  ],
  projections: { asOfSeq: 1, values: { permissions: { currentValue: 'workspace-write' } } },
};

/** The approval listener the bridge surface subscribes (module-level on purpose). */
const approvalListener: { current?: (request: unknown) => void } = {};

function muxDouble(order: string[] = []) {
  const opened: Array<{ endpoint: string; payload: unknown; handle: Record<string, any> }> = [];
  const disconnect = vi.fn(() => {
    order.push('mux:disconnect');
  });
  const client = {
    connect: vi.fn(async () => undefined),
    disconnect,
    isConnected: () => true,
    open: vi.fn((endpoint: string, payload: unknown) => {
      const handle: Record<string, any> = {
        streamId: `stream-${opened.length + 1}`,
        endpoint,
        payload,
        cancelled: false,
        listeners: [] as Array<(value: unknown) => void>,
        onItem(listener: (value: unknown) => void) {
          handle.listeners.push(listener);
          return () => undefined;
        },
        cancel: vi.fn(() => {
          handle.cancelled = true;
          order.push(`follow:cancel:${endpoint}`);
        }),
        promise: new Promise<readonly unknown[]>(() => undefined),
      };
      opened.push({ endpoint, payload, handle });
      order.push(`mux:open:${endpoint}`);
      // A real stream delivers its first frame on a later task, after the
      // caller attached its onItem listener synchronously below open().
      queueMicrotask(() => {
        for (const listener of [...handle.listeners]) listener(SNAPSHOT);
      });
      return handle;
    }),
    opened,
  };
  return { client, disconnect, opened };
}

function bridgeDouble(order: string[] = []) {
  return {
    attached: [] as Array<{ handle: unknown; sessionId?: string }>,
    stopped: false,
    detachFollow: vi.fn(),
    history: [] as unknown[][],
    attachFollow(handle: unknown, sessionId?: string) {
      this.attached.push({ handle, sessionId });
      order.push('bridge:attachFollow');
    },
    applyHistory(entries: unknown[]) {
      this.history.push(entries);
      order.push('bridge:applyHistory');
    },
    subscribeApprovals(listener: (request: unknown) => void) {
      approvalListener.current = listener;
      return () => undefined;
    },
    stop() {
      this.stopped = true;
      order.push('bridge:stop');
    },
  };
}

function dshPopupBridgeDouble() {
  return {
    onToolPart: vi.fn(),
    onLiveReasoning: vi.fn(),
    onLiveSubagent: vi.fn(),
    onReconcilePart: vi.fn(),
  };
}

function messageStoreDouble() {
  return {
    updateMessage: vi.fn(),
    updatePart: vi.fn(),
    removeMessage: vi.fn(),
    loadHistory: vi.fn(),
    messages: {
      value: new Map<string, { value: { info?: { sessionID: string; role: string } } }>(),
    },
  };
}

function credentialsDouble() {
  return {
    backendKind: { value: 'dsh' as string },
    dshBridgeUrl: { value: DSH_BRIDGE_URL },
    dshBridgeToken: { value: DSH_BRIDGE_TOKEN },
    saveDsh: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// 1. currentBackendIdentity — exhaustive, never undefined (the TS2322 contract)
// ---------------------------------------------------------------------------

describe('currentBackendIdentity (Todo 33 dsh case)', () => {
  const program = transpile(
    `${appFunctionDeclaration('currentBackendIdentity')};currentBackendIdentity();`,
  );

  function identityFor(kind: string, dshBridgeUrl = DSH_BRIDGE_URL): unknown {
    return runInNewContext(program, {
      activeBackendKind: box(kind),
      credentials: {
        codexBridgeUrl: box('ws://localhost:23004/codex'),
        acpBridgeUrl: box('ws://localhost:23004'),
        acpAgentId: box('agent-1'),
        kimiWebBridgeUrl: box('ws://localhost:23004/kimi-web/ws'),
        dshBridgeUrl: box(dshBridgeUrl),
        url: box('http://localhost:4096'),
      },
    });
  }

  it('returns the dsh identity for the dsh backend kind', () => {
    expect(identityFor('dsh')).toBe(`dsh:${DSH_BRIDGE_URL}`);
  });

  it('keeps every backend kind exhaustive (no undefined identity)', () => {
    for (const kind of ['codex', 'acp', 'kimi-web', 'dsh', 'opencode']) {
      const identity = identityFor(kind);
      expect(typeof identity).toBe('string');
      expect(String(identity).length).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 2. bootstrapDshWorkspace — singleton construction, four bodies, stale state
// ---------------------------------------------------------------------------

const DSH_BOOTSTRAP_DECLARATIONS = [
  appVariableDeclaration('dshSelectionPersistence'),
  appVariableDeclaration('dshInitialSelectionConsumed'),
  appVariableDeclaration('dshMessageBridge'),
  appVariableDeclaration('dshMuxClient'),
  appVariableDeclaration('dshFollowStreams'),
  appVariableDeclaration('dshSessionEvents'),
  appVariableDeclaration('dshPermissions'),
  appFunctionDeclaration('dshRecord'),
  appFunctionDeclaration('dshBackend'),
  appFunctionDeclaration('dshRpcClient'),
  appFunctionDeclaration('dshSnapshotSessionId'),
  appFunctionDeclaration('dshBootstrapNormalizer'),
  appFunctionDeclaration('dshFetchSessionPage'),
  appVariableDeclaration('dshBootstrapFetchPage'),
  appFunctionDeclaration('dshReadFirstFollowFrame'),
  appFunctionDeclaration('dshAdoptFollow'),
  appFunctionDeclaration('dshDisposeFollow'),
  appFunctionDeclaration('dshAttachFollow'),
  appFunctionDeclaration('dshCreateMessageBridge'),
  appFunctionDeclaration('disconnectDshBackend'),
  appFunctionDeclaration('bootstrapDshWorkspace'),
].join('\n');

describe('bootstrapDshWorkspace (Todo 33 dsh bridge construction)', () => {
  beforeEach(() => window.localStorage.clear());
  const DECLARATIONS = DSH_BOOTSTRAP_DECLARATIONS;

  type BootstrapSandbox = {
    bootstrapDshWorkspace: (isCurrent: () => boolean) => Promise<void>;
    disconnectDshBackend: () => void;
    selectedProjectId: { value: string };
    selectedSessionId: { value: string };
    dshMessageBridge: { value: unknown };
    dshMuxClient: { value: unknown };
    dshFollowStreams: Map<string, unknown>;
    dshPermissions: {
      isApprovalUiEnabled: () => boolean;
      state: { permissionPreset: string; agentPreset: string };
    };
    dshSessionEvents: {
      onSessionEvent: (listener: (op: DshNormalizeOp, context: unknown) => void) => () => void;
    };
  };

  function createSandbox(options: { current?: boolean; initialSessionId?: string } = {}) {
    const current = options.current ?? true;
    approvalListener.current = undefined;
    const order: string[] = [];
    const mux = muxDouble(order);
    const bridge = bridgeDouble(order);
    const popup = dshPopupBridgeDouble();
    const msg = messageStoreDouble();
    const credentials = credentialsDouble();
    const adapter = {
      kind: 'dsh',
      listSessions: vi.fn(async () => []),
      forkSession: vi.fn(async () => ({})),
      abortSession: vi.fn(async () => undefined),
      updateSession: vi.fn(async () => ({})),
    };
    const DshAdapterDouble = class DshAdapter {};
    Object.setPrototypeOf(adapter, DshAdapterDouble.prototype);
    const upsertPermissionEntry = vi.fn();
    const removePermissionEntry = vi.fn();
    const gitHydration = vi.fn();
    const disconnectDshBackendAdapter = vi.fn();
    const capturedBridgeOptions: Array<Record<string, unknown>> = [];
    const sessionEventSpy = vi.fn();
    const bootstrapCalls: Array<Record<string, unknown>> = [];

    const runDshBootstrap = vi.fn(
      async (bootstrapOptions: Record<string, any>) => {
        bootstrapCalls.push(bootstrapOptions);
        const createBridge = bootstrapOptions.createBridge as () => unknown;
        const commit = bootstrapOptions.commit as (state: {
          projects: Record<string, unknown>;
          selectedProjectId: string;
          selectedSessionId: string;
        }) => void;
        const normalize = bootstrapOptions.normalize as {
          normalizeSnapshot: (value: unknown) => { cursor: number; entries: unknown[] };
        };
        const muxSeam = bootstrapOptions.mux as {
          open: (endpoint: string, payload: unknown) => any;
          disconnect: () => void;
        };
        const handle = muxSeam.open('session/follow', {
          args: { request: { address: { kind: 'session', sessionId: 'session-entry' } } },
        });
        if (!current) {
          // The real pipeline disposes its own transport on an orphaned run.
          handle.cancel();
          (createBridge() as { stop: () => void }).stop();
          muxSeam.disconnect();
          return { tree: {} };
        }
        normalize.normalizeSnapshot(SNAPSHOT);
        commit({
          projects: mapDshSessionsToProjects([mapDshSessionItem({ sessionId: 'session-entry', workspaceId: 'workspace-1', cwd: '/repo' })]),
          selectedProjectId: 'workspace-1',
          selectedSessionId: 'session-entry',
        });
        return { follow: handle, tree: {} };
      },
    );

    const sandbox = runInNewContext(
      transpile(
        `${DECLARATIONS}\n;({ bootstrapDshWorkspace, disconnectDshBackend, selectedProjectId, selectedSessionId, dshMessageBridge, dshMuxClient, dshFollowStreams, dshPermissions, dshSessionEvents });`,
      ),
      {
        shallowRef: shallowRefDouble(),
        createDshSessionEventHub,
        createDshSelectionPersistence,
        createDshPermissions,
        upsertPermissionEntry,
        removePermissionEntry,
        getActiveBackendAdapter: () => adapter,
        DshAdapter: DshAdapterDouble,
        configureDshBackend: vi.fn(() => adapter),
        createDshMuxClient: vi.fn(() => {
          order.push('mux:create');
          return mux.client;
        }),
        useDshMessageBridge: vi.fn((bridgeOptions: Record<string, unknown>) => {
          order.push('bridge:construct');
          capturedBridgeOptions.push(bridgeOptions);
          return bridge;
        }),
        runDshBootstrap,
        initialQuery: { sessionId: options.initialSessionId ?? 'session-entry' },
        dshSubagentModes: new Map(),
        deriveDshBridgeHttpUrl,
        readDshHistoryPage,
        normalizeDshHistoryPage,
        createDshRpcClient: vi.fn(() => ({ call: vi.fn(async () => ({})) })),
        msg,
        credentials,
        serverState: { projects: {} as Record<string, unknown> },
        selectedProjectId: box(''),
        selectedSessionId: box(''),
        bootstrapReady: box(false),
        scheduleDshTopPanelGitInfoHydration: gitHydration,
        dshPopupBridge: popup,
        disconnectDshBackendAdapter,
      },
    ) as BootstrapSandbox;

    // Subscribe through the REAL hub the wiring created: the bridge's
    // onSessionEvent must reach every hub listener.
    sandbox.dshSessionEvents.onSessionEvent((op, context) => sessionEventSpy(op, context));

    return {
      sandbox,
      order,
      mux,
      bridge,
      popup,
      msg,
      credentials,
      adapter,
      upsertPermissionEntry,
      removePermissionEntry,
      gitHydration,
      disconnectDshBackendAdapter,
      capturedBridgeOptions,
      sessionEventSpy,
      bootstrapCalls,
    };
  }

  it('passes the persisted session into bootstrap and commits its refreshed project identity', async () => {
    // Given: a prior selection with a project identity that no longer exists.
    const persistence = createDshSelectionPersistence();
    persistence.commit(DSH_BRIDGE_URL, mapDshSessionsToProjects([
      mapDshSessionItem({ sessionId: 'session-entry', workspaceId: 'old-project', cwd: '/repo' }),
    ]), 'session-entry');
    const harness = createSandbox({ initialSessionId: '' });
    // When: App's extracted bootstrap runs with the real persistence helper.
    await harness.sandbox.bootstrapDshWorkspace(() => true);
    // Then: it requests the saved session and commits the project from the new baseline.
    expect(harness.bootstrapCalls[0]?.preferredSessionId).toBe('session-entry');
    expect(harness.sandbox.selectedSessionId.value).toBe('session-entry');
    expect(harness.sandbox.selectedProjectId.value).toBe('workspace-1');
    expect(createDshSelectionPersistence().preferredSessionId(DSH_BRIDGE_URL)).toBe('session-entry');
  });

  it('constructs exactly one bridge and wires the four water bodies', async () => {
    const harness = createSandbox();

    await harness.sandbox.bootstrapDshWorkspace(() => true);

    // messages: one bridge, one mux client, the shared facade, the page source.
    expect(harness.capturedBridgeOptions).toHaveLength(1);
    const bridgeOptions = harness.capturedBridgeOptions[0]!;
    expect(bridgeOptions.mux).toBe(harness.mux.client);
    expect((bridgeOptions.rpc as { baseUrl: string }).baseUrl).toBe(
      deriveDshBridgeHttpUrl(DSH_BRIDGE_URL),
    );
    expect(bridgeOptions.msg).toBe(harness.msg);
    expect(typeof bridgeOptions.fetchPage).toBe('function');

    // popup: the three live callbacks + the reconcile callback are the popup
    // bridge's own functions (nothing re-implemented at the seam).
    expect(bridgeOptions.onToolPart).toBe(harness.popup.onToolPart);
    expect(bridgeOptions.onLiveReasoning).toBe(harness.popup.onLiveReasoning);
    expect(bridgeOptions.onLiveSubagent).toBe(harness.popup.onLiveSubagent);
    expect(bridgeOptions.onReconcilePart).toBe(harness.popup.onReconcilePart);

    // sessions: ops route to the permission surface AND the shared hub, and
    // the bootstrap snapshot seeded the preset state (Todo 28).
    const policyOp: DshNormalizeOp = {
      kind: 'policy',
      policy: 'permission-preset',
      value: 'danger-full-access',
      time: 3,
    };
    (bridgeOptions.onSessionEvent as (op: DshNormalizeOp, context: unknown) => void)(policyOp, {
      origin: 'live',
      sessionId: 'session-entry',
    });
    expect(harness.sessionEventSpy).toHaveBeenCalledWith(policyOp, {
      origin: 'live',
      sessionId: 'session-entry',
    });
    expect(harness.sandbox.dshPermissions.state.permissionPreset).toBe('danger-full-access');
    (bridgeOptions.onSessionEvent as (op: DshNormalizeOp, context: unknown) => void)({ ...policyOp, value: 'read-only' }, { origin: 'live', sessionId: 'child-session' });
    expect(harness.sandbox.dshPermissions.state.permissionPreset).toBe('danger-full-access');
    expect(harness.sandbox.dshPermissions.state.agentPreset).toBe('standard');
    expect(harness.sandbox.dshPermissions.isApprovalUiEnabled()).toBe(true);

    // lifecycle: the pair is published, the follow is registered once, git
    // hydration is scheduled, and the pipeline got the real seams.
    expect(harness.sandbox.dshMessageBridge.value).toBe(harness.bridge);
    expect(harness.sandbox.dshMuxClient.value).toBe(harness.mux.client);
    expect([...harness.sandbox.dshFollowStreams.keys()]).toEqual(['session-entry']);
    expect(harness.gitHydration).toHaveBeenCalledTimes(1);
    expect(harness.bootstrapCalls).toHaveLength(1);
    expect(harness.bootstrapCalls[0]!.adapter).toBe(harness.adapter);
    expect(harness.bootstrapCalls[0]!.normalize).toBeTypeOf('object');
    expect(harness.bootstrapCalls[0]!.fetchPage).toBeTypeOf('function');
  });

  it('disposes the previous pair before constructing a new bridge on re-activation', async () => {
    const harness = createSandbox();

    await harness.sandbox.bootstrapDshWorkspace(() => true);
    const firstMux = harness.mux.client;
    const firstBridge = harness.bridge;
    harness.order.length = 0;

    // A backend switch disposes; the re-activation rebuilds.
    harness.sandbox.disconnectDshBackend();
    expect(firstBridge.stopped).toBe(true);
    expect(firstMux.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.disconnectDshBackendAdapter).toHaveBeenCalled();

    await harness.sandbox.bootstrapDshWorkspace(() => true);

    expect(harness.capturedBridgeOptions).toHaveLength(2);
    // Disposal happened BEFORE the second construction (no double bridge).
    expect(harness.order.indexOf('bridge:stop')).toBeLessThan(
      harness.order.indexOf('bridge:construct'),
    );
    expect(harness.order.indexOf('mux:disconnect')).toBeLessThan(
      harness.order.indexOf('bridge:construct'),
    );
  });

  it('commits nothing and disposes its transport when the activation is orphaned', async () => {
    const harness = createSandbox({ current: false });

    await harness.sandbox.bootstrapDshWorkspace(() => false);

    expect(harness.sandbox.dshMessageBridge.value).toBeUndefined();
    expect(harness.sandbox.dshMuxClient.value).toBeUndefined();
    expect(harness.mux.client.disconnect).toHaveBeenCalledTimes(1);
    expect(harness.bridge.stopped).toBe(true);
    expect(harness.gitHydration).not.toHaveBeenCalled();
    expect([...harness.sandbox.dshFollowStreams.keys()]).toEqual([]);
  });

  it('keeps the permission windows bound to the existing surface', async () => {
    const harness = createSandbox();
    await harness.sandbox.bootstrapDshWorkspace(() => true);

    // The bridge subscribes through the post-construction seam (attach), and
    // an approval request opens the shared permission window.
    expect(typeof approvalListener.current).toBe('function');
    approvalListener.current?.({
      eventId: 'evt-1',
      agentId: 'a',
      sessionId: 'session-entry',
      request: {},
    });
    expect(harness.upsertPermissionEntry).toHaveBeenCalledTimes(1);
    expect(harness.upsertPermissionEntry.mock.calls[0]![0]).toMatchObject({
      id: 'dsh-approval:evt-1',
      sessionID: 'session-entry',
    });
  });
});

type AdapterDouble = {
  kind: string;
  disposed: boolean;
  listSessions: Mock<() => Promise<unknown[]>>;
  disconnect: () => void;
};

function registryDouble(order: string[], DshAdapter: new () => unknown) {
  let current: AdapterDouble | undefined;
  const built: AdapterDouble[] = [];
  const configureDshBackend = vi.fn((_options: { bridgeUrl: string; bridgeToken?: string }) => {
    order.push('registry:configure');
    const adapter: AdapterDouble = {
      kind: 'dsh',
      disposed: false,
      listSessions: vi.fn(async () => {
        if (adapter.disposed) throw new Error('dsh mux: client disconnected');
        return [];
      }),
      disconnect() {
        adapter.disposed = true;
        order.push('registry:adapter-dispose');
      },
    };
    Object.setPrototypeOf(adapter, DshAdapter.prototype);
    built.push(adapter);
    current = adapter;
    return adapter;
  });
  return {
    built,
    configureDshBackend,
    getActiveBackendAdapter: vi.fn((): AdapterDouble => {
      if (!current) throw new Error('Backend adapter is not registered: dsh');
      return current;
    }),
    disconnectDshBackend: vi.fn(() => {
      order.push('registry:disconnect');
      current?.disconnect();
      current = undefined;
    }),
  };
}

describe('bootstrapDshWorkspace — adapter identity across the disposal (defect D1)', () => {
  function createSandbox() {
    const order: string[] = [];
    const mux = muxDouble(order);
    const bridge = bridgeDouble(order);
    const DshAdapterDouble = class DshAdapter {};
    const registry = registryDouble(order, DshAdapterDouble);
    const bootstrapCalls: Array<Record<string, any>> = [];
    const runDshBootstrap = vi.fn(async (bootstrapOptions: Record<string, any>) => {
      bootstrapCalls.push(bootstrapOptions);
      // The real pipeline's first statement (bootstrap.ts:223): it walks the
      // sessions through the adapter, whose mux the disposal may have poisoned.
      const sessions = await bootstrapOptions.adapter.listSessions();
      const createBridge = bootstrapOptions.createBridge as () => unknown;
      const commit = bootstrapOptions.commit as (state: {
        projects: Record<string, unknown>;
        selectedProjectId: string;
        selectedSessionId: string;
      }) => void;
      const normalize = bootstrapOptions.normalize as {
        normalizeSnapshot: (value: unknown) => { cursor: number; entries: unknown[] };
      };
      const handle = (bootstrapOptions.mux as { open: (e: string, p: unknown) => unknown }).open(
        'session/follow',
        { args: { request: { address: { kind: 'session', sessionId: 'session-entry' } } } },
      );
      normalize.normalizeSnapshot(SNAPSHOT);
      commit({ projects: {}, selectedProjectId: 'workspace-1', selectedSessionId: 'session-entry' });
      createBridge();
      return { follow: handle, tree: { sessions } };
    });

    const sandbox = runInNewContext(
      transpile(
        `${DSH_BOOTSTRAP_DECLARATIONS}\n;({ bootstrapDshWorkspace, dshMessageBridge, dshMuxClient, dshFollowStreams });`,
      ),
      {
        shallowRef: shallowRefDouble(),
        createDshSessionEventHub,
        createDshSelectionPersistence,
        createDshPermissions,
        upsertPermissionEntry: vi.fn(),
        removePermissionEntry: vi.fn(),
        getActiveBackendAdapter: registry.getActiveBackendAdapter,
        DshAdapter: DshAdapterDouble,
        configureDshBackend: registry.configureDshBackend,
        createDshMuxClient: vi.fn(() => {
          order.push('mux:create');
          return mux.client;
        }),
        useDshMessageBridge: vi.fn(() => {
          order.push('bridge:construct');
          return bridge;
        }),
        runDshBootstrap,
        initialQuery: { sessionId: 'session-entry' },
        dshSubagentModes: new Map(),
        deriveDshBridgeHttpUrl,
        readDshHistoryPage,
        normalizeDshHistoryPage,
        createDshRpcClient: vi.fn(() => ({ call: vi.fn(async () => ({})) })),
        msg: messageStoreDouble(),
        credentials: credentialsDouble(),
        serverState: { projects: {} as Record<string, unknown> },
        selectedProjectId: box(''),
        selectedSessionId: box(''),
        bootstrapReady: box(false),
        scheduleDshTopPanelGitInfoHydration: vi.fn(),
        dshPopupBridge: dshPopupBridgeDouble(),
        disconnectDshBackendAdapter: registry.disconnectDshBackend,
      },
    ) as { bootstrapDshWorkspace: (isCurrent: () => boolean) => Promise<void> };

    return { sandbox, order, registry, mux, bridge, bootstrapCalls };
  }

  it('bootstraps against a FRESH adapter, not the one its disposal just poisoned', async () => {
    const harness = createSandbox();
    // useBackendActivation.activateDsh configures the backend before bootstrap.
    harness.registry.configureDshBackend({
      bridgeUrl: DSH_BRIDGE_URL,
      bridgeToken: DSH_BRIDGE_TOKEN,
    });

    await harness.sandbox.bootstrapDshWorkspace(() => true);

    const used = harness.bootstrapCalls[0]!.adapter as unknown as AdapterDouble;
    expect(used).toBeDefined();
    // RED at HEAD: the captured adapter was disposed above, so its mux is
    // permanently poisoned and this rejects with `client disconnected`.
    await expect(used.listSessions()).resolves.toEqual([]);
    expect(used.disposed).toBe(false);
  });

  it('re-activates against a newly built adapter and still disposes first', async () => {
    const harness = createSandbox();
    const configure = () =>
      harness.registry.configureDshBackend({
        bridgeUrl: DSH_BRIDGE_URL,
        bridgeToken: DSH_BRIDGE_TOKEN,
      });

    configure();
    await harness.sandbox.bootstrapDshWorkspace(() => true);
    const first = harness.bootstrapCalls[0]!.adapter as unknown as AdapterDouble;

    configure();
    harness.order.length = 0;
    await harness.sandbox.bootstrapDshWorkspace(() => true);

    const second = harness.bootstrapCalls[1]!.adapter as unknown as AdapterDouble;
    expect(second).not.toBe(first);
    expect(second.disposed).toBe(false);
    await expect(second.listSessions()).resolves.toEqual([]);
    // Single-instance governance survives: the disposal still precedes the
    // fresh construction, so no stale bridge answers the new waterfall.
    expect(harness.order.indexOf('registry:disconnect')).toBeLessThan(
      harness.order.indexOf('registry:configure'),
    );
  });
});

// ---------------------------------------------------------------------------
// 3. dshSendApi — the composer's guarded send seam (Todo 25 routing)
// ---------------------------------------------------------------------------

describe('dshSendApi (Todo 25 send routing)', () => {
  const DECLARATIONS = [
    appVariableDeclaration('dshMessageBridge'),
    appVariableDeclaration('dshMuxClient'),
    appFunctionDeclaration('dshBackend'),
    appFunctionDeclaration('dshRpcClient'),
    appFunctionDeclaration('dshIsServerTerminal'),
    appFunctionDeclaration('dshIsBlankSession'),
    appVariableDeclaration('dshSendApi'),
  ].join('\n');

  type SendSandbox = {
    dshSendApi: {
      prompt: (request: unknown) => Promise<unknown>;
      abortSession: (sessionId: string) => Promise<unknown>;
      sessionIdForCwd: (cwd: string) => Promise<string | null>;
      isServerTerminal: () => boolean;
      isBlankSession: (sessionId: string) => boolean;
    };
    dshMessageBridge: { value: unknown };
    dshMuxClient: { value: unknown };
  };

  function createSandbox(
    input: {
      syncKind?: string;
      connected?: boolean;
      loadingHistory?: boolean;
      messages?: Array<{ sessionID: string; role: string }>;
    } = {},
  ) {
    const call = vi.fn(async () => ({ accepted: true }));
    const createDshRpcClient = vi.fn(() => ({ call }));
    const adapter = {
      kind: 'dsh',
      listSessions: vi.fn(async () => [
        { id: 'session-a' },
        { id: 'session-b', time: { archived: 1 } },
      ]),
      abortSession: vi.fn(async () => undefined),
    };
    const DshAdapterDouble = class DshAdapter {};
    Object.setPrototypeOf(adapter, DshAdapterDouble.prototype);
    const store = messageStoreDouble();
    for (const message of input.messages ?? []) {
      store.messages.value.set(`m-${message.sessionID}-${message.role}`, {
        value: { info: message },
      });
    }
    const mux = { isConnected: () => input.connected ?? true };
    const bridgeState = { syncState: () => ({ kind: input.syncKind ?? 'live' }) };

    const sandbox = runInNewContext(
      transpile(`${DECLARATIONS}\n;({ dshSendApi, dshMessageBridge, dshMuxClient });`),
      {
        shallowRef: shallowRefDouble(),
        getActiveBackendAdapter: () => adapter,
        DshAdapter: DshAdapterDouble,
        createDshRpcClient,
        deriveDshBridgeHttpUrl,
        credentials: credentialsDouble(),
        selectedSessionId: box('session-a'),
        isLoadingHistory: box(input.loadingHistory ?? false),
        msg: store,
      },
    ) as SendSandbox;

    // The refs are the wiring's own (declared inside the program), so the
    // doubles are installed through them — never through the context, which
    // the program's own declarations shadow.
    sandbox.dshMessageBridge.value = input.syncKind === undefined ? undefined : bridgeState;
    sandbox.dshMuxClient.value = mux;

    return { sandbox, call, adapter, createDshRpcClient };
  }

  it('sends the prompt envelope with its bound rpcId (Todo 20 binding)', async () => {
    const harness = createSandbox();
    const request = {
      type: 'client-request',
      rpcId: 'rpc-bound-1',
      method: 'session/prompt',
      payload: {
        args: { request: { requestId: 'rpc-bound-1', sessionId: 'session-a', mode: 'queue' } },
      },
    };

    await harness.sandbox.dshSendApi.prompt(request);

    expect(harness.call).toHaveBeenCalledWith('session', 'prompt', request.payload.args, {
      rpcId: 'rpc-bound-1',
    });
  });

  it('routes cancellation through the adapter abortSession', async () => {
    const harness = createSandbox();
    await harness.sandbox.dshSendApi.abortSession('session-a');
    expect(harness.adapter.abortSession).toHaveBeenCalledWith('session-a');
  });

  it('resolves the session for the selected worktree cwd', async () => {
    const harness = createSandbox();
    await expect(harness.sandbox.dshSendApi.sessionIdForCwd('/repo')).resolves.toBe('session-a');
    expect(harness.adapter.listSessions).toHaveBeenCalledWith({ directory: '/repo' });
  });

  it('keeps the selected session when another session in the cwd was updated more recently', async () => {
    const harness = createSandbox();
    harness.adapter.listSessions.mockResolvedValue([
      { id: 'session-newer' }, { id: 'session-a' },
    ]);
    await expect(harness.sandbox.dshSendApi.sessionIdForCwd('/repo')).resolves.toBe('session-a');
  });

  it('fails closed when the stream is terminal', () => {
    expect(createSandbox({ connected: false }).sandbox.dshSendApi.isServerTerminal()).toBe(true);
    expect(createSandbox({ syncKind: 'detached' }).sandbox.dshSendApi.isServerTerminal()).toBe(
      true,
    );
    expect(createSandbox({ syncKind: 'live' }).sandbox.dshSendApi.isServerTerminal()).toBe(false);
  });

  it('never claims a blank session while history is unsettled or a user message exists', () => {
    expect(
      createSandbox({ loadingHistory: true }).sandbox.dshSendApi.isBlankSession('session-a'),
    ).toBe(false);
    expect(
      createSandbox({ messages: [{ sessionID: 'session-a', role: 'user' }] }).sandbox.dshSendApi
        .isBlankSession('session-a'),
    ).toBe(false);
    expect(
      createSandbox({ messages: [{ sessionID: 'session-other', role: 'user' }] }).sandbox
        .dshSendApi.isBlankSession('session-a'),
    ).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. dshSessionApi — session action routing (Todo 27)
// ---------------------------------------------------------------------------

describe('dshSessionApi (Todo 27 session action routing)', () => {
  const DECLARATIONS = [
    appVariableDeclaration('dshMessageBridge'),
    appVariableDeclaration('dshMuxClient'),
    appVariableDeclaration('dshFollowStreams'),
    appVariableDeclaration('dshSessionEvents'),
    appVariableDeclaration('dshPermissions'),
    appFunctionDeclaration('dshRecord'),
    appFunctionDeclaration('dshBackend'),
    appFunctionDeclaration('dshRpcClient'),
    appFunctionDeclaration('dshSnapshotSessionId'),
    appFunctionDeclaration('dshBootstrapNormalizer'),
    appFunctionDeclaration('dshFetchSessionPage'),
    appVariableDeclaration('dshBootstrapFetchPage'),
    appFunctionDeclaration('dshReadFirstFollowFrame'),
    appFunctionDeclaration('dshAdoptFollow'),
    appFunctionDeclaration('dshDisposeFollow'),
    appFunctionDeclaration('dshDisposeSessionFollow'),
    appFunctionDeclaration('dshFollowSession'),
    appVariableDeclaration('dshSessionApi'),
  ].join('\n');

  type SessionSandbox = {
    dshSessionApi: {
      renameSession: (sessionId: string, title: string) => Promise<unknown>;
      archiveSession: (sessionId: string) => Promise<unknown>;
      unarchiveSession: (sessionId: string) => Promise<unknown>;
      pinSession: (sessionId: string) => Promise<unknown>;
      unpinSession: (sessionId: string) => Promise<unknown>;
      forkSession: (sessionId: string, atSeq?: number) => Promise<unknown>;
      followSession: (sessionId: string) => Promise<{ archived?: boolean }>;
      disposeSessionFollow: (sessionId: string) => void;
    };
    dshFollowStreams: Map<string, { cancelled: boolean }>;
    dshMessageBridge: { value: unknown };
    dshMuxClient: { value: unknown };
  };

  function createSandbox(input: { archivedSessions?: string[] } = {}) {
    const mux = muxDouble();
    const bridge = bridgeDouble();
    const adapter = {
      kind: 'dsh',
      listSessions: vi.fn(async () =>
        (input.archivedSessions ?? []).map((id) => ({ id, projectID: 'dsh:/tmp/dsh', projectId: 'dsh:/tmp/dsh', workspaceId: 'dsh:/tmp/dsh', directory: '/tmp/dsh', title: id, status: 'unknown', time: { created: 1, updated: 1, archived: 1 } })),
      ),
      forkSession: vi.fn(async () => ({ sessionId: 'session-forked' })),
      updateSession: vi.fn(async () => ({})),
    };
    const DshAdapterDouble = class DshAdapter {};
    Object.setPrototypeOf(adapter, DshAdapterDouble.prototype);
    const sandbox = runInNewContext(
      transpile(
        `${DECLARATIONS}\n;({ dshSessionApi, dshFollowStreams, dshMessageBridge, dshMuxClient });`,
      ),
      {
        shallowRef: shallowRefDouble(),
        createDshSessionEventHub,
        createDshSelectionPersistence,
        createDshPermissions,
        upsertPermissionEntry: vi.fn(),
        removePermissionEntry: vi.fn(),
        getActiveBackendAdapter: () => adapter,
        DshAdapter: DshAdapterDouble,
        createDshRpcClient: vi.fn(() => ({ call: vi.fn(async () => ({})) })),
        deriveDshBridgeHttpUrl,
        readDshHistoryPage,
        normalizeDshHistoryPage,
        credentials: credentialsDouble(),
        dshPopupBridge: dshPopupBridgeDouble(),
        upsertDshSessionIntoProjects,
        serverState: { projects: {} },
        selectedSessionId: { value: 'session-forked' },
      },
    ) as SessionSandbox;
    // Install the doubles through the wiring's own refs (the program's
    // declarations shadow the sandbox context).
    sandbox.dshMessageBridge.value = bridge;
    sandbox.dshMuxClient.value = mux.client;
    return { sandbox, adapter, mux, bridge };
  }

  it('maps the dsh payload vocabulary onto updateSession', async () => {
    const harness = createSandbox();
    await harness.sandbox.dshSessionApi.renameSession('s1', 'renamed');
    expect(harness.adapter.updateSession).toHaveBeenCalledWith('s1', { title: 'renamed' });
    await harness.sandbox.dshSessionApi.archiveSession('s1');
    expect(harness.adapter.updateSession).toHaveBeenLastCalledWith('s1', {
      time: { archived: expect.any(Number) },
    });
    await harness.sandbox.dshSessionApi.unarchiveSession('s1');
    expect(harness.adapter.updateSession).toHaveBeenLastCalledWith('s1', { time: { archived: 0 } });
    await harness.sandbox.dshSessionApi.pinSession('s1');
    expect(harness.adapter.updateSession).toHaveBeenLastCalledWith('s1', {
      time: { pinned: expect.any(Number) },
    });
    await harness.sandbox.dshSessionApi.unpinSession('s1');
    expect(harness.adapter.updateSession).toHaveBeenLastCalledWith('s1', { time: { pinned: 0 } });
  });

  it('forks without an atSeq when no checkpoint is passed', async () => {
    const harness = createSandbox();
    await harness.sandbox.dshSessionApi.forkSession('s1');
    expect(harness.adapter.forkSession).toHaveBeenCalledWith('s1');
  });

  it('opens a FRESH follow for the forked session and adopts its snapshot', async () => {
    const harness = createSandbox({ archivedSessions: ['session-forked'] });
    // A stale stream for the same session must be disposed first (R7).
    const stale = {
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
    };
    harness.sandbox.dshFollowStreams.set('session-forked', stale);

    const outcome = await harness.sandbox.dshSessionApi.followSession('session-forked');

    expect(stale.cancelled).toBe(true);
    const opened = harness.mux.opened.filter((entry) => entry.endpoint === 'session/follow');
    expect(opened).toHaveLength(1);
    expect(opened[0]!.payload).toEqual({
      args: { request: { address: { kind: 'session', sessionId: 'session-forked' }, assistantStream: true } },
    });
    // Attached with the join-time binding and the snapshot published.
    expect(harness.bridge.attached).toEqual([
      { handle: opened[0]!.handle, sessionId: 'session-forked' },
    ]);
    expect(harness.bridge.history).toHaveLength(1);
    // The fork's archive flag is restored from the authoritative session list.
    expect(outcome).toEqual({ archived: true });
  });

  it('disposes a session follow stream on request', () => {
    const harness = createSandbox();
    const handle = {
      cancelled: false,
      cancel() {
        this.cancelled = true;
      },
    };
    harness.sandbox.dshFollowStreams.set('s1', handle);
    harness.sandbox.dshSessionApi.disposeSessionFollow('s1');
    expect(handle.cancelled).toBe(true);
    expect(harness.sandbox.dshFollowStreams.has('s1')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 5. Login surface + activation hooks + permission reply routing
// ---------------------------------------------------------------------------

describe('dsh lifecycle wiring (Todo 33)', () => {
  const LOGIN_BOXES = {
    loginCodexBridgeUrl: box(''),
    loginCodexBridgeToken: box(''),
    loginAcpBridgeUrl: box(''),
    loginAcpBridgeToken: box(''),
    loginAcpAgentId: box(''),
    loginKimiWebBridgeUrl: box(''),
    loginKimiWebBridgeToken: box(''),
    loginDshBridgeUrl: box('ws://localhost:23004/dsh/ws'),
    loginDshBridgeToken: box('dsh-bridge-token'),
    loginRequiresAuth: box(false),
    loginUsername: box(''),
    loginPassword: box(''),
    loginUrl: box(''),
  };

  function runHandleLogin(input: { dshBridgeUrl?: string; saveDsh?: () => void } = {}) {
    const program = transpile(`${appFunctionDeclaration('handleLogin')};handleLogin();`);
    const credentials = credentialsDouble();
    if (input.saveDsh) credentials.saveDsh.mockImplementation(input.saveDsh);
    const startInitialization = vi.fn();
    const initErrorMessage = box('');
    runInNewContext(program, {
      ...LOGIN_BOXES,
      loginBackendKind: box('dsh'),
      loginDshBridgeUrl: box(input.dshBridgeUrl ?? 'ws://localhost:23004/dsh/ws'),
      credentials,
      startInitialization,
      initErrorMessage,
      toErrorMessage: (error: unknown) =>
        error instanceof Error ? error.message : String(error),
    });
    return { credentials, startInitialization, initErrorMessage };
  }

  it('saves dsh credentials and starts initialization from the login form', () => {
    const { credentials, startInitialization } = runHandleLogin();
    expect(credentials.saveDsh).toHaveBeenCalledWith(
      'ws://localhost:23004/dsh/ws',
      'dsh-bridge-token',
    );
    expect(startInitialization).toHaveBeenCalledTimes(1);
  });

  it('surfaces a rejected empty dsh bridge URL instead of starting', () => {
    const { startInitialization, initErrorMessage } = runHandleLogin({
      dshBridgeUrl: '  ',
      saveDsh: () => {
        throw new Error('dsh bridge URL is required.');
      },
    });
    expect(startInitialization).not.toHaveBeenCalled();
    expect(initErrorMessage.value).toBe('dsh bridge URL is required.');
  });

  it('passes the four dsh activation hooks to useBackendActivation', () => {
    const activationOptions = appCallArgumentText('useBackendActivation');
    // The precheck keeps the default (dshRpc account/getState); the other
    // hooks are satisfied here (no more "not wired" throw).
    expect(activationOptions).toContain('configureDshBackend');
    expect(activationOptions).toContain('disconnectDshBackend');
    expect(activationOptions).toContain('bootstrapDshWorkspace');
    expect(activationOptions).not.toContain('precheckDshConnection');
  });

  it('configures the dsh backend from credentials in the watchEffect', () => {
    const watchEffectText = appCallArgumentText('watchEffect', 'configureDshBackend');
    expect(watchEffectText).toContain('configureDshBackend({');
    expect(watchEffectText).toContain('credentials.dshBridgeUrl.value');
    expect(watchEffectText).toContain('credentials.dshBridgeToken.value');
  });

  it('routes dsh permission replies through the dsh permission surface', () => {
    const sendReplyText = appCallPropertyInitializer('usePermissions', 'sendReply');
    const program = transpile(
      `const sendReply = ${sendReplyText};sendReply("dsh-approval:evt-9", "once");`,
    );
    const dshPermissions = { replyToPermission: vi.fn() };
    runInNewContext(program, {
      activeBackendKind: box('dsh'),
      parseDshApprovalRequestId,
      parseKimiWebApprovalRequestId,
      replyKimiWebApproval: vi.fn(),
      dshPermissions,
      getActiveBackendAdapter: () => ({ replyPermission: undefined }),
      activeDirectory: box('/repo'),
      codexApi: { serverRequests: { value: [] }, replyPermissionRequest: vi.fn() },
      encodeCodexDialogRequestId: (id: string) => id,
    });

    expect(dshPermissions.replyToPermission).toHaveBeenCalledWith('dsh-approval:evt-9', 'once');
  });

  it('maps the live dsh state bits onto the status snapshot (Todo 34 handoff)', () => {
    const program = transpile(
      `${appVariableDeclaration('dshStatusSnapshot')};dshStatusSnapshot.value;`,
    );
    const bridge = {
      sessionState: () => ({ busy: true }),
      syncState: () => ({ kind: 'live' }),
      pendingApprovals: () => [{}, {}],
    };
    const dshPermissions = {
      state: {
        permissionPreset: 'workspace-write',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'ask',
      },
    };
    const snapshot = runInNewContext(program, {
      computed,
      activeBackendKind: box('dsh'),
      dshMessageBridge: box(bridge),
      selectedSessionId: box('session-a'),
      connectionState: box('ready'),
      dshPermissions,
      dshStatusDiagnostic: box(null),
      dshStatusVersion: box(null),
    }) as Record<string, unknown> | undefined;

    expect(snapshot).toEqual({
      connectionState: 'ready',
      busy: true,
      followHealth: 'live',
      pendingApprovals: 2,
      permissions: {
        permissionPreset: 'workspace-write',
        sandboxMode: 'workspace-write',
        approvalPolicy: 'ask',
      },
      account: null,
      version: null,
      usage: null,
    });

    // Another backend (or no bridge yet) publishes no snapshot at all: the
    // modal renders no dsh rows instead of guessing a state.
    expect(
      runInNewContext(program, {
        computed,
        activeBackendKind: box('kimi-web'),
        dshMessageBridge: box(bridge),
        selectedSessionId: box('session-a'),
        connectionState: box('ready'),
        dshPermissions,
      }),
    ).toBeUndefined();
    expect(
      runInNewContext(program, {
        computed,
        activeBackendKind: box('dsh'),
        dshMessageBridge: box(undefined),
        selectedSessionId: box('session-a'),
        connectionState: box('ready'),
        dshPermissions,
      }),
    ).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// 5. dsh status diagnostics — health endpoint contract + live version path
// ---------------------------------------------------------------------------

describe('App.vue dsh status diagnostics (Todo 34 health/version contract)', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  /** A `server-response` answer for the recording fetcher (echoes the client rpcId). */
  function dshRpcResponse(
    result: { ok: true; value: unknown } | { ok: false; error: { code: string; message: string } },
  ): Response {
    const body = { type: 'server-response', rpcId: 'dsh-1', result };
    return responder(JSON.stringify(body));
  }

  function supervisorResponse(services: unknown): Response {
    return responder(JSON.stringify({ services }));
  }

  function responder(text: string): Response {
    return {
      status: 200,
      ok: true,
      headers: {
        get: (name: string) => (name.toLowerCase() === 'content-type' ? 'application/json' : null),
      },
      text: async () => text,
      json: async () => JSON.parse(text),
      arrayBuffer: async () => new TextEncoder().encode(text).buffer,
    } as unknown as Response;
  }

  const ACCOUNT_STATE = {
    status: 'signed-out',
    links: {
      usageUrl: 'https://platform.deepseek.com/usage',
      topUpUrl: 'https://platform.deepseek.com/top_up',
    },
  };

  function runDiagnostics(input: { rpc: () => Response; supervisor?: unknown }) {
    const calls: Array<{ url: string; method?: string; headers?: Record<string, string>; body?: string }> = [];
    const fetchImpl = vi.fn(
      async (
        url: string,
        init?: { method: string; headers: Record<string, string>; body: string },
      ) => {
        calls.push({ url, method: init?.method, headers: init?.headers, body: init?.body });
        if (url.includes('/dsh/account/getState')) return input.rpc();
        if (url.includes('/api/v1/supervisor')) return supervisorResponse(input.supervisor ?? []);
        throw new Error(`unexpected fetch ${url}`);
      },
    );
    // The extracted dshRpcClient is a host-realm function: its default fetcher
    // reads globalThis.fetch in THIS realm, so the recorder must be stubbed on
    // the host global as well as published into the vm sandbox.
    vi.stubGlobal('fetch', fetchImpl);
    const dshStatusDiagnostic = {
      value: null as { health?: string; healthError?: string; account?: unknown } | null,
    };
    const dshStatusVersion = {
      value: null as { value?: string; state?: string; supported?: boolean; error?: string } | null,
    };
    const credentials = {
      backendKind: { value: 'dsh' },
      dshBridgeUrl: { value: DSH_BRIDGE_URL },
      dshBridgeToken: { value: DSH_BRIDGE_TOKEN },
      codexBridgeUrl: { value: 'ws://localhost:23004/codex' },
      codexBridgeToken: { value: 'codex-bridge-token' },
    };
    const program = transpile(
      `var dshStatusDiagnosticGeneration = 0;\n${appFunctionDeclaration('dshAccountSnapshot')}\n${appFunctionDeclaration('dshRpcClient')}\n${appFunctionDeclaration('refreshDshStatusDiagnostics')}\nrefreshDshStatusDiagnostics();`,
    );
    const pending = runInContext(
      program,
      createContext({
        dshStatusDiagnaticGeneration: 0,
        dshStatusDiagnostic,
        dshStatusVersion,
        createDshRpcClient,
        deriveDshBridgeHttpUrl,
        appendCodexBridgeToken,
        codexBridgeHttpUrl,
        credentials,
        fetch: fetchImpl,
      }),
    ) as Promise<void>;
    return { calls, fetchImpl, dshStatusDiagnostic, dshStatusVersion, pending };
  }

  it('health is POST /dsh/account/getState judged by result.ok — never GET /dsh/ (review blocker #4)', async () => {
    const run = runDiagnostics({
      rpc: () => dshRpcResponse({ ok: true, value: ACCOUNT_STATE }),
      supervisor: [{ id: 'dsh', state: 'running', version: '0.2.9' }],
    });
    await run.pending;

    expect(run.fetchImpl).toHaveBeenCalledTimes(2);
    const rpcCall = run.calls[0]!;
    expect(rpcCall.url).toBe('http://localhost:23004/dsh/account/getState');
    expect(rpcCall.method).toBe('POST');
    expect(rpcCall.headers?.['content-type']).toBe('application/json');
    expect(rpcCall.headers?.Authorization).toBe(`Bearer ${DSH_BRIDGE_TOKEN}`);
    expect(JSON.parse(rpcCall.body ?? '{}')).toEqual({
      type: 'client-request',
      rpcId: 'dsh-1',
      method: 'account/getState',
      payload: { args: {} },
    });

    // A signed-out account is still a HEALTHY gateway; the verdict maps through.
    expect(run.dshStatusDiagnostic.value).toEqual({
      health: 'ok',
      account: {
        status: 'signed-out',
        usageUrl: 'https://platform.deepseek.com/usage',
        topUpUrl: 'https://platform.deepseek.com/top_up',
      },
    });
  });

  it('fails closed when account/getState answers result.ok === false (MISSING_CREDENTIAL)', async () => {
    const run = runDiagnostics({
      rpc: () =>
        dshRpcResponse({
          ok: false,
          error: { code: 'MISSING_CREDENTIAL', message: 'session credential missing' },
        }),
    });
    await run.pending;

    const diagnostic = run.dshStatusDiagnostic.value;
    expect(diagnostic?.health).toBe('error');
    expect(diagnostic?.healthError).toContain('MISSING_CREDENTIAL');
    expect(diagnostic?.account).toBeNull();
  });

  it('reads the version from the supervisor-captured dsh service, never another service entry', async () => {
    const run = runDiagnostics({
      rpc: () => dshRpcResponse({ ok: true, value: ACCOUNT_STATE }),
      supervisor: [
        { id: 'codex', state: 'running', version: '0.8.9' },
        { id: 'dsh', state: 'running', version: '0.2.9' },
      ],
    });
    await run.pending;

    const supervisorCall = run.calls[1]!;
    expect(supervisorCall.url).toContain('/api/v1/supervisor');
    expect(supervisorCall.url).toContain('token=codex-bridge-token');
    expect(run.dshStatusVersion.value).toEqual({ value: '0.2.9', state: 'running', supported: true });
    expect(run.dshStatusVersion.value?.value).not.toBe('0.8.9');
  });

  it('marks a supervisor-gate-rejected dsh version as an error snapshot', async () => {
    const run = runDiagnostics({
      rpc: () => dshRpcResponse({ ok: true, value: ACCOUNT_STATE }),
      supervisor: [{ id: 'dsh', state: 'error', version: '0.2.1', error: 'protocol generation mismatch' }],
    });
    await run.pending;

    expect(run.dshStatusVersion.value).toEqual({
      value: '0.2.1',
      state: 'error',
      supported: false,
      error: 'protocol generation mismatch',
    });
  });
});
