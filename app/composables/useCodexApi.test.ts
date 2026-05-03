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
    readFile: vi.fn().mockResolvedValue({ dataBase64: 'aGVsbG8=' }),
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
});
