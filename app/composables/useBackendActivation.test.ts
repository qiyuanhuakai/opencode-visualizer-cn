import { afterEach, describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendActivation } from './useBackendActivation';
import type { BackendKind } from '../backends/types';

type HarnessOverrides = {
  codexConnect?: () => Promise<void>;
  fetchGlobalProviderConfig?: () => Promise<void>;
  connectOpenCode?: () => Promise<void>;
  bootstrapAcpWorkspace?: () => Promise<void>;
  bootstrapSelections?: () => Promise<void>;
  hydrateActiveWorktreeResources?: () => Promise<void>;
  precheckKimiWebConnection?: () => Promise<void>;
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
    bootstrapAcpWorkspace:
      overrides.bootstrapAcpWorkspace ??
      (async () => {
        calls.push('bootstrapAcpWorkspace');
        selectedProjectId.value = 'acp';
        selectedSessionId.value = 'acp-session';
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
    ]);
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
    expect(harness.activation.initializationInFlight.value).toBe(false);
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
