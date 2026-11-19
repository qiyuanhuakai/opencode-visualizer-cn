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
import { computed, createApp, h, nextTick, ref } from 'vue';
import { afterEach, describe, expect, it, vi } from 'vitest';
import {
  parseEnvironmentId,
  parseHarnessInstanceId,
  parseSessionRef,
} from '../shared/runtime/identity.js';
import type { SessionRef } from '../shared/runtime/identity.js';
import type { EnvironmentId } from '../shared/runtime/identity.js';
import type { HarnessManifest } from '../shared/runtime/harnessContract.js';
import type { ControlScope } from './composables/useRuntimeCapabilities';
import { useRuntimeSessionActions } from './composables/useRuntimeSessionActions';
import { mountRuntimeApp } from './test/runtimeAppHarness';

vi.mock('@iconify/vue', () => ({ Icon: () => null }));

const registryMock = vi.hoisted(() => ({
  getAdapter: vi.fn(),
}));

vi.mock('./backends/registry', async (importOriginal) => {
  const registry = await importOriginal<typeof import('./backends/registry')>();
  return {
    ...registry,
    getBackendAdapter: (...args: Parameters<typeof registry.getBackendAdapter>) =>
      registryMock.getAdapter(...args) ?? registry.getBackendAdapter(...args),
  };
});

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
// Management controls require a published manifest for the selected Agent.
const HARNESS_SCOPE_PROGRAM = transpile(
  `${appVariableDeclaration('harnessInstanceScope')};harnessInstanceScope.value;`,
);

function resolveHarnessScope(manifest: HarnessManifest | null = null): unknown {
  return runInNewContext(HARNESS_SCOPE_PROGRAM, {
    computed,
    managementManifest: box(manifest),
  });
}

describe('App.vue management scope', () => {
  it('stays null until the management Agent publishes a manifest', () => {
    expect(resolveHarnessScope()).toBeNull();
  });

  it('uses the instance identity of the management Agent', () => {
    expect(resolveHarnessScope(OPENCODE_MANIFEST)).toEqual({
      kind: 'instance',
      environmentId: ENV,
      harnessInstanceId: HARNESS,
    });
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
    const scope = resolveHarnessScope() as ControlScope | null;
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

  function parseQualifiedSession(session: SessionRef | null): unknown {
    return runInNewContext(PROGRAM, {
      unifiedSessionTree: box({ selection: box(session ? { selection: { session } } : null) }),
    });
  }

  it('returns the qualified identity from the unified tree selection', () => {
    expect(parseQualifiedSession(SESSION)).toEqual(SESSION);
  });

  it('returns null when no session is selected', () => {
    expect(parseQualifiedSession(null)).toBeNull();
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
      runtimeKindFor: () => 'opencode',
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
    expect(client.mutate.mock.calls[0]!.slice(1, 2)).toEqual(['native.extension']);
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
      sendRuntimeComposer: () => {},
      selectedRuntimeSendSupported: () => true,
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

describe('App unified tree over Bridge (F3-P2-1)', () => {
  it('loads the Bridge session tree after connecting, before any manual refresh', async () => {
    const fixture = await mountRuntimeApp([]);
    await fixture.connect();
    await fixture.select('Session A');
    await vi.waitFor(() => {
      expect(fixture.historyOpens.map(session => session.nativeSessionId)).toEqual(['session-a']);
    }, { timeout: 10000 });
  }, 30000);
});
