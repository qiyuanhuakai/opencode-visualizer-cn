import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import { useBackendActivation } from './useBackendActivation';
import type { BackendKind } from '../backends/types';

function createHarness(initialBackend: BackendKind = 'opencode') {
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
    bootstrapSelections: async () => {
      calls.push('bootstrapSelections');
    },
    hydrateActiveWorktreeResources: async () => {
      calls.push('hydrateActiveWorktreeResources');
    },
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
      'codex.disconnect',
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
  });

  it('activates ACP through the shared bridge without connecting OpenCode events', async () => {
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
      'codex.disconnect',
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
});
