/**
 * PR #182 review round e0f83b871 items 2 and 3 — the default App regressions
 * from the task-23/24 migration (RED harness for FIX.pr182-app-scope-regressions).
 *
 * Finding B: the default App unconditionally supplies an empty manifest and a
 * scope that falls back to `workspace`, so provider/config operations that
 * worked before are judged unavailable. The legacy fallback must survive until
 * a real manifest/qualified harness exists, and a workspace scope must never be
 * treated as a harness scope.
 *
 * Finding C: the task-24 qualified runtime wiring cannot establish.
 * `parseQualifiedSession` passes computed REF OBJECTS instead of `.value` (so it
 * always returns null), and the router is handed the computed client cast to
 * `RuntimeActionClient` (so `ctx.client.scope` is not a function).
 *
 * Pattern (from `dshAppWiring.integration.test.ts`): the REAL wiring text is
 * extracted from `app/App.vue`, transpiled, and EXECUTED against doubles — the
 * assertions run the actual App code, not a re-implementation or a source
 * string match. The finding-B seam is additionally proven end-to-end through a
 * mount of the REAL ProviderManagerModal fed with the scope App computes.
 */
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { runInNewContext } from 'node:vm';
import ts from 'typescript';
import { computed, createApp, h, nextTick, ref, shallowRef, watch } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseInstanceId,
  parseSessionRef,
} from '../shared/runtime/identity.js';
import type { SessionRef } from '../shared/runtime/identity.js';
import type { EnvironmentId } from '../shared/runtime/identity.js';
import type { HarnessManifest } from '../shared/runtime/harnessContract.js';
import type { ControlScope } from './composables/useRuntimeCapabilities';
import { useRuntimeSessionActions, bindRuntimeAction } from './composables/useRuntimeSessionActions';
import { managementCandidate, parseConnectionReference } from './runtime/connectionProfile';
import { createAppCollaborationPorts } from './runtime/collaborationPorts';
import { createRuntimeClient } from './runtime/client';
import { createRuntimeConnection } from './runtime/connection';
import { encodeFrame } from '../shared/runtime/protocol.js';
import type { Hello } from '../shared/runtime/protocol.js';
import { parseCapabilities } from '../shared/runtime/capabilities.js';
import { RUNTIME_WIRE_METHODS } from '../shared/runtime/runtimeWire.js';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const registryMock = vi.hoisted(() => ({
  getAdapter: vi.fn(),
}));

vi.mock('./backends/registry', () => ({
  getBackendAdapter: () => registryMock.getAdapter(),
}));

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

/** The object-literal argument text of the single top-level call to `callee`. */
function appCallArgumentText(callee: string): string {
  let found: ts.CallExpression | undefined;
  const visit = (node: ts.Node): void => {
    if (ts.isCallExpression(node) && node.expression.getText(APP_SCRIPT) === callee) {
      if (found) throw new Error(`App.vue has more than one call to ${callee}`);
      found = node;
    }
    ts.forEachChild(node, visit);
  };
  ts.forEachChild(APP_SCRIPT, visit);
  if (!found) throw new Error(`App.vue call ${callee} was not found`);
  const argument = found.arguments[0];
  if (!argument) throw new Error(`App.vue call ${callee} has no argument`);
  return argument.getText(APP_SCRIPT);
}

function transpile(source: string): string {
  return ts.transpileModule(source, {
    compilerOptions: { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.None },
  }).outputText;
}

function box<T>(value: T): { value: T } {
  return { value };
}

// ---------------------------------------------------------------------------
// Identity doubles: the REAL identity helpers decide what is well-formed.
// ---------------------------------------------------------------------------

const ENV = parseEnvironmentId('11111111-1111-4111-8111-111111111111');
const HARNESS = parseHarnessInstanceId('10000000-0000-4000-8000-000000000001');
const PROFILE = '22222222-2222-4222-8222-222222222222';
const SESSION: SessionRef = parseSessionRef({
  environmentId: ENV,
  harnessInstanceId: HARNESS,
  nativeSessionId: 'ses-a',
});

const SUPPORTED = Object.freeze({ state: 'supported' as const });

/** A published opencode manifest declaring the provider/auth/config surface. */
const OPENCODE_MANIFEST: HarnessManifest = Object.freeze({
  environmentId: ENV,
  harnessInstanceId: HARNESS,
  kind: 'opencode',
  protocolVersion: 1,
  core: Object.freeze({
    inspect: SUPPORTED,
    listSessionPage: SUPPORTED,
    getSession: SUPPORTED,
    readHistoryPage: SUPPORTED,
    createSession: SUPPORTED,
    send: SUPPORTED,
    cancel: SUPPORTED,
    respondInteraction: SUPPORTED,
    subscribe: SUPPORTED,
    close: SUPPORTED,
  }),
  extensions: Object.freeze(
    ['listProviders', 'listProviderAuthMethods', 'setProviderAuth', 'deleteProviderAuth', 'getGlobalConfig', 'updateGlobalConfig'].map((name) =>
      Object.freeze({
        name,
        owner: HARNESS,
        scope: 'instance',
        permission: `opencode:${name}`,
        schemaVersion: 1,
        support: SUPPORTED,
      }),
    ),
  ),
  capabilities: Object.freeze({}),
});

// ---------------------------------------------------------------------------
// Finding B — App's harnessScope must stay null until a real manifest/qualified
// harness exists (never a workspace scope, never an empty-manifest gate).
// ---------------------------------------------------------------------------

const HARNESS_SCOPE_PROGRAM = transpile(
  `${appVariableDeclaration('harnessScope')};harnessScope.value;`,
);

function resolveHarnessScope(input: {
  manifests?: readonly HarnessManifest[];
  session?: SessionRef | null;
}): unknown {
  return runInNewContext(HARNESS_SCOPE_PROGRAM, {
    computed,
    harnessManifests: box(input.manifests ?? []),
    runtimeSelectedSessionRef: box(input.session ?? null),
    activeRuntimeEnvironmentId: box(ENV),
    activeDirectory: box('/repo'),
  });
}

describe('App.vue harness scope — no manifest published (PR #182 finding B)', () => {
  it('resolves to null with App’s default state, never to a workspace scope', () => {
    // Given: App's default state — no manifest loaded, no qualified session.
    // When: the real harnessScope computed runs.
    const scope = resolveHarnessScope({});

    // Then: it is null, so the modals keep their legacy adapter-shape path.
    // A workspace scope here would route provider controls into the workspace
    // resolver and report every operation unavailable.
    expect(scope).toBeNull();
  });

  it('stays null when a session is selected but no manifest is published', () => {
    expect(resolveHarnessScope({ session: SESSION })).toBeNull();
  });

  it('stays null when a manifest is published but no session is selected', () => {
    expect(resolveHarnessScope({ manifests: [OPENCODE_MANIFEST] })).toBeNull();
  });

  it('resolves to the qualified session scope once a manifest and a session exist', () => {
    const scope = resolveHarnessScope({ manifests: [OPENCODE_MANIFEST], session: SESSION });
    expect(scope).toEqual({ kind: 'session', session: SESSION });
  });
});

// ---------------------------------------------------------------------------
// Finding B end-to-end — the REAL ProviderManagerModal mounted with the scope
// App computes keeps the legacy provider/config operations working.
// ---------------------------------------------------------------------------

function fakeRuntimeClient() {
  return {
    scope: vi.fn((_target: EnvironmentId) => ({
      binding: Object.freeze({
        target: ENV,
        epoch: 'epoch-1',
        generation: 0,
        profileId: PROFILE,
      }),
      generation: 0,
      isCurrent: () => true,
    })),
    mutate: vi.fn((_target: EnvironmentId, _method: string, _params: unknown, _options: unknown) => ({
      accepted: Promise.resolve({ operationId: 'op-1' }),
      executed: Promise.resolve({ operationId: 'op-1' }),
    })),
    request: vi.fn(async () => ({})),
  };
}

const mountedModals: Array<{ app: ReturnType<typeof createApp>; host: HTMLElement }> = [];

afterEach(() => {
  for (const entry of mountedModals.splice(0)) {
    entry.app.unmount();
    entry.host.remove();
  }
  registryMock.getAdapter.mockReset();
});

/** An opencode-shaped adapter with the real provider/config method surface. */
function openCodeAdapter() {
  return {
    kind: 'opencode',
    updateGlobalConfig: vi.fn(async (payload: Record<string, unknown>) => payload),
    setProviderAuth: vi.fn(async () => undefined),
    deleteProviderAuth: vi.fn(async () => undefined),
    listProviderAuthMethods: vi.fn(async () => ({})),
  };
}

async function flushUi() {
  await nextTick();
  await Promise.resolve();
  await nextTick();
}

async function mountProviderManagerModal(harnessScope: ControlScope | null) {
  const { default: ProviderManagerModal } = await import('./components/ProviderManagerModal.vue');
  const { i18n } = await import('./i18n');
  const props = ref({
    open: true,
    providers: [{ id: 'openai', name: 'OpenAI', source: 'api', models: {} }],
    connectedProviderIds: [] as string[],
    selectedModel: '',
    hiddenModels: [] as string[],
    providerConfig: null,
    backendKind: 'opencode' as const,
    dshRpcClient: undefined,
    harnessScope: harnessScope ?? undefined,
    harnessManifests: [] as readonly HarnessManifest[],
  });
  const host = document.createElement('div');
  document.body.append(host);
  const app = createApp({
    render: () => h(ProviderManagerModal, props.value),
  });
  app.use(i18n);
  app.provide('showPrompt', async () => null);
  app.provide('showConfirm', async () => true);
  app.mount(host);
  mountedModals.push({ app, host });
  await flushUi();
  return host;
}

function providerRow(host: HTMLElement, providerId: string) {
  const row = Array.from(host.querySelectorAll<HTMLElement>('.provider-mini-row')).find(
    (candidate) => candidate.textContent?.includes(providerId),
  );
  if (!row) throw new Error(`Missing provider row: ${providerId}`);
  return row;
}

async function expandProviderList(host: HTMLElement) {
  const toggle = host.querySelector<HTMLButtonElement>('.provider-view-all-toggle');
  if (!toggle) throw new Error('Missing provider view-all toggle');
  toggle.click();
  await flushUi();
}

describe('the default app keeps provider controls on the legacy path (PR #182 finding B)', () => {
  it('mounts the REAL ProviderManagerModal with App’s harness props and keeps connect/config working', async () => {
    // Given: the opencode adapter (auth + config capable) and the harness scope
    // App.vue computes in its default state, with App's empty manifest list.
    registryMock.getAdapter.mockReturnValue(openCodeAdapter());
    const scope = resolveHarnessScope({}) as ControlScope | null;
    const host = await mountProviderManagerModal(scope);

    // When: the provider list is expanded.
    await expandProviderList(host);

    // Then: the connect control is NOT gated off by the empty manifest.
    const connect = providerRow(host, 'openai').querySelector<HTMLButtonElement>('button');
    expect(connect).not.toBeNull();
    expect(connect!.disabled).toBe(false);
    expect(connect!.title).toBe('');
    expect(host.querySelector('[data-testid="provider-control-source"]')).toBeNull();

    // And: the config-update surface (custom provider entry) stays available.
    const customEntry = host.querySelector<HTMLButtonElement>('.custom-provider-entry button');
    expect(customEntry).not.toBeNull();
    expect(customEntry!.disabled).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// Finding C — parseQualifiedSession must dereference its computed refs, and the
// router must receive the ACTUAL client.
// ---------------------------------------------------------------------------

describe('App.vue parseQualifiedSession (PR #182 finding C)', () => {
  const PROGRAM = transpile(
    `${appFunctionDeclaration('parseQualifiedSession')};parseQualifiedSession();`,
  );

  function parseQualifiedSession(selectedSessionId: string): unknown {
    return runInNewContext(PROGRAM, {
      selectedSessionId: box(selectedSessionId),
      activeRuntimeEnvironmentId: box(ENV),
      activeHarnessInstanceId: box(HARNESS),
      parseSessionRef,
    });
  }

  it('returns the real qualified session for the selected session id', () => {
    // Given: a selected session and two valid identity refs.
    // When: the real parseQualifiedSession runs.
    const session = parseQualifiedSession('ses-a');

    // Then: it is the well-formed SessionRef — not null.
    expect(session).toEqual({
      environmentId: ENV,
      harnessInstanceId: HARNESS,
      nativeSessionId: 'ses-a',
    });
  });

  it('returns null when no session is selected', () => {
    expect(parseQualifiedSession('')).toBeNull();
  });
});

describe('App.vue qualified router client wiring (PR #182 finding C)', () => {
  const DECLARATIONS = [
    appFunctionDeclaration('requireRuntimeActionClient'),
    appVariableDeclaration('runtimeActionClientSurface'),
    `const runtimeSessionActions = useRuntimeSessionActions(${appCallArgumentText('useRuntimeSessionActions')});`,
  ].join('\n');

  const PROGRAM = transpile(`${DECLARATIONS};({ runtimeSessionActions });`);

  function runWiring(client: unknown) {
    return runInNewContext(PROGRAM, {
      computed,
      runtimeActionClient: box(client),
      activeProfileId: box(PROFILE),
      runtimeSelectionCapture: () => null,
      useRuntimeSessionActions,
    }) as {
      runtimeSessionActions: {
        fork: (session: SessionRef) => unknown;
      };
    };
  }

  it('hands the router the actual client, so ctx.client.scope resolves', () => {
    // Given: an attached runtime client.
    const client = fakeRuntimeClient();
    const wiring = runWiring(client);

    // When: a qualified session action is routed.
    wiring.runtimeSessionActions.fork(SESSION);

    // Then: the REAL client's scope/mutate were invoked for the qualified
    // target — the computed ref was never passed as the client.
    expect(client.scope).toHaveBeenCalledWith(ENV);
    expect(client.mutate).toHaveBeenCalledTimes(1);
    expect(client.mutate.mock.calls[0]![0]).toBe(ENV);
    expect(client.mutate.mock.calls[0]![1]).toBe('session.send');
  });

  it('refuses loudly instead of dereferencing a missing client', () => {
    // Given: no runtime client for the active bridge target (the default app's
    // bare OpenCode server is not a runtime wire endpoint).
    const wiring = runWiring(null);

    // Then: the facade fails closed with a clear error, never a cast TypeError.
    expect(() => wiring.runtimeSessionActions.fork(SESSION)).toThrowError(/runtime client/i);
  });
});

describe('App.vue runtimeSessionRuntime binding (PR #182 finding C)', () => {
  const PROGRAM = transpile(
    `${appFunctionDeclaration('runtimeTargetAttached')};${appVariableDeclaration('runtimeSessionRuntime')};runtimeSessionRuntime.binding();`,
  );

  function bindingWith(input: { session?: SessionRef | null; client?: unknown }) {
    return runInNewContext(PROGRAM, {
      runtimeSelectedSessionRef: box(input.session ?? null),
      activeProfileId: box(PROFILE),
      runtimeActionClient: box(input.client ?? null),
      runtimeSessionActions: {},
      runtimeMessageSend: {},
      runtimeInteractions: {},
    });
  }

  it('keeps the legacy path while no runtime client is attached', () => {
    // Given: a qualified session but no attached runtime client.
    // When: the binding is requested.
    const binding = bindingWith({ session: SESSION, client: null });

    // Then: it is null — the legacy backend-specific path keeps running.
    expect(binding).toBeNull();
  });

  it('binds the qualified session once a runtime client is attached', () => {
    const binding = bindingWith({ session: SESSION, client: fakeRuntimeClient() });
    expect(binding).toEqual({ profileId: PROFILE, session: SESSION });
  });
});

// ---------------------------------------------------------------------------
// F3-P2-1 — the unified five-source tree never self-loads in the running app.
//
// The real mechanism, proven here by executing App.vue's own wiring: the
// connection emits `hello` to its listeners in SUBSCRIPTION order
// (`connection.ts` `emit` walks a Set). `buildRuntimeActionClient` used to
// subscribe App's environment-id handler BEFORE `createRuntimeClient`
// subscribed its own `receive`, so the handler published
// `runtimeEnvironmentId`, the synchronous watcher rebuilt the tree and called
// `tree.start()` while the client's `targets` map was still empty — and
// `state.start` → `client.scope()` → `getTarget()` rejects with
// `reconcile_required (target.attachment)`. The rejection was swallowed by an
// empty `catch` with no retry, so the sidebar stayed on "Loading sessions...
// 0/0" until a manual refresh. The fix is the ORDER (client first, exactly as
// the canonical `useRuntimeConnection.ts` composes the same pair), not a retry.
// ---------------------------------------------------------------------------

describe('App.vue runtime client wiring order (F3-P2-1)', () => {
  /** The real hello the bridge sends, shaped as `client.test.ts` shapes it. */
  const HELLO: Hello = {
    kind: 'hello',
    version: 1,
    target: ENV,
    epoch: 'epoch-1',
    generation: 1,
    instanceId: parseInstanceId('66666666-6666-4666-8666-666666666666'),
    capabilities: parseCapabilities({ methods: Object.keys(RUNTIME_WIRE_METHODS), extensions: [] }),
  };

  /** Only the transport is doubled; the connection, client and wiring are real. */
  class WireSocket extends EventTarget {
    binaryType: BinaryType = 'arraybuffer';
    readyState: 0 | 1 | 2 | 3 = 1;
    bufferedAmount = 0;
    close() { this.readyState = 3; }
    send() {}
    frame(value: unknown) { this.dispatchEvent(new MessageEvent('message', { data: encodeFrame(value) })); }
  }

  const WIRING = [
    appFunctionDeclaration('buildRuntimeActionClient'),
    appFunctionDeclaration('disposeUnifiedSessionTree'),
    appFunctionDeclaration('buildUnifiedSessionTree'),
    'watch([runtimeActionClient, runtimeEnvironmentId], buildUnifiedSessionTree, { immediate: true, flush: "sync" });',
    'buildRuntimeActionClient();',
  ].join('\n');

  function driveWiring() {
    const socket = new WireSocket();
    const started: Array<{ target: EnvironmentId; scopeError: string | null }> = [];
    const runtimeActionClient = shallowRef<unknown>(null);
    const runtimeEnvironmentId = shallowRef<EnvironmentId | null>(null);
    const unifiedSessionTree = shallowRef<unknown>(null);
    const PROGRAM = transpile(WIRING);
    runInNewContext(PROGRAM, {
      runtimeConnectionOwner: undefined,
      runtimeHelloUnsubscribe: undefined,
      runtimeActionClient,
      runtimeEnvironmentId,
      unifiedSessionTree,
      activeBridgeUrl: box('ws://127.0.0.1:43210/runtime'),
      activeProfileId: box(PROFILE),
      managementCandidate,
      activeBridgeToken: () => '',
      parseConnectionReference,
      createRuntimeConnection: (options: Parameters<typeof createRuntimeConnection>[0]) =>
        createRuntimeConnection({ ...options, createWebSocket: () => socket }),
      createRuntimeClient,
      watch,
      onScopeDispose: () => {},
      parseEnvironmentId,
      useRuntimeSessionTree: ({ client, target }: { client: { scope: (t: EnvironmentId) => unknown }; target: EnvironmentId }) => ({
        // The tree's first act is `state.start(target)`, whose own first act is
        // `client.scope(target)`. Recording whether THAT resolved is exactly the
        // self-load contract: an unresolvable scope is the reconcile_required
        // rejection that left the tree stuck on "Loading sessions... 0/0".
        start: async () => {
          let scopeError: string | null = null;
          try { client.scope(target); } catch (error) { scopeError = error instanceof Error ? error.message : String(error); }
          started.push({ target, scopeError });
        },
        dispose: async () => {},
      }),
    });
    return { socket, started, runtimeActionClient, runtimeEnvironmentId };
  }

  it('registers the client\'s target before the environment id is published, so the tree self-loads on hello', async () => {
    // Given: the REAL App.vue wiring over the REAL connection and REAL client.
    const wiring = driveWiring();
    // And: the socket exists (the connection creates it after authentication).
    await new Promise((resolve) => setTimeout(resolve, 0));

    // When: the bridge's real hello arrives over the real connection.
    wiring.socket.frame(HELLO);
    await Promise.resolve();
    await Promise.resolve();

    // Then: the environment id really was published from the hello's target...
    expect(wiring.runtimeEnvironmentId.value).toBe(ENV);
    // And: the tree's start really ran against the hello's target...
    expect(wiring.started).toHaveLength(1);
    expect(wiring.started[0]!.target).toBe(ENV);
    // And: the scope RESOLVED — the client had already registered the target
    // when the environment id was published, so no reconcile_required and no
    // manual refresh is needed. This is the assertion the defect failed.
    expect(wiring.started[0]!.scopeError).toBeNull();
  });

  it('fails the same wiring when the environment-id handler is subscribed first (the defect, locked red)', async () => {
    // Given: the same real connection and client, but with the two subscriptions
    // swapped back into the order the defect had — the handler first, the client
    // second.
    const socket = new WireSocket();
    const started: Array<{ target: EnvironmentId; scopeError: string | null }> = [];
    const runtimeActionClient = shallowRef<unknown>(null);
    const runtimeEnvironmentId = shallowRef<EnvironmentId | null>(null);
    const unifiedSessionTree = shallowRef<unknown>(null);
    const connection = createRuntimeConnection({
      reference: { url: 'ws://127.0.0.1:43210/runtime' },
      resolveAuthentication: async () => ({}),
      createWebSocket: () => socket,
    });
    const DEFECTIVE = transpile([
      appFunctionDeclaration('disposeUnifiedSessionTree'),
      appFunctionDeclaration('buildUnifiedSessionTree'),
      'watch([runtimeActionClient, runtimeEnvironmentId], buildUnifiedSessionTree, { immediate: true, flush: "sync" });',
      // The defect, reproduced exactly: subscribe the environment-id handler
      // first, then construct the client (which subscribes its own receive).
      'connection.subscribe((event) => { if (event.kind !== "hello") return; try { runtimeEnvironmentId.value = parseEnvironmentId(event.hello.target); } catch { runtimeEnvironmentId.value = null; } });',
      'runtimeActionClient.value = createRuntimeClient({ connection });',
    ].join('\n'));
    runInNewContext(DEFECTIVE, {
      connection,
      runtimeActionClient,
      runtimeEnvironmentId,
      unifiedSessionTree,
      activeProfileId: box(PROFILE),
      createRuntimeClient,
      watch,
      onScopeDispose: () => {},
      parseEnvironmentId,
      useRuntimeSessionTree: ({ client, target }: { client: { scope: (t: EnvironmentId) => unknown }; target: EnvironmentId }) => ({
        start: async () => {
          let scopeError: string | null = null;
          try { client.scope(target); } catch (error) { scopeError = error instanceof Error ? error.message : String(error); }
          started.push({ target, scopeError });
        },
        dispose: async () => {},
      }),
    });
    await Promise.resolve();
    await Promise.resolve();
    connection.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    // When: the same real hello arrives.
    socket.frame(HELLO);
    await Promise.resolve();
    await Promise.resolve();

    // Then: the tree's start really ran, and its scope REJECTED — proving the
    // ordering is what makes the tree load, and that this test can see it.
    expect(started).toHaveLength(1);
    expect(started[0]!.scopeError).not.toBeNull();
    expect(started[0]!.scopeError).toContain('reconcile_required');
  });
});

// ---------------------------------------------------------------------------
// Row 64 — collaboration delivery must bind to the session it was GIVEN.
//
// `deliverRuntimePrompt` is the single send path behind `deliverAttempt`,
// `deliverDelegation` and `deliverFanout`, and every one of those hands over the
// session the collaboration service resolved for that participant. It used to
// gate on `binding.session.nativeSessionId !== session.nativeSessionId` and then
// send through `binding` — the AMBIENT selection — so as soon as the user's
// selection moved off a participant, that participant's delivery answered
// `{ackId: ''}` and the whole collaboration chain was unreachable. The invariant
// is documented 200 lines away in `useBackendSessionActions.ts` ("finding A"):
// the seam binds the operation to the session it was GIVEN; the ambient binding
// supplies only the profile/environment/harness context.
// ---------------------------------------------------------------------------

describe('App.vue deliverRuntimePrompt binds to the GIVEN session (row 64)', () => {
  const OTHER = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-ambient',
  });
  const GIVEN = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-given',
  });

  const PROGRAM = transpile(`${appFunctionDeclaration('deliverRuntimePrompt')};deliverRuntimePrompt;`);

  function runDelivery(input: { ambient: SessionRef; given: SessionRef }) {
    const sent: Array<{ session: SessionRef; text: string }> = [];
    const runtime = {
      binding: () => Object.freeze({ profileId: PROFILE, session: input.ambient }),
      router: {
        sendMessage: (binding: { session: SessionRef }, payload: { text: string }) => {
          sent.push({ session: binding.session, text: payload.text });
          // The REAL router contract: `sendMessage` is `runtimeMessageSend.send`,
          // which returns a SessionMutation — a NON-thenable object whose
          // `accepted` promise carries the native receipt. This stub used to
          // answer a bare promise, which is exactly the shape that hid the
          // defect row 65 locks red: awaiting the mutation itself resolves
          // immediately and reads `operationId === undefined`.
          return {
            accepted: Promise.resolve({ operationId: 'op-real-1' }),
            executed: Promise.resolve({ operationId: 'op-real-1' }),
          };
        },
      },
    };
    const deliver = runInNewContext(PROGRAM, {
      runtimeSessionRuntime: runtime,
      bindRuntimeAction,
      parseSessionRef,
    }) as (session: SessionRef, prompt: string) => Promise<{ ackId: string }>;
    return { deliver, sent };
  }

  it('delivers to a participant that is NOT the currently selected session', async () => {
    // Given: the ambient selection is a DIFFERENT session than the participant
    // the collaboration service is delivering to.
    const wiring = runDelivery({ ambient: OTHER, given: GIVEN });

    // When: the prompt is delivered for the GIVEN session.
    const outcome = await wiring.deliver(GIVEN, 'review this change');

    // Then: the send really went out over the app's own router...
    expect(wiring.sent).toHaveLength(1);
    // ...bound to the session it was GIVEN, not the ambient selection...
    expect(wiring.sent[0]!.session).toEqual(GIVEN);
    expect(wiring.sent[0]!.session.nativeSessionId).toBe('ses-given');
    // ...and the real operation id came back, so the delivery is not ambiguous.
    expect(outcome).toEqual({ ackId: 'op-real-1' });
  });

  it('still delivers when the given session happens to be the selected one', async () => {
    // Given: the participant IS the ambient selection.
    const wiring = runDelivery({ ambient: GIVEN, given: GIVEN });

    // When: the prompt is delivered.
    const outcome = await wiring.deliver(GIVEN, 'review this change');

    // Then: it still goes out, still bound to that session, still readable.
    expect(wiring.sent).toHaveLength(1);
    expect(wiring.sent[0]!.session).toEqual(GIVEN);
    expect(outcome).toEqual({ ackId: 'op-real-1' });
  });

  it('answers with no ack when there is no seam to deliver through', async () => {
    // Given: no runtime seam at all (a bare OpenCode server is not a runtime
    // wire endpoint) — the legacy path keeps running and nothing is sent.
    const wiring = runDelivery({ ambient: OTHER, given: GIVEN });
    const deliver = runInNewContext(PROGRAM, {
      runtimeSessionRuntime: null,
      bindRuntimeAction,
      parseSessionRef,
    }) as (session: SessionRef, prompt: string) => Promise<{ ackId: string }>;

    // When/Then: the delivery is ambiguous and the router was never touched.
    expect(await deliver(GIVEN, 'review this change')).toEqual({ ackId: '' });
    expect(wiring.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row 65 — a delivery's ack is the mutation's ACCEPTED receipt, not the
// mutation object.
//
// `runtimeSessionRuntime.router.sendMessage` is `runtimeMessageSend.send`,
// which returns a `SessionMutation` (`useRuntimeSessionActions.ts`): a plain
// object carrying two promises — `accepted` (the native acceptance, resolving
// to the receipt `{operationId}`) and `executed` (the turn's own terminal
// state). It is NOT a thenable, so `await`ing it resolves to the mutation
// itself and reads `operationId === undefined`: every handoff, fan-out,
// delegation and attempt delivery answered `{ackId: ''}` even when the send was
// accepted, and the calling services recorded a reconcile for a delivery that
// had actually gone out. The seam must await `accepted`, take the receipt's
// operationId as the ack, and observe `executed`'s terminal state so a turn
// that fails after acceptance never surfaces as an unhandled rejection.
// ---------------------------------------------------------------------------

describe('App.vue deliverRuntimePrompt reads the mutation accepted receipt (row 65)', () => {
  const OTHER = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-ambient',
  });
  const GIVEN = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-given',
  });

  const PROGRAM = transpile(`${appFunctionDeclaration('deliverRuntimePrompt')};deliverRuntimePrompt;`);

  /** The REAL router contract: `sendMessage` answers a non-thenable mutation. */
  function mutationRouter(input: {
    accepted: () => Promise<{ operationId: string }>;
    executed: () => Promise<unknown>;
  }) {
    const sent: Array<{ session: SessionRef; text: string }> = [];
    const runtime = {
      binding: () => Object.freeze({ profileId: PROFILE, session: OTHER }),
      router: {
        sendMessage: (binding: { session: SessionRef }, payload: { text: string }) => {
          sent.push({ session: binding.session, text: payload.text });
          return { accepted: input.accepted(), executed: input.executed() };
        },
      },
    };
    const deliver = runInNewContext(PROGRAM, {
      runtimeSessionRuntime: runtime,
      bindRuntimeAction,
      parseSessionRef,
    }) as (session: SessionRef, prompt: string) => Promise<{ ackId: string }>;
    return { deliver, sent };
  }

  it('waits for a DEFERRED accepted receipt instead of answering an empty ack first', async () => {
    // Given: the router hands back the real mutation and the native acceptance
    // only lands on a later turn.
    let landReceipt: (receipt: { operationId: string }) => void = () => {};
    const wiring = mutationRouter({
      accepted: () => new Promise<{ operationId: string }>((resolve) => { landReceipt = resolve; }),
      executed: () => new Promise<unknown>(() => {}),
    });

    // When: the delivery starts.
    let answered: { ackId: string } | null = null;
    const pending = wiring.deliver(GIVEN, 'review this change').then((outcome) => { answered = outcome; });
    await Promise.resolve();
    await Promise.resolve();

    // Then: the delivery has NOT answered yet — answering `{ackId: ''}` before
    // the receipt lands is the defect: an accepted send reported as ambiguous.
    expect(answered).toBeNull();

    // When: the real receipt lands.
    landReceipt({ operationId: 'op-deferred-1' });
    await pending;

    // Then: the ack IS the receipt's operationId, and the send went out once,
    // bound to the given session.
    expect(answered).toEqual({ ackId: 'op-deferred-1' });
    expect(wiring.sent).toHaveLength(1);
    expect(wiring.sent[0]!.session).toEqual(GIVEN);
  });

  it('answers with no ack when the accepted receipt is rejected', async () => {
    // Given: the native side refuses the send.
    const wiring = mutationRouter({
      accepted: () => Promise.reject(new Error('unauthorized: session.send')),
      executed: () => new Promise<unknown>(() => {}),
    });

    // When/Then: the delivery stays ambiguous — never a fabricated ack — and
    // the send really was attempted.
    expect(await wiring.deliver(GIVEN, 'review this change')).toEqual({ ackId: '' });
    expect(wiring.sent).toHaveLength(1);
  });

  it('keeps the accepted ack when the turn later fails, and observes the executed terminal state', async () => {
    // Given: the send is accepted and the turn then fails. `executed` is a
    // proxied promise so the test can see whether the seam subscribed to the
    // turn's terminal state at all; the harness itself already observed the
    // terminal rejection so a missing seam subscription cannot masquerade as
    // an environment failure.
    const observed: string[] = [];
    const executedTerminal = Promise.reject(new Error('turn failed after acceptance'));
    executedTerminal.catch(() => {});
    const executed = new Proxy(executedTerminal, {
      get(target, property) {
        if (property === 'then') {
          observed.push('subscribed');
          return target.then.bind(target);
        }
        return Reflect.get(target, property, target);
      },
    });
    const wiring = mutationRouter({
      accepted: () => Promise.resolve({ operationId: 'op-real-2' }),
      executed: () => executed,
    });

    // When: the delivery completes.
    const outcome = await wiring.deliver(GIVEN, 'review this change');
    await Promise.resolve();
    await Promise.resolve();

    // Then: an accepted delivery stays accepted...
    expect(outcome).toEqual({ ackId: 'op-real-2' });
    // ...and the seam explicitly observed the executed terminal state instead
    // of leaving the turn's failure unhandled.
    expect(observed).toEqual(['subscribed']);
  });
});

// ---------------------------------------------------------------------------
// Row 66 — an attempt delivery resolves the session from the attempt's OWNER.
//
// The coordinator's attemptService delivers with `{attemptId, taskId, owner,
// prompt}` (`bridge/runtime/collaboration/attemptService.js`), and the owner is
// `{participantId, session}` — the prompt's target session is one level down,
// at `payload.owner.session`. Reading a top-level `payload.session` answered
// `{ackId: ''}` for every real attempt, so `deliverRuntimePrompt` never ran and
// the attempt stopped at `reconcile` before a single prompt was sent.
// Delegation carries a top-level session and fan-out a `target.session`; only
// the attempt payload nests under the owner, which is why this is its own
// resolver and not the delegation one.
// ---------------------------------------------------------------------------

describe('App.vue deliverAttempt resolves the owner session (row 66)', () => {
  const OWNER_PID = '33333333-3333-4333-8333-333333333333';
  const OWNED = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-owner',
  });
  const OTHER = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'ses-ambient',
  });

  const PROGRAM = transpile([
    appFunctionDeclaration('deliverRuntimePrompt'),
    appFunctionDeclaration('deliverCollaborationAttempt'),
    'deliverCollaborationAttempt;',
  ].join('\n'));

  function attemptSeam() {
    const sent: Array<{ session: SessionRef; text: string }> = [];
    const runtime = {
      binding: () => Object.freeze({ profileId: PROFILE, session: OTHER }),
      router: {
        sendMessage: (binding: { session: SessionRef }, payload: { text: string }) => {
          sent.push({ session: binding.session, text: payload.text });
          return {
            accepted: Promise.resolve({ operationId: 'op-real-1' }),
            executed: Promise.resolve({ operationId: 'op-real-1' }),
          };
        },
      },
    };
    const seam = runInNewContext(PROGRAM, {
      runtimeSessionRuntime: runtime,
      bindRuntimeAction,
      parseSessionRef,
    }) as (payload: unknown) => Promise<{ ackId: string }>;
    return { seam, sent };
  }

  it('delivers the attempt prompt to the OWNER session, not a top-level session field', async () => {
    // Given: the payload the real attemptService hands over.
    const wiring = attemptSeam();

    // When: the seam resolves it.
    const outcome = await wiring.seam({
      attemptId: '44444444-4444-4444-8444-444444444444',
      taskId: '55555555-5555-4555-8555-555555555555',
      owner: { participantId: OWNER_PID, session: OWNED },
      prompt: 'review this change',
    });

    // Then: the send went out bound to the owner's session and the real ack
    // came back — the attempt does not stop at reconcile.
    expect(wiring.sent).toHaveLength(1);
    expect(wiring.sent[0]!.session).toEqual(OWNED);
    expect(wiring.sent[0]!.session.nativeSessionId).toBe('ses-owner');
    expect(outcome).toEqual({ ackId: 'op-real-1' });
  });

  it('answers with no ack for a payload whose owner session is missing', async () => {
    // Given: a malformed attempt payload (no owner at all).
    const wiring = attemptSeam();

    // When/Then: the delivery is ambiguous and nothing was sent.
    expect(await wiring.seam({
      attemptId: '44444444-4444-4444-8444-444444444444',
      taskId: '55555555-5555-4555-8555-555555555555',
      prompt: 'review this change',
    })).toEqual({ ackId: '' });
    expect(wiring.sent).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Row 67 — the REAL coordinator drives the App attempt seam end to end.
//
// The ports wire the coordinator straight to the seam
// (`app/runtime/collaborationPorts.ts`), with no conversion layer, so the only
// honest proof that an attempt can be delivered is the real task graph, the
// real attemptService journal and the real App seam running against an
// observable router. A payload-shape mismatch anywhere in that chain shows up
// as an attempt parked at `reconcile` with nothing sent.
// ---------------------------------------------------------------------------

describe('real coordinator drives the App attempt seam end to end (row 67)', () => {
  const OWNER_PID = '66666666-6666-4666-8666-666666666666';
  const OWNED = parseSessionRef({
    environmentId: ENV,
    harnessInstanceId: HARNESS,
    nativeSessionId: 'native:codex-owner',
  });
  const T0 = 1_700_000_000_000;
  const LEASE_TTL = 60_000;
  const CRITERIA = Object.freeze([
    { id: 'build', text: 'the production build passes' },
    { id: 'tests', text: 'the focused regression passes', required: true },
  ]);

  it('a dispatched attempt reaches the router bound to its owner session with the real ack', async () => {
    // Given: the REAL App seam (transpiled from App.vue) behind an observable
    // router that answers the real mutation contract with a DEFERRED receipt.
    const sent: Array<{ session: SessionRef; text: string }> = [];
    let landReceipt: (receipt: { operationId: string }) => void = () => {};
    const runtime = {
      binding: () => Object.freeze({ profileId: PROFILE, session: OWNED }),
      router: {
        sendMessage: (binding: { session: SessionRef }, payload: { text: string }) => {
          sent.push({ session: binding.session, text: payload.text });
          return {
            accepted: new Promise<{ operationId: string }>((resolve) => { landReceipt = resolve; }),
            executed: Promise.resolve({ operationId: 'op-e2e-1' }),
          };
        },
      },
    };
    const seam = runInNewContext(transpile([
      appFunctionDeclaration('deliverRuntimePrompt'),
      appFunctionDeclaration('deliverCollaborationAttempt'),
      'deliverCollaborationAttempt;',
    ].join('\n')), {
      runtimeSessionRuntime: runtime,
      bindRuntimeAction,
      parseSessionRef,
    }) as (payload: unknown) => Promise<{ ackId: string }>;

    // And: the REAL ports wiring the REAL coordinator to that seam.
    const ports = createAppCollaborationPorts({
      deliverAttempt: seam,
      deliverDelegation: async () => ({ ackId: '' }),
      deliverFanout: async () => ({ ackId: '' }),
    });
    const team = ports.coordinator.createTeam({ name: 'vis team', at: T0 });
    const task = ports.coordinator.createTask({
      teamId: team.teamId,
      title: 'land the runtime tree',
      criteria: CRITERIA,
      owner: { participantId: OWNER_PID, session: OWNED },
      lease: { ownerId: OWNER_PID, expiresAt: T0 + LEASE_TTL },
      at: T0,
    });

    // When: the task is dispatched and its attempt is sent for real.
    const dispatched = await ports.coordinator.dispatch({ taskId: task.taskId, at: T0 + 1 });
    const attemptId = dispatched.attempt!.attemptId;
    const sending = ports.coordinator.send({ attemptId, at: T0 + 2 });
    await Promise.resolve();
    await Promise.resolve();

    // Then: the seam really sent, bound to the attempt owner's own session...
    expect(sent).toHaveLength(1);
    expect(sent[0]!.session).toEqual(OWNED);

    // When: the deferred native receipt lands.
    landReceipt({ operationId: 'op-e2e-1' });
    const result = await sending;

    // Then: the attempt reached `sent` with the real ack — not `reconcile`.
    expect(result.attempt!.state).toBe('sent');
    expect(ports.coordinator.attempt(attemptId).state).toBe('sent');
    expect(ports.coordinator.attempt(attemptId).sends).toBe(1);
  });
});
