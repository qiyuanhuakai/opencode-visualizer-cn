import type { Ref } from 'vue';
import type { BackendKind } from '../backends/types';
import { appendCodexBridgeToken } from '../backends/codex/bridgeUrl';
import { createKimiWebClient } from '../utils/kimiWeb';
import { kimiWebProxyHttpUrl, kimiWebWsUrl } from '../utils/kimiWebWs';
import { createBackendRequestFence } from '../utils/backendRequestFence';

// allow: SIZE_OK — one composable owns the shared generation/lock lifecycle closure
// for four backend activation flows; extraction would thread >3 closure params.

type UiInitState = 'loading' | 'ready' | 'error' | 'login';
type ConnectionState = 'connecting' | 'bootstrapping' | 'ready' | 'reconnecting' | 'error';

type CredentialsLike = {
  backendKind: Ref<BackendKind>;
  codexBridgeUrl: Ref<string>;
  acpBridgeUrl: Ref<string>;
  codexBridgeToken: Ref<string>;
  acpBridgeToken: Ref<string>;
  acpAgentId: Ref<string>;
  kimiWebBridgeUrl: Ref<string>;
  kimiWebBridgeToken: Ref<string>;
};

export type KimiWebPrecheckRequest = {
  bridgeUrl: string;
  bridgeToken: string;
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
  agents: Ref<unknown[]>;
  agentOptions: Ref<unknown[]>;
  commands: Ref<unknown[]>;
  thinkingOptions: Ref<Array<string | undefined>>;
  providerDefaults: Ref<unknown>;
  modelMetaByPath: Ref<unknown>;
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
  configureKimiWebBackend?: (options: { bridgeUrl: string; bridgeToken?: string }) => void;
  precheckKimiWebConnection?: (request: KimiWebPrecheckRequest) => Promise<void>;
  disconnectAcpBackend: () => void;
  disconnectCodexBackend: () => void;
  disconnectKimiWebBackend: () => void;
  bootstrapAcpWorkspace: () => Promise<void>;
  bootstrapKimiWebWorkspace: (isCurrent: () => boolean) => Promise<void>;
  fetchGlobalProviderConfig: () => Promise<void>;
  fetchProviders: (force?: boolean) => Promise<void>;
  fetchAgents: () => Promise<void>;
  fetchCommands: () => Promise<void>;
  fetchHomePath: () => Promise<void>;
  bootstrapSelections: () => Promise<void>;
  hydrateActiveWorktreeResources: () => Promise<void>;
  reloadSelectedSessionState: (sessionId: string) => Promise<void>;
  handleOpenCodeUnauthorized: (message: string) => void;
};

function kimiWebBridgeHealthUrl(request: KimiWebPrecheckRequest) {
  const bridgeUrl = new URL(kimiWebProxyHttpUrl(kimiWebWsUrl(request.bridgeUrl, request.bridgeToken)));
  bridgeUrl.pathname = '/healthz';
  bridgeUrl.search = '';
  bridgeUrl.hash = '';
  return appendCodexBridgeToken(bridgeUrl.toString(), request.bridgeToken);
}

async function runKimiWebPrecheck(request: KimiWebPrecheckRequest) {
  const bridgeHealth = await fetch(kimiWebBridgeHealthUrl(request), { method: 'GET' });
  if (!bridgeHealth.ok) {
    throw new Error(`Kimi Web bridge health check failed (HTTP ${bridgeHealth.status}).`);
  }
  const client = createKimiWebClient({
    baseUrl: kimiWebProxyHttpUrl(kimiWebWsUrl(request.bridgeUrl, request.bridgeToken)),
    getToken: () => request.bridgeToken,
  });
  await client.getMeta();
}

export function useBackendActivation(options: UseBackendActivationOptions) {
  const initializationInFlight = { value: false } as Ref<boolean>;
  let initializationGeneration = 0;
  const requestFence = createBackendRequestFence(() => options.credentials.backendKind.value);

  function ownsInitialization(generation: number) {
    return initializationInFlight.value && generation === initializationGeneration;
  }

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

  function resetCrossBackendState() {
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
    options.agents.value = [];
    options.agentOptions.value = [];
    options.commands.value = [];
    options.thinkingOptions.value = [];
    options.providerDefaults.value = {};
    options.modelMetaByPath.value = new Map();
  }

  async function activateCodex(generation: number) {
    resetCrossBackendState();
    options.ge.disconnect();
    options.disconnectAcpBackend();
    options.disconnectKimiWebBackend();
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
        if (!ownsInitialization(generation)) return;
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
      if (!ownsInitialization(generation)) return;

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
        options.fetchGlobalProviderConfig().then(async () => {
          if (!ownsInitialization(generation)) return;
          await Promise.all([options.fetchProviders(true), options.fetchAgents()]);
        }),
      ]);
      if (!ownsInitialization(generation)) return;
      await options.hydrateActiveWorktreeResources();
      if (!ownsInitialization(generation)) return;
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';

      if (options.selectedSessionId.value) {
        await options.reloadSelectedSessionState(options.selectedSessionId.value);
      }
    } catch (error) {
      if (!ownsInitialization(generation)) return;
      options.codexApi.disconnectTransport();
      options.disconnectCodexBackend();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
      options.uiInitState.value = 'login';
    } finally {
      if (generation === initializationGeneration) initializationInFlight.value = false;
    }
  }

  async function activateOpenCode(generation: number) {
    resetCrossBackendState();
    options.disconnectAcpBackend();
    options.disconnectCodexBackend();
    options.disconnectKimiWebBackend();
    options.activeBackendKind.value = 'opencode';
    options.setActiveBackendKind('opencode');
    resetSharedUiState();

    try {
      markStartup('vis:opencode-connect-start');
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.ge.connect({ failFast: true, timeoutMs: 10000 });
      if (!ownsInitialization(generation)) return;
      options.connectionState.value = 'bootstrapping';
      options.initLoadingMessage.value = options.t('app.status.loadingServerPath');
      await options.fetchHomePath();
      if (!ownsInitialization(generation)) return;
      options.initLoadingMessage.value = options.t('app.status.loadingProjects');
      await options.bootstrapSelections();
      if (!ownsInitialization(generation)) return;
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
      if (!ownsInitialization(generation)) return;
      // Once the UI reached Ready, only connect/path/hydration/selection
      // failures (all pre-Ready) may send the user back to login.
      if (options.uiInitState.value === 'ready') return;
      options.ge.disconnect();
      const message = options.toErrorMessage(error);
      options.connectionState.value = 'error';
      if (/\(40[13]\)/.test(message)) {
        options.handleOpenCodeUnauthorized(message);
      }
      options.initErrorMessage.value = message;
      options.uiInitState.value = 'login';
    } finally {
      if (generation === initializationGeneration) initializationInFlight.value = false;
    }
  }

  async function activateAcp(generation: number) {
    resetCrossBackendState();
    try {
      options.ge.disconnect();
      options.disconnectCodexBackend();
      options.disconnectKimiWebBackend();
      options.activeBackendKind.value = 'acp';
      options.configureAcpBackend({
        bridgeUrl: options.credentials.acpBridgeUrl.value,
        bridgeToken: options.credentials.acpBridgeToken.value,
        agentId: options.credentials.acpAgentId.value,
      });
      options.setActiveBackendKind('acp');
      resetSharedUiState();
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');
      await options.bootstrapAcpWorkspace();
      if (!ownsInitialization(generation)) return;
      await Promise.all([options.fetchAgents(), options.fetchCommands()]);
      if (!ownsInitialization(generation)) return;
      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';
      void (async () => {
        try {
          if (options.selectedSessionId.value) {
            await options.reloadSelectedSessionState(options.selectedSessionId.value);
          }
        } finally {
          if (generation === initializationGeneration) {
            await Promise.all([
              options.fetchGlobalProviderConfig(),
              options.fetchProviders(true),
              options.fetchAgents(),
              options.fetchCommands(),
            ]);
            if (generation === initializationGeneration) {
              await options.hydrateActiveWorktreeResources();
            }
          }
        }
      })().catch(() => {});
    } catch (error) {
      if (!ownsInitialization(generation)) return;
      options.disconnectAcpBackend();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
      options.uiInitState.value = 'login';
    } finally {
      if (generation === initializationGeneration) initializationInFlight.value = false;
    }
  }

  async function activateKimiWeb(generation: number) {
    resetCrossBackendState();
    const requestToken = requestFence.start();
    const hasCurrentRequest = () => requestFence.isCurrent(requestToken);
    const isCurrent = () => ownsInitialization(generation) && hasCurrentRequest();
    const remainsCurrent = () => generation === initializationGeneration && hasCurrentRequest();

    try {
      options.ge.disconnect();
      options.disconnectAcpBackend();
      options.disconnectCodexBackend();
      options.activeBackendKind.value = 'kimi-web';
      const bridgeUrl = options.credentials.kimiWebBridgeUrl.value;
      const bridgeToken = options.credentials.kimiWebBridgeToken.value;
      options.configureKimiWebBackend?.({ bridgeUrl, bridgeToken });
      options.setActiveBackendKind('kimi-web');
      resetSharedUiState();
      options.connectionState.value = 'connecting';
      options.initLoadingMessage.value = options.t('app.connection.connecting');

      const precheck = options.precheckKimiWebConnection ?? runKimiWebPrecheck;
      await precheck({ bridgeUrl, bridgeToken });
      if (!isCurrent()) return;

      options.connectionState.value = 'bootstrapping';
      await options.bootstrapKimiWebWorkspace(isCurrent);
      if (!isCurrent()) return;

      options.connectionState.value = 'ready';
      options.uiInitState.value = 'ready';
      setTimeout(() => {
        if (!remainsCurrent()) return;
        void Promise.allSettled([
          options.fetchGlobalProviderConfig(),
          options.fetchProviders(true),
        ]);
      }, 0);
    } catch (error) {
      if (!isCurrent()) return;
      options.disconnectKimiWebBackend();
      options.connectionState.value = 'error';
      options.initErrorMessage.value = options.toErrorMessage(error);
      options.uiInitState.value = 'login';
    } finally {
      if (generation === initializationGeneration) initializationInFlight.value = false;
    }
  }

  async function startInitialization() {
    if (initializationInFlight.value) return;
    initializationInFlight.value = true;
    const generation = ++initializationGeneration;
    if (options.credentials.backendKind.value === 'codex') {
      await activateCodex(generation);
      return;
    }
    if (options.credentials.backendKind.value === 'acp') {
      await activateAcp(generation);
      return;
    }
    if (options.credentials.backendKind.value === 'kimi-web') {
      await activateKimiWeb(generation);
      return;
    }
    await activateOpenCode(generation);
  }

  function cancelInitialization() {
    initializationGeneration += 1;
    initializationInFlight.value = false;
    requestFence.invalidate();
  }

  function abortInitialization() {
    cancelInitialization();
    options.ge.disconnect();
    options.disconnectAcpBackend();
    options.disconnectKimiWebBackend();
    if (options.credentials.backendKind.value === 'codex') options.codexApi.disconnectTransport();
    options.disconnectCodexBackend();
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
