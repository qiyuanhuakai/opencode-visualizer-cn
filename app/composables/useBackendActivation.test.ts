import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref, type Ref } from 'vue';
import { useBackendActivation } from './useBackendActivation';
import type { BackendAdapter, BackendKind } from '../backends/types';
import { createKimiWebAdapter } from '../backends/kimiWeb/kimiWebAdapter';
import { createKimiWebClient } from '../utils/kimiWeb';

type HarnessOverrides = {
  codexConnect?: () => Promise<void>;
  fetchGlobalProviderConfig?: () => Promise<void>;
  connectOpenCode?: () => Promise<void>;
  bootstrapAcpWorkspace?: () => Promise<void>;
  bootstrapSelections?: () => Promise<void>;
  hydrateActiveWorktreeResources?: () => Promise<void>;
  precheckKimiWebConnection?: () => Promise<void>;
  bootstrapKimiWebWorkspace?: (isCurrent: () => boolean) => Promise<void>;
};

function createHarness(initialBackend: BackendKind = 'opencode', overrides: HarnessOverrides = {}) {
  const calls: string[] = [];
  const credentials = {
    backendKind: ref<BackendKind>(initialBackend),
    codexBridgeUrl: ref('http://localhost:4040'),
    acpBridgeUrl: ref('ws://localhost:23004'),
    codexBridgeToken: ref('token'),
    acpBridgeToken: ref('acp-token'),
    acpAgentId: ref('oh-my-pi'),
    kimiWebBridgeUrl: ref('ws://localhost:23004/kimi-web/ws'),
    kimiWebBridgeToken: ref('kimi-bridge-token'),
  };
  const codexApi = {
    url: ref(''),
    bridgeToken: ref(''),
    activeThreadId: ref('thread-1'),
    visibleThreads: ref([{ id: 'thread-1' }]),
    connect: vi.fn(
      overrides.codexConnect ??
        (async () => {
          calls.push('codex.connect');
        }),
    ),
    disconnect: vi.fn(() => {
      calls.push('codex.disconnect');
    }),
    disconnectTransport: vi.fn(() => {
      calls.push('codex.disconnectTransport');
    }),
    selectThread: vi.fn(async () => {
      calls.push('codex.selectThread');
    }),
  };
  const ge = {
    connect: vi.fn(
      overrides.connectOpenCode ??
        (async () => {
          calls.push('ge.connect');
        }),
    ),
    disconnect: vi.fn(() => {
      calls.push('ge.disconnect');
    }),
  };
  const activeBackendKind = ref<BackendKind>('opencode');
  const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>('login');
  const initLoadingMessage = ref('');
  const initErrorMessage = ref('');
  const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
    'connecting',
  );
  const reconnectingMessage = ref('stale');
  const selectedProjectId = ref('old-project');
  const selectedSessionId = ref('old-session');
  const providerConfig = ref<unknown>('old-config');
  const providersLoaded = ref(true);
  const providers = ref<unknown[]>(['old-provider']);
  const connectedProviderIds = ref<string[]>(['old-provider']);
  const modelOptions = ref<unknown[]>(['old-model']);
  const selectedModel = ref('old-model');
  const agents = ref<unknown[]>([]);
  const agentOptions = ref<unknown[]>([]);
  const commands = ref<unknown[]>([]);
  const thinkingOptions = ref<Array<string | undefined>>([]);
  const providerDefaults = ref<unknown>({});
  const modelMetaByPath = ref<unknown>(new Map());
  const serverState = {
    bootstrapped: ref(true),
    projects: { stale: {} as unknown },
  };
  const configureAcpBackend = vi.fn(() => {
    calls.push('configureAcpBackend');
  });
  const configureKimiWebBackend = vi.fn(() => {
    calls.push('configureKimiWebBackend');
  });
  const disconnectAcpBackend = vi.fn(() => {
    calls.push('disconnectAcpBackend');
  });
  const disconnectCodexBackend = vi.fn(() => {
    calls.push('disconnectCodexBackend');
  });
  const disconnectKimiWebBackend = vi.fn(() => {
    calls.push('disconnectKimiWebBackend');
  });

  const activation = useBackendActivation({
    credentials,
    codexApi,
    ge,
    activeBackendKind,
    uiInitState,
    initLoadingMessage,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    selectedProjectId,
    selectedSessionId,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    agents,
    agentOptions,
    commands,
    thinkingOptions,
    providerDefaults,
    modelMetaByPath,
    serverState,
    t: (key: string) => key,
    toErrorMessage: (error: unknown) => String(error),
    setActiveBackendKind: (kind) => {
      calls.push(`setActiveBackendKind:${kind}`);
    },
    configureCodexBackend: () => {
      calls.push('configureCodexBackend');
    },
    configureAcpBackend,
    configureKimiWebBackend,
    disconnectAcpBackend,
    disconnectCodexBackend,
    disconnectKimiWebBackend,
    bootstrapAcpWorkspace:
      overrides.bootstrapAcpWorkspace ??
      (async () => {
        calls.push('bootstrapAcpWorkspace');
        selectedProjectId.value = 'acp';
        selectedSessionId.value = 'acp-session';
      }),
    bootstrapKimiWebWorkspace:
      overrides.bootstrapKimiWebWorkspace ??
      (async () => {
        calls.push('bootstrapKimiWebWorkspace');
      }),
    fetchGlobalProviderConfig: async () => {
      calls.push('fetchGlobalProviderConfig');
      await overrides.fetchGlobalProviderConfig?.();
    },
    fetchProviders: async () => {
      calls.push('fetchProviders');
    },
    fetchAgents: async () => {
      calls.push('fetchAgents');
    },
    fetchCommands: async () => {
      calls.push('fetchCommands');
    },
    fetchHomePath: async () => {
      calls.push('fetchHomePath');
    },
    bootstrapSelections:
      overrides.bootstrapSelections ??
      (async () => {
        calls.push('bootstrapSelections');
        if (initialBackend === 'opencode') {
          performance.mark('vis:opencode-topology-ready');
        }
      }),
    hydrateActiveWorktreeResources:
      overrides.hydrateActiveWorktreeResources ??
      (async () => {
        calls.push('hydrateActiveWorktreeResources');
        if (initialBackend === 'opencode') {
          performance.mark('vis:opencode-full-tree');
        }
      }),
    reloadSelectedSessionState: async () => {
      calls.push('reloadSelectedSessionState');
    },
    precheckKimiWebConnection:
      overrides.precheckKimiWebConnection ??
      (async () => {
        calls.push('precheckKimiWebConnection');
      }),
    handleOpenCodeUnauthorized: (message: string) => {
      calls.push(`handleOpenCodeUnauthorized:${message}`);
    },
  });

  return {
    calls,
    credentials,
    codexApi,
    ge,
    activeBackendKind,
    uiInitState,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    selectedProjectId,
    selectedSessionId,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    serverState,
    configureAcpBackend,
    configureKimiWebBackend,
    disconnectKimiWebBackend,
    activation,
  };
}

// R3/S2, R6/S5a, R9/S3b: additive harness for the new failing describes.
function createKimiWebActivationHarness(
  overrides: {
    precheckKimiWebConnection?: () => Promise<void>;
    bootstrapKimiWebWorkspace?: (isCurrent: () => boolean) => Promise<void>;
  } = {},
) {
  const calls: string[] = [];
  const fetchProviderArgs: Array<boolean | undefined> = [];

  const restFetcher = vi.fn(async (_input: unknown) => {
    const url = String(_input);
    const payload = url.includes('/api/v1/models')
      ? {
          code: 0,
          msg: 'ok',
          request_id: 'test',
          data: {
            items: [
              { provider: 'kimi', model: 'kimi-k2', display_name: 'Kimi K2' },
              { provider: 'kimi', model: 'kimi-k2-thinking', display_name: 'Kimi K2 Thinking' },
            ],
          },
        }
      : { code: 0, msg: 'ok', request_id: 'test', data: {} };
    return new Response(JSON.stringify(payload), {
      status: 200,
      headers: { 'content-type': 'application/json' },
    });
  });
  const restClient = createKimiWebClient({
    baseUrl: 'http://localhost:23004/kimi-web',
    getToken: () => 'kimi-bridge-token',
    fetcher: restFetcher as unknown as typeof fetch,
  });
  const adapter = createKimiWebAdapter({
    bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
    client: restClient,
  });
  const adapterContract: BackendAdapter = adapter;

  const credentials = {
    backendKind: ref<BackendKind>('kimi-web'),
    codexBridgeUrl: ref('http://localhost:4040'),
    acpBridgeUrl: ref('ws://localhost:23004'),
    codexBridgeToken: ref('token'),
    acpBridgeToken: ref('acp-token'),
    acpAgentId: ref('oh-my-pi'),
    kimiWebBridgeUrl: ref('ws://localhost:23004/kimi-web/ws'),
    kimiWebBridgeToken: ref('kimi-bridge-token'),
  };
  const codexApi = {
    url: ref(''),
    bridgeToken: ref(''),
    activeThreadId: ref(''),
    visibleThreads: ref<Array<{ id: string }>>([]),
    connect: vi.fn(async () => {}),
    disconnectTransport: vi.fn(() => {}),
    disconnect: vi.fn(() => {}),
    selectThread: vi.fn(async () => {}),
  };
  const ge = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(() => {}),
  };
  const activeBackendKind = ref<BackendKind>('opencode');
  const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>('login');
  const initLoadingMessage = ref('');
  const initErrorMessage = ref('');
  const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
    'connecting',
  );
  const reconnectingMessage = ref('');
  const selectedProjectId = ref('');
  const selectedSessionId = ref('');
  const providerConfig = ref<unknown>(null);
  const providersLoaded = ref(false);
  const providers = ref<unknown[]>([]);
  const connectedProviderIds = ref<string[]>([]);
  const modelOptions = ref<unknown[]>([]);
  const selectedModel = ref('');
  const serverState = {
    bootstrapped: ref(false),
    projects: {} as Record<string, unknown>,
  };
  const agentOptions = ref<Array<{ id: string; label: string }>>([]);
  const commands = ref<Array<{ id: string; name: string }>>([]);
  const thinkingOptions = ref<Array<string | undefined>>([]);
  const providerDefaults = ref<Record<string, string>>({});
  const agents = ref<unknown[]>([]);
  const modelMetaByPath = ref<unknown>(new Map());

  const activation = useBackendActivation({
    credentials,
    codexApi,
    ge,
    activeBackendKind,
    uiInitState,
    initLoadingMessage,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    selectedProjectId,
    selectedSessionId,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    agents,
    agentOptions,
    commands,
    thinkingOptions,
    providerDefaults,
    modelMetaByPath,
    serverState,
    t: (key: string) => key,
    toErrorMessage: (error: unknown) => String(error),
    setActiveBackendKind: (kind) => {
      calls.push(`setActiveBackendKind:${kind}`);
    },
    configureCodexBackend: () => {
      calls.push('configureCodexBackend');
    },
    configureAcpBackend: () => {
      calls.push('configureAcpBackend');
    },
    configureKimiWebBackend: () => {
      calls.push('configureKimiWebBackend');
    },
    disconnectAcpBackend: () => {
      calls.push('disconnectAcpBackend');
    },
    disconnectCodexBackend: () => {
      calls.push('disconnectCodexBackend');
    },
    disconnectKimiWebBackend: () => {
      calls.push('disconnectKimiWebBackend');
    },
    bootstrapAcpWorkspace: async () => {
      calls.push('bootstrapAcpWorkspace');
    },
    bootstrapKimiWebWorkspace:
      overrides.bootstrapKimiWebWorkspace ??
      (async () => {
        calls.push('bootstrapKimiWebWorkspace');
      }),
    fetchGlobalProviderConfig: async () => {
      calls.push('fetchGlobalProviderConfig');
      const getGlobalConfig = adapterContract.getGlobalConfig?.bind(adapterContract);
      providerConfig.value = getGlobalConfig ? await getGlobalConfig() : { model: 'kimi-k2' };
    },
    fetchProviders: async (force?: boolean) => {
      calls.push('fetchProviders');
      fetchProviderArgs.push(force);
      const data = await adapter.listProviders();
      providerDefaults.value = data.default ?? {};
      providers.value = data.all ?? [];
      connectedProviderIds.value = data.connected ?? [];
      modelOptions.value = (data.all ?? []).flatMap((provider) =>
        Object.values(provider.models ?? {}).map((model) => ({
          id: `${provider.id}/${model.id}`,
          modelID: model.id,
          label: model.name ?? model.id,
        })),
      );
      thinkingOptions.value = [];
      providersLoaded.value = true;
    },
    fetchAgents: async () => {
      calls.push('fetchAgents');
      if (activeBackendKind.value === 'kimi-web') agentOptions.value = [];
    },
    fetchCommands: async () => {
      calls.push('fetchCommands');
      if (activeBackendKind.value === 'kimi-web') commands.value = [];
    },
    fetchHomePath: async () => {
      calls.push('fetchHomePath');
    },
    bootstrapSelections: async () => {
      calls.push('bootstrapSelections');
    },
    hydrateActiveWorktreeResources: async () => {
      calls.push('hydrateActiveWorktreeResources');
    },
    reloadSelectedSessionState: async () => {
      calls.push('reloadSelectedSessionState');
    },
    precheckKimiWebConnection:
      overrides.precheckKimiWebConnection ??
      (async () => {
        calls.push('precheckKimiWebConnection');
      }),
    handleOpenCodeUnauthorized: (message: string) => {
      calls.push(`handleOpenCodeUnauthorized:${message}`);
    },
  });

  return {
    calls,
    fetchProviderArgs,
    adapterContract,
    activeBackendKind,
    uiInitState,
    initErrorMessage,
    connectionState,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    agentOptions,
    commands,
    thinkingOptions,
    providerDefaults,
    activation,
  };
}

describe('useBackendActivation', () => {
  afterEach(() => {
    vi.useRealTimers();
    vi.restoreAllMocks();
    vi.unstubAllGlobals();
  });

  it.each(['opencode', 'acp'] as const)(
    'keeps the independent Codex panel client connected while activating %s',
    async (backendKind) => {
      const harness = createHarness(backendKind);

      await harness.activation.startInitialization();

      expect(harness.codexApi.disconnect).not.toHaveBeenCalled();
    },
  );

  it('loads Codex configuration before resolving composer model and effort defaults', async () => {
    let finishConfig = () => {};
    const pendingConfig = new Promise<void>(resolve => { finishConfig = resolve; });
    const harness = createHarness('codex', { fetchGlobalProviderConfig: () => pendingConfig });
    const initializing = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.calls).toContain('fetchGlobalProviderConfig'));
    expect(harness.calls).not.toContain('fetchProviders');
    finishConfig();
    await initializing;
    expect(harness.calls).toContain('fetchProviders');
  });

  it('resets shared OpenCode state and runs the shared activation sequence', async () => {
    const harness = createHarness('opencode');

    await harness.activation.startInitialization();

    expect(harness.activeBackendKind.value).toBe('opencode');
    expect(harness.serverState.bootstrapped.value).toBe(false);
    expect(harness.serverState.projects).toEqual({});
    expect(harness.selectedProjectId.value).toBe('');
    expect(harness.selectedSessionId.value).toBe('');
    expect(harness.providerConfig.value).toBe(null);
    expect(harness.providersLoaded.value).toBe(false);
    expect(harness.providers.value).toEqual([]);
    expect(harness.connectedProviderIds.value).toEqual([]);
    expect(harness.modelOptions.value).toEqual([]);
    expect(harness.selectedModel.value).toBe('');
    expect(harness.calls).toEqual([
      'disconnectAcpBackend',
      'disconnectCodexBackend',
      'disconnectKimiWebBackend',
      'setActiveBackendKind:opencode',
      'ge.connect',
      'fetchHomePath',
      'bootstrapSelections',
      'hydrateActiveWorktreeResources',
      'fetchGlobalProviderConfig',
      'fetchProviders',
      'fetchAgents',
    ]);
  });

  it('runs the Codex activation path through the shared manager', async () => {
    const markSpy = vi.spyOn(performance, 'mark');
    const harness = createHarness('codex');

    await harness.activation.startInitialization();

    expect(harness.activeBackendKind.value).toBe('codex');
    expect(harness.selectedSessionId.value).toBe('thread-1');
    expect(harness.calls).toEqual([
      'ge.disconnect',
      'disconnectAcpBackend',
      'disconnectKimiWebBackend',
      'setActiveBackendKind:codex',
      'configureCodexBackend',
      'codex.connect',
      'codex.selectThread',
      'fetchGlobalProviderConfig',
      'fetchProviders',
      'fetchAgents',
      'hydrateActiveWorktreeResources',
      'reloadSelectedSessionState',
    ]);
    expect(
      markSpy.mock.calls.map(([name]) => name).filter((name) => name.startsWith('vis:opencode-')),
    ).toEqual([]);
    markSpy.mockRestore();
  });

  it('activates ACP through the shared bridge without connecting OpenCode events', async () => {
    const markSpy = vi.spyOn(performance, 'mark');
    const harness = createHarness('acp');

    await harness.activation.startInitialization();

    expect(harness.activeBackendKind.value).toBe('acp');
    expect(harness.selectedProjectId.value).toBe('acp');
    expect(harness.selectedSessionId.value).toBe('acp-session');
    expect(harness.configureAcpBackend).toHaveBeenCalledWith({
      bridgeUrl: 'ws://localhost:23004',
      bridgeToken: 'acp-token',
      agentId: 'oh-my-pi',
    });
    await vi.waitFor(() => expect(harness.calls).toContain('hydrateActiveWorktreeResources'));
    expect(harness.calls).toEqual([
      'ge.disconnect',
      'disconnectCodexBackend',
      'disconnectKimiWebBackend',
      'configureAcpBackend',
      'setActiveBackendKind:acp',
      'bootstrapAcpWorkspace',
      'fetchAgents',
      'fetchCommands',
      'reloadSelectedSessionState',
      'fetchGlobalProviderConfig',
      'fetchProviders',
      'fetchAgents',
      'fetchCommands',
      'hydrateActiveWorktreeResources',
    ]);
    expect(
      markSpy.mock.calls.map(([name]) => name).filter((name) => name.startsWith('vis:opencode-')),
    ).toEqual([]);
    markSpy.mockRestore();
  });

  it('reaches Ready while resource hydration is still pending', async () => {
    // Given: hydration never settles
    let finishHydration = () => {};
    const harness = createHarness('opencode', {
      hydrateActiveWorktreeResources: () => new Promise<void>((resolve) => { finishHydration = resolve; }),
    });

    // When: OpenCode activation runs
    const initPromise = harness.activation.startInitialization();

    // Then: the UI becomes Ready without waiting for hydration
    await vi.waitFor(() => {
      expect(harness.connectionState.value).toBe('ready');
      expect(harness.uiInitState.value).toBe('ready');
    });
    await initPromise;
    expect(harness.activation.initializationInFlight.value).toBe(false);
    finishHydration();
  });

  it('keeps an aborted OpenCode bootstrap on the login screen after its work settles', async () => {
    // Given: OpenCode is still selecting the initial project and session.
    let finishBootstrap: (() => void) | undefined;
    const harness = createHarness('opencode', {
      bootstrapSelections: () =>
        new Promise<void>((resolve) => {
          finishBootstrap = resolve;
        }),
    });
    const initialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.connectionState.value).toBe('bootstrapping'));

    // When: the user aborts startup before selection finishes.
    harness.activation.abortInitialization();
    finishBootstrap?.();
    await initialization;

    // Then: the obsolete bootstrap cannot publish Ready or continue startup work.
    expect(harness.uiInitState.value).toBe('login');
    expect(harness.connectionState.value).toBe('connecting');
    expect(harness.calls).not.toContain('hydrateActiveWorktreeResources');
    expect(harness.calls).not.toContain('fetchGlobalProviderConfig');
  });

  it('preserves an SSE authentication failure after cancelling its pending bootstrap', async () => {
    // Given: project selection is pending when SSE rejects the active credentials.
    let finishBootstrap: (() => void) | undefined;
    const harness = createHarness('opencode', {
      bootstrapSelections: () =>
        new Promise<void>((resolve) => {
          finishBootstrap = resolve;
        }),
    });
    const initialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.connectionState.value).toBe('bootstrapping'));

    // When: the authentication handler cancels startup and returns the app to login.
    harness.activation.abortInitialization();
    harness.connectionState.value = 'error';
    harness.initErrorMessage.value = 'Authentication failed. (HTTP 401)';
    harness.uiInitState.value = 'login';
    finishBootstrap?.();
    await initialization;

    // Then: the pending bootstrap cannot overwrite the authentication failure.
    expect(harness.connectionState.value).toBe('error');
    expect(harness.initErrorMessage.value).toBe('Authentication failed. (HTTP 401)');
    expect(harness.uiInitState.value).toBe('login');
    expect(harness.calls).not.toContain('hydrateActiveWorktreeResources');
  });

  it.each(['codex', 'acp'] satisfies BackendKind[])(
    'keeps a new OpenCode initialization owned after a stale %s activation settles',
    async (staleBackend) => {
      // Given: a backend activation remains pending while a replacement OpenCode login starts.
      let finishStaleActivation: (() => void) | undefined;
      let finishOpenCodeConnect: (() => void) | undefined;
      const harness = createHarness(staleBackend, {
        codexConnect: () =>
          new Promise<void>((resolve) => {
            finishStaleActivation = resolve;
          }),
        bootstrapAcpWorkspace: () =>
          new Promise<void>((resolve) => {
            finishStaleActivation = resolve;
          }),
        connectOpenCode: () =>
          new Promise<void>((resolve) => {
            finishOpenCodeConnect = resolve;
          }),
      });
      const staleInitialization = harness.activation.startInitialization();
      await vi.waitFor(() => expect(finishStaleActivation).toBeTypeOf('function'));
      harness.activation.abortInitialization();
      harness.credentials.backendKind.value = 'opencode';
      const currentInitialization = harness.activation.startInitialization();
      await vi.waitFor(() => expect(finishOpenCodeConnect).toBeTypeOf('function'));

      // When: the obsolete activation reaches its finalizer.
      finishStaleActivation?.();
      await staleInitialization;

      expect(harness.selectedSessionId.value).toBe('');
      expect(harness.uiInitState.value).toBe('loading');
      expect(harness.calls).not.toContain('reloadSelectedSessionState');

      // Then: the replacement still owns the lock and can finish reaching Ready.
      expect(harness.activation.initializationInFlight.value).toBe(true);
      finishOpenCodeConnect?.();
      await currentInitialization;
      expect(harness.connectionState.value).toBe('ready');
      expect(harness.uiInitState.value).toBe('ready');
    },
  );

  it('keeps Ready state when resource hydration rejects after activation', async () => {
    // Given: hydration fails after the UI is already Ready
    let rejectHydration: ((error: unknown) => void) | undefined;
    const harness = createHarness('opencode', {
      hydrateActiveWorktreeResources: () =>
        new Promise<void>((_resolve, reject) => {
          rejectHydration = reject;
        }),
    });
    const initPromise = harness.activation.startInitialization();
    await vi.waitFor(() => {
      expect(harness.uiInitState.value).toBe('ready');
    });
    await initPromise;

    // When: the detached hydration promise rejects
    rejectHydration?.(new Error('hydration failed'));
    await new Promise((resolve) => setTimeout(resolve, 0));

    // Then: state stays Ready, no disconnect, no login revert
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
    expect(harness.initErrorMessage.value).toBe('');
    expect(harness.calls).not.toContain('ge.disconnect');
  });

  it('records OpenCode startup marks from connection through full-tree hydration', async () => {
    // Given: a spy on performance.mark
    const markSpy = vi.spyOn(performance, 'mark');
    const harness = createHarness('opencode');

    // When: OpenCode activation completes
    await harness.activation.startInitialization();

    // Then: connection, topology, session selection, ready, and full-tree are ordered
    const opencodeMarks = markSpy.mock.calls
      .map(([name]) => name)
      .filter((name) => name.startsWith('vis:opencode-'));
    expect(opencodeMarks).toEqual([
      'vis:opencode-connect-start',
      'vis:opencode-topology-ready',
      'vis:opencode-session-selectable',
      'vis:opencode-ui-ready',
      'vis:opencode-full-tree',
    ]);
    markSpy.mockRestore();
  });

  it('keeps credentials intact when OpenCode selection bootstrap fails', async () => {
    // Given: selection hydration cannot resolve a target session
    const bootstrapSelections = vi.fn(async () => {
      throw new Error('errors.sessionNotFound');
    });
    const harness = createHarness('opencode', { bootstrapSelections });

    // When: initialization reaches the selection failure
    await harness.activation.startInitialization();

    // Then: the initialization error is surfaced without an unauthorized credential reset
    expect(harness.uiInitState.value).toBe('login');
    expect(harness.initErrorMessage.value).toContain('errors.sessionNotFound');
    expect(harness.calls).not.toContain('handleOpenCodeUnauthorized:errors.sessionNotFound');
  });

  it('reports ACP configuration failures and releases the initialization lock', async () => {
    const harness = createHarness('acp');
    harness.configureAcpBackend.mockImplementation(() => {
      throw new Error('invalid ACP bridge');
    });

    await expect(harness.activation.startInitialization()).resolves.toBeUndefined();

    expect(harness.uiInitState.value).toBe('login');
    expect(harness.initErrorMessage.value).toContain('invalid ACP bridge');
    expect(harness.activation.initializationInFlight.value).toBe(false);
  });

  it.each(['opencode', 'acp'] satisfies BackendKind[])(
    'preserves the Codex panel connection when aborting %s initialization',
    (backendKind) => {
      // Given: a non-Codex backend is being initialized while the panel is connected
      const harness = createHarness(backendKind);

      // When: that backend initialization is aborted
      harness.activation.abortInitialization();

      // Then: only backend-owned transports are disconnected
      expect(harness.codexApi.disconnect).not.toHaveBeenCalled();
      expect(harness.calls).toContain('disconnectCodexBackend');
    },
  );

  it('preserves reconnect intent when aborting Codex backend initialization', () => {
    // Given: Codex is the backend being initialized
    const harness = createHarness('codex');

    // When: Codex initialization is aborted
    harness.activation.abortInitialization();

    // Then: only the current transport is closed
    expect(harness.codexApi.disconnectTransport).toHaveBeenCalledOnce();
    expect(harness.codexApi.disconnect).not.toHaveBeenCalled();
  });

  it('preserves reconnect intent when Codex activation fails after connecting', async () => {
    // Given: Codex transport connects before downstream workspace hydration fails
    const harness = createHarness('codex', {
      hydrateActiveWorktreeResources: async () => {
        throw new Error('workspace hydration failed');
      },
    });

    // When: Codex backend activation falls back to the login screen
    await harness.activation.startInitialization();

    // Then: transport is closed without treating the failure as an explicit disconnect
    expect(harness.codexApi.disconnectTransport).toHaveBeenCalledOnce();
    expect(harness.codexApi.disconnect).not.toHaveBeenCalled();
    expect(harness.uiInitState.value).toBe('login');
  });

  it('activates the kimi-web backend after the bridge and meta prechecks pass', async () => {
    // Given: the kimi-web backend is selected with bridge credentials
    const harness = createHarness('kimi-web');

    // When: activation runs the fenced precheck sequence
    await harness.activation.startInitialization();

    // Then: configuration, active identity, and Ready state are committed
    expect(harness.activeBackendKind.value).toBe('kimi-web');
    expect(harness.configureKimiWebBackend).toHaveBeenCalledWith({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
      bridgeToken: 'kimi-bridge-token',
    });
    expect(harness.calls).toEqual([
      'ge.disconnect',
      'disconnectAcpBackend',
      'disconnectCodexBackend',
      'configureKimiWebBackend',
      'setActiveBackendKind:kimi-web',
      'precheckKimiWebConnection',
      'bootstrapKimiWebWorkspace',
    ]);
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
    expect(harness.activation.initializationInFlight.value).toBe(false);
  });

  it('disposes the kimi-web transport when switching to another backend', async () => {
    const harness = createHarness('opencode');

    await harness.activation.startInitialization();

    expect(harness.disconnectKimiWebBackend).toHaveBeenCalledOnce();
  });

  it('gives kimi-web bootstrap a stale fence so an interrupted list cannot commit', async () => {
    let finishBootstrap: (() => void) | undefined;
    let bootstrapFence: (() => boolean) | undefined;
    const harness = createHarness('kimi-web', {
      bootstrapKimiWebWorkspace: (isCurrent) => {
        bootstrapFence = isCurrent;
        return new Promise<void>((resolve) => {
          finishBootstrap = resolve;
        });
      },
    });
    const staleInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(bootstrapFence).toBeTypeOf('function'));

    harness.activation.abortInitialization();
    expect(bootstrapFence?.()).toBe(false);
    finishBootstrap?.();
    await staleInitialization;

    expect(harness.uiInitState.value).toBe('login');
    expect(harness.connectionState.value).toBe('connecting');
  });

  it('keeps an aborted kimi-web precheck on the login screen', async () => {
    // Given: the bridge/meta precheck is still pending
    let finishPrecheck: (() => void) | undefined;
    const harness = createHarness('kimi-web', {
      precheckKimiWebConnection: () =>
        new Promise<void>((resolve) => {
          finishPrecheck = resolve;
        }),
    });
    const initialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(finishPrecheck).toBeTypeOf('function'));

    // When: the user aborts startup before the precheck settles
    harness.activation.abortInitialization();
    finishPrecheck?.();
    await initialization;

    // Then: the obsolete precheck cannot publish Ready
    expect(harness.uiInitState.value).toBe('login');
    expect(harness.connectionState.value).toBe('connecting');
    expect(harness.initErrorMessage.value).toBe('');
    expect(harness.activation.initializationInFlight.value).toBe(false);
  });

  it('holds the kimi-web initialization lock against a concurrent start', async () => {
    // Given: a kimi-web precheck is pending and owns the initialization lock
    let finishPrecheck: (() => void) | undefined;
    const precheck = vi.fn(
      () =>
        new Promise<void>((resolve) => {
          finishPrecheck = resolve;
        }),
    );
    const harness = createHarness('kimi-web', { precheckKimiWebConnection: precheck });
    const first = harness.activation.startInitialization();
    await vi.waitFor(() => expect(precheck).toHaveBeenCalledTimes(1));

    // When: a second initialization is requested while the first is in flight
    await harness.activation.startInitialization();

    // Then: the second request is ignored and the lock is still held
    expect(precheck).toHaveBeenCalledTimes(1);
    expect(harness.activation.initializationInFlight.value).toBe(true);

    finishPrecheck?.();
    await first;
    expect(harness.activation.initializationInFlight.value).toBe(false);
    expect(harness.uiInitState.value).toBe('ready');
  });

  it('drops a stale-generation kimi-web precheck without mutating the current backend state', async () => {
    // Given: a kimi-web precheck is pending when the user switches to OpenCode
    let finishStalePrecheck: (() => void) | undefined;
    const harness = createHarness('kimi-web', {
      precheckKimiWebConnection: () =>
        new Promise<void>((resolve) => {
          finishStalePrecheck = resolve;
        }),
    });
    const staleInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(finishStalePrecheck).toBeTypeOf('function'));

    harness.activation.abortInitialization();
    harness.credentials.backendKind.value = 'opencode';
    const currentInitialization = harness.activation.startInitialization();
    await currentInitialization;
    expect(harness.uiInitState.value).toBe('ready');

    // When: the obsolete kimi-web precheck finally resolves "successfully"
    const callsAfterCurrent = [...harness.calls];
    finishStalePrecheck?.();
    await staleInitialization;

    // Then: the stale response commits nothing
    expect(harness.calls).toEqual(callsAfterCurrent);
    expect(harness.activeBackendKind.value).toBe('opencode');
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
  });

  it('returns a failed kimi-web precheck to the login screen', async () => {
    // Given: the fenced precheck rejects (bridge healthz or kimi meta not usable)
    const harness = createHarness('kimi-web', {
      precheckKimiWebConnection: async () => {
        throw new Error('kimi web precheck failed');
      },
    });

    // When: kimi-web activation runs
    await harness.activation.startInitialization();

    // Then: the failure is surfaced and the lock is released back to login
    expect(harness.uiInitState.value).toBe('login');
    expect(harness.connectionState.value).toBe('error');
    expect(harness.initErrorMessage.value).toContain('kimi web precheck failed');
    expect(harness.activation.initializationInFlight.value).toBe(false);
  });
});

describe('kimi-web activation loads providers and global config (R3/S2)', () => {
  it('calls fetchProviders(true) and populates providers, modelOptions, connectedProviderIds, and providerConfig', async () => {
    const harness = createKimiWebActivationHarness();

    await harness.activation.startInitialization();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      harness.fetchProviderArgs,
      'kimi-web activation must call fetchProviders(true) (R3/S2)',
    ).toContain(true);
    expect(
      harness.providers.value.length,
      'kimi-web activation must populate providers from /api/v1/models (R3/S2)',
    ).toBeGreaterThan(0);
    expect(
      harness.modelOptions.value.length,
      'kimi-web activation must populate modelOptions from /api/v1/models (R3/S2)',
    ).toBeGreaterThan(0);
    expect(
      harness.connectedProviderIds.value.length,
      'kimi-web activation must populate connectedProviderIds from /api/v1/models (R3/S2)',
    ).toBeGreaterThan(0);
    expect(
      harness.providerConfig.value,
      'kimi-web activation must load the global provider config (R3/S2)',
    ).not.toBeNull();
  });
});

describe('kimi-web activation clears stale Codex/ACP composer state (R6/S5a)', () => {
  it('empties agentOptions, commands, thinkingOptions, and providerDefaults on switch', async () => {
    const harness = createKimiWebActivationHarness();
    harness.agentOptions.value = [{ id: 'oh-my-pi', label: 'Oh My Pi' }];
    harness.commands.value = [{ id: 'codex:review', name: 'review' }];
    harness.thinkingOptions.value = ['high'];
    harness.providerDefaults.value = { 'gpt-5': 'high' };

    await harness.activation.startInitialization();
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(
      harness.agentOptions.value,
      'switching to kimi-web must clear the previous backend agentOptions (R6/S5a)',
    ).toEqual([]);
    expect(
      harness.commands.value,
      'switching to kimi-web must clear the previous backend commands (R6/S5a)',
    ).toEqual([]);
    expect(
      harness.thinkingOptions.value,
      'switching to kimi-web must clear the previous backend thinkingOptions (R6/S5a)',
    ).toEqual([]);
    expect(
      harness.providerDefaults.value,
      'switching to kimi-web must clear the previous backend providerDefaults (R6/S5a)',
    ).toEqual({});
  });
});

describe('kimi-web global provider config contract (R9/S3b)', () => {
  function requireBackendMethod<T>(method: T | undefined, name: string): T {
    if (!method) throw new Error(`Active backend does not support ${name}.`);
    return method;
  }

  it('resolves the shared global provider config load instead of throwing', async () => {
    const adapter: BackendAdapter = createKimiWebAdapter({
      bridgeUrl: 'ws://localhost:23004/kimi-web/ws',
    });

    let thrown: unknown;
    try {
      const getGlobalConfig = requireBackendMethod(adapter.getGlobalConfig, 'global config');
      await getGlobalConfig();
    } catch (error) {
      thrown = error;
    }

    expect(
      thrown,
      'KimiWebAdapter must implement getGlobalConfig so App.vue fetchGlobalProviderConfig does not throw (R9/S3b)',
    ).toBeUndefined();
  });
});

// R6b/S5a: the cross-backend residue is BIDIRECTIONAL. The first pass only
// pinned Codex/ACP -> kimi-web, but the shared surface is owned by App.vue and
// is backend-scoped, so every activation must clear it:
//   - resetOpenCodeSelectionState() (useBackendActivation.ts:138-151) clears
//     only 10 selection fields and never touches the composer/picker surface.
//   - activateCodex() (:153) calls no reset at all, so an OpenCode ->
//     Codex switch leaks projects, providers, models and selection verbatim.
// The full surface lives at App.vue:1758-1767 (providerDefaults, agents,
// commands, modelMetaByPath, agentOptions, thinkingOptions). hiddenModels
// (App.vue:2127) is persisted user preference and is deliberately NOT part of
// the reset contract.
type CrossBackendSharedState = {
  agents: Ref<unknown[]>;
  agentOptions: Ref<unknown[]>;
  commands: Ref<unknown[]>;
  thinkingOptions: Ref<Array<string | undefined>>;
  providerDefaults: Ref<unknown>;
  modelMetaByPath: Ref<unknown>;
};

type CrossBackendHarness = CrossBackendSharedState & {
  activation: ReturnType<typeof useBackendActivation>;
  credentials: { backendKind: ReturnType<typeof ref<BackendKind>> };
  uiInitState: ReturnType<typeof ref<'loading' | 'ready' | 'error' | 'login'>>;
  selectedProjectId: ReturnType<typeof ref<string>>;
  selectedSessionId: ReturnType<typeof ref<string>>;
  providerConfig: ReturnType<typeof ref<unknown>>;
  providersLoaded: ReturnType<typeof ref<boolean>>;
  providers: ReturnType<typeof ref<unknown[]>>;
  connectedProviderIds: ReturnType<typeof ref<string[]>>;
  modelOptions: ReturnType<typeof ref<unknown[]>>;
  selectedModel: ReturnType<typeof ref<string>>;
  serverState: { bootstrapped: ReturnType<typeof ref<boolean>>; projects: Record<string, unknown> };
};

function createCrossBackendHarness(target: BackendKind): CrossBackendHarness {
  const credentials = {
    backendKind: ref<BackendKind>(target),
    codexBridgeUrl: ref('http://localhost:4040'),
    acpBridgeUrl: ref('ws://localhost:23004'),
    codexBridgeToken: ref('token'),
    acpBridgeToken: ref('acp-token'),
    acpAgentId: ref('oh-my-pi'),
    kimiWebBridgeUrl: ref('ws://localhost:23004/kimi-web/ws'),
    kimiWebBridgeToken: ref('kimi-bridge-token'),
  };
  const codexApi = {
    url: ref(''),
    bridgeToken: ref(''),
    activeThreadId: ref('thread-1'),
    visibleThreads: ref([{ id: 'thread-1' }]),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    disconnectTransport: vi.fn(),
    selectThread: vi.fn(async () => {}),
  };
  const ge = {
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
  };
  const activeBackendKind = ref<BackendKind>('opencode');
  const uiInitState = ref<'loading' | 'ready' | 'error' | 'login'>('login');
  const initLoadingMessage = ref('');
  const initErrorMessage = ref('');
  const connectionState = ref<'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error'>(
    'connecting',
  );
  const reconnectingMessage = ref('');
  const selectedProjectId = ref('');
  const selectedSessionId = ref('');
  const providerConfig = ref<unknown>(null);
  const providersLoaded = ref(false);
  const providers = ref<unknown[]>([]);
  const connectedProviderIds = ref<string[]>([]);
  const modelOptions = ref<unknown[]>([]);
  const selectedModel = ref('');
  const serverState = { bootstrapped: ref(false), projects: {} as Record<string, unknown> };

  // The shared cross-backend surface App.vue owns. useBackendActivation does
  // not accept these yet — that missing contract is exactly what R6b pins.
  // Built as a variable so the absent option keys stay a runtime assertion
  // failure instead of a type error in the RED state.
  const sharedState: CrossBackendSharedState = {
    agents: ref<unknown[]>([]),
    agentOptions: ref<unknown[]>([]),
    commands: ref<unknown[]>([]),
    thinkingOptions: ref<Array<string | undefined>>([]),
    providerDefaults: ref<unknown>({}),
    modelMetaByPath: ref<unknown>(new Map()),
  };

  const options = {
    credentials,
    codexApi,
    ge,
    activeBackendKind,
    uiInitState,
    initLoadingMessage,
    initErrorMessage,
    connectionState,
    reconnectingMessage,
    selectedProjectId,
    selectedSessionId,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    serverState,
    t: (key: string) => key,
    toErrorMessage: (error: unknown) => String(error),
    setActiveBackendKind: () => {},
    configureCodexBackend: () => {},
    configureAcpBackend: () => {},
    configureKimiWebBackend: () => {},
    disconnectAcpBackend: () => {},
    disconnectCodexBackend: () => {},
    disconnectKimiWebBackend: () => {},
    bootstrapAcpWorkspace: async () => {},
    bootstrapKimiWebWorkspace: async () => {},
    fetchGlobalProviderConfig: async () => {},
    fetchProviders: async () => {},
    fetchAgents: async () => {},
    fetchCommands: async () => {},
    fetchHomePath: async () => {},
    bootstrapSelections: async () => {},
    hydrateActiveWorktreeResources: async () => {},
    reloadSelectedSessionState: async () => {},
    precheckKimiWebConnection: async () => {},
    handleOpenCodeUnauthorized: () => {},
    ...sharedState,
  };

  return {
    ...sharedState,
    activation: useBackendActivation(options),
    credentials,
    uiInitState,
    selectedProjectId,
    selectedSessionId,
    providerConfig,
    providersLoaded,
    providers,
    connectedProviderIds,
    modelOptions,
    selectedModel,
    serverState,
  };
}

function seedCrossBackendState(harness: CrossBackendHarness) {
  harness.serverState.projects['stale-project'] = {} as unknown;
  harness.serverState.bootstrapped.value = true;
  harness.selectedProjectId.value = 'stale-project';
  harness.selectedSessionId.value = 'stale-session';
  harness.providerConfig.value = { stale: true };
  harness.providersLoaded.value = true;
  harness.providers.value = [{ id: 'stale-provider' }];
  harness.connectedProviderIds.value = ['stale-provider'];
  harness.modelOptions.value = [{ id: 'stale-model' }];
  harness.selectedModel.value = 'stale-model';
  harness.agents.value = [{ id: 'stale-agent' }];
  harness.agentOptions.value = [{ id: 'oh-my-pi', label: 'Oh My Pi' }];
  harness.commands.value = [{ id: 'codex:review', name: 'review' }];
  harness.thinkingOptions.value = ['high'];
  harness.providerDefaults.value = { 'stale-model': 'high' };
  harness.modelMetaByPath.value = new Map([['stale-model', { path: 'stale-model' }]]);
}

function expectCrossBackendStateCleared(harness: CrossBackendHarness, target: BackendKind) {
  expect(
    harness.agentOptions.value,
    `switching to ${target} must clear the previous backend agentOptions (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.commands.value,
    `switching to ${target} must clear the previous backend commands (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.thinkingOptions.value,
    `switching to ${target} must clear the previous backend thinkingOptions (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.providerDefaults.value,
    `switching to ${target} must clear the previous backend providerDefaults (R6b/S5a)`,
  ).toEqual({});
  expect(
    harness.agents.value,
    `switching to ${target} must clear the previous backend agents (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.modelMetaByPath.value,
    `switching to ${target} must clear the previous backend modelMetaByPath (R6b/S5a)`,
  ).toEqual(new Map());
  expect(
    harness.selectedProjectId.value,
    `switching to ${target} must clear the previous backend selectedProjectId (R6b/S5a)`,
  ).toBe('');
  // Codex legitimately re-points the selection at its own thread, so the
  // contract is "no stale value survives", not "empty".
  expect(
    harness.selectedSessionId.value,
    `switching to ${target} must not keep the previous backend selectedSessionId (R6b/S5a)`,
  ).not.toBe('stale-session');
  expect(
    harness.providerConfig.value,
    `switching to ${target} must clear the previous backend providerConfig (R6b/S5a)`,
  ).toBeNull();
  expect(
    harness.providersLoaded.value,
    `switching to ${target} must clear the previous backend providersLoaded (R6b/S5a)`,
  ).toBe(false);
  expect(
    harness.providers.value,
    `switching to ${target} must clear the previous backend providers (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.connectedProviderIds.value,
    `switching to ${target} must clear the previous backend connectedProviderIds (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.modelOptions.value,
    `switching to ${target} must clear the previous backend modelOptions (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.selectedModel.value,
    `switching to ${target} must clear the previous backend selectedModel (R6b/S5a)`,
  ).toBe('');
  expect(
    Object.keys(harness.serverState.projects),
    `switching to ${target} must clear the previous backend serverState.projects (R6b/S5a)`,
  ).toEqual([]);
  expect(
    harness.serverState.bootstrapped.value,
    `switching to ${target} must clear the previous backend serverState.bootstrapped (R6b/S5a)`,
  ).toBe(false);
}

describe('every backend switch clears the shared cross-backend surface (R6b/S5a)', () => {
  for (const target of ['codex', 'opencode', 'acp', 'kimi-web'] as BackendKind[]) {
    it(`switching to ${target} clears the previous backend's composer and selection state`, async () => {
      const harness = createCrossBackendHarness(target);
      seedCrossBackendState(harness);

      await harness.activation.startInitialization();

      expect(harness.uiInitState.value, `switching to ${target} must reach ready`).toBe('ready');
      expectCrossBackendStateCleared(harness, target);
    });
  }
});
