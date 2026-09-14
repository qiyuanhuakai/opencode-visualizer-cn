import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter } from '../backends/codex/codexAdapter';
import { StorageKeys, storageGet, storageSet } from '../utils/storageKeys';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

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

  it('resolves connection once threads are ready without waiting for panel catalog hydration', async () => {
    const mock = createAdapterMock();
    let resolveModels: ((value: { data: []; nextCursor: null }) => void) | undefined;
    mock.adapter.listModels = vi.fn(
      () =>
        new Promise<{ data: []; nextCursor: null }>((resolve) => {
          resolveModels = resolve;
        }),
    );
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
    await vi.waitFor(() =>
      expect(api.models.value.map((model) => model.id)).toEqual(['current-model']),
    );

    staleModels.resolve({
      data: [{ id: 'stale-model', model: 'stale-model', displayName: 'Stale model' }],
      nextCursor: null,
    });
    await Promise.resolve();

    expect(api.models.value.map((model) => model.id)).toEqual(['current-model']);
  });
});
