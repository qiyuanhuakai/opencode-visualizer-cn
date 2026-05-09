import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';

type UiInitState = 'loading' | 'ready' | 'error' | 'login';
type ConnectionState = 'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error';

type CredentialsLike = {
  backendKind: Ref<BackendKind>;
  codexBridgeUrl: Ref<string>;
  codexBridgeToken: Ref<string>;
};

type CodexApiLike = {
  url: Ref<string>;
  bridgeToken: Ref<string>;
  activeThreadId: Ref<string>;
  visibleThreads: Ref<Array<{ id: string }>>;
  connect: (bridgeUrl: string, onPhase?: (phase: string) => void) => Promise<void>;
  disconnect: () => void;
  selectThread: (threadId: string) => Promise<void>;
};

type GlobalEventsLike = {
  connect: (options: { failFast: boolean; timeoutMs: number }) => Promise<void>;
  disconnect: () => void;
};

type ServerStateLike = {
  bootstrapped: Ref<boolean>;
  projects: Record<string, unknown>;
};

export type UseBackendActivationOptions = {
  credentials: CredentialsLike;
  codexApi: CodexApiLike;
  ge: GlobalEventsLike;
  activeBackendKind: Ref<BackendKind>;
  uiInitState: Ref<UiInitState>;
  initLoadingMessage: Ref<string>;
  initErrorMessage: Ref<string>;
  connectionState: Ref<ConnectionState>;
  reconnectingMessage: Ref<string>;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  providerConfig: Ref<unknown>;
  providersLoaded: Ref<boolean>;
  providers: Ref<unknown[]>;
  connectedProviderIds: Ref<string[]>;
  modelOptions: Ref<unknown[]>;
  selectedModel: Ref<string>;
  serverState: ServerStateLike;
  t: (key: string) => string;
  toErrorMessage: (error: unknown) => string;
  setActiveBackendKind: (kind: BackendKind) => void;
  configureCodexBackend: (options: { bridgeUrl: string; bridgeToken?: string }) => void;
  fetchGlobalProviderConfig: () => Promise<void>;
  fetchProviders: (force?: boolean) => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchHomePath: () => Promise<void>;
  bootstrapSelections: () => Promise<void>;
  hydrateActiveWorktreeResources: () => Promise<void>;
  reloadSelectedSessionState: (sessionId: string) => Promise<void>;
  handleOpenCodeUnauthorized: (message: string) => void;
};

export function useBackendActivation(options: UseBackendActivationOptions) {
  const initializationInFlight = { value: false } as Ref<boolean>;

  function resetSharedUiState() {
    options.uiInitState.value = 'loading';
    options.initErrorMessage.value = '';
    options.reconnectingMessage.value = '';
  }

  function resetOpenCodeSelectionState() {
    options.serverState.bootstrapped.value = false;
    Object.keys(options.serverState.projects).forEach((key) => {
      delete options.serverState.projects[key];
    });
    options.selectedProjectId.value = '';
    options.selectedSessionId.value = '';
    options.providerConfig.value = null;
    options.providersLoaded.value = false;
    options.providers.value = [];
    options.connectedProviderIds.value = [];
    options.modelOptions.value = [];
    options.selectedModel.value = '';
  }

  async function activateCodex() {
    options.ge.disconnect();
    options.activeBackendKind.value = 'codex';
    options.setActiveBackendKind('codex');
    options.configureCodexBackend({
      bridgeUrl: options.credentials.codexBridgeUrl.value,
      bridgeToken: options.credentials.codexBridgeToken.value,
    });
    options.codexApi.url.value = options.credentials.codexBridgeUrl.value;
    options.codexApi.bridgeToken.value = options.credentials.codexBridgeToken.value;
    resetSharedUiState();

    try {
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.codexApi.connect(options.credentials.codexBridgeUrl.value, (phase) => {
        if (phase === 'home') options.initLoadingMessage.value = options.t('app.status.loadingCodexHome');
        else if (phase === 'handshake') options.initLoadingMessage.value = options.t('app.status.loadingCodexHandshake');
        else if (phase === 'threads') options.initLoadingMessage.value = options.t('app.status.loadingCodexThreads');
        else if (phase === 'workspace') options.initLoadingMessage.value = options.t('app.status.loadingCodexWorkspace');
        else options.initLoadingMessage.value = options.t('app.status.loadingCodexModels');
      });

      const existingThreadId = options.codexApi.activeThreadId.value || options.codexApi.visibleThreads.value[0]?.id || '';
      if (existingThreadId) {
        await options.codexApi.selectThread(existingThreadId);
        options.selectedSessionId.value = existingThreadId;
      }

      await Promise.all([
        options.fetchGlobalProviderConfig(),
        options.fetchProviders(true),
        options.fetchAgents(),
      ]);
      await options.hydrateActiveWorktreeResources();
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';

      if (options.selectedSessionId.value) {
        await options.reloadSelectedSessionState(options.selectedSessionId.value);
      }
    } catch (error) {
      options.codexApi.disconnect();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
      options.uiInitState.value = 'login';
    } finally {
      initializationInFlight.value = false;
    }
  }

  async function activateOpenCode() {
    options.activeBackendKind.value = 'opencode';
    options.setActiveBackendKind('opencode');
    resetOpenCodeSelectionState();
    resetSharedUiState();

    try {
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.ge.connect({ failFast: true, timeoutMs: 10000 });
      options.connectionState.value = 'bootstrapping';
      options.initLoadingMessage.value = options.t('app.status.loadingServerPath');
      await options.fetchHomePath();
      options.initLoadingMessage.value = options.t('app.status.loadingProjects');
      await options.bootstrapSelections();
      await options.hydrateActiveWorktreeResources();
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';
      await options.fetchGlobalProviderConfig();
      await Promise.all([options.fetchProviders(true), options.fetchAgents()]);
    } catch (error) {
      if (!initializationInFlight.value) return;
      options.ge.disconnect();
      const message = options.toErrorMessage(error);
      options.connectionState.value = 'error';
      if (/\(40[13]\)/.test(message)) {
        options.handleOpenCodeUnauthorized(message);
      }
      options.initErrorMessage.value = message;
      options.uiInitState.value = 'login';
    } finally {
      initializationInFlight.value = false;
    }
  }

  async function startInitialization() {
    if (initializationInFlight.value) return;
    initializationInFlight.value = true;
    if (options.credentials.backendKind.value === 'codex') {
      await activateCodex();
      return;
    }
    await activateOpenCode();
  }

  function abortInitialization() {
    options.ge.disconnect();
    initializationInFlight.value = false;
    options.connectionState.value = 'connecting';
    options.uiInitState.value = 'login';
    options.initErrorMessage.value = '';
  }

  return {
    initializationInFlight,
    startInitialization,
    abortInitialization,
  };
}
