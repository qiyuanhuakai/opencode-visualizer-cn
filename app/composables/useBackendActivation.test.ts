import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendActivation } from './useBackendActivation';
import type { BackendKind } from '../backends/types';
import { SseConnectionError } from '../utils/sseConnection';

type HarnessOverrides = {
  bootstrapSelections?: () => Promise<void>;
  hydrateActiveWorktreeResources?: () => Promise<void>;
  connectOpenCode?: () => Promise<void>;
  handleOpenCodeUnauthorized?: (
    message: string,
    credentialRevision: string | null,
  ) => Promise<boolean>;
  getCredentialRevision?: () => string | null;
  loadCredentials?: () => Promise<void>;
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
    getRevision: overrides.getCredentialRevision ?? (() => 'revision-1'),
    load: vi.fn(overrides.loadCredentials ?? (async () => undefined)),
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
    handleOpenCodeUnauthorized:
      overrides.handleOpenCodeUnauthorized ??
      (async (message: string) => {
        calls.push(`handleOpenCodeUnauthorized:${message}`);
        return true;
      }),
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

  it('does not let a cancelled bootstrap publish Ready after a replacement connection failure', async () => {
    // Given: the initial SSE opened, while project selection is still bootstrapping.
    let resolveBootstrap: (() => void) | undefined;
    const harness = createHarness('opencode', {
      bootstrapSelections: () =>
        new Promise<void>((resolve) => {
          resolveBootstrap = resolve;
        }),
    });
    const initPromise = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.connectionState.value).toBe('bootstrapping'));

    // When: a replacement SSE fails terminally and invalidates this initialization generation.
    harness.activation.cancelInitialization();
    resolveBootstrap?.();
    await initPromise;

    // Then: the obsolete bootstrap cannot overwrite the error/login state with Ready.
    expect(harness.activation.initializationInFlight.value).toBe(false);
    expect(harness.connectionState.value).toBe('bootstrapping');
    expect(harness.uiInitState.value).toBe('loading');
  });

  it('waits for the cancelled selection bootstrap before running the replacement owner', async () => {
    // Given: the cancelled generation still owns an unfinished selection bootstrap.
    let resolveFirstBootstrap: (() => void) | undefined;
    let invocationCount = 0;
    const bootstrapSelections = vi.fn(() => {
      invocationCount += 1;
      if (invocationCount > 1) return Promise.resolve();
      return new Promise<void>((resolve) => {
        resolveFirstBootstrap = () => {
          resolve();
        };
      });
    });
    const harness = createHarness('opencode', { bootstrapSelections });
    const firstInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.connectionState.value).toBe('bootstrapping'));

    // When: replacement failure cancels that generation and retry starts immediately.
    harness.activation.cancelInitialization();
    const retryInitialization = harness.activation.startInitialization();
    await vi.waitFor(() =>
      expect(harness.calls.filter((call) => call === 'fetchHomePath')).toHaveLength(2),
    );
    await Promise.resolve();
    await Promise.resolve();

    // Then: retry waits for the first owner before running its own bootstrap.
    expect(bootstrapSelections).toHaveBeenCalledTimes(1);
    expect(harness.connectionState.value).toBe('bootstrapping');
    expect(harness.uiInitState.value).toBe('loading');

    resolveFirstBootstrap?.();
    await Promise.all([firstInitialization, retryInitialization]);
    expect(bootstrapSelections).toHaveBeenCalledTimes(2);
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
  });

  it('runs replacement selection bootstrap after the cancelled owner rejects', async () => {
    // Given: the cancelled generation owns a bootstrap tied to its old topology.
    let rejectFirstBootstrap: ((reason?: unknown) => void) | undefined;
    let invocationCount = 0;
    const bootstrapSelections = vi.fn(() => {
      invocationCount += 1;
      if (invocationCount > 1) return Promise.resolve();
      return new Promise<void>((_resolve, reject) => {
        rejectFirstBootstrap = reject;
      });
    });
    const harness = createHarness('opencode', { bootstrapSelections });
    const firstInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.connectionState.value).toBe('bootstrapping'));

    // When: a replacement generation starts before the old topology rejects.
    harness.activation.cancelInitialization();
    const retryInitialization = harness.activation.startInitialization();
    await vi.waitFor(() =>
      expect(harness.calls.filter((call) => call === 'fetchHomePath')).toHaveLength(2),
    );
    rejectFirstBootstrap?.(new Error('old topology unavailable'));
    await Promise.all([firstInitialization, retryInitialization]);

    // Then: the replacement runs its own bootstrap and reaches Ready.
    expect(bootstrapSelections).toHaveBeenCalledTimes(2);
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
  });

  it('does not publish stale unauthorized cleanup after replacement reaches Ready', async () => {
    // Given: the first generation waits for durable unauthorized cleanup.
    let connectCount = 0;
    let resolveCleanup: ((cleared: boolean) => void) | undefined;
    const handleOpenCodeUnauthorized = vi.fn(
      () =>
        new Promise<boolean>((resolve) => {
          resolveCleanup = resolve;
        }),
    );
    const harness = createHarness('opencode', {
      connectOpenCode: async () => {
        connectCount += 1;
        if (connectCount === 1) throw new SseConnectionError('Authentication failed.', 401);
      },
      handleOpenCodeUnauthorized,
    });
    const firstInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(handleOpenCodeUnauthorized).toHaveBeenCalledOnce());

    // When: replacement credentials reach Ready before the old cleanup settles.
    harness.activation.cancelInitialization();
    const retryInitialization = harness.activation.startInitialization();
    await vi.waitFor(() => expect(harness.uiInitState.value).toBe('ready'));
    resolveCleanup?.(false);
    await Promise.all([firstInitialization, retryInitialization]);

    // Then: the old generation cannot overwrite the replacement state.
    expect(harness.connectionState.value).toBe('ready');
    expect(harness.uiInitState.value).toBe('ready');
    expect(harness.initErrorMessage.value).toBe('');
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

  it('does not present login when unauthorized credential deletion is rejected', async () => {
    // Given: the real transport rejects startup with typed 401 and cleanup cannot commit.
    const handleOpenCodeUnauthorized = vi.fn(async () => false);
    const harness = createHarness('opencode', {
      connectOpenCode: async () => {
        throw new SseConnectionError('Authentication failed.', 401);
      },
      handleOpenCodeUnauthorized,
    });

    // When: OpenCode activation handles the unauthorized response.
    await harness.activation.startInitialization();

    // Then: the application exposes an error state instead of claiming login cleanup completed.
    expect(handleOpenCodeUnauthorized).toHaveBeenCalledWith(
      'Authentication failed. (HTTP 401)',
      'revision-1',
    );
    expect(harness.uiInitState.value).toBe('error');
    expect(harness.connectionState.value).toBe('error');
  });

  it('reloads replacement credentials after a stale startup rejection', async () => {
    // Given: request A receives 401 after another window durably commits revision B.
    let revision = 'revision-a';
    let connectCount = 0;
    const handleOpenCodeUnauthorized = vi.fn(async () => false);
    const loadCredentials = vi.fn(async () => undefined);
    const harness = createHarness('opencode', {
      getCredentialRevision: () => revision,
      loadCredentials,
      handleOpenCodeUnauthorized,
      connectOpenCode: async () => {
        connectCount += 1;
        if (connectCount === 1) {
          revision = 'revision-b';
          throw Object.assign(new SseConnectionError('Authentication failed.', 401), {
            credentialRevision: 'revision-a',
          });
        }
      },
    });

    // When: conditional cleanup rejects A as stale.
    await harness.activation.startInitialization();

    // Then: B is reloaded and initialized without clearing its connection intent.
    expect(loadCredentials).toHaveBeenCalledOnce();
    expect(harness.ge.connect).toHaveBeenCalledTimes(2);
    expect(harness.ge.disconnect).not.toHaveBeenCalled();
    expect(harness.uiInitState.value).toBe('ready');
    expect(harness.connectionState.value).toBe('ready');
  });

  it('cleans the replacement revision that owns a fail-fast startup rejection', async () => {
    // Given: revision B replaces startup request A before B returns a typed 401.
    const handleOpenCodeUnauthorized = vi.fn(async () => true);
    const harness = createHarness('opencode', {
      connectOpenCode: async () => {
        throw Object.assign(new SseConnectionError('Authentication failed.', 401), {
          credentialRevision: 'revision-2',
        });
      },
      handleOpenCodeUnauthorized,
    });

    // When: activation handles the fail-fast rejection owned by B.
    await harness.activation.startInitialization();

    // Then: durable cleanup targets B rather than the revision captured for A.
    expect(handleOpenCodeUnauthorized).toHaveBeenCalledWith(
      'Authentication failed. (HTTP 401)',
      'revision-2',
    );
    expect(harness.uiInitState.value).toBe('login');
  });

  it('routes startup 403 through acknowledged credential cleanup', async () => {
    // Given: the real transport rejects startup with typed 403 and cleanup cannot commit.
    const handleOpenCodeUnauthorized = vi.fn(async () => false);
    const harness = createHarness('opencode', {
      connectOpenCode: async () => {
        throw new SseConnectionError('Authentication failed.', 403);
      },
      handleOpenCodeUnauthorized,
    });

    // When: OpenCode activation handles the forbidden response.
    await harness.activation.startInitialization();

    // Then: 403 uses the same durable cleanup gate and cannot present login early.
    expect(handleOpenCodeUnauthorized).toHaveBeenCalledWith(
      'Authentication failed. (HTTP 403)',
      'revision-1',
    );
    expect(harness.uiInitState.value).toBe('error');
    expect(harness.connectionState.value).toBe('error');
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
