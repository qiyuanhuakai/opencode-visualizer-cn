import { createApp, defineComponent, h, nextTick } from 'vue';
import { vi } from 'vitest';
import type { CodexPromptInput, CodexPromptResult } from '../backends/codex/codexAdapter';
import type { CodexJsonRpcNotification } from '../backends/codex/jsonRpcClient';
import type { BackendAdapter, BackendCapabilities, BackendKind } from '../backends/types';
import { i18n } from '../i18n';
import type { ConnectionErrorPacket } from '../types/sse';
import type { WorkerToTabMessage } from '../types/sse-worker';
import type { ProjectState } from '../types/worker-state';
import { StorageKeys, storageKey } from '../utils/storageKeys';

type ProviderListResult = {
  readonly all: readonly unknown[];
  readonly connected: readonly string[];
  readonly default: Record<string, string>;
};

type CodexSendOptions = {
  readonly threadId?: string;
  readonly forceNewThread?: boolean;
};

type CodexSendClient = {
  sendPrompt: (text: string, options?: CodexSendOptions) => Promise<unknown>;
};

function isCodexSendClient(value: unknown): value is CodexSendClient {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof Reflect.get(value, 'sendPrompt') === 'function'
  );
}

const emptyProviderList: ProviderListResult = { all: [], connected: [], default: {} };
const codexProviderList: ProviderListResult = {
  all: [
    {
      id: 'openai',
      name: 'OpenAI',
      source: 'system',
      models: {
        'official-model': { id: 'official-model', name: 'Official Model', providerID: 'openai' },
      },
    },
    {
      id: 'custom-provider',
      name: 'Custom Provider',
      source: 'config',
      models: {
        'custom-model': { id: 'custom-model', name: 'Custom Model', providerID: 'custom-provider' },
      },
    },
  ],
  connected: ['openai', 'custom-provider'],
  default: {},
};

const harness = vi.hoisted(() => {
  let connectionGate: Promise<void> | undefined;
  let releaseConnection: (() => void) | undefined;
  const connectionErrorHandlers = new Set<(payload: ConnectionErrorPacket) => void>();
  const sessionEventHandlers = new Map<string, Set<(payload: unknown) => void>>();
  let codexNotificationHandler: ((notification: CodexJsonRpcNotification) => void) | undefined;
  const terminalInstances: Array<{ disposed: boolean; opened: boolean }> = [];
  const createPty = vi.fn(async () => ({
    id: 'pty-harness',
    title: 'Harness shell',
    command: '/bin/sh',
    args: [],
    cwd: '/repo',
    status: 'running',
    pid: 101,
  }));
  const deletePty = vi.fn(async () => undefined);
  const configureCodexBackend = vi.fn();
  const configureAcpBackend = vi.fn();
  const configureKimiWebBackend = vi.fn();
  const listProviders = vi.fn<() => Promise<ProviderListResult>>(async () => emptyProviderList);
  const getGlobalConfig = vi.fn(async () => ({}));
  const updateGlobalConfig = vi.fn(async (payload: Record<string, unknown>) => payload);
  const codexAdapterSendPrompt = vi.fn(
    async (input: CodexPromptInput): Promise<CodexPromptResult> => ({
      threadId: input.threadId ?? 'thread-custom',
      thread: {
        id: input.threadId ?? 'thread-custom',
        cwd: '/repo',
        modelProvider: input.threadId ? 'openai' : 'custom-provider',
      },
      turn: { id: 'turn-harness', status: 'completed' },
    }),
  );
  const codexBatchWriteConfig = vi.fn(async () => ({}));
  let activeBackendKind: BackendKind = 'opencode';
  const acpEventHandlers = new Set<(event: unknown) => void>();

  class HarnessTerminal {
    readonly buffer = { active: { baseY: 0, cursorY: 0, viewportY: 0 } };
    readonly cols = 80;
    readonly rows = 24;
    readonly options: Record<string, unknown> = {};
    element: HTMLElement | undefined;
    private readonly record = { disposed: false, opened: false };

    constructor(_options: unknown) {
      terminalInstances.push(this.record);
    }

    dispose() {
      this.record.disposed = true;
      this.element?.remove();
      this.element = undefined;
    }

    focus() {}

    onData() {
      return { dispose: () => undefined };
    }

    open(host: HTMLElement) {
      this.record.opened = true;
      this.element = document.createElement('div');
      this.element.className = 'xterm';
      const screen = document.createElement('div');
      screen.className = 'xterm-screen';
      const viewport = document.createElement('div');
      viewport.className = 'xterm-viewport';
      this.element.append(screen, viewport);
      host.append(this.element);
    }

    refresh() {}

    resize() {}

    scrollToBottom() {}

    scrollToLine() {}

    write(_data: string | Uint8Array, callback?: () => void) {
      callback?.();
    }
  }

  return {
    listSessionMessages: vi.fn(),
    createPty,
    deletePty,
    HarnessTerminal,
    terminalInstances,
    getPathInfo: vi.fn(async () => ({ home: '/home/test', worktree: '/repo' })),
    connectionErrorHandlers,
    pauseConnection() {
      connectionGate = new Promise<void>((resolve) => {
        releaseConnection = resolve;
      });
    },
    async waitForConnection() {
      await connectionGate;
    },
    releaseConnection() {
      releaseConnection?.();
      releaseConnection = undefined;
      connectionGate = undefined;
    },
    resetConnection() {
      connectionErrorHandlers.clear();
      sessionEventHandlers.clear();
      codexNotificationHandler = undefined;
      releaseConnection?.();
      releaseConnection = undefined;
      connectionGate = undefined;
    },
    sessionEventHandlers,
    setCodexNotificationHandler(handler?: (notification: CodexJsonRpcNotification) => void) {
      codexNotificationHandler = handler;
    },
    emitCodexNotification(notification: CodexJsonRpcNotification) {
      codexNotificationHandler?.(notification);
    },
    configureCodexBackend,
    configureAcpBackend,
    configureKimiWebBackend,
    acpEventHandlers,
    listProviders,
    getGlobalConfig,
    updateGlobalConfig,
    codexAdapterSendPrompt,
    codexBatchWriteConfig,
    activeBackendKind: () => activeBackendKind,
    setActiveBackendKind(kind: BackendKind) {
      activeBackendKind = kind;
    },
  };
});

vi.mock('../backends/codex/codexAdapter', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../backends/codex/codexAdapter')>();

  class HarnessCodexAdapter extends actual.CodexAdapter {
    async initialize() {
      return {};
    }

    disconnect() {}

    onNotification(handler: (notification: CodexJsonRpcNotification) => void) {
      harness.setCodexNotificationHandler(handler);
      return () => harness.setCodexNotificationHandler();
    }

    onServerRequest() {
      return () => undefined;
    }

    async listThreads() {
      return {
        data: [{ id: 'thread-openai', cwd: '/repo', modelProvider: 'openai' }],
        nextCursor: null,
      };
    }

    async readThread() {
      return {
        thread: { id: 'thread-openai', cwd: '/repo', modelProvider: 'openai', turns: [] },
      };
    }

    async resumeThread() {
      return {
        thread: { id: 'thread-openai', cwd: '/repo', modelProvider: 'openai', turns: [] },
      };
    }

    async startThread() {
      return { thread: { id: 'thread-openai', cwd: '/repo', modelProvider: 'openai' } };
    }

    async getVcsInfo() {
      return { root: '/repo', commonRoot: '/repo', branch: 'main' };
    }

    async listModels() {
      return { data: [], nextCursor: null };
    }

    async readConfig() {
      return { config: { model_provider: 'openai', model: 'official-model' }, layers: [] };
    }

    async batchWriteConfig(...args: Parameters<typeof harness.codexBatchWriteConfig>) {
      return harness.codexBatchWriteConfig(...args);
    }

    async sendPrompt(input: CodexPromptInput) {
      return harness.codexAdapterSendPrompt(input);
    }

    async readAccount() {
      return { account: null, requiresOpenaiAuth: false };
    }

    async readAccountRateLimits() {
      return { rateLimits: { limitId: 'harness', primary: null } };
    }

    async listSkills() {
      return { data: [] };
    }

    async listPlugins() {
      return { marketplaces: [] };
    }

    async listMcpServerStatus() {
      return { data: [], nextCursor: null };
    }

    async listApps() {
      return { data: [], nextCursor: null };
    }

    async listExperimentalFeatures() {
      return { data: [], nextCursor: null };
    }

    async listCollaborationModes() {
      return { data: [] };
    }

    async readConfigRequirements() {
      return { requirements: null };
    }

    async listLoadedThreads() {
      return { data: [] };
    }

    async readDirectory() {
      return { entries: [] };
    }
  }

  return { ...actual, CodexAdapter: HarnessCodexAdapter };
});

const capabilities: BackendCapabilities = {
  projects: true,
  worktrees: true,
  sessions: true,
  sessionFork: true,
  sessionRevert: true,
  sessionRename: true,
  sessionArchive: true,
  sessionUnarchive: true,
  sessionDelete: true,
  sessionPin: true,
  sessionUnpin: true,
  sessionCompact: true,
  files: true,
  terminal: true,
  permissions: true,
  questions: true,
  todos: true,
  status: true,
  providerConfig: true,
  imageAttachmentsOnly: false,
  projectPickerCreatesSession: false,
  ptyExitRequiresSyntheticEvent: false,
  ptyRefreshArtifactsOnSuccess: false,
  strictSandboxPaths: false,
  sessionManagementMode: 'standard',
};

const adapter: BackendAdapter = {
  kind: 'opencode',
  label: 'OpenCode',
  capabilities,
  createSession: vi.fn(async () => ({})),
  forkSession: vi.fn(async () => ({})),
  updateSession: vi.fn(async () => ({})),
  deleteSession: vi.fn(async () => ({})),
  revertSession: vi.fn(async () => ({})),
  unrevertSession: vi.fn(async () => ({})),
  listSessions: vi.fn(async () => []),
  updateProject: vi.fn(async () => ({})),
  createWorktree: vi.fn(async () => ({})),
  deleteWorktree: vi.fn(async () => ({})),
  getGlobalConfig: harness.getGlobalConfig,
  updateGlobalConfig: harness.updateGlobalConfig,
  getPathInfo: harness.getPathInfo,
  listAgents: vi.fn(async () => []),
  listCommands: vi.fn(async () => []),
  listProviders: harness.listProviders,
  listSessionMessages: harness.listSessionMessages,
  listPtys: vi.fn(async () => []),
  createPty: harness.createPty,
  updatePtySize: vi.fn(async () => undefined),
  deletePty: harness.deletePty,
  createPtyWebSocketUrl: () => 'ws://127.0.0.1:4096/pty-harness',
  getSessionTodos: vi.fn(async () => []),
  listPendingPermissions: vi.fn(async () => []),
  listPendingQuestions: vi.fn(async () => []),
};

const acpAdapter = {
  ...adapter,
  kind: 'acp' as const,
  label: 'ACP',
  onEvent(handler: (event: unknown) => void) {
    harness.acpEventHandlers.add(handler);
    return () => harness.acpEventHandlers.delete(handler);
  },
};

harness.configureAcpBackend.mockImplementation(() => acpAdapter);

vi.mock('../backends/registry', () => ({
  DEFAULT_ACP_BRIDGE_URL: 'ws://127.0.0.1:23004',
  DEFAULT_CODEX_BRIDGE_URL: 'ws://127.0.0.1:23004/codex',
  DEFAULT_KIMI_WEB_BRIDGE_URL: 'ws://127.0.0.1:23004/kimi-web/ws',
  configureAcpBackend: harness.configureAcpBackend,
  configureCodexBackend: harness.configureCodexBackend,
  configureKimiWebBackend: harness.configureKimiWebBackend,
  configureOpenCodeBackend: vi.fn(),
  disconnectAcpBackend: vi.fn(),
  disconnectCodexBackend: vi.fn(),
  getActiveBackendAdapter: () => (harness.activeBackendKind() === 'acp' ? acpAdapter : adapter),
  getActiveBackendKind: harness.activeBackendKind,
  getBackendAdapter: (kind: BackendKind) => (kind === 'acp' ? acpAdapter : adapter),
  getPersistedAcpBridgeToken: () => '',
  getPersistedAcpBridgeUrl: () => 'ws://127.0.0.1:23004',
  getPersistedCodexBridgeToken: () => '',
  getPersistedCodexBridgeUrl: () => 'ws://127.0.0.1:23004/codex',
  setActiveBackendKind: harness.setActiveBackendKind,
}));

vi.mock('../composables/useGlobalEvents', () => ({
  useGlobalEvents: () => {
    let workerHandler: ((message: WorkerToTabMessage) => boolean) | undefined;
    return {
      connect: vi.fn(async () => {
        await harness.waitForConnection();
        workerHandler?.({
          type: 'state.bootstrap',
          projects: { [project.id]: project },
          notifications: {},
          sessionHydrationByDirectory: {},
        });
      }),
      disconnect: vi.fn(),
      dispose: vi.fn(),
      mainSession: () => ({ on: () => () => {}, dispose: vi.fn() }),
      on: (event: string, handler: (payload: ConnectionErrorPacket) => void) => {
        if (event !== 'connection.error') return () => undefined;
        harness.connectionErrorHandlers.add(handler);
        return () => harness.connectionErrorHandlers.delete(handler);
      },
      sendToWorker: vi.fn(() => false),
      session: () => ({
        on: (event: string, handler: (payload: unknown) => void) => {
          const handlers = harness.sessionEventHandlers.get(event) ?? new Set();
          handlers.add(handler);
          harness.sessionEventHandlers.set(event, handlers);
          return () => handlers.delete(handler);
        },
        dispose: vi.fn(),
      }),
      setWorkerMessageHandler: (handler?: (message: WorkerToTabMessage) => boolean) => {
        workerHandler = handler;
      },
    };
  },
}));

const project: ProjectState = {
  id: 'project-1',
  name: 'Fixture project',
  worktree: '/repo',
  sandboxes: {
    '/repo': {
      directory: '/repo',
      name: 'main',
      rootSessions: ['session-a', 'session-b'],
      sessions: {
        'session-a': {
          id: 'session-a',
          title: 'Session A',
          status: 'idle',
          timeCreated: 1,
          timeUpdated: 1,
        },
        'session-b': {
          id: 'session-b',
          title: 'Session B',
          status: 'idle',
          timeCreated: 2,
          timeUpdated: 2,
        },
      },
    },
  },
};

let mountSequence = 0;

vi.mock('@iconify/vue', () => ({
  Icon: defineComponent({
    name: 'IconStub',
    setup: () => () => h('span', { 'aria-hidden': 'true' }),
  }),
}));

vi.mock('@xterm/xterm', () => ({
  Terminal: harness.HarnessTerminal,
}));

class HarnessWebSocket {
  static readonly CONNECTING = 0;
  static readonly OPEN = 1;
  static readonly CLOSING = 2;
  static readonly CLOSED = 3;
  readonly readyState = HarnessWebSocket.OPEN;
  binaryType = 'blob';

  addEventListener(type: string, callback: (event: Event) => void) {
    if (type === 'open') queueMicrotask(() => callback(new Event('open')));
  }

  close() {}

  send() {}
}

function dispatchStorageChange(key: string, newValue: string) {
  window.dispatchEvent(
    new StorageEvent('storage', {
      key: storageKey(key),
      newValue,
    }),
  );
}

async function mountApp(
  history: unknown[],
  pauseInitialization: boolean,
  seedOpenCodeCredentials = true,
  startupBackend: 'opencode' | 'codex' = 'opencode',
) {
  harness.resetConnection();
  harness.createPty.mockClear();
  harness.deletePty.mockClear();
  harness.terminalInstances.splice(0);
  harness.listSessionMessages.mockReset();
  harness.listSessionMessages.mockResolvedValue(history);
  harness.getPathInfo.mockClear();
  harness.configureCodexBackend.mockClear();
  harness.configureAcpBackend.mockClear();
  harness.configureKimiWebBackend.mockClear();
  harness.listProviders.mockReset();
  harness.listProviders.mockResolvedValue(emptyProviderList);
  harness.getGlobalConfig.mockReset();
  harness.getGlobalConfig.mockResolvedValue({});
  harness.updateGlobalConfig.mockReset();
  harness.updateGlobalConfig.mockImplementation(async (payload) => payload);
  harness.codexAdapterSendPrompt.mockClear();
  harness.codexBatchWriteConfig.mockClear();
  harness.acpEventHandlers.clear();
  harness.setActiveBackendKind('opencode');
  vi.stubGlobal('WebSocket', HarnessWebSocket);
  if (!seedOpenCodeCredentials || startupBackend === 'codex') {
    vi.stubGlobal(
      'fetch',
      vi.fn(async () => new Response(JSON.stringify({ home: '/repo' }))),
    );
  }
  window.localStorage.clear();
  mountSequence += 1;
  const serverUrl = `http://127.0.0.1:4096/harness-${mountSequence}`;
  if (startupBackend === 'codex') {
    window.localStorage.setItem(storageKey(StorageKeys.auth.backendKind), 'codex');
    window.localStorage.setItem(
      storageKey(StorageKeys.auth.codexBridgeUrl),
      'ws://127.0.0.1:23004/codex',
    );
    harness.listProviders.mockResolvedValue(codexProviderList);
  } else if (seedOpenCodeCredentials) {
    window.localStorage.setItem('opencode.auth.serverUrl.v1', serverUrl);
    window.localStorage.setItem(
      'opencode.auth.credentials.v1',
      JSON.stringify({
        url: serverUrl,
        username: 'initial-user',
        password: 'initial-password',
      }),
    );
  } else {
    window.localStorage.setItem(storageKey(StorageKeys.auth.acpAgentId), 'oh-my-pi');
  }
  if (pauseInitialization) harness.pauseConnection();
  const host = document.createElement('div');
  document.body.append(host);
  const { default: App } = await import('../App.vue');
  const app = createApp(App);
  app.use(i18n);
  app.mount(host);
  if (!seedOpenCodeCredentials) {
    await vi.waitFor(() => {
      if (!host.querySelector('.app-login-form')) throw new Error('App did not reach login state');
    });
  } else if (pauseInitialization) {
    await vi.waitFor(() => {
      if (!host.querySelector('.app-loading-view')) throw new Error('App did not start loading');
    });
  } else {
    await vi.waitFor(() => {
      if (!host.querySelector('.top-panel')) throw new Error('App did not reach ready state');
    });
  }
  await nextTick();
  const instance = Reflect.get(app, '_instance');
  const setupState =
    instance && typeof instance === 'object' ? Reflect.get(instance, 'setupState') : undefined;
  const codexApi =
    setupState && typeof setupState === 'object' ? Reflect.get(setupState, 'codexApi') : undefined;
  if (!isCodexSendClient(codexApi)) throw new Error('App Codex client binding is unavailable');
  const codexSendPrompt = vi.spyOn(codexApi, 'sendPrompt');
  return {
    host,
    listSessionMessages: harness.listSessionMessages,
    getPathInfo: harness.getPathInfo,
    createPty: harness.createPty,
    deletePty: harness.deletePty,
    terminalInstances: harness.terminalInstances,
    configureCodexBackend: harness.configureCodexBackend,
    configureAcpBackend: harness.configureAcpBackend,
    configureKimiWebBackend: harness.configureKimiWebBackend,
    listProviders: harness.listProviders,
    getGlobalConfig: harness.getGlobalConfig,
    updateGlobalConfig: harness.updateGlobalConfig,
    codexSendPrompt,
    codexAdapterSendPrompt: harness.codexAdapterSendPrompt,
    codexBatchWriteConfig: harness.codexBatchWriteConfig,
    dispatchStorageChange,
    emitConnectionError(payload: ConnectionErrorPacket) {
      for (const handler of harness.connectionErrorHandlers) handler(payload);
    },
    emitAcpEvent(event: unknown) {
      for (const handler of harness.acpEventHandlers) handler(event);
    },
    emitSessionEvent(event: string, payload: unknown) {
      for (const handler of harness.sessionEventHandlers.get(event) ?? []) handler(payload);
    },
    emitCodexNotification(notification: CodexJsonRpcNotification) {
      harness.emitCodexNotification(notification);
    },
    setStoredBackendKind(kind: 'opencode' | 'codex' | 'acp') {
      window.localStorage.setItem(storageKey(StorageKeys.auth.backendKind), kind);
      dispatchStorageChange(StorageKeys.auth.backendKind, kind);
    },
    readSetupBinding(name: string): unknown {
      const instance = Reflect.get(app, '_instance');
      if (!instance || typeof instance !== 'object') return undefined;
      const setupState = Reflect.get(instance, 'setupState');
      if (!setupState || typeof setupState !== 'object') return undefined;
      return Reflect.get(setupState, name);
    },
    async releaseInitialization() {
      harness.releaseConnection();
      await new Promise<void>((resolve) => setTimeout(resolve, 0));
      await nextTick();
    },
    unmount() {
      app.unmount();
      host.remove();
      harness.resetConnection();
      window.localStorage.clear();
      vi.unstubAllGlobals();
    },
  };
}

export async function mountHistoryApp(history: unknown[]) {
  return mountApp(history, false);
}

export async function mountPausedInitializationApp() {
  return mountApp([], true);
}

export async function mountLoginApp() {
  return mountApp([], false, false);
}

export async function mountCodexApp() {
  return mountApp([], false, true, 'codex');
}
