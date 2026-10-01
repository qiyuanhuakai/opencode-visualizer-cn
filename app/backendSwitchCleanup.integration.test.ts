import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import type { BackendKind } from './backends/types';
import { useBackendActivation } from './composables/useBackendActivation';

function createHarness(initialKind: BackendKind) {
  const credentials = {
    backendKind: ref<BackendKind>(initialKind),
    codexBridgeUrl: ref('ws://localhost:23004/codex'),
    acpBridgeUrl: ref('ws://localhost:23004'),
    codexBridgeToken: ref('codex-token'),
    acpBridgeToken: ref('acp-token'),
    acpAgentId: ref('oh-my-pi'),
    kimiWebBridgeUrl: ref('ws://localhost:23004/kimi-web/ws'),
    kimiWebBridgeToken: ref('kimi-token'),
    dshBridgeUrl: ref('ws://localhost:23004/dsh/ws'),
    dshBridgeToken: ref('dsh-token'),
  };
  const codexApi = {
    url: ref(''),
    bridgeToken: ref(''),
    activeThreadId: ref('thread-1'),
    visibleThreads: ref<Array<{ id: string }>>([{ id: 'thread-1' }]),
    connect: vi.fn(async () => {}),
    disconnect: vi.fn(),
    disconnectTransport: vi.fn(),
    selectThread: vi.fn(async () => {}),
  };
  const ge = { connect: vi.fn(async () => {}), disconnect: vi.fn() };
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
  const agents = ref<unknown[]>([]);
  const agentOptions = ref<unknown[]>([]);
  const commands = ref<unknown[]>([]);
  const thinkingOptions = ref<Array<string | undefined>>([]);
  const providerDefaults = ref<unknown>({});
  const modelMetaByPath = ref<unknown>(new Map());
  const serverState = {
    bootstrapped: ref(true),
    projects: { stale: {} } as Record<string, unknown>,
  };

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
    t: (key) => key,
    toErrorMessage: (error) => String(error),
    setActiveBackendKind: () => {},
    configureCodexBackend: () => {},
    configureAcpBackend: () => {},
    configureKimiWebBackend: () => {},
    configureDshBackend: () => {},
    disconnectAcpBackend: () => {},
    disconnectCodexBackend: () => {},
    disconnectKimiWebBackend: () => {},
    disconnectDshBackend: () => {},
    bootstrapAcpWorkspace: async () => {},
    bootstrapKimiWebWorkspace: async () => {},
    bootstrapDshWorkspace: async () => {},
    precheckKimiWebConnection: async () => {},
    precheckDshConnection: async () => {},
    fetchGlobalProviderConfig: async () => {},
    fetchProviders: async () => {},
    fetchAgents: async () => {},
    fetchCommands: async () => {},
    fetchHomePath: async () => {},
    bootstrapSelections: async () => {},
    hydrateActiveWorktreeResources: async () => {},
    reloadSelectedSessionState: async () => {},
    handleOpenCodeUnauthorized: () => {},
  });

  return {
    activation,
    credentials,
    activeBackendKind,
    uiInitState,
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
  };
}

describe('cross-backend switch cleanup (Todo 35)', () => {
  it('activating dsh clears the previous backend transient selection and provider/model state', async () => {
    const h = createHarness('dsh');

    await h.activation.startInitialization();

    expect(h.uiInitState.value).toBe('ready');
    expect(h.activeBackendKind.value).toBe('dsh');
    expect(h.selectedProjectId.value).toBe('');
    expect(h.selectedSessionId.value).toBe('');
    expect(h.providerConfig.value).toBeNull();
    expect(h.providersLoaded.value).toBe(false);
    expect(h.providers.value).toEqual([]);
    expect(h.connectedProviderIds.value).toEqual([]);
    expect(h.modelOptions.value).toEqual([]);
    expect(h.selectedModel.value).toBe('');
    expect(h.agents.value).toEqual([]);
    expect(h.agentOptions.value).toEqual([]);
    expect(h.commands.value).toEqual([]);
    expect(h.thinkingOptions.value).toEqual([]);
    expect(h.providerDefaults.value).toEqual({});
    expect(h.modelMetaByPath.value).toEqual(new Map());
    expect(Object.keys(h.serverState.projects)).toEqual([]);
    expect(h.serverState.bootstrapped.value).toBe(false);
  });

  it('preserves persisted bridge credentials across a switch to dsh', async () => {
    const h = createHarness('dsh');

    await h.activation.startInitialization();

    expect(h.credentials.dshBridgeUrl.value).toBe('ws://localhost:23004/dsh/ws');
    expect(h.credentials.dshBridgeToken.value).toBe('dsh-token');
    expect(h.credentials.codexBridgeUrl.value).toBe('ws://localhost:23004/codex');
    expect(h.credentials.codexBridgeToken.value).toBe('codex-token');
    expect(h.credentials.acpBridgeUrl.value).toBe('ws://localhost:23004');
    expect(h.credentials.acpBridgeToken.value).toBe('acp-token');
    expect(h.credentials.kimiWebBridgeUrl.value).toBe('ws://localhost:23004/kimi-web/ws');
    expect(h.credentials.kimiWebBridgeToken.value).toBe('kimi-token');
  });

  it('does not resurrect a stale dsh selection after switching away and back', async () => {
    const h = createHarness('dsh');
    await h.activation.startInitialization();

    h.selectedProjectId.value = 'stale-dsh-project';
    h.selectedSessionId.value = 'stale-dsh-session';
    h.credentials.backendKind.value = 'kimi-web';
    await h.activation.startInitialization();
    expect(h.selectedProjectId.value).toBe('');
    expect(h.selectedSessionId.value).not.toBe('stale-dsh-session');

    h.credentials.backendKind.value = 'dsh';
    await h.activation.startInitialization();
    expect(h.selectedProjectId.value).toBe('');
    expect(h.selectedSessionId.value).not.toBe('stale-dsh-session');
    expect(h.modelOptions.value).toEqual([]);
    expect(Object.keys(h.serverState.projects)).toEqual([]);
  });
});
