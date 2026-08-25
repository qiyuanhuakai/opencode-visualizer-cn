import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import { SseConnectionError } from '../utils/sseConnection';

type UiInitState = 'loading' | 'ready' | 'error' | 'login';
type ConnectionState = 'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error';

type CredentialsLike = {
  backendKind: Ref<BackendKind>;
  codexBridgeUrl: Ref<string>;
  acpBridgeUrl: Ref<string>;
  codexBridgeToken: Ref<string>;
  acpBridgeToken: Ref<string>;
  acpAgentId: Ref<string>;
  getRevision: () => string | null;
  load: () => Promise<void>;
};

type CodexApiLike = {
  url: Ref<string>;
  bridgeToken: Ref<string>;
  activeThreadId: Ref<string>;
  visibleThreads: Ref<Array<{ id: string }>>;
  connect: (bridgeUrl: string, onPhase?: (phase: string) => void) => Promise<void>;
  disconnectTransport: () => void;
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
  configureAcpBackend: (options: {
    bridgeUrl: string;
    bridgeToken?: string;
    agentId: string;
  }) => void;
  disconnectAcpBackend: () => void;
  disconnectCodexBackend: () => void;
  bootstrapAcpWorkspace: () => Promise<void>;
  fetchGlobalProviderConfig: () => Promise<void>;
  fetchProviders: (force?: boolean) => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchCommands: () => Promise<void>;
  fetchHomePath: () => Promise<void>;
  bootstrapSelections: () => Promise<void>;
  hydrateActiveWorktreeResources: () => Promise<void>;
  reloadSelectedSessionState: (sessionId: string) => Promise<void>;
  handleOpenCodeUnauthorized: (
    message: string,
    credentialRevision: string | null,
  ) => Promise<boolean>;
};

export function useBackendActivation(options: UseBackendActivationOptions) {
  const initializationInFlight = { value: false } as Ref<boolean>;
  let openCodeInitializationGeneration = 0;
  let selectionBootstrapInFlight: {
    generation: number;
    promise: Promise<void>;
  } | null = null;

  function markStartup(name: string) {
    if (typeof performance !== 'undefined' && typeof performance.mark === 'function') {
      performance.mark(name);
    }
  }

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
    options.disconnectAcpBackend();
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
        if (phase === 'home')
          options.initLoadingMessage.value = options.t('app.status.loadingCodexHome');
        else if (phase === 'handshake')
          options.initLoadingMessage.value = options.t('app.status.loadingCodexHandshake');
        else if (phase === 'threads')
          options.initLoadingMessage.value = options.t('app.status.loadingCodexThreads');
        else if (phase === 'workspace')
          options.initLoadingMessage.value = options.t('app.status.loadingCodexWorkspace');
        else options.initLoadingMessage.value = options.t('app.status.loadingCodexModels');
      });

      const existingThreadId =
        options.codexApi.activeThreadId.value || options.codexApi.visibleThreads.value[0]?.id || '';
      if (existingThreadId) {
        options.selectedSessionId.value = existingThreadId;
      }

      // selectThread is independent of the provider fetches; run them in
      // parallel to shorten startup. allSettled keeps one failure from
      // blocking the rest of the boot sequence.
      await Promise.allSettled([
        existingThreadId ? options.codexApi.selectThread(existingThreadId) : Promise.resolve(),
        Promise.all([
          options.fetchGlobalProviderConfig(),
          options.fetchProviders(true),
          options.fetchAgents(),
        ]),
      ]);
      await options.hydrateActiveWorktreeResources();
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';

      if (options.selectedSessionId.value) {
        await options.reloadSelectedSessionState(options.selectedSessionId.value);
      }
    } catch (error) {
      options.codexApi.disconnectTransport();
      options.disconnectCodexBackend();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
      options.uiInitState.value = 'login';
    } finally {
      initializationInFlight.value = false;
    }
  }

  async function resolveOpenCodeFailure(error: unknown, credentialRevision: string | null) {
    const connectionError = error instanceof SseConnectionError ? error : null;
    const message = connectionError
      ? `${connectionError.message} (HTTP ${connectionError.statusCode})`
      : options.toErrorMessage(error);
    const unauthorized = connectionError?.statusCode === 401 || connectionError?.statusCode === 403;
    const credentialsCleared = unauthorized
      ? await options.handleOpenCodeUnauthorized(message, credentialRevision)
      : true;
    return { message, unauthorized, credentialsCleared };
  }

  function getRejectedCredentialRevision(error: unknown, fallbackRevision: string | null) {
    if (error instanceof SseConnectionError && error.credentialRevision !== undefined) {
      return error.credentialRevision;
    }
    return fallbackRevision;
  }

  async function handleOpenCodeActivationFailure(
    error: unknown,
    fallbackRevision: string | null,
    isCurrentInitialization: () => boolean,
  ) {
    if (!isCurrentInitialization() || options.uiInitState.value === 'ready') return false;
    const rejectedCredentialRevision = getRejectedCredentialRevision(error, fallbackRevision);
    const { message, unauthorized, credentialsCleared } = await resolveOpenCodeFailure(
      error,
      rejectedCredentialRevision,
    );
    if (!isCurrentInitialization()) return false;
    if (!unauthorized) options.ge.disconnect();
    if (
      unauthorized &&
      !credentialsCleared &&
      options.credentials.getRevision() !== rejectedCredentialRevision
    ) {
      await options.credentials.load();
      return isCurrentInitialization();
    }
    options.connectionState.value = 'error';
    options.initErrorMessage.value = message;
    options.uiInitState.value = credentialsCleared ? 'login' : 'error';
    return false;
  }

  async function bootstrapOpenCodeSelection(generation: number) {
    const existingBootstrap = selectionBootstrapInFlight;
    if (existingBootstrap?.generation === generation) {
      await existingBootstrap.promise;
      return;
    }
    if (existingBootstrap) {
      await Promise.allSettled([existingBootstrap.promise]);
      if (generation !== openCodeInitializationGeneration) return;
    }
    const bootstrap = Promise.resolve().then(() => options.bootstrapSelections());
    const owner = { generation, promise: bootstrap };
    selectionBootstrapInFlight = owner;
    try {
      await bootstrap;
    } finally {
      if (selectionBootstrapInFlight === owner) selectionBootstrapInFlight = null;
    }
  }

  async function activateOpenCode(generation: number) {
    const credentialRevision = options.credentials.getRevision();
    let restartWithReplacement = false;
    const isCurrentInitialization = () =>
      initializationInFlight.value && generation === openCodeInitializationGeneration;
    options.disconnectAcpBackend();
    options.disconnectCodexBackend();
    options.activeBackendKind.value = 'opencode';
    options.setActiveBackendKind('opencode');
    resetOpenCodeSelectionState();
    resetSharedUiState();

    try {
      markStartup('vis:opencode-connect-start');
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.ge.connect({ failFast: true, timeoutMs: 10000 });
      if (!isCurrentInitialization()) return;
      options.connectionState.value = 'bootstrapping';
      options.initLoadingMessage.value = options.t('app.status.loadingServerPath');
      await options.fetchHomePath();
      if (!isCurrentInitialization()) return;
      options.initLoadingMessage.value = options.t('app.status.loadingProjects');
      await bootstrapOpenCodeSelection(generation);
      if (!isCurrentInitialization()) return;
      markStartup('vis:opencode-session-selectable');
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';
      markStartup('vis:opencode-ui-ready');
      // Resource hydration (file tree, git status, commands, permissions,
      // questions) is slow; run it detached so it never blocks or reverts Ready.
      void options.hydrateActiveWorktreeResources().catch(() => {});
      await options.fetchGlobalProviderConfig();
      await Promise.all([options.fetchProviders(true), options.fetchAgents()]);
    } catch (error) {
      // Once the UI reached Ready, only connect/path/hydration/selection
      // failures (all pre-Ready) may send the user back to login.
      restartWithReplacement = await handleOpenCodeActivationFailure(
        error,
        credentialRevision,
        isCurrentInitialization,
      );
    } finally {
      if (generation === openCodeInitializationGeneration) {
        initializationInFlight.value = false;
        if (restartWithReplacement) await startInitialization();
      }
    }
  }

  async function activateAcp() {
    try {
      options.ge.disconnect();
      options.disconnectCodexBackend();
      options.activeBackendKind.value = 'acp';
      options.configureAcpBackend({
        bridgeUrl: options.credentials.acpBridgeUrl.value,
        bridgeToken: options.credentials.acpBridgeToken.value,
        agentId: options.credentials.acpAgentId.value,
      });
      options.setActiveBackendKind('acp');
      resetOpenCodeSelectionState();
      resetSharedUiState();
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.bootstrapAcpWorkspace();
      await Promise.all([options.fetchAgents(), options.fetchCommands()]);
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';
      void (async () => {
        try {
          if (options.selectedSessionId.value) {
            await options.reloadSelectedSessionState(options.selectedSessionId.value);
          }
        } finally {
          await Promise.all([
            options.fetchGlobalProviderConfig(),
            options.fetchProviders(true),
            options.fetchAgents(),
            options.fetchCommands(),
          ]);
          await options.hydrateActiveWorktreeResources();
        }
      })().catch(() => {});
    } catch (error) {
      options.disconnectAcpBackend();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
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
    if (options.credentials.backendKind.value === 'acp') {
      await activateAcp();
      return;
    }
    await activateOpenCode(++openCodeInitializationGeneration);
  }

  function cancelInitialization() {
    openCodeInitializationGeneration += 1;
    initializationInFlight.value = false;
  }

  function abortInitialization() {
    cancelInitialization();
    options.ge.disconnect();
    options.disconnectAcpBackend();
    if (options.credentials.backendKind.value === 'codex') options.codexApi.disconnectTransport();
    options.disconnectCodexBackend();
    options.connectionState.value = 'connecting';
    options.uiInitState.value = 'login';
    options.initErrorMessage.value = '';
  }

  return {
    initializationInFlight,
    startInitialization,
    cancelInitialization,
    abortInitialization,
  };
}
