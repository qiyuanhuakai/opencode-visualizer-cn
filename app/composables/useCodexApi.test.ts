import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter, CodexPromptResult } from '../backends/codex/codexAdapter';
import type { CodexJsonRpcId, CodexJsonRpcNotification } from '../backends/codex/jsonRpcClient';
import { StorageKeys, storageGet, storageGetJSON, storageKey, storageSet } from '../utils/storageKeys';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createAdapterMock() {
  let notificationHandler: ((notification: CodexJsonRpcNotification) => void) | null = null;
  let serverRequestHandler: ((request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void) | null = null;
  const adapter = {
    initialize: vi.fn().mockResolvedValue({ userAgent: 'codex-test' }),
    disconnect: vi.fn(),
    onNotification: vi.fn((handler: (notification: CodexJsonRpcNotification) => void) => {
      notificationHandler = handler;
      return vi.fn(() => {
        notificationHandler = null;
      });
    }),
    onServerRequest: vi.fn((handler: (request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void) => {
      serverRequestHandler = handler;
      return vi.fn(() => {
        serverRequestHandler = null;
      });
    }),
    listThreads: vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread' }],
      nextCursor: null,
    }),
    startThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } }),
    readThread: vi.fn((params: { threadId: string }) => Promise.resolve({
      thread: {
        id: params.threadId,
        name: params.threadId === 'thr_fork' ? 'Forked thread' : 'Existing named thread',
        turns: [
          {
            id: 'turn_old',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: `${params.threadId} prompt` }] },
              { type: 'agentMessage', id: 'a1', text: `${params.threadId} answer` },
            ],
          },
        ],
      },
    })),
    resumeThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    setThreadName: vi.fn().mockResolvedValue({}),
    archiveThread: vi.fn().mockResolvedValue({}),
    unsubscribeThread: vi.fn().mockResolvedValue({}),
    interruptTurn: vi.fn().mockResolvedValue({}),
    forkThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_fork', preview: '' } }),
    rollbackThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    readDirectory: vi.fn().mockResolvedValue({ entries: [{ name: 'file.txt', type: 'file' }] }),
    readFile: vi.fn().mockResolvedValue({ dataBase64: 'aGVsbG8=' }),
    listCollaborationModes: vi.fn().mockResolvedValue({ data: [] }),
    getThreadGoal: vi.fn().mockResolvedValue({ goal: null }),
    setThreadGoal: vi.fn(),
    clearThreadGoal: vi.fn(),
    readAccountUsage: vi.fn().mockResolvedValue({
      summary: {
        lifetimeTokens: null,
        peakDailyTokens: null,
        longestRunningTurnSec: null,
        currentStreakDays: null,
        longestStreakDays: null,
      },
      dailyUsageBuckets: null,
    }),
    readModelProviderCapabilities: vi.fn().mockResolvedValue({
      namespaceTools: false,
      imageGeneration: false,
      webSearch: false,
    }),
    listPermissionProfiles: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    listLoadedThreads: vi.fn().mockResolvedValue({ data: ['thr_existing'] }),
    respondToServerRequest: vi.fn(),
    sendPrompt: vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_1', status: 'inProgress' },
    } satisfies CodexPromptResult),
  };

  return {
    adapter: adapter as unknown as CodexAdapter,
    emit(notification: CodexJsonRpcNotification) {
      notificationHandler?.(notification);
    },
    emitServerRequest(request: { id: CodexJsonRpcId; method: string; params?: unknown }) {
      serverRequestHandler?.(request);
    },
  };
}

describe('useCodexApi', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    localStorage.clear();
  });

  it('connects through a Codex adapter and loads threads', async () => {
    const mock = createAdapterMock();
    const phases: string[] = [];
    const api = useCodexApi({
      url: 'ws://localhost:23004/codex',
      bridgeToken: 'local-token',
      adapterFactory: (options) => {
        expect(options.url).toBe('ws://localhost:23004/codex?token=local-token');
        return mock.adapter;
      },
    });

    await api.connect(undefined, (phase) => phases.push(phase));

    expect(api.status.value).toBe('connected');
    expect(api.initialized.value).toBe(true);
    expect(api.threads.value).toEqual([{ id: 'thr_existing', preview: 'Existing thread' }]);
    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(phases).toEqual(['home', 'handshake', 'threads', 'workspace', 'panelData']);
  });

  it('restores successful panel connection intent until the user disconnects', async () => {
    // Given: the Codex panel establishes a real initialized connection
    const firstMock = createAdapterMock();
    const firstApi = useCodexApi({ adapterFactory: () => firstMock.adapter });
    await firstApi.connect();
    firstApi.disconnectTransport();
    expect(firstApi.reconnectOnMount.value).toBe(true);
    expect(storageGet(StorageKeys.state.codexPanelConnected)).toBe('1');

    // When: a fresh API instance is created after a page reload
    const reloadedMock = createAdapterMock();
    const reloadedApi = useCodexApi({ adapterFactory: () => reloadedMock.adapter });

    // Then: it remembers that the panel should reconnect
    expect(reloadedApi.reconnectOnMount.value).toBe(true);
    expect(storageGet(StorageKeys.state.codexPanelConnected)).toBe('1');

    // When: the user explicitly disconnects the panel
    reloadedApi.disconnect();

    // Then: later reloads no longer reconnect automatically
    const disconnectedApi = useCodexApi({ adapterFactory: () => createAdapterMock().adapter });
    expect(disconnectedApi.reconnectOnMount.value).toBe(false);
    expect(storageGet(StorageKeys.state.codexPanelConnected)).toBe('0');
  });

  it('restores a remembered connection without mounting the Codex panel', async () => {
    // Given: a prior initialized connection left startup reconnect intent behind
    storageSet(StorageKeys.state.codexPanelConnected, '1');
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    // When: the application startup lifecycle restores the API transport
    await api.restoreConnection();

    // Then: the connection is initialized before any panel component mounts
    expect(mock.adapter.initialize).toHaveBeenCalledOnce();
    expect(api.connected.value).toBe(true);
  });

  it('releases the loading lock when disconnecting during thread selection', async () => {
    // Given: a connected API is still waiting for the selected thread
    const pendingThread = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockReturnValue(pendingThread.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const selection = api.selectThread('thread-pending');
    await vi.waitFor(() => expect(mock.adapter.readThread).toHaveBeenCalledOnce());
    expect(api.loadingThread.value).toBe(true);

    // When: the transport disconnects before that request settles
    api.disconnectTransport();

    // Then: reconnecting cannot inherit the obsolete loading lock
    expect(api.loadingThread.value).toBe(false);
    await api.connect();
    expect(api.loadingThread.value).toBe(false);
    pendingThread.resolve({ thread: { id: 'thread-pending', turns: [] } });
    await selection;
    expect(api.loadingThread.value).toBe(false);
  });

  it('loads runtime inspector data through capability-tracked composable methods', async () => {
    const mock = createAdapterMock();
    mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({
      goal: {
        threadId: 'thr_existing',
        objective: 'Ship the integration',
        status: 'active',
        tokenBudget: 1000,
        tokensUsed: 50,
        timeUsedSeconds: 12,
        createdAt: 1,
        updatedAt: 2,
      },
    });
    mock.adapter.readAccountUsage = vi.fn().mockResolvedValue({
      summary: {
        lifetimeTokens: 100,
        peakDailyTokens: 20,
        longestRunningTurnSec: 12,
        currentStreakDays: 3,
        longestStreakDays: 7,
      },
      dailyUsageBuckets: [{ startDate: '2026-07-26', tokens: 20 }],
    });
    mock.adapter.readModelProviderCapabilities = vi.fn().mockResolvedValue({
      namespaceTools: true,
      imageGeneration: false,
      webSearch: true,
    });
    mock.adapter.listPermissionProfiles = vi.fn().mockResolvedValue({
      data: [{ id: 'default', description: 'Default profile' }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await Promise.all([
      api.refreshThreadGoal('thr_existing'),
      api.refreshAccountUsage(),
      api.refreshModelProviderCapabilities(),
      api.refreshPermissionProfiles('/workspace'),
      api.refreshLoadedThreads(),
    ]);

    expect(api.threadGoal.value?.objective).toBe('Ship the integration');
    expect(api.accountUsage.value?.summary.lifetimeTokens).toBe(100);
    expect(api.modelProviderCapabilities.value).toEqual({
      namespaceTools: true,
      imageGeneration: false,
      webSearch: true,
    });
    expect(api.permissionProfiles.value).toEqual([
      { id: 'default', description: 'Default profile' },
    ]);
    expect(api.runtimeCapabilities.value).toMatchObject({
      'thread/goal/get': 'supported',
      'account/usage/read': 'supported',
      'modelProvider/capabilities/read': 'supported',
      'permissionProfile/list': 'supported',
      'thread/loaded/list': 'supported',
    });
  });

  it('keeps the selected thread goal when an older goal read resolves last', async () => {
    const mock = createAdapterMock();
    const staleGoal = deferred<{
      goal: {
        threadId: string;
        objective: string;
        status: 'active';
        tokenBudget: null;
        tokensUsed: number;
        timeUsedSeconds: number;
        createdAt: number;
        updatedAt: number;
      };
    }>();
    mock.adapter.getThreadGoal = vi.fn((params: { threadId: string }) => (
      params.threadId === 'thr_existing'
        ? staleGoal.promise
        : Promise.resolve({
          goal: {
            threadId: params.threadId,
            objective: 'Current goal',
            status: 'active' as const,
            tokenBudget: null,
            tokensUsed: 0,
            timeUsedSeconds: 0,
            createdAt: 1,
            updatedAt: 1,
          },
        })
    ));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const staleRefresh = api.refreshThreadGoal('thr_existing');
    await api.selectThread('thr_current');
    await api.refreshThreadGoal('thr_current');
    staleGoal.resolve({
      goal: {
        threadId: 'thr_existing',
        objective: 'Stale goal',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 0,
        timeUsedSeconds: 0,
        createdAt: 1,
        updatedAt: 1,
      },
    });
    await staleRefresh;

    expect(api.threadGoal.value).toMatchObject({
      threadId: 'thr_current',
      objective: 'Current goal',
    });
  });

  it('keeps the newest goal refresh for the selected thread', async () => {
    const mock = createAdapterMock();
    const staleGoal = deferred<{ goal: null }>();
    mock.adapter.getThreadGoal = vi.fn()
      .mockImplementationOnce(() => staleGoal.promise)
      .mockResolvedValueOnce({
        goal: {
          threadId: 'thr_existing',
          objective: 'Current goal',
          status: 'active',
          tokenBudget: null,
          tokensUsed: 0,
          timeUsedSeconds: 0,
          createdAt: 1,
          updatedAt: 1,
        },
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const staleRefresh = api.refreshThreadGoal('thr_existing');
    await api.refreshThreadGoal('thr_existing');
    staleGoal.resolve({ goal: null });
    await staleRefresh;

    expect(api.threadGoal.value?.objective).toBe('Current goal');
  });

  it('keeps live plans owned by their source thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    mock.emit({
      method: 'turn/plan/updated',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [{ step: 'Probe runtime', status: 'completed' }],
      },
    });

    expect(api.planItems.value).toEqual([
      {
        threadId: 'thr_existing',
        turnId: 'turn-1',
        explanation: 'Implementation plan',
        plan: [{ step: 'Probe runtime', status: 'completed' }],
      },
    ]);
  });

  it('preserves each plugin marketplace locator when flattening plugin lists', async () => {
    const mock = createAdapterMock();
    mock.adapter.listPlugins = vi.fn().mockResolvedValue({
      marketplaces: [{
        name: 'local-marketplace',
        path: '/repo/.agents/plugins/marketplace.json',
        plugins: [{ id: 'demo', name: 'demo', isAccessible: true, isEnabled: false, source: { type: 'local', path: '/repo/plugins/demo' } }],
      }],
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.refreshPlugins();

    expect(api.plugins.value).toEqual([expect.objectContaining({
      id: 'demo',
      marketplaceName: 'local-marketplace',
      marketplacePath: '/repo/.agents/plugins/marketplace.json',
    })]);
  });

  it('keeps the newest plugin refresh when an older request resolves last', async () => {
    const mock = createAdapterMock();
    const stalePlugins = deferred<{
      marketplaces: Array<{
        name: string;
        path: string;
        plugins: Array<{
          id: string;
          name: string;
          isAccessible: boolean;
          isEnabled: boolean;
          source: { type: 'local'; path: string };
        }>;
      }>;
    }>();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.listPlugins = vi.fn()
      .mockImplementationOnce(() => stalePlugins.promise)
      .mockResolvedValueOnce({
        marketplaces: [{
          name: 'current-marketplace',
          path: '/current/marketplace.json',
          plugins: [{ id: 'current', name: 'current', isAccessible: true, isEnabled: true, source: { type: 'local', path: '/current' } }],
        }],
      });

    const staleRefresh = api.refreshPlugins();
    await api.refreshPlugins();
    stalePlugins.resolve({
      marketplaces: [{
        name: 'stale-marketplace',
        path: '/stale/marketplace.json',
        plugins: [{ id: 'stale', name: 'stale', isAccessible: true, isEnabled: false, source: { type: 'local', path: '/stale' } }],
      }],
    });
    await staleRefresh;

    expect(api.plugins.value.map((plugin) => plugin.id)).toEqual(['current']);
  });

  it('resolves connection once threads are ready without waiting for panel catalog hydration', async () => {
    const mock = createAdapterMock();
    let resolveModels: ((value: { data: []; nextCursor: null }) => void) | undefined;
    mock.adapter.listModels = vi.fn(() => new Promise<{ data: []; nextCursor: null }>((resolve) => {
      resolveModels = resolve;
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    let connected = false;

    const connection = api.connect().then(() => {
      connected = true;
    });
    await vi.waitFor(() => expect(mock.adapter.listThreads).toHaveBeenCalled());
    await Promise.resolve();

    expect(api.threads.value).toEqual([{ id: 'thr_existing', preview: 'Existing thread' }]);
    expect(connected).toBe(true);

    resolveModels?.({ data: [], nextCursor: null });
    await connection;
  });

  it('lists threads without waiting for a cold config/read request', async () => {
    const mock = createAdapterMock();
    const pendingConfig = deferred<{ config: Record<string, unknown> }>();
    mock.adapter.readConfig = vi.fn(() => pendingConfig.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    let connected = false;

    void api.connect().then(() => {
      connected = true;
    });
    await vi.waitFor(() => expect(mock.adapter.listThreads).toHaveBeenCalled());

    expect(connected).toBe(true);
    expect(api.status.value).toBe('connected');
    pendingConfig.resolve({ config: {} });
  });

  it('keeps the newest account refresh when an older preload resolves last', async () => {
    const mock = createAdapterMock();
    const staleAccount = deferred<{ account: null }>();
    mock.adapter.readAccount = vi.fn()
      .mockImplementationOnce(() => staleAccount.promise)
      .mockResolvedValueOnce({ account: { type: 'chatgpt', email: 'current@example.com' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await vi.waitFor(() => expect(mock.adapter.readAccount).toHaveBeenCalledTimes(1));
    await api.refreshAccount();
    staleAccount.resolve({ account: null });
    await vi.waitFor(() => expect(mock.adapter.readAccount).toHaveBeenCalledTimes(2));
    await Promise.resolve();

    expect(api.account.value).toEqual({ type: 'chatgpt', email: 'current@example.com' });
  });

  it('ignores panel preload results from a disconnected adapter', async () => {
    const firstMock = createAdapterMock();
    const secondMock = createAdapterMock();
    const staleModels = deferred<Awaited<ReturnType<CodexAdapter['listModels']>>>();
    firstMock.adapter.listModels = vi.fn(() => staleModels.promise);
    secondMock.adapter.listModels = vi.fn().mockResolvedValue({
      data: [{ id: 'current-model', model: 'current-model', displayName: 'Current model' }],
      nextCursor: null,
    });
    let connection = 0;
    const api = useCodexApi({
      adapterFactory: () => {
        connection += 1;
        return connection === 1 ? firstMock.adapter : secondMock.adapter;
      },
    });

    await api.connect();
    await vi.waitFor(() => expect(firstMock.adapter.listModels).toHaveBeenCalled());
    await api.connect();
    await vi.waitFor(() => expect(api.models.value.map((model) => model.id)).toEqual(['current-model']));

    staleModels.resolve({
      data: [{ id: 'stale-model', model: 'stale-model', displayName: 'Stale model' }],
      nextCursor: null,
    });
    await Promise.resolve();

    expect(api.models.value.map((model) => model.id)).toEqual(['current-model']);
  });

  it('ignores a stale home directory response when the same adapter reconnects', async () => {
    const mock = createAdapterMock();
    const staleHome = deferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi.fn()
      .mockImplementationOnce(() => staleHome.promise)
      .mockResolvedValueOnce(new Response(JSON.stringify({ home: '/current-home' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
    vi.stubGlobal('fetch', fetchMock);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    try {
      const staleConnection = api.connect();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await api.connect();
      expect(api.homeDir.value).toBe('/current-home');

      staleHome.resolve(new Response(JSON.stringify({ home: '/stale-home' }), {
        status: 200,
        headers: { 'Content-Type': 'application/json' },
      }));
      await staleConnection;

      expect(api.homeDir.value).toBe('/current-home');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('sends Codex image input items without degrading them to file text', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('', {
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: '',
      threadId: 'thr_existing',
      input: [{ type: 'image', url: 'data:image/png;base64,AA==' }],
    });
  });

  it('sends only the Codex model id when the selected UI key includes a provider', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello custom model.', { threadId: 'thr_existing' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Hello custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('keeps slash-containing explicit Codex model ids intact', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.sendPrompt('Hello explicit custom model.', {
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Hello explicit custom model.',
      threadId: 'thr_existing',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('never requests native archived threads through the VIS session refresh flow', async () => {
    const mock = createAdapterMock();
    const listThreadsMock = vi.fn().mockResolvedValue({
      data: [{ id: 'thr_active', preview: 'Active thread' }],
      nextCursor: null,
    });
    mock.adapter.listThreads = listThreadsMock;
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    expect(api.threads.value.map((thread) => thread.id)).toEqual(['thr_active']);
    expect(listThreadsMock).not.toHaveBeenCalledWith(expect.objectContaining({ archived: true }));
  });

  it('requests all Codex model providers when refreshing threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    expect(mock.adapter.listThreads).toHaveBeenLastCalledWith({
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
  });

  it('merges explicit provider thread lists when custom providers are configured', async () => {
    const mock = createAdapterMock();
    mock.adapter.readConfig = vi.fn().mockResolvedValue({
      config: {
        model_provider: 'omniroute',
        model_providers: { omniroute: { name: 'OmniRoute' } },
      },
    });
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'custom-null', preview: 'Null custom', modelProvider: 'omniroute', updatedAt: 2 }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'official', preview: 'OpenAI', modelProvider: 'openai', updatedAt: 3 }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'custom-explicit', preview: 'Custom', modelProvider: 'omniroute', updatedAt: 1 }], nextCursor: null });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    await vi.waitFor(() => {
      expect(api.threads.value.map((thread) => thread.id)).toEqual(['official', 'custom-null', 'custom-explicit']);
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(1, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: null,
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(2, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['openai'],
    });
    expect(mock.adapter.listThreads).toHaveBeenNthCalledWith(3, {
      limit: 50,
      sortKey: 'updated_at',
      modelProviders: ['omniroute'],
    });
  });

  it('ignores provider discovery from an older connection generation when the adapter is reused', async () => {
    const mock = createAdapterMock();
    const staleProviderConfig = deferred<Awaited<ReturnType<CodexAdapter['readConfig']>>>();
    const stalePanelConfig = deferred<Awaited<ReturnType<CodexAdapter['readConfig']>>>();
    const currentConfig = {
      config: {
        model_provider: 'current',
        model_providers: { current: { name: 'Current' } },
      },
    };
    mock.adapter.readConfig = vi.fn()
      .mockImplementationOnce(() => staleProviderConfig.promise)
      .mockImplementationOnce(() => stalePanelConfig.promise)
      .mockResolvedValue(currentConfig);
    let baseListCount = 0;
    mock.adapter.listThreads = vi.fn(({ modelProviders }: { modelProviders?: string[] | null }) => {
      if (modelProviders === null) {
        baseListCount += 1;
        const id = baseListCount === 1 ? 'first-base' : 'current-base';
        return Promise.resolve({ data: [{ id, preview: id }], nextCursor: null });
      }
      const providerId = modelProviders?.[0] ?? 'unknown';
      return Promise.resolve({
        data: [{ id: `${providerId}-thread`, preview: providerId, modelProvider: providerId }],
        nextCursor: null,
      });
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await vi.waitFor(() => expect(mock.adapter.readConfig).toHaveBeenCalledTimes(2));
    await api.connect();
    await vi.waitFor(() => {
      expect(api.config.value).toEqual(currentConfig);
      expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    });

    staleProviderConfig.resolve({
      config: {
        model_provider: 'stale',
        model_providers: { stale: { name: 'Stale' } },
      },
    });
    stalePanelConfig.resolve({ config: { model_provider: 'stale-panel' } });
    await new Promise((resolve) => setTimeout(resolve, 0));

    expect(api.config.value).toEqual(currentConfig);
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');
  });

  it('ignores stale thread enrichment after the same adapter reconnects', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await new Promise((resolve) => setTimeout(resolve, 0));

    const staleVcs = deferred<Awaited<ReturnType<CodexAdapter['getVcsInfo']>>>();
    mock.adapter.getVcsInfo = vi.fn()
      .mockImplementationOnce(() => staleVcs.promise)
      .mockResolvedValue({ root: '/current', branch: 'main' });
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 'stale-thread', preview: 'Stale', cwd: '/repo' }],
        nextCursor: null,
      })
      .mockResolvedValue({
        data: [{ id: 'current-thread', preview: 'Current', cwd: '/repo' }],
        nextCursor: null,
      });

    const staleRefresh = api.refreshThreads({}, false);
    await vi.waitFor(() => expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo'));
    const currentConnect = api.connect();
    await vi.waitFor(() => expect(mock.adapter.getVcsInfo).toHaveBeenCalledTimes(2));
    await currentConnect;
    expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');

    staleVcs.resolve({ root: '/repo', branch: 'old' });
    await staleRefresh;

    expect(api.threads.value.map((thread) => thread.id)).toContain('current-thread');
    expect(api.threads.value.map((thread) => thread.id)).not.toContain('stale-thread');
  });

  it('strips raw git remote URLs from loaded thread metadata', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [{
        id: 'thr_repo',
        preview: 'Repo',
        cwd: '/repo',
        gitInfo: {
          root: '/repo',
          branch: 'main',
          originUrl: 'https://token@example.com/org/repo.git',
        },
      }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    expect(api.threads.value[0]?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('expands tilde cwd values loaded from Codex threads', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [
        { id: 'thr_home', preview: 'Home', cwd: '~' },
        { id: 'thr_repo', preview: 'Repo', cwd: '~/repo' },
      ],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();

    expect(api.threads.value.map((thread) => thread.cwd)).toEqual(['/home/codex', '/home/codex/repo']);
  });

  it('falls back to reading unmaterialized threads without turns', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn()
      .mockRejectedValueOnce(new Error('thread thr_empty is not materialized yet; includeTurns is unavailable before first user message'))
      .mockResolvedValueOnce({ thread: { id: 'thr_empty', preview: 'Empty thread' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(1, { threadId: 'thr_empty', includeTurns: true });
    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(2, { threadId: 'thr_empty', includeTurns: false });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('keeps the newest thread selection when an older read resolves last', async () => {
    const mock = createAdapterMock();
    const threadA = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    mock.adapter.readThread = vi.fn((params: { threadId: string }) => {
      if (params.threadId === 'thread-a') return threadA.promise;
      return Promise.resolve({
        thread: {
          id: params.threadId,
          turns: [{
            id: `${params.threadId}:turn`,
            items: [
              { type: 'userMessage', id: `${params.threadId}:user`, content: [{ type: 'text', text: `${params.threadId} prompt` }] },
              { type: 'agentMessage', id: `${params.threadId}:assistant`, text: `${params.threadId} answer` },
            ],
          }],
        },
      });
    });
    mock.adapter.resumeThread = vi.fn((params: { threadId: string }) => Promise.resolve({
      thread: { id: params.threadId },
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const selectingA = api.selectThread('thread-a');
    await vi.waitFor(() => expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thread-a',
      includeTurns: true,
    }));
    await api.selectThread('thread-b');

    threadA.resolve({
      thread: {
        id: 'thread-a',
        turns: [{
          id: 'thread-a:turn',
          items: [
            { type: 'userMessage', id: 'thread-a:user', content: [{ type: 'text', text: 'thread-a prompt' }] },
            { type: 'agentMessage', id: 'thread-a:assistant', text: 'thread-a answer' },
          ],
        }],
      },
    });
    await selectingA;

    expect(api.activeThreadId.value).toBe('thread-b');
    expect(api.transcript.value.map((entry) => entry.text)).toEqual(['thread-b prompt', 'thread-b answer']);
  });

  it('persists a delayed completed item under its notification thread instead of the active thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thread-b');

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thread-a',
        turnId: 'thread-a:turn',
        item: {
          id: 'thread-a:command',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo-a',
          status: 'completed',
          aggregatedOutput: '/repo-a\n',
        },
      },
    });

    const threadAKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thread-a')}`;
    const threadBKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thread-b')}`;
    await vi.waitFor(() => {
      const snapshot = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(threadAKey);
      expect(snapshot?.entries?.flatMap((entry) => entry.parts ?? []).map((part) => part.id)).toContain(
        'thread-a:command',
      );
    });
    expect(storageGetJSON(threadBKey)).toBeNull();
    expect(api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id)).not.toContain(
      'thread-a:command',
    );
  });

  it('keeps the requested cwd when a newly started thread omits cwd', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    const thread = await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({ cwd: '/home/codex/repo' });
    expect(thread.cwd).toBe('/home/codex/repo');
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.cwd).toBe('/home/codex/repo');
  });

  it('starts threads with the bare Codex model id from the selected UI key', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    api.selectModel('omniroute/mimo/mimo-v2.5');
    await api.startThread('~/repo');

    expect(mock.adapter.startThread).toHaveBeenCalledWith({
      cwd: '/home/codex/repo',
      model: 'mimo/mimo-v2.5',
    });
  });

  it('preserves known cwd and git info when later thread reads omit them', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_new',
        name: 'Existing named thread',
        turns: [{ id: 'turn_old', items: [] }],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.startThread('/repo/subdir');
    await api.selectThread('thr_new');

    const thread = api.threads.value.find((item) => item.id === 'thr_new');
    expect(thread?.cwd).toBe('/repo/subdir');
    expect(thread?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('preserves known cwd when refreshThreads returns a thinner thread payload', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({ data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/subdir' }], nextCursor: null })
      .mockResolvedValueOnce({ data: [{ id: 'thr_existing', preview: 'Existing thread' }], nextCursor: null });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreads();

    const thread = api.threads.value.find((item) => item.id === 'thr_existing');
    expect(thread?.cwd).toBe('/repo/subdir');
    expect(thread?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('enriches newly started threads with git root metadata', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_new', cwd: '/repo/subdir', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const thread = await api.startThread('/repo/subdir');

    expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo/subdir');
    expect(thread.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
  });

  it('waits for git metadata before inserting thread-started notifications', async () => {
    const mock = createAdapterMock();
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({
      method: 'thread/started',
      params: { thread: { id: 'thr_notify', cwd: '/repo/subdir', preview: '' } },
    });

    expect(api.threads.value.find((item) => item.id === 'thr_notify')).toBeUndefined();
    await vi.waitFor(() => {
      expect(api.threads.value.find((item) => item.id === 'thr_notify')?.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    });
  });

  it('sends prompts to the active thread and records user transcript entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const result = await api.sendPrompt('  Summarize this repo.  ');

    expect(mock.adapter.sendPrompt).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      text: 'Summarize this repo.',
    });
    expect(result?.threadId).toBe('thr_existing');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'Summarize this repo.' }),
    ]);
  });

  it('sends prompts with the selected thread and cwd snapshot', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.sendPrompt('Continue here.', { threadId: 'thr_existing', cwd: '~/repo' });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      threadId: 'thr_existing',
      text: 'Continue here.',
      cwd: '/home/codex/repo',
    });
  });

  it('can force a new thread instead of resuming the active thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.sendPrompt('Start on the selected provider.', {
      threadId: 'thr_existing',
      forceNewThread: true,
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });

    expect(mock.adapter.sendPrompt).toHaveBeenLastCalledWith({
      text: 'Start on the selected provider.',
      model: 'mimo/mimo-v2.5',
      cwd: '/repo',
    });
  });

  it('preserves a newly materialized active thread when list refresh is temporarily stale', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_materialized',
      thread: { id: 'thr_materialized', preview: 'New prompt', cwd: '/repo' },
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    mock.adapter.listThreads = vi.fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo' }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('First prompt.', { threadId: 'thr_empty', cwd: '/repo' });
    await api.refreshThreads();

    expect(api.activeThreadId.value).toBe('thr_materialized');
    expect(api.threads.value.map((thread) => thread.id)).toContain('thr_materialized');
  });

  it('falls back to the active thread cwd when creating a sandbox thread without a selected path', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/' }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.sandboxPath.value = '   ';
    api.fsCwd.value = '';
    await api.createThreadInSandbox();

    expect(api.selectedSandboxCwd()).toBe('/repo');
    expect(mock.adapter.startThread).toHaveBeenLastCalledWith({ cwd: '/repo' });
  });

  it('normalizes relative sandbox paths against home before starting threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    api.homeDir.value = '/home/codex';

    await api.connect();
    await api.startThread('../shared/./work');

    expect(mock.adapter.startThread).toHaveBeenLastCalledWith({ cwd: '/home/shared/work' });
  });

  it('updates state from thread and agent delta notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/started', params: { thread: { id: 'thr_stream', preview: '' } } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', Codex.' } });

    expect(api.activeThreadId.value).toBe('thr_existing');
    await vi.waitFor(() => {
      expect(api.threads.value[0]).toEqual({ id: 'thr_stream', preview: '' });
    });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'assistant', text: 'Hello, Codex.' }),
    ]);
    expect(api.events.value.map((event) => event.method)).toEqual([
      'thread/started',
      'item/agentMessage/delta',
      'item/agentMessage/delta',
    ]);
  });

  it('loads thread history and resumes when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_existing');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      includeTurns: true,
    });
    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.threads.value[0]).toEqual(expect.objectContaining({
      id: 'thr_existing',
      name: 'Existing named thread',
    }));
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual(['user', 'assistant']);
  });

  it('keeps all turns in canonicalHistory when readThread returns multi-turn history (page refresh regression)', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_multi',
        name: 'Multi-turn thread',
        turns: [
          {
            id: 'turn_1',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'First user prompt' }] },
              { type: 'agentMessage', id: 'a1', text: 'First agent answer' },
            ],
          },
          {
            id: 'turn_2',
            items: [
              { type: 'userMessage', id: 'u2', content: [{ type: 'text', text: 'Second user prompt' }] },
              { type: 'agentMessage', id: 'a2', text: 'Second agent answer' },
            ],
          },
          {
            id: 'turn_3',
            items: [
              { type: 'userMessage', id: 'u3', content: [{ type: 'text', text: 'Third user prompt' }] },
              { type: 'agentMessage', id: 'a3', text: 'Third agent answer' },
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_multi');

    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_multi',
      includeTurns: true,
    });
    expect(api.canonicalHistory.value.length).toBeGreaterThanOrEqual(6);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user', 'assistant',
      'user', 'assistant',
      'user', 'assistant',
    ]);
  });

  it('keeps selecting an empty thread when resume reports no rollout', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_empty', preview: 'Empty', turns: [] } });
    mock.adapter.resumeThread = vi.fn().mockRejectedValue(new Error('no rollout found for thread id thr_empty'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.resumeThread).toHaveBeenCalledWith({ threadId: 'thr_empty' });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('refreshes and updates thread names from notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/name/updated', params: { threadId: 'thr_existing', name: 'Renamed' } });

    expect(api.threads.value[0]).toEqual(expect.objectContaining({
      id: 'thr_existing',
      name: 'Renamed',
    }));
    await vi.waitFor(() => {
      expect(mock.adapter.listThreads).toHaveBeenCalledTimes(2);
    });
  });

  it('renames, archives, unsubscribes, and interrupts active Codex threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.setThreadName('thr_existing', '  Renamed by user  ');
    await api.sendPrompt('Continue.');
    await api.interruptActiveTurn();
    await api.unsubscribeThread('thr_existing');
    await api.archiveThread('thr_existing');

    expect(mock.adapter.setThreadName).toHaveBeenCalledWith({ threadId: 'thr_existing', name: 'Renamed by user' });
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({ threadId: 'thr_existing', turnId: 'turn_1' });
    expect(mock.adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.activeThreadId.value).toBe('');
    expect(api.activeTurn.value).toBeNull();
  });

  it('hides empty no-rollout threads when archive is rejected by Codex', async () => {
    const mock = createAdapterMock();
    mock.adapter.archiveThread = vi.fn().mockRejectedValue(new Error('no rollout found for thread id thr_existing'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.archiveThread('thr_existing');

    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value).toEqual([]);
    expect(api.activeThreadId.value).toBe('');
    expect(api.errorMessage.value).toBe('');
  });

  it('tracks and resolves server-initiated approval requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        itemId: 'item_1',
        command: ['pnpm', 'test'],
        availableDecisions: ['accept', 'decline', 'unexpected'],
      },
    });

    expect(api.serverRequests.value).toEqual([
      expect.objectContaining({
        id: 'approval-1',
        method: 'item/commandExecution/requestApproval',
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept', 'decline'],
      }),
    ]);

    api.resolveServerRequest('approval-1', 'acceptForSession');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    api.resolveServerRequest('approval-1', 'accept');

    expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('approval-1', {
      decision: 'accept',
    });
    expect(api.serverRequests.value).toEqual([]);
  });

  it('ignores unsupported or out-of-scope server requests', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'wrong-thread',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_other',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });
    mock.emitServerRequest({
      id: 'missing-decisions',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
      },
    });
    mock.emitServerRequest({
      id: 'unsupported-method',
      method: 'item/tool/requestUserInput',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toEqual([]);
  });

  it('clears stale approvals when the active thread or turn changes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Needs scoped approval.');
    mock.emitServerRequest({
      id: 'approval-1',
      method: 'item/commandExecution/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        availableDecisions: ['accept'],
      },
    });

    expect(api.serverRequests.value).toHaveLength(1);

    mock.emit({ method: 'turn/started', params: { turn: { id: 'turn_2', status: 'inProgress' } } });

    expect(api.serverRequests.value).toEqual([]);
    api.resolveServerRequest('approval-1', 'accept');
    expect(mock.adapter.respondToServerRequest).not.toHaveBeenCalled();

    mock.emitServerRequest({
      id: 'approval-2',
      method: 'item/fileChange/requestApproval',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_2',
        availableDecisions: ['decline'],
      },
    });
    expect(api.serverRequests.value).toHaveLength(1);

    await api.startThread();

    expect(api.serverRequests.value).toEqual([]);
  });

  it('forks and rolls back threads through the adapter', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.forkThread('thr_existing');
    expect(api.activeThreadId.value).toBe('thr_fork');
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_fork prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_fork answer' }),
    ]);

    await api.selectThread('thr_existing');
    await api.rollbackThread('thr_existing', 1);

    expect(mock.adapter.forkThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.rollbackThread).toHaveBeenCalledWith({ threadId: 'thr_existing', numTurns: 1 });
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
  });

  it('clears persisted auxiliary history when a thread is rolled back', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a cached tool turn.');
    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'rollback-command',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/repo\n',
        },
      },
    });
    const cacheKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thr_existing')}`;
    await vi.waitFor(() => expect(storageGet(cacheKey)).not.toBeNull());

    await api.rollbackThread('thr_existing', 1);

    expect(storageGet(cacheKey)).toBeNull();
    expect(api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id)).not.toContain(
      'rollback-command',
    );

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'rollback-command-late',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/stale\n',
        },
      },
    });

    expect(storageGet(cacheKey)).toBeNull();
    expect(api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id)).not.toContain(
      'rollback-command-late',
    );
  });

  it('ignores delayed items after rollback even when no turn notification arrived', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Rollback before notifications.');
    await api.rollbackThread('thr_existing', 1);

    mock.emit({
      method: 'item/completed',
      params: {
        threadId: 'thr_existing',
        turnId: 'turn_1',
        item: {
          id: 'late-without-notification',
          type: 'commandExecution',
          command: 'pwd',
          status: 'completed',
          aggregatedOutput: '/stale\n',
        },
      },
    });

    const cacheKey = `${StorageKeys.state.codexAuxiliaryHistory}.${encodeURIComponent('thr_existing')}`;
    expect(storageGet(cacheKey)).toBeNull();
  });

  it('locally hides threads with in-memory state', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.hideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value.length).toBe(0);

    api.unhideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(false);
    expect(api.visibleThreads.value.length).toBe(1);
  });

  it('browses filesystem entries and reads file previews', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.readDirectory('/tmp');
    expect(mock.adapter.readDirectory).toHaveBeenCalledWith({ path: '/tmp' });
    expect(api.fsEntries.value).toEqual([{ name: 'file.txt', type: 'file' }]);
    expect(api.fsCwd.value).toBe('/tmp');

    await api.readFile('/tmp/file.txt');
    expect(mock.adapter.readFile).toHaveBeenCalledWith({ path: '/tmp/file.txt' });
    expect(api.previewFileContent.value).toBe('hello');
    expect(api.previewFilePath.value).toBe('/tmp/file.txt');

    api.clearPreview();
    expect(api.previewFilePath.value).toBe('');
  });

  it('pushes completed items to realtimeHistoryQueue for OutputPanel bridge', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test realtime.');

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Test realtime.' });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'agent-realtime-1',
          type: 'agentMessage',
          text: 'Realtime answer',
        },
      },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'assistant');
    expect(assistantEntries.length).toBeGreaterThan(0);
    expect(assistantEntries.some((e) => e.parts.some((p) => p.type === 'text' && 'text' in p && p.text === 'Realtime answer'))).toBe(true);
  });

  it('pushes user message to realtimeHistoryQueue immediately on sendPrompt', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    expect(api.realtimeHistoryQueue.value).toEqual([]);

    await api.sendPrompt('Hello immediately.');

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.role).toBe('user');
    expect(userEntries[0]?.info.id).toContain(':user:0');
    expect(userEntries[0]?.info.id).toBe('turn_1:user:0');
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:'))).toBe(true);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain('turn_1:user:0');
    expect(userEntries[0]?.parts).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Hello immediately.' });
  });

  it('does not reuse the previous active turn id for a new provisional user message', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockResolvedValue({
      threadId: 'thr_existing',
      turn: { id: 'turn_2', status: 'inProgress' },
    } satisfies CodexPromptResult);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.activeTurn.value = { id: 'turn_old', status: 'completed' } as never;

    await api.sendPrompt('Fresh turn please.');

    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('turn_old:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('pending-turn:'))).toBe(true);
    expect(api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.id).toBe('turn_2:user:0');
  });

  it('removes provisional realtime user history if sendPrompt fails', async () => {
    const mock = createAdapterMock();
    mock.adapter.sendPrompt = vi.fn().mockRejectedValue(new Error('send failed'));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await expect(api.sendPrompt('Will fail.')).rejects.toThrow('send failed');

    expect(api.realtimeHistoryQueue.value).toEqual([]);
  });

  it('finalizes the provisional user entry even if another realtime entry lands before sendPrompt resolves', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(() => new Promise<CodexPromptResult>((resolve) => {
      resolveSend = resolve;
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Race test.');
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Early' } });
    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_race', status: 'inProgress' },
    });
    await pendingSend;

    const userEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.id).toBe('turn_race:user:0');
    expect(userEntries[0]?.parts[0]).toMatchObject({ id: 'turn_race:user:0:text', text: 'Race test.' });
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain('turn_race:user:0');
  });

  it('updates realtimeStreamingPart on agent message deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Stream test.');

    expect(api.realtimeStreamingPart.value).not.toBeNull();
    expect(api.realtimeStreamingPart.value?.info.id).toContain(':assistant');
    expect(api.realtimeStreamingPart.value?.part.text).toBe('');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Hello, world!');
  });

  it('marks realtimeStreamingPart completed when agent message completes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Partial' } });
    expect(api.realtimeStreamingPart.value).not.toBeNull();

    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Final answer' } },
    });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Final answer');
    expect(api.realtimeStreamingPart.value?.part.time?.end).toEqual(expect.any(Number));
  });

  it('uses one canonical assistant text part across streaming and completed history', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', world!' } });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Hello, world!' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    const textParts = assistantEntries[0]?.parts.filter((part) => part.type === 'text') ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.id).toBe('turn_1:assistant:text');
    expect(textParts[0]).toMatchObject({ messageID: 'turn_1:assistant', text: 'Hello, world!' });
  });

  it('merges completed tool parts into the existing assistant entry instead of duplicating assistant history rows', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Create a file');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Done' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: ['ls'], cwd: '/repo' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: ['ls'], cwd: '/repo', aggregatedOutput: 'file.txt' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Done' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter((entry) => entry.info.role === 'assistant');
    expect(assistantEntries).toHaveLength(1);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'tool')).toBe(true);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'text' && 'text' in part && part.text === 'Done')).toBe(true);
  });

  it('updates realtimeReasoningPart on reasoning deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Reasoning test.');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: 'Thinking...' },
    });

    expect(api.realtimeReasoningPart.value).not.toBeNull();
    expect(api.realtimeReasoningPart.value?.part.type).toBe('reasoning');
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking...');
    expect(api.realtimeReasoningPart.value?.info.id).toContain(':assistant');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-1', delta: ' more thoughts' },
    });
    expect(api.realtimeReasoningPart.value?.part.text).toBe('Thinking... more thoughts');
  });

  it('tracks tool parts from item/started notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(1);
    expect(api.realtimeToolParts.value[0]?.part.type).toBe('tool');
    expect(api.realtimeToolParts.value[0]?.part.state.status).toBe('running');
  });

  it('marks realtime tool parts completed and writes them to realtime history on item completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Tool completion test.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
        },
      },
    });

    mock.emit({ method: 'command/exec/outputDelta', params: { callId: 'cmd-1', delta: 'running output' } });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['pnpm', 'test'],
          cwd: '/repo',
          aggregatedOutput: 'final output',
        },
      },
    });

    expect(api.realtimeToolParts.value).toHaveLength(0);
    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'cmd-1'));
    expect(toolEntry).toBeDefined();
    const toolPart = toolEntry?.parts.find((part) => part.id === 'cmd-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'completed' } });
    expect(toolPart).toMatchObject({ type: 'tool', state: { output: 'running outputfinal output' } });
  });

  it('restores persisted reasoning and non-web tool parts when server history omits them', async () => {
    const firstMock = createAdapterMock();
    const firstApi = useCodexApi({ adapterFactory: () => firstMock.adapter });
    await firstApi.connect();
    await firstApi.sendPrompt('Persist auxiliary history.');

    firstMock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'reasoning-persisted',
          type: 'reasoning',
          summary: ['Inspecting the command'],
          content: [],
        },
      },
    });
    firstMock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'command-persisted',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          status: 'inProgress',
        },
      },
    });
    firstMock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'command-persisted',
          type: 'commandExecution',
          command: 'pwd',
          cwd: '/repo',
          status: 'completed',
          aggregatedOutput: '/repo\n',
        },
      },
    });

    const cacheKey = 'state.codexAuxiliaryHistory.v1.thr_existing';
    await vi.waitFor(() => {
      const cached = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(cacheKey);
      expect(cached?.entries?.flatMap((entry) => entry.parts ?? []).map((part) => part.id)).toEqual(
        expect.arrayContaining(['reasoning-persisted', 'command-persisted']),
      );
    });
    firstApi.disconnect();

    const secondMock = createAdapterMock();
    const secondApi = useCodexApi({ adapterFactory: () => secondMock.adapter });
    await secondApi.connect();
    await secondApi.selectThread('thr_existing');

    const restoredParts = secondApi.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(restoredParts.filter((part) => part.id === 'reasoning-persisted')).toHaveLength(1);
    expect(restoredParts.filter((part) => part.id === 'command-persisted')).toHaveLength(1);
    expect(restoredParts.find((part) => part.id === 'command-persisted')).toMatchObject({
      type: 'tool',
      state: { status: 'completed', output: '/repo\n' },
    });
  });

  it('maps failed tool completion to error state instead of leaving tool loading forever', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search the web');

    mock.emit({
      method: 'item/started',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs' } },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'web-1', type: 'webSearch', query: 'vite docs', status: 'failed' } },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'web-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'error' } });
    expect(api.realtimeToolParts.value).toHaveLength(0);
  });

  it('replaces started fileChange shell parts with finalized edit metadata on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'edit-started-1',
      tool: 'edit',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-started-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'empty.ts', diff: '' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-started-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-started-1');
    const expectedPatch = '## File changed\n\nPath: empty.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'empty.ts', files: ['empty.ts'] },
        output: expectedPatch,
        metadata: { filediff: { patch: expectedPatch } },
      },
    });
  });

  it('replaces started webSearch shell parts with finalized completed output on completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Search after start');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          query: '',
        },
      },
    });

    expect(api.realtimeToolParts.value[0]?.part).toMatchObject({
      id: 'web-started-1',
      tool: 'websearch',
      state: { status: 'running' },
    });

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'web-started-1',
          type: 'webSearch',
          status: 'completed',
          query: 'vite docs',
          action: { type: 'open', url: 'https://vite.dev' },
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'web-started-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-started-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'websearch',
      state: {
        status: 'completed',
        input: { query: 'vite docs', action: 'open', url: 'https://vite.dev' },
        output: expect.stringContaining('Query: vite docs'),
      },
    });
  });

  it('maps completed single-file fileChange notifications into edit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit one file');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-1',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'a.ts', diff: '@@ patch a' }],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-1'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'edit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts'] },
        metadata: { filediff: { patch: '@@ patch a' } },
      },
    });
  });

  it('maps completed multi-file fileChange notifications into multiedit history entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Edit two files');

    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'edit-2',
          type: 'fileChange',
          status: 'completed',
          changes: [
            { path: 'a.ts', diff: '@@ patch a' },
            { path: 'b.ts', diff: '@@ patch b' },
          ],
        },
      },
    });

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) => entry.parts.some((part) => part.id === 'edit-2'));
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-2');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'multiedit',
      state: {
        status: 'completed',
        input: { filePath: 'a.ts', files: ['a.ts', 'b.ts'] },
        metadata: {
          results: [
            { path: 'a.ts', filediff: { patch: '@@ patch a' } },
            { path: 'b.ts', filediff: { patch: '@@ patch b' } },
          ],
        },
      },
    });
  });

  it('clears realtimeStreamingPart and realtimeToolParts when selecting a thread', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Test.');

    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'streaming' } });
    mock.emit({
      method: 'item/started',
      params: { item: { id: 'cmd-1', type: 'commandExecution', command: 'ls' } },
    });

    expect(api.realtimeStreamingPart.value).not.toBeNull();
    expect(api.realtimeToolParts.value).toHaveLength(1);

    await api.selectThread('thr_existing');

    expect(api.realtimeStreamingPart.value).toBeNull();
    expect(api.realtimeReasoningPart.value).toBeNull();
    expect(api.realtimeToolParts.value).toEqual([]);
  });

  it('clears provisional realtime aliases and history when selecting a different thread', async () => {
    const mock = createAdapterMock();
    let resolveSend: ((result: CodexPromptResult) => void) | null = null;
    mock.adapter.sendPrompt = vi.fn().mockImplementation(() => new Promise<CodexPromptResult>((resolve) => {
      resolveSend = resolve;
    }));
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Pending thread switch');

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(true);

    await api.selectThread('thr_existing');

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:'))).toBe(false);

    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_after_switch', status: 'inProgress' },
    });
    await pendingSend;

    expect(api.realtimeHistoryQueue.value.some((entry) => entry.info.id === 'turn_after_switch:user:0')).toBe(false);
  });

  it('returns empty list and warns when collaborationMode/list throws (experimental API not enabled)', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockRejectedValue(new Error('method not found'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const result = await api.refreshCollaborationModes();
    expect(result.data).toEqual([]);
    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesLoading.value).toBe(false);
    expect(warnSpy).toHaveBeenCalled();
    warnSpy.mockRestore();
  });

  it('normalizes non-array data to empty array when collaborationMode/list returns malformed payload', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: null });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.refreshCollaborationModes();
    expect(api.collaborationModes.value).toEqual([]);
  });

  it('preserves collaboration modes returned from a successful list call', async () => {
    const mock = createAdapterMock();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({
      data: [
        { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
        { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
      ],
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const result = await api.refreshCollaborationModes();
    expect(api.collaborationModes.value).toEqual([
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ]);
    expect(result.data).toEqual([
      { name: 'Plan', mode: 'plan', model: null, reasoningEffort: 'medium' },
      { name: 'Default', mode: 'default', model: null, reasoningEffort: null },
    ]);
  });

  describe('monotonic timestamp protection', () => {
    it('preserves existing createdAt/updatedAt when upsertThread receives older values', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 1000, updatedAt: 2000 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 1000, updatedAt: 2000 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_stale', preview: 'Stale', createdAt: 50, updatedAt: 150 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      expect(api.threads.value.find((t) => t.id === 'thr_stale')?.createdAt).toBe(1000);
      expect(api.threads.value.find((t) => t.id === 'thr_stale')?.updatedAt).toBe(2000);

      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_stale');
      expect(thread?.createdAt).toBe(1000);
      expect(thread?.updatedAt).toBe(2000);
    });

    it('accepts incoming createdAt/updatedAt when they are larger than existing', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 100, updatedAt: 200 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 100, updatedAt: 200 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_growing', preview: 'Growing', createdAt: 150, updatedAt: 250 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_growing');
      expect(thread?.createdAt).toBe(150);
      expect(thread?.updatedAt).toBe(250);
    });

    it('uses incoming createdAt/updatedAt when no existing value is present', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [{ id: 'thr_fresh', preview: 'Fresh', createdAt: 300, updatedAt: 400 }],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      const thread = api.threads.value.find((t) => t.id === 'thr_fresh');
      expect(thread?.createdAt).toBe(300);
      expect(thread?.updatedAt).toBe(400);
    });

    it('handles undefined existing timestamps without regressing incoming values', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_mixed', preview: 'Mixed' }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_mixed', preview: 'Mixed', createdAt: 10, updatedAt: 20 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      const thread = api.threads.value.find((t) => t.id === 'thr_mixed');
      expect(thread?.createdAt).toBe(10);
      expect(thread?.updatedAt).toBe(20);
    });

    it('does not regress timestamps when merging thread reads (mergeThreadReadResult)', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValue({
        data: [{ id: 'thr_read', preview: 'Read', createdAt: 500, updatedAt: 600 }],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.adapter.readThread = vi.fn().mockResolvedValue({
        thread: { id: 'thr_read', preview: 'Read', createdAt: 1, updatedAt: 2 },
        turns: [],
      });
      await api.selectThread('thr_read');

      const thread = api.threads.value.find((t) => t.id === 'thr_read');
      expect(thread?.createdAt).toBe(500);
      expect(thread?.updatedAt).toBe(600);
    });

    it('integration: refreshThreads does not regress previous session timestamps when the latest fetch returns older data for a known thread', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn()
        .mockResolvedValueOnce({
          data: [
            { id: 'thr_latest', preview: 'Latest', createdAt: 1000, updatedAt: 5000 },
            { id: 'thr_middle', preview: 'Middle', createdAt: 500, updatedAt: 3000 },
            { id: 'thr_oldest', preview: 'Oldest', createdAt: 100, updatedAt: 1000 },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            { id: 'thr_latest', preview: 'Latest', createdAt: 0, updatedAt: 0 },
            { id: 'thr_middle', preview: 'Middle', createdAt: 0, updatedAt: 0 },
            { id: 'thr_oldest', preview: 'Oldest', createdAt: 0, updatedAt: 0 },
          ],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshThreads();

      const byId = (id: string) => api.threads.value.find((t) => t.id === id);
      expect(byId('thr_latest')?.createdAt).toBe(1000);
      expect(byId('thr_latest')?.updatedAt).toBe(5000);
      expect(byId('thr_middle')?.createdAt).toBe(500);
      expect(byId('thr_middle')?.updatedAt).toBe(3000);
      expect(byId('thr_oldest')?.createdAt).toBe(100);
      expect(byId('thr_oldest')?.updatedAt).toBe(1000);
    });

    it('preserves monotonic timestamps when merging threads across multiple providers', async () => {
      const mock = createAdapterMock();
      mock.adapter.readConfig = vi.fn().mockResolvedValue({
        config: {
          model_provider: 'omniroute',
          model_providers: { omniroute: { name: 'OmniRoute' } },
        },
      });
      mock.adapter.listThreads = vi.fn()
        .mockResolvedValueOnce({
          data: [{ id: 'thr_shared', preview: 'Shared', modelProvider: 'openai', createdAt: 900, updatedAt: 950 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_shared', preview: 'Shared', modelProvider: 'openai', createdAt: 1, updatedAt: 2 }],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [{ id: 'thr_shared', preview: 'Shared', modelProvider: 'omniroute', createdAt: 100, updatedAt: 200 }],
          nextCursor: null,
        });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      const shared = api.threads.value.find((t) => t.id === 'thr_shared');
      expect(shared?.createdAt).toBe(900);
      expect(shared?.updatedAt).toBe(950);
    });
  });

  describe('typed Codex server requests', () => {
    it('queues and answers structured permission requests with the requested profile', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 7,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          startedAtMs: 123,
          cwd: '/repo',
          reason: 'Need network access',
          permissions: { network: { enabled: true } },
        },
      });

      expect(api.permissionRequests.value).toHaveLength(1);
      expect(api.permissionRequests.value[0]).toMatchObject({
        dialogId: 'codex-permission:number:7',
        sessionID: 'thr_existing',
        requestedPermissions: { network: { enabled: true } },
      });

      api.replyPermissionRequest('codex-permission:number:7', 'always');

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith(7, {
        permissions: { network: { enabled: true } },
        scope: 'session',
      });
      expect(api.permissionRequests.value).toEqual([]);
    });

    it('queues and answers MCP form elicitations without persisting answers', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 'elicitation-1',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: {
            type: 'object',
            properties: { region: { type: 'string', enum: ['us', 'eu'] } },
            required: ['region'],
          },
        },
      });

      expect(api.elicitationRequests.value[0]).toMatchObject({
        mode: 'form',
        dialogId: 'codex-elicitation:string:elicitation-1',
        fields: [{ key: 'region', type: 'select', required: true }],
      });

      api.replyElicitationRequest('codex-elicitation:string:elicitation-1', 'accept', { region: 'eu' });

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('elicitation-1', {
        action: 'accept',
        content: { region: 'eu' },
        _meta: null,
      });
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears pending structured requests on disconnect', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 'elicitation-2',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: null,
          serverName: 'identity',
          mode: 'url',
          message: 'Authorize',
          url: 'https://example.test',
          elicitationId: 'external-1',
        },
      });
      expect(api.elicitationRequests.value).toHaveLength(1);

      api.disconnect();

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears structured requests when the server resolves them', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 8,
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          cwd: '/repo',
          permissions: { network: { enabled: true } },
        },
      });
      mock.emitServerRequest({
        id: 'elicitation-resolved',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: { type: 'object', properties: {} },
        },
      });

      mock.emit({ method: 'serverRequest/resolved', params: { requestId: 8 } });
      mock.emit({ method: 'serverRequest/resolved', params: { requestId: 'elicitation-resolved' } });

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('clears structured requests when the active turn changes', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      mock.emitServerRequest({
        id: 'permission-stale',
        method: 'item/permissions/requestApproval',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'permission-item',
          cwd: '/repo',
          permissions: { network: { enabled: true } },
        },
      });
      mock.emitServerRequest({
        id: 'elicitation-stale',
        method: 'mcpServer/elicitation/request',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          serverName: 'deployments',
          mode: 'form',
          message: 'Select target',
          requestedSchema: { type: 'object', properties: {} },
        },
      });

      mock.emit({
        method: 'turn/started',
        params: { threadId: 'thr_existing', turn: { id: 'turn_2', status: 'inProgress' } },
      });

      expect(api.permissionRequests.value).toEqual([]);
      expect(api.elicitationRequests.value).toEqual([]);
    });

    it('parses and answers current-wire tool user-input requests', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 'tool-input',
        method: 'item/tool/requestUserInput',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          itemId: 'item-1',
          questions: [{
            id: 'target',
            header: 'Deployment target',
            question: 'Where should this deploy?',
            isOther: true,
            isSecret: true,
            options: [{ label: 'staging', description: 'Staging environment' }],
          }],
        },
      });

      expect(api.toolUserInputRequests.value).toEqual([{
        requestId: 'tool-input',
        itemId: 'item-1',
        threadId: 'thr_existing',
        turnId: 'turn_1',
        questions: [{
          id: 'target',
          header: 'Deployment target',
          text: 'Where should this deploy?',
          isOther: true,
          isSecret: true,
          options: [{ label: 'staging', description: 'Staging environment' }],
        }],
      }]);

      await api.respondToToolUserInput('tool-input', [{ questionId: 'target', response: 'staging' }]);

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('tool-input', {
        answers: { target: { answers: ['staging'] } },
      });
    });

    it('parses and answers current-wire dynamic tool calls', async () => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      mock.emitServerRequest({
        id: 9,
        method: 'item/tool/call',
        params: {
          threadId: 'thr_existing',
          turnId: 'turn_1',
          callId: 'call-1',
          namespace: 'vis',
          tool: 'deploy',
          arguments: { target: 'staging' },
        },
      });

      expect(api.dynamicToolCalls.value).toEqual([{
        requestId: 9,
        callId: 'call-1',
        namespace: 'vis',
        toolName: 'deploy',
        arguments: { target: 'staging' },
        threadId: 'thr_existing',
        turnId: 'turn_1',
      }]);

      await api.respondToDynamicToolCall(9, [{ type: 'inputText', text: 'deployed' }]);

      expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith(9, {
        contentItems: [{ type: 'inputText', text: 'deployed' }],
        success: true,
      });
    });
  });

  describe('activeThreadId persistence', () => {
    it('restores the active thread from storage on init', () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_restored');

      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });

      expect(api.activeThreadId.value).toBe('thr_restored');
    });

    it('persists the active thread to storage when it changes to a non-empty value', async () => {
      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_one', preview: 'One' },
          { id: 'thr_two', preview: 'Two' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      await api.selectThread('thr_two');

      expect(api.activeThreadId.value).toBe('thr_two');
      expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_two');
    });

    it('does not overwrite the persisted active thread when it is cleared to empty', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_keep');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_keep', preview: 'Keep' },
          { id: 'thr_other', preview: 'Other' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      api.activeThreadId.value = '';

      expect(storageGet(StorageKeys.state.codexActiveThread)).toBe('thr_keep');
    });

    it('clears a stale persisted active thread and falls back to the first thread on refresh', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_deleted');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_alpha', preview: 'Alpha' },
          { id: 'thr_beta', preview: 'Beta' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      expect(api.activeThreadId.value).toBe('thr_alpha');
      expect(api.threads.value.map((t) => t.id)).toEqual(['thr_alpha', 'thr_beta']);
    });

    it('keeps the persisted active thread when the thread still exists in the refreshed list', async () => {
      localStorage.setItem(storageKey(StorageKeys.state.codexActiveThread), 'thr_persisted');

      const mock = createAdapterMock();
      mock.adapter.listThreads = vi.fn().mockResolvedValueOnce({
        data: [
          { id: 'thr_other', preview: 'Other' },
          { id: 'thr_persisted', preview: 'Persisted' },
        ],
        nextCursor: null,
      });
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();

      expect(api.activeThreadId.value).toBe('thr_persisted');
    });

    it('isolates codex activeThread from opencode session storage', async () => {
      localStorage.setItem(storageKey('state.sessionId'), 'opc_session');
      localStorage.setItem(storageKey('state.pinnedSessions'), JSON.stringify(['opc_session']));

      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });

      expect(api.activeThreadId.value).toBe('');
      expect(storageGet(StorageKeys.state.codexActiveThread)).toBeNull();
    });
  });
});
