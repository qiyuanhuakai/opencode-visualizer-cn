import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import type { CodexAdapter, CodexPromptResult } from '../backends/codex/codexAdapter';
import type { CodexJsonRpcNotification } from '../backends/codex/jsonRpcClient';

function createAdapterMock() {
  let notificationHandler: ((notification: CodexJsonRpcNotification) => void) | null = null;
  let serverRequestHandler: ((request: { id: string; method: string; params?: unknown }) => void) | null = null;
  const adapter = {
    initialize: vi.fn().mockResolvedValue({ userAgent: 'codex-test' }),
    disconnect: vi.fn(),
    onNotification: vi.fn((handler: (notification: CodexJsonRpcNotification) => void) => {
      notificationHandler = handler;
      return vi.fn(() => {
        notificationHandler = null;
      });
    }),
    onServerRequest: vi.fn((handler: (request: { id: string; method: string; params?: unknown }) => void) => {
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
    unarchiveThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    unsubscribeThread: vi.fn().mockResolvedValue({}),
    interruptTurn: vi.fn().mockResolvedValue({}),
    forkThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_fork', preview: '' } }),
    rollbackThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    readDirectory: vi.fn().mockResolvedValue({ entries: [{ name: 'file.txt', type: 'file' }] }),
    readFile: vi.fn().mockResolvedValue({ content: 'hello' }),
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
    emitServerRequest(request: { id: string; method: string; params?: unknown }) {
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
    const api = useCodexApi({
      url: 'ws://localhost:23004/codex',
      bridgeToken: 'local-token',
      adapterFactory: (options) => {
        expect(options.url).toBe('ws://localhost:23004/codex?token=local-token');
        return mock.adapter;
      },
    });

    await api.connect();

    expect(api.status.value).toBe('connected');
    expect(api.initialized.value).toBe(true);
    expect(api.threads.value).toEqual([{ id: 'thr_existing', preview: 'Existing thread' }]);
    expect(api.activeThreadId.value).toBe('thr_existing');
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

  it('updates state from thread and agent delta notifications', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    mock.emit({ method: 'thread/started', params: { thread: { id: 'thr_stream', preview: '' } } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Hello' } });
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: ', Codex.' } });

    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(api.threads.value[0]).toEqual({ id: 'thr_stream', preview: '' });
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
    expect(mock.adapter.listThreads).toHaveBeenCalledTimes(2);
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

    expect(mock.adapter.respondToServerRequest).toHaveBeenCalledWith('approval-1', 'accept');
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

  it('locally hides and pins threads with persisted storage', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    api.hideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(true);
    expect(api.visibleThreads.value.length).toBe(0);

    api.pinThread('thr_existing');
    expect(api.pinnedThreadIds.value.has('thr_existing')).toBe(true);

    api.unhideThread('thr_existing');
    expect(api.hiddenThreadIds.value.has('thr_existing')).toBe(false);
    expect(api.visibleThreads.value.length).toBe(1);

    api.unpinThread('thr_existing');
    expect(api.pinnedThreadIds.value.has('thr_existing')).toBe(false);
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
});
