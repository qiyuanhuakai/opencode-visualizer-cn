import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendActivation } from './useBackendActivation';
import type { BackendKind } from '../backends/types';

type HarnessOverrides = {
  bootstrapSelections?: () => Promise<void>;
  hydrateActiveWorktreeResources?: () => Promise<void>;
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
  };
  const codexApi = {
    url: ref(''),
    bridgeToken: ref(''),
    activeThreadId: ref('thread-1'),
    visibleThreads: ref([{ id: 'thread-1' }]),
    connect: vi.fn(async () => {
      calls.push('codex.connect');
    }),
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
    connect: vi.fn(async () => {
      calls.push('ge.connect');
    }),
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
    disconnectAcpBackend,
    disconnectCodexBackend,
    bootstrapAcpWorkspace: async () => {
      calls.push('bootstrapAcpWorkspace');
      selectedProjectId.value = 'acp';
      selectedSessionId.value = 'acp-session';
    },
    fetchGlobalProviderConfig: async () => {
      calls.push('fetchGlobalProviderConfig');
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
    activation,
  };
}

describe('useBackendActivation', () => {
  it.each(['opencode', 'acp'] as const)(
    'keeps the independent Codex panel client connected while activating %s',
    async (backendKind) => {
      const harness = createHarness(backendKind);

      await harness.activation.startInitialization();

      expect(harness.codexApi.disconnect).not.toHaveBeenCalled();
    },
  );

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
    const harness = createHarness('opencode', {
      hydrateActiveWorktreeResources: () => new Promise<void>(() => {}),
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
  });

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
});
