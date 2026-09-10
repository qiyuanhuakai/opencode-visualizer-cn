import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { useCodexWorkspace } from './useCodexWorkspace';
import type {
  CodexAdapter,
  CodexPromptResult,
  CodexThreadGoal,
  CodexThreadListResult,
} from '../backends/codex/codexAdapter';
import {
  CodexJsonRpcError,
  type CodexJsonRpcId,
  type CodexJsonRpcNotification,
} from '../backends/codex/jsonRpcClient';
import type { ToolStatePending } from '../types/sse';
import {
  StorageKeys,
  storageGet,
  storageGetJSON,
  storageKey,
  storageSet,
} from '../utils/storageKeys';

function deferred<T>() {
  let resolve: (value: T) => void = () => undefined;
  const promise = new Promise<T>((next) => {
    resolve = next;
  });
  return { promise, resolve };
}

function createAdapterMock() {
  let notificationHandler: ((notification: CodexJsonRpcNotification) => void) | null = null;
  let serverRequestHandler:
    | ((request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void)
    | null = null;
  const adapter = {
    initialize: vi.fn().mockResolvedValue({ userAgent: 'codex-test' }),
    disconnect: vi.fn(),
    onNotification: vi.fn((handler: (notification: CodexJsonRpcNotification) => void) => {
      notificationHandler = handler;
      return vi.fn(() => {
        notificationHandler = null;
      });
    }),
    onServerRequest: vi.fn(
      (handler: (request: { id: CodexJsonRpcId; method: string; params?: unknown }) => void) => {
        serverRequestHandler = handler;
        return vi.fn(() => {
          serverRequestHandler = null;
        });
      },
    ),
    listThreads: vi.fn().mockResolvedValue({
      data: [{ id: 'thr_existing', preview: 'Existing thread' }],
      nextCursor: null,
    }),
    startThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_new', preview: '' } }),
    listThreadTurns: vi.fn().mockResolvedValue({ data: [], nextCursor: null }),
    readThread: vi.fn((params: { threadId: string }) =>
      Promise.resolve({
        thread: {
          id: params.threadId,
          name: params.threadId === 'thr_fork' ? 'Forked thread' : 'Existing named thread',
          turns: [
            {
              id: 'turn_old',
              items: [
                {
                  type: 'userMessage',
                  id: 'u1',
                  content: [{ type: 'text', text: `${params.threadId} prompt` }],
                },
                { type: 'agentMessage', id: 'a1', text: `${params.threadId} answer` },
              ],
            },
          ],
        },
      }),
    ),
    resumeThread: vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
    setThreadName: vi.fn().mockResolvedValue({}),
    archiveThread: vi.fn().mockResolvedValue({}),
    unsubscribeThread: vi.fn().mockResolvedValue({}),
    interruptTurn: vi.fn().mockResolvedValue({}),
    forkThread: vi.fn().mockResolvedValue({ thread: { id: 'thr_fork', preview: '' } }),
    rollbackThread: vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing named thread' } }),
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
    captureNotificationHandler() {
      return notificationHandler;
    },
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

  it('restores the running turn and interrupt target when selecting an active thread after refresh', async () => {
    const mock = createAdapterMock();
    const turn = { id: 'restored-turn', status: 'inProgress', items: [] };
    vi.mocked(mock.adapter.readThread).mockResolvedValue({ thread: { id: 'thr_existing', turns: [turn] } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    expect(api.activeTurn.value).toEqual(turn);
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'thr_existing', status: 'active' } });
    await api.interruptActiveTurn();
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({ threadId: 'thr_existing', turnId: 'restored-turn' });
    expect(useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status).toBe('idle');
  });

  it('restores the latest running turn returned by resume', async () => {
    const mock = createAdapterMock();
    const turn = { id: 'resumed-turn', status: 'inProgress', items: [] };
    vi.mocked(mock.adapter.resumeThread).mockResolvedValue({ thread: { id: 'thr_existing', turns: [turn] } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    expect(api.activeTurn.value).toEqual(turn);
  });

  it('does not overwrite a realtime completion with stale resumed running turn data', async () => {
    const mock = createAdapterMock();
    const reply = deferred<Awaited<ReturnType<CodexAdapter['resumeThread']>>>();
    vi.mocked(mock.adapter.resumeThread).mockImplementation(() => reply.promise);
    const turn = { id: 'restored-turn', status: 'inProgress', items: [] };
    vi.mocked(mock.adapter.readThread).mockResolvedValue({ thread: { id: 'thr_existing', turns: [turn] } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const selecting = api.selectThread('thr_existing');
    await vi.waitFor(() => expect(mock.adapter.resumeThread).toHaveBeenCalled());
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { ...turn, status: 'completed' } } });
    reply.resolve({ thread: { id: 'thr_existing', turns: [turn] } });
    await selecting;
    expect(api.activeTurn.value?.status).toBe('completed');
  });

  it('does not restore a historical completed turn as active', async () => {
    const mock = createAdapterMock();
    vi.mocked(mock.adapter.readThread).mockResolvedValue({ thread: { id: 'thr_existing', turns: [{ id: 'past', status: 'completed', items: [] }] } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    expect(api.activeTurn.value).toBeNull();
  });

  it('keeps a newer realtime turn when an older running turn read resolves', async () => {
    const mock = createAdapterMock();
    const reply = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    vi.mocked(mock.adapter.readThread).mockImplementationOnce(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const selecting = api.selectThread('thr_existing');
    const newerTurn = { id: 'newer-turn', status: 'inProgress', items: [] };
    mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: newerTurn } });
    reply.resolve({ thread: { id: 'thr_existing', turns: [{ id: 'older-turn', status: 'inProgress', items: [] }] } });
    await selecting;
    expect(api.activeTurn.value).toEqual(newerTurn);
  });

  it('ignores the running turn from a read that resolves after selecting another thread', async () => {
    const mock = createAdapterMock();
    const reply = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    vi.mocked(mock.adapter.readThread).mockImplementationOnce(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const firstSelection = api.selectThread('thr_existing');
    await api.selectThread('thr_other');
    reply.resolve({ thread: { id: 'thr_existing', turns: [{ id: 'stale-turn', status: 'inProgress', items: [] }] } });
    await firstSelection;
    expect(api.activeThreadId.value).toBe('thr_other');
    expect(api.activeTurn.value).toBeNull();
  });

  it('retains green idle only for participating threads across page reload and isolates connections', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({ data: [
      { id: 'thr_existing', status: { type: 'active' } },
      { id: 'untouched', status: { type: 'idle' } },
    ], nextCursor: null });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect('ws://localhost:9001/codex');
    const workspace = useCodexWorkspace(api);
    const sessions = () => workspace.project.value.sandboxes['/'].sessions;
    expect(sessions()['thr_existing'].status).toBe('busy');
    mock.adapter.listThreads = vi.fn().mockResolvedValue({ data: [
      { id: 'thr_existing', status: { type: 'idle' } },
      { id: 'untouched', status: { type: 'idle' } },
    ], nextCursor: null });
    await api.refreshThreads();
    expect(sessions()['thr_existing'].status).toBe('idle');
    expect(sessions()['untouched'].status).toBe('unknown');
    api.disconnect();
    const restored = useCodexApi({ adapterFactory: () => mock.adapter });
    await restored.connect('ws://localhost:9001/codex');
    expect(useCodexWorkspace(restored).project.value.sandboxes['/'].sessions['thr_existing'].status).toBe('idle');
    await restored.connect('ws://localhost:9002/codex');
    expect(useCodexWorkspace(restored).project.value.sandboxes['/'].sessions['thr_existing'].status).toBe('unknown');
    restored.disconnect();
  });

  it('applies short background activity notifications without waiting for a list refresh', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const workspace = useCodexWorkspace(api);
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'background', status: { type: 'active' } } });
    expect(workspace.project.value.sandboxes['/'].sessions['background']?.status).toBe('busy');
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'background', status: { type: 'idle' } } });
    expect(workspace.project.value.sandboxes['/'].sessions['background']?.status).toBe('idle');
    api.disconnect();
  });

  it('does not replace a newer idle notification with an older busy list response', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'thr_existing', status: 'active' } });
    const listing = deferred<CodexThreadListResult>();
    mock.adapter.listThreads = vi.fn(() => listing.promise);
    const refresh = api.refreshThreads();
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'thr_existing', status: 'idle' } });
    listing.resolve({ data: [{ id: 'thr_existing', status: 'active' }], nextCursor: null });
    await refresh;
    expect(useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status).toBe('idle');
    api.disconnect();
  });

  it('does not revive completed activity when the send response arrives last', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const send = api.sendPrompt('Fast turn');
    mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: 'fast', status: 'inProgress' } } });
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'fast', status: 'completed' } } });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'fast', status: 'inProgress' } });
    await send;
    expect(api.activeTurn.value?.status).toBe('completed');
    expect(useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status).toBe('idle');
    api.disconnect();
  });

  it('does not carry a running thread or a late send into another connection', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect('ws://localhost:9001/codex');
    mock.emit({ method: 'thread/status/changed', params: { threadId: 'thr_existing', status: 'active' } });
    const send = api.sendPrompt('Previous connection');
    mock.adapter.listThreads = vi.fn().mockResolvedValue({ data: [{ id: 'other', status: 'idle' }], nextCursor: null });
    await api.connect('ws://localhost:9002/codex');
    expect(api.threads.value.map(thread => thread.id)).toEqual(['other']);
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'late', status: 'inProgress' } });
    await send;
    expect(api.participatedThreadIds.value.size).toBe(0);
    expect(api.activeThreadId.value).toBe('other');
    api.disconnect();
  });

  it('preserves item-start order when an earlier assistant finishes after later tools', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const now = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      mock.emit({ method: 'item/started', params: { threadId: 'thr_existing', turnId: 'turn_1', item: { type: 'agentMessage', id: 'z-first' } } });
      mock.emit({ method: 'item/started', params: { threadId: 'thr_existing', turnId: 'turn_1', item: { type: 'commandExecution', id: 'a-second', command: 'pwd' } } });
      now.mockReturnValue(200);
      mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_1', item: { type: 'agentMessage', id: 'z-first', text: 'Delayed response' } } });
      const assistant = api.realtimeHistoryQueue.value.find(entry => entry.info.id === 'turn_1:assistant:z-first');
      const tool = api.realtimeToolParts.value.find(entry => entry.info.id === 'turn_1:assistant:a-second');
      expect(assistant?.info.time.created).toBeLessThan(tool?.info.time.created ?? 0);
    } finally {
      now.mockRestore();
      api.disconnect();
    }
  });

  it('keeps supplemental echoes, item parents and card identities stable through history reload', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Same text', { effort: 'high' });
    const firstClient = vi.mocked(mock.adapter.sendPrompt).mock.calls[0]?.[0].clientUserMessageId;
    const firstUser = { type: 'userMessage', id: 'wire-a', clientId: firstClient, content: [{ type: 'text', text: 'Same text' }] };
    const emit = (method: string, item: Record<string, unknown>) => mock.emit({ method, params: { threadId: 'thr_existing', turnId: 'turn_1', item } });
    emit('item/completed', firstUser);
    emit('item/started', { type: 'agentMessage', id: 'old-answer' });
    emit('item/started', { type: 'commandExecution', id: 'old-tool', command: 'echo old' });
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const pending = api.sendPrompt('Same text', { effort: 'low' });
    const secondClient = vi.mocked(mock.adapter.sendPrompt).mock.calls[0]?.[0].clientUserMessageId;
    expect(secondClient).not.toBe(firstClient);
    const secondUser = { type: 'userMessage', id: 'wire-b', clientId: secondClient, content: [{ type: 'text', text: 'Same text' }] };
    emit('item/started', secondUser);
    emit('item/completed', secondUser);
    expect(api.realtimeHistoryQueue.value.filter(entry => entry.info.role === 'user')).toHaveLength(2);
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn_1', status: 'inProgress' } });
    await pending;
    const oldAnswer = { type: 'agentMessage', id: 'old-answer', text: 'Old response, delayed' };
    const oldTool = { type: 'commandExecution', id: 'old-tool', command: 'echo old', status: 'completed' };
    const newAnswer = { type: 'agentMessage', id: 'new-answer', text: 'New response' };
    const newTool = { type: 'commandExecution', id: 'new-tool', command: 'echo new', status: 'completed' };
    const reasoning = { type: 'reasoning', id: 'new-reasoning', summary: [{ type: 'summary_text', text: 'New reasoning' }] };
    for (const item of [oldAnswer, oldTool, newAnswer, newTool, reasoning]) emit('item/completed', item);
    const identity = (entries: typeof api.canonicalHistory.value) => entries.map(entry => ({
      id: entry.info.id,
      parent: entry.info.role === 'assistant' ? entry.info.parentID : '',
      variant: entry.info.variant,
    })).sort((a, b) => a.id.localeCompare(b.id));
    const live = identity(api.realtimeHistoryQueue.value);
    expect(live.find(entry => entry.id === 'turn_1:assistant:old-answer')?.parent).toBe(`turn_1:user:${firstClient}`);
    expect(live.find(entry => entry.id === 'turn_1:assistant:old-tool')?.parent).toBe(`turn_1:user:${firstClient}`);
    expect(live.find(entry => entry.id === 'turn_1:assistant:new-answer')?.parent).toBe(`turn_1:user:${secondClient}`);
    vi.mocked(mock.adapter.readThread).mockResolvedValue({ thread: { id: 'thr_existing', turns: [{ id: 'turn_1', status: 'completed', items: [firstUser, oldAnswer, oldTool, secondUser, newAnswer, newTool, reasoning] }] } });
    await api.selectThread('thr_existing');
    expect(identity(api.canonicalHistory.value)).toEqual(live);
    emit('item/completed', firstUser);
    emit('item/completed', { type: 'agentMessage', id: 'after-reload', text: 'Still follows the latest user' });
    expect(api.realtimeHistoryQueue.value.find(entry => entry.info.id === 'turn_1:assistant:after-reload')?.info).toMatchObject({ parentID: `turn_1:user:${secondClient}` });
    api.disconnect();
  });

  it('keeps supplemental users and their replies distinct within a reused active turn', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Original request', { effort: 'high' });
    const first = api.realtimeHistoryQueue.value.find(entry => entry.info.role === 'user');
    mock.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr_existing', turnId: 'turn_1', itemId: 'answer-a', delta: 'Original reply' } });
    await api.sendPrompt('Supplemental request', { effort: 'low' });
    const users = api.realtimeHistoryQueue.value.filter(entry => entry.info.role === 'user');
    expect(users).toHaveLength(2);
    expect(users.map(entry => entry.parts.find(part => part.type === 'text')?.text)).toEqual(['Original request', 'Supplemental request']);
    mock.emit({ method: 'item/agentMessage/delta', params: { threadId: 'thr_existing', turnId: 'turn_1', itemId: 'answer-b', delta: 'Supplemental reply' } });
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_1', item: { id: 'answer-a', type: 'agentMessage', text: 'Original reply completed late' } } });
    const parent = (id: string) => api.realtimeHistoryQueue.value.find(entry => entry.info.id === `turn_1:assistant:${id}`)?.info;
    expect(parent('answer-a')).toMatchObject({ parentID: first?.info.id });
    expect(parent('answer-b')).toMatchObject({ parentID: users[1]?.info.id });
    expect(users.map(entry => entry.info.variant)).toEqual(['high', 'low']);
    api.disconnect();
  });

  it('retains selected effort through the pending prompt and server echo', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const sending = api.sendPrompt('Explain', { effort: 'high' });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    expect(api.realtimeHistoryQueue.value.find(entry => entry.info.role === 'user')?.info.variant).toBe('high');
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_effort', item: { type: 'userMessage', id: 'u', clientId, content: [{ type: 'text', text: 'Explain' }] } } });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn_effort', status: 'inProgress' } });
    await sending;
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_effort', item: { type: 'agentMessage', id: 'a', text: 'Answer' } } });
    const messages = api.realtimeHistoryQueue.value.map(entry => entry.info);
    expect(messages.filter(info => info.role === 'user')).toHaveLength(1);
    expect(messages.every(info => info.variant === 'high')).toBe(true);
  });

  it('restores each captured turn effort after reload without labelling unknown turns', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const clientIds = new Map<string, string | undefined>();
    for (const [id, effort] of [['turn_high', 'high'], ['turn_low', 'low']]) {
      vi.mocked(mock.adapter.sendPrompt).mockResolvedValueOnce({ threadId: 'thr_existing', turn: { id, status: 'inProgress' } });
      await api.sendPrompt('Explain', { effort });
      clientIds.set(id, vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId);
    }
    vi.mocked(mock.adapter.readThread).mockResolvedValue({ thread: { id: 'thr_existing', name: 'Existing', turns: ['turn_high', 'turn_low', 'turn_unknown'].map(id => ({ id, items: [
      { type: 'userMessage', id: 'u', clientId: clientIds.get(id), content: [{ type: 'text', text: 'Explain' }] },
      { type: 'agentMessage', id: 'a', text: 'Answer' },
    ] })) } });
    api.disconnect();
    const restored = useCodexApi({ adapterFactory: () => mock.adapter });
    await restored.connect();
    await restored.selectThread('thr_existing');
    expect(restored.canonicalHistory.value.map(entry => entry.info.variant)).toEqual(['high', 'high', 'low', 'low', undefined, undefined]);
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_high', item: { type: 'userMessage', id: 'u', clientId: clientIds.get('turn_high'), content: [{ type: 'text', text: 'Explain' }] } } });
    expect(restored.realtimeHistoryQueue.value.find(entry => entry.info.id === `turn_high:user:${clientIds.get('turn_high')}`)?.info.variant).toBe('high');
  });

  it('keeps restored replies attached to their original user across tool events', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const original = api.canonicalHistory.value.find(entry => entry.info.role === 'assistant')!;
    mock.emit({ method: 'item/started', params: { threadId: 'thr_existing', turnId: 'turn_old', item: { id: 'command-live', type: 'commandExecution', command: 'pwd' } } });
    expect(api.realtimeToolParts.value[0]?.info).toMatchObject({
      parentID: 'turn_old:user:u1',
      id: 'turn_old:assistant:command-live',
    });
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_old', item: { id: 'command-live', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: '/repo' } } });
    expect(api.realtimeHistoryQueue.value.find(entry => entry.info.role === 'assistant')?.info).toMatchObject({ parentID: 'turn_old:user:u1' });
    expect(api.canonicalHistory.value.find(entry => entry.info.id === original.info.id)).toEqual(original);
  });

  it('retains streamed reasoning when completion contains no summary and separates consecutive items', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    for (const [itemId, delta] of [['reason-1', 'First summary'], ['reason-2', 'Second summary']]) {
      mock.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thr_existing', turnId: 'turn_old', itemId, delta } });
      mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_old', item: { id: itemId, type: 'reasoning', summary: [], content: [] } } });
    }
    const reasoning = api.realtimeHistoryQueue.value.flatMap(entry => entry.parts).filter(part => part.type === 'reasoning');
    expect(reasoning.map(part => [part.id, part.text])).toEqual([['reason-1', 'First summary'], ['reason-2', 'Second summary']]);
  });

  it('does not revive completed reasoning when this or a later turn finishes', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const clock = vi.spyOn(Date, 'now').mockReturnValue(100);
    try {
      mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn-a', item: { id: 'reason-a', type: 'reasoning', summary: ['Finished thought'], content: [] } } });
      const finishedPart = api.realtimeReasoningPart.value?.part;
      clock.mockReturnValue(200);
      mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'turn-a', status: 'completed' } } });
      expect(api.realtimeReasoningPart.value?.part).toBe(finishedPart);
      clock.mockReturnValue(300);
      mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: 'turn-b', status: 'inProgress' } } });
      mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'turn-b', status: 'completed' } } });
      expect(api.realtimeReasoningPart.value?.part).toBe(finishedPart);
    } finally {
      clock.mockRestore();
    }
  });

  it('keeps authoritative completed reasoning through the turn completion event', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({ method: 'item/reasoning/summaryTextDelta', params: { threadId: 'thr_existing', turnId: 'turn-live', itemId: 'reason-final', delta: 'Draft' } });
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn-live', item: { id: 'reason-final', type: 'reasoning', summary: ['Final summary'], content: [] } } });
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'turn-live', status: 'completed' } } });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({ id: 'reason-final', text: 'Final summary' });
  });

  it('reparents early tool events when the optimistic user receives its final ID', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const sending = api.sendPrompt('Continue');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    mock.emit({ method: 'item/started', params: { threadId: 'thr_existing', turnId: 'turn-race', item: { id: 'early-tool', type: 'commandExecution', command: 'pwd' } } });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'turn-race', status: 'inProgress' } });
    await sending;
    mock.emit({ method: 'item/commandExecution/outputDelta', params: { threadId: 'thr_existing', turnId: 'turn-race', itemId: 'early-tool', delta: '/repo' } });
    expect(api.realtimeToolParts.value[0]?.info).toMatchObject({ parentID: `turn-race:user:${clientId}` });
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn-race', item: { id: 'early-tool', type: 'commandExecution', command: 'pwd', status: 'completed' } } });
    expect(api.realtimeHistoryQueue.value.find(entry => entry.info.role === 'assistant')?.info).toMatchObject({ parentID: `turn-race:user:${clientId}` });
  });

  it('publishes completed-only reasoning and collaboration notifications to live window sources', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn-c', item: { id: 'reason-only', type: 'reasoning', summary: ['Decision'] } } });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({id: 'reason-only', text: 'Decision', time: {end: expect.any(Number)}});
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn-c', item: { id: 'spawn-only', type: 'collabAgentToolCall', tool: 'spawnAgent', status: 'completed', senderThreadId: 'thr_existing', receiverThreadIds: ['child'], prompt: 'Review', agentsStates: {child: {status: 'running'}} } } });
    expect(api.realtimeCompletedPart.value?.part).toMatchObject({tool: 'task', state: {metadata: {sessionIds: ['child']}}});
    await api.selectThread('thr_existing');
    expect(api.realtimeReasoningPart.value).toBeNull();
    expect(api.realtimeToolParts.value).toEqual([]);
  });

  it('reads child history without changing the selected parent session', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const parentHistory = api.canonicalHistory.value;
    const result = await api.readSubagentHistory('thr_child');
    expect(result.every(entry => entry.info.sessionID === 'thr_child')).toBe(true);
    expect(result.flatMap(entry => entry.parts).some(part => part.type === 'text' && part.text.includes('thr_child answer'))).toBe(true);
    expect(api.activeThreadId.value).toBe('thr_existing');
    expect(api.canonicalHistory.value).toBe(parentHistory);
  });

  it('reports each successful live turn once, including background threads', async () => {
    const mock = createAdapterMock();
    const onTaskCompleted = vi.fn();
    const api = useCodexApi({ adapterFactory: () => mock.adapter, onTaskCompleted });
    await api.connect();

    mock.emit({
      method: 'turn/started',
      params: { threadId: 'thr_background', turn: { id: 'turn-live', status: 'inProgress' } },
    });
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_background', turn: { id: 'turn-live', status: 'completed' } },
    });
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_background', turn: { id: 'turn-live', status: 'completed' } },
    });

    expect(onTaskCompleted).toHaveBeenCalledOnce();
    expect(onTaskCompleted).toHaveBeenCalledWith({
      sessionId: 'thr_background',
      completionId: 'turn-live',
    });
  });

  it('still reports completion when the interruption RPC rejects', async () => {
    const mock = createAdapterMock();
    const onTaskCompleted = vi.fn();
    const api = useCodexApi({ adapterFactory: () => mock.adapter, onTaskCompleted });
    await api.connect();
    mock.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: 'turn-running', status: 'inProgress' } } });
    vi.spyOn(mock.adapter, 'interruptTurn').mockRejectedValueOnce(new Error('Interruption rejected'));
    await expect(api.interruptActiveTurn()).rejects.toThrow('Interruption rejected');
    expect(api.activeTurn.value?.status).toBe('inProgress');
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'turn-running', status: 'completed' } } });
    expect(onTaskCompleted).toHaveBeenCalledExactlyOnceWith({ sessionId: 'thr_existing', completionId: 'turn-running' });
  });

  it.each(['new turn', 'new connection'] as const)('does not overwrite a %s with a late interruption response', async (mode) => {
    const first = createAdapterMock();
    const second = createAdapterMock();
    const interrupted = deferred<Awaited<ReturnType<CodexAdapter['interruptTurn']>>>();
    vi.spyOn(first.adapter, 'interruptTurn').mockReturnValueOnce(interrupted.promise);
    const onTaskCompleted = vi.fn();
    let connection = 0;
    const api = useCodexApi({ adapterFactory: () => connection++ === 0 ? first.adapter : second.adapter, onTaskCompleted });
    await api.connect();
    first.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: 'turn-shared', status: 'inProgress' } } });
    const pendingInterruption = api.interruptActiveTurn();
    if (mode === 'new connection') {
      api.disconnectTransport();
      await api.connect();
    }
    const current = mode === 'new connection' ? second : first;
    const turnId = mode === 'new connection' ? 'turn-shared' : 'turn-new';
    current.emit({ method: 'turn/started', params: { threadId: 'thr_existing', turn: { id: turnId, status: 'inProgress' } } });
    interrupted.resolve({});
    await pendingInterruption;
    expect(api.activeTurn.value).toMatchObject({ id: turnId, status: 'inProgress' });
    current.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: turnId, status: 'completed' } } });
    expect(onTaskCompleted).toHaveBeenCalledExactlyOnceWith({ sessionId: 'thr_existing', completionId: turnId });
  });

  it('suppresses non-live, interrupted, failed, and stale-connection turn completions', async () => {
    const first = createAdapterMock();
    const second = createAdapterMock();
    const onTaskCompleted = vi.fn();
    let connection = 0;
    const api = useCodexApi({
      adapterFactory: () => (connection++ === 0 ? first.adapter : second.adapter),
      onTaskCompleted,
    });
    await api.connect();

    first.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-history', status: 'completed' } },
    });
    first.emit({
      method: 'turn/started',
      params: { threadId: 'thr_existing', turn: { id: 'turn-failed', status: 'inProgress' } },
    });
    first.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-failed', status: 'failed' } },
    });
    first.emit({
      method: 'turn/started',
      params: { threadId: 'thr_existing', turn: { id: 'turn-interrupted', status: 'inProgress' } },
    });
    api.activeTurn.value = { id: 'turn-interrupted', status: 'inProgress' };
    await api.interruptActiveTurn();
    first.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-interrupted', status: 'completed' } },
    });
    first.emit({
      method: 'turn/started',
      params: { threadId: 'thr_existing', turn: { id: 'turn-stale', status: 'inProgress' } },
    });
    const staleHandler = first.captureNotificationHandler();

    api.disconnectTransport();
    await api.connect();
    staleHandler?.({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-stale', status: 'completed' } },
    });

    expect(onTaskCompleted).not.toHaveBeenCalled();
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
    mock.adapter.getThreadGoal = vi.fn((params: { threadId: string }) =>
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
          }),
    );
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
    mock.adapter.getThreadGoal = vi
      .fn()
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

  it.each(['updated', 'cleared'])(
    'applies goal %s notifications before stale reads',
    async (event) => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.selectThread('thr_existing');
      const goal: CodexThreadGoal = {
        threadId: 'thr_existing',
        objective: 'Live goal',
        status: 'active',
        tokenBudget: null,
        tokensUsed: 8,
        timeUsedSeconds: 2,
        createdAt: 1,
        updatedAt: 2,
      };
      mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({ goal });
      await api.refreshThreadGoal();
      const stale = deferred<{ goal: CodexThreadGoal | null }>();
      mock.adapter.getThreadGoal = vi.fn(() => stale.promise);
      const refresh = api.refreshThreadGoal();
      expect(api.threadGoalLoading.value).toBe(true);
      expect(api.threadGoal.value).toEqual(goal);
      expect(api.threadGoalThreadId.value).toBe('thr_existing');

      mock.emit({
        method: `thread/goal/${event}`,
        params: { threadId: 'thr_existing', goal: { ...goal, tokensUsed: 20 } },
      });
      stale.resolve({ goal: { ...goal, objective: 'Stale goal' } });
      await refresh;

      expect(api.threadGoal.value).toEqual(
        event === 'cleared' ? null : { ...goal, tokensUsed: 20 },
      );
      expect(api.threadGoalThreadId.value).toBe('thr_existing');
      expect(api.threadGoalLoading.value).toBe(false);
    },
  );

  it('ignores goal notifications belonging to other threads', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    await api.refreshThreadGoal();

    mock.emit({ method: 'thread/goal/cleared', params: { threadId: 'thr_other' } });

    expect(api.threadGoalThreadId.value).toBe('thr_existing');
  });

  it.each(['thr_other', ''])('ignores goal updates with mismatched payload ownership (%s)', async (threadId) => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    await api.refreshThreadGoal();

    mock.emit({
      method: 'thread/goal/updated',
      params: {
        threadId: 'thr_existing',
        goal: {
          threadId, objective: 'Wrong owner', status: 'active', tokenBudget: null,
          tokensUsed: 0, timeUsedSeconds: 0, createdAt: 1, updatedAt: 1,
        },
      },
    });

    expect(api.threadGoal.value).toBeNull();
    expect(api.threadGoalThreadId.value).toBe('thr_existing');
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
      marketplaces: [
        {
          name: 'local-marketplace',
          path: '/repo/.agents/plugins/marketplace.json',
          plugins: [
            {
              id: 'demo',
              name: 'demo',
              isAccessible: true,
              isEnabled: false,
              source: { type: 'local', path: '/repo/plugins/demo' },
            },
          ],
        },
      ],
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    await api.refreshPlugins();

    expect(api.plugins.value).toEqual([
      expect.objectContaining({
        id: 'demo',
        marketplaceName: 'local-marketplace',
        marketplacePath: '/repo/.agents/plugins/marketplace.json',
      }),
    ]);
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
    mock.adapter.listPlugins = vi
      .fn()
      .mockImplementationOnce(() => stalePlugins.promise)
      .mockResolvedValueOnce({
        marketplaces: [
          {
            name: 'current-marketplace',
            path: '/current/marketplace.json',
            plugins: [
              {
                id: 'current',
                name: 'current',
                isAccessible: true,
                isEnabled: true,
                source: { type: 'local', path: '/current' },
              },
            ],
          },
        ],
      });

    const staleRefresh = api.refreshPlugins();
    await api.refreshPlugins();
    stalePlugins.resolve({
      marketplaces: [
        {
          name: 'stale-marketplace',
          path: '/stale/marketplace.json',
          plugins: [
            {
              id: 'stale',
              name: 'stale',
              isAccessible: true,
              isEnabled: false,
              source: { type: 'local', path: '/stale' },
            },
          ],
        },
      ],
    });
    await staleRefresh;

    expect(api.plugins.value.map((plugin) => plugin.id)).toEqual(['current']);
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

  it('keeps the newest account refresh when an older preload resolves last', async () => {
    const mock = createAdapterMock();
    const staleAccount = deferred<{ account: null }>();
    mock.adapter.readAccount = vi
      .fn()
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

  it('ignores a stale home directory response when the same adapter reconnects', async () => {
    const mock = createAdapterMock();
    const staleHome = deferred<Response>();
    const originalFetch = globalThis.fetch;
    const fetchMock = vi
      .fn()
      .mockImplementationOnce(() => staleHome.promise)
      .mockResolvedValueOnce(
        new Response(JSON.stringify({ home: '/current-home' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
    vi.stubGlobal('fetch', fetchMock);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    try {
      const staleConnection = api.connect();
      await vi.waitFor(() => expect(fetchMock).toHaveBeenCalledTimes(1));
      await api.connect();
      expect(api.homeDir.value).toBe('/current-home');

      staleHome.resolve(
        new Response(JSON.stringify({ home: '/stale-home' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        }),
      );
      await staleConnection;

      expect(api.homeDir.value).toBe('/current-home');
    } finally {
      vi.stubGlobal('fetch', originalFetch);
    }
  });

  it('redetects hydrated history support when the same adapter reconnects', async () => {
    // Given: this connection has already fallen back to paginated history.
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn()
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValue({ thread: { id: 'thr_existing' } });
    mock.adapter.listThreadTurns = vi.fn().mockResolvedValue({
      data: [{ id: 'turn_old', items: [{ type: 'agentMessage', id: 'old', text: 'Old runtime' }] }],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    api.disconnect();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_existing',
        turns: [{ id: 'turn_new', items: [{ type: 'agentMessage', id: 'new', text: 'New runtime' }] }],
      },
    });
    mock.adapter.listThreadTurns = vi.fn().mockRejectedValue(
      new CodexJsonRpcError(-32601, 'Method not found'),
    );

    // When: the same adapter reconnects to a runtime supporting hydrated reads.
    await api.connect();
    await api.selectThread('thr_existing');

    // Then: old connection capabilities do not force unsupported pagination.
    expect(mock.adapter.readThread).toHaveBeenCalledWith({
      threadId: 'thr_existing', includeTurns: true,
    });
    expect(mock.adapter.listThreadTurns).not.toHaveBeenCalled();
    expect(api.transcript.value.map((entry) => entry.text)).toEqual(['New runtime']);
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
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          { id: 'custom-null', preview: 'Null custom', modelProvider: 'omniroute', updatedAt: 2 },
        ],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'official', preview: 'OpenAI', modelProvider: 'openai', updatedAt: 3 }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [
          { id: 'custom-explicit', preview: 'Custom', modelProvider: 'omniroute', updatedAt: 1 },
        ],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();

    await vi.waitFor(() => {
      expect(api.threads.value.map((thread) => thread.id)).toEqual([
        'official',
        'custom-null',
        'custom-explicit',
      ]);
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
    mock.adapter.readConfig = vi
      .fn()
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
    mock.adapter.getVcsInfo = vi
      .fn()
      .mockImplementationOnce(() => staleVcs.promise)
      .mockResolvedValue({ root: '/current', branch: 'main' });
    mock.adapter.listThreads = vi
      .fn()
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
      data: [
        {
          id: 'thr_repo',
          preview: 'Repo',
          cwd: '/repo',
          gitInfo: {
            root: '/repo',
            branch: 'main',
            originUrl: 'https://token@example.com/org/repo.git',
          },
        },
      ],
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

    expect(api.threads.value.map((thread) => thread.cwd)).toEqual([
      '/home/codex',
      '/home/codex/repo',
    ]);
  });

  it('falls back to reading unmaterialized threads without turns', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(
        new Error(
          'thread thr_empty is not materialized yet; includeTurns is unavailable before first user message',
        ),
      )
      .mockResolvedValueOnce({ thread: { id: 'thr_empty', preview: 'Empty thread' } });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_empty');

    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(1, {
      threadId: 'thr_empty',
      includeTurns: true,
    });
    expect(mock.adapter.readThread).toHaveBeenNthCalledWith(2, {
      threadId: 'thr_empty',
      includeTurns: false,
    });
    expect(api.activeThreadId.value).toBe('thr_empty');
    expect(api.canonicalHistory.value).toEqual([]);
    expect(api.errorMessage.value).toBe('');
  });

  it('loads paginated full history when legacy hydrated reads are unsupported', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockRejectedValueOnce(new CodexJsonRpcError(-32601, 'list_turns is not supported yet'))
      .mockResolvedValueOnce({
        thread: { id: 'thr_paginated', name: 'Paginated', historyMode: 'paginated' },
      });
    mock.adapter.listThreadTurns = vi
      .fn()
      .mockResolvedValueOnce({
        data: [
          {
            id: 'turn_1',
            items: [
              { type: 'userMessage', id: 'u1', content: [{ type: 'text', text: 'First prompt' }] },
            ],
          },
        ],
        nextCursor: 'page-2',
      })
      .mockResolvedValueOnce({
        data: [{ id: 'turn_2', items: [{ type: 'agentMessage', id: 'a1', text: 'Final answer' }] }],
        nextCursor: null,
      });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_paginated');

    expect(mock.adapter.listThreadTurns).toHaveBeenNthCalledWith(1, {
      threadId: 'thr_paginated',
      limit: 100,
      sortDirection: 'asc',
      itemsView: 'full',
    });
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user',
      'assistant',
    ]);
    expect(api.transcript.value.map((entry) => entry.text)).toEqual([
      'First prompt',
      'Final answer',
    ]);
  });

  it('keeps the newest thread selection when an older read resolves last', async () => {
    const mock = createAdapterMock();
    const threadA = deferred<Awaited<ReturnType<CodexAdapter['readThread']>>>();
    mock.adapter.readThread = vi.fn((params: { threadId: string }) => {
      if (params.threadId === 'thread-a') return threadA.promise;
      return Promise.resolve({
        thread: {
          id: params.threadId,
          turns: [
            {
              id: `${params.threadId}:turn`,
              items: [
                {
                  type: 'userMessage',
                  id: `${params.threadId}:user`,
                  content: [{ type: 'text', text: `${params.threadId} prompt` }],
                },
                {
                  type: 'agentMessage',
                  id: `${params.threadId}:assistant`,
                  text: `${params.threadId} answer`,
                },
              ],
            },
          ],
        },
      });
    });
    mock.adapter.resumeThread = vi.fn((params: { threadId: string }) =>
      Promise.resolve({
        thread: { id: params.threadId },
      }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();

    const selectingA = api.selectThread('thread-a');
    await vi.waitFor(() =>
      expect(mock.adapter.readThread).toHaveBeenCalledWith({
        threadId: 'thread-a',
        includeTurns: true,
      }),
    );
    await api.selectThread('thread-b');

    threadA.resolve({
      thread: {
        id: 'thread-a',
        turns: [
          {
            id: 'thread-a:turn',
            items: [
              {
                type: 'userMessage',
                id: 'thread-a:user',
                content: [{ type: 'text', text: 'thread-a prompt' }],
              },
              { type: 'agentMessage', id: 'thread-a:assistant', text: 'thread-a answer' },
            ],
          },
        ],
      },
    });
    await selectingA;

    expect(api.activeThreadId.value).toBe('thread-b');
    expect(api.transcript.value.map((entry) => entry.text)).toEqual([
      'thread-b prompt',
      'thread-b answer',
    ]);
  });

  it('maps every supported history item through the public transcript path', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_variants',
        turns: [
          {
            id: 'turn_variants',
            items: [
              {
                type: 'userMessage',
                content: [{ type: 'text', text: 'user prompt' }],
              },
              { type: 'agentMessage', text: 'agent answer' },
              { type: 'plan', text: 'plan text' },
              {
                type: 'commandExecution',
                command: ['pnpm', 'test'],
                cwd: '/repo',
                status: 'completed',
                exitCode: 0,
                aggregatedOutput: 'passed',
              },
              {
                type: 'fileChange',
                changes: [{ path: 'src/a.ts' }, { path: 'src/b.ts' }],
                status: 'completed',
              },
              { type: 'reasoning', summary: 'reasoning text' },
              { type: 'enteredReviewMode' },
              { type: 'exitedReviewMode', review: 'current changes' },
              {
                type: 'webSearch',
                query: 'codex',
                action: { type: 'open', query: 'docs', url: 'https://example.test' },
              },
              { type: 'imageView', path: '/tmp/image.png' },
              {
                type: 'mcpToolCall',
                server: 'docs',
                tool: 'search',
                arguments: { query: 'codex' },
                status: 'completed',
              },
              { type: 'dynamicToolCall', tool: 'lookup', status: 'completed' },
              { type: 'collabToolCall', tool: 'delegate', status: 'completed' },
              { type: 'contextCompaction' },
              { type: 'reasoning', summary: '' },
              { type: 'exitedReviewMode' },
              { type: 'imageView' },
              { type: 'unknownItem', text: 'ignored' },
              null,
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_variants');

    expect(api.transcript.value.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'user', text: 'user prompt' },
      { role: 'assistant', text: 'agent answer' },
      { role: 'system', text: 'plan text' },
      {
        role: 'system',
        text: '$ pnpm test\ncwd: /repo\nstatus: completed\nexit code: 0\n\npassed',
      },
      {
        role: 'system',
        text: 'File changes (2):\n  src/a.ts\n  src/b.ts\nstatus: completed',
      },
      { role: 'system', text: 'Reasoning: reasoning text' },
      { role: 'system', text: 'Entered review mode: current changes' },
      { role: 'system', text: 'Review: current changes' },
      {
        role: 'system',
        text: 'Web search: codex\naction: open\nquery: docs\nurl: https://example.test',
      },
      { role: 'system', text: 'Image: /tmp/image.png' },
      {
        role: 'system',
        text: 'Tool call: docs.search\narguments:\n{\n  "query": "codex"\n}\nstatus: completed',
      },
      { role: 'system', text: 'Tool call: lookup\nstatus: completed' },
      { role: 'system', text: 'Tool call: delegate\nstatus: completed' },
      { role: 'system', text: 'Context compaction completed' },
    ]);
  });

  it('preserves item fallbacks when history fields are missing or malformed', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi.fn().mockResolvedValue({
      thread: {
        id: 'thr_fallbacks',
        turns: [
          {
            id: 'turn_fallbacks',
            items: [
              null,
              {},
              { type: 'unknownItem' },
              { type: 'userMessage', content: [{ type: 'image', path: '/tmp/image.png' }] },
              { type: 'agentMessage', text: '' },
              { type: 'plan', text: '' },
              { type: 'commandExecution' },
              { type: 'fileChange', changes: [] },
              { type: 'reasoning', summary: 42 },
              { type: 'enteredReviewMode', review: 42 },
              { type: 'exitedReviewMode' },
              { type: 'webSearch', action: {} },
              { type: 'imageView' },
              { type: 'mcpToolCall' },
              { type: 'dynamicToolCall' },
              { type: 'collabToolCall' },
            ],
          },
        ],
      },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.selectThread('thr_fallbacks');

    expect(api.transcript.value.map(({ role, text }) => ({ role, text }))).toEqual([
      { role: 'system', text: 'File changes' },
      { role: 'system', text: 'Entered review mode: current changes' },
    ]);
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
      const snapshot = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(
        threadAKey,
      );
      expect(
        snapshot?.entries?.flatMap((entry) => entry.parts ?? []).map((part) => part.id),
      ).toContain('thread-a:command');
    });
    expect(storageGetJSON(threadBKey)).toBeNull();
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('thread-a:command');
  });

  it('keeps the requested cwd when a newly started thread omits cwd', async () => {
    const mock = createAdapterMock();
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
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
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
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
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', preview: '' } });
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
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread', cwd: '/repo/subdir' }],
        nextCursor: null,
      })
      .mockResolvedValueOnce({
        data: [{ id: 'thr_existing', preview: 'Existing thread' }],
        nextCursor: null,
      });
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
    mock.adapter.startThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_new', cwd: '/repo/subdir', preview: '' } });
    mock.adapter.getVcsInfo = vi.fn().mockResolvedValue({ root: '/repo', branch: 'main' });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const thread = await api.startThread('/repo/subdir');

    expect(mock.adapter.getVcsInfo).toHaveBeenCalledWith('/repo/subdir');
    expect(thread.gitInfo).toEqual({ root: '/repo', branch: 'main' });
    expect(api.threads.value.find((item) => item.id === 'thr_new')?.gitInfo).toEqual({
      root: '/repo',
      branch: 'main',
    });
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
      expect(api.threads.value.find((item) => item.id === 'thr_notify')?.gitInfo).toEqual({
        root: '/repo',
        branch: 'main',
      });
    });
  });

  it('sends prompts to the active thread and records user transcript entries', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const result = await api.sendPrompt('  Summarize this repo.  ');

    expect(mock.adapter.sendPrompt).toHaveBeenCalledWith({
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
      summary: 'auto',
      clientUserMessageId: expect.stringMatching(/^client-user:/u),
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
    mock.adapter.listThreads = vi
      .fn()
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
    expect(api.threads.value[0]).toEqual(
      expect.objectContaining({
        id: 'thr_existing',
        name: 'Existing named thread',
      }),
    );
    expect(api.transcript.value).toEqual([
      expect.objectContaining({ role: 'user', text: 'thr_existing prompt' }),
      expect.objectContaining({ role: 'assistant', text: 'thr_existing answer' }),
    ]);
    expect(api.canonicalHistory.value.map((entry) => entry.info.role)).toEqual([
      'user',
      'assistant',
    ]);
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
              {
                type: 'userMessage',
                id: 'u1',
                content: [{ type: 'text', text: 'First user prompt' }],
              },
              { type: 'agentMessage', id: 'a1', text: 'First agent answer' },
            ],
          },
          {
            id: 'turn_2',
            items: [
              {
                type: 'userMessage',
                id: 'u2',
                content: [{ type: 'text', text: 'Second user prompt' }],
              },
              { type: 'agentMessage', id: 'a2', text: 'Second agent answer' },
            ],
          },
          {
            id: 'turn_3',
            items: [
              {
                type: 'userMessage',
                id: 'u3',
                content: [{ type: 'text', text: 'Third user prompt' }],
              },
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
      'user',
      'assistant',
      'user',
      'assistant',
      'user',
      'assistant',
    ]);
  });

  it('keeps selecting an empty thread when resume reports no rollout', async () => {
    const mock = createAdapterMock();
    mock.adapter.readThread = vi
      .fn()
      .mockResolvedValue({ thread: { id: 'thr_empty', preview: 'Empty', turns: [] } });
    mock.adapter.resumeThread = vi
      .fn()
      .mockRejectedValue(new Error('no rollout found for thread id thr_empty'));
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
    mock.emit({
      method: 'thread/name/updated',
      params: { threadId: 'thr_existing', name: 'Renamed' },
    });

    expect(api.threads.value[0]).toEqual(
      expect.objectContaining({
        id: 'thr_existing',
        name: 'Renamed',
      }),
    );
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

    expect(mock.adapter.setThreadName).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      name: 'Renamed by user',
    });
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      turnId: 'turn_1',
    });
    expect(mock.adapter.unsubscribeThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(mock.adapter.archiveThread).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.activeThreadId.value).toBe('');
    expect(api.activeTurn.value).toBeNull();
  });

  it('hides empty no-rollout threads when archive is rejected by Codex', async () => {
    const mock = createAdapterMock();
    mock.adapter.archiveThread = vi
      .fn()
      .mockRejectedValue(new Error('no rollout found for thread id thr_existing'));
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
    expect(mock.adapter.rollbackThread).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      numTurns: 1,
    });
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
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('rollback-command');

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
    expect(
      api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts).map((part) => part.id),
    ).not.toContain('rollback-command-late');
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

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (e) => e.info.role === 'assistant',
    );
    expect(assistantEntries.length).toBeGreaterThan(0);
    expect(
      assistantEntries.some((e) =>
        e.parts.some((p) => p.type === 'text' && 'text' in p && p.text === 'Realtime answer'),
      ),
    ).toBe(true);
  });

  it('pushes user message to realtimeHistoryQueue immediately on sendPrompt', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    expect(api.realtimeHistoryQueue.value).toEqual([]);

    await api.sendPrompt('Hello immediately.');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const userId = `turn_1:user:${clientId}`;

    const userEntries = api.realtimeHistoryQueue.value.filter((e) => e.info.role === 'user');
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.role).toBe('user');
    expect(clientId).toMatch(/^client-user:/u);
    expect(userEntries[0]?.info.id).toBe(userId);
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:')),
    ).toBe(true);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain(userId);
    expect(userEntries[0]?.parts).toHaveLength(1);
    expect(userEntries[0]?.parts[0]).toMatchObject({ type: 'text', text: 'Hello immediately.' });
  });

  it('hydrates images in the turn-completed history refresh', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    mock.adapter.readFile = vi.fn().mockResolvedValue({ dataBase64: 'AA==' });
    mock.adapter.readThread = vi.fn().mockResolvedValue({ thread: { id: 'thr_existing', turns: [{ id: 'turn_img', items: [{ id: 'shot', type: 'imageView', path: '/tmp/shot.png' }] }] } });
    mock.emit({ method: 'turn/completed', params: { threadId: 'thr_existing', turn: { id: 'turn_img', status: 'completed' } } });
    await vi.waitFor(() => expect(api.canonicalHistory.value.flatMap(e => e.parts)).toContainEqual(expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' })));
    api.disconnect();
  });

  it('hydrates a realtime agent image before publishing its local path', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const read = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => read.promise);
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_img', item: { id: 'shot', type: 'imageView', path: '/tmp/shot.png' } } });
    expect(api.realtimeHistoryQueue.value.flatMap(e => e.parts).filter(p => p.type === 'file')).toHaveLength(0);
    read.resolve({ dataBase64: 'AA==' });
    await vi.waitFor(() => expect(api.realtimeHistoryQueue.value.flatMap(e => e.parts)).toContainEqual(expect.objectContaining({ type: 'file', url: 'data:image/png;base64,AA==' })));
    api.disconnect();
  });

  it('ignores realtime image reads after a thread switch', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    const read = deferred<{ dataBase64: string }>();
    mock.adapter.readFile = vi.fn(() => read.promise);
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_img', item: { id: 'shot', type: 'imageView', path: '/tmp/shot.png' } } });
    await api.selectThread('thr_other');
    read.resolve({ dataBase64: 'AA==' });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.realtimeHistoryQueue.value.flatMap(e => e.parts).filter(p => p.type === 'file')).toHaveLength(0);
    api.disconnect();
  });

  it('retains the sent image preview when the echoed local file cannot be read', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Look', { input: [{ type: 'image', url: 'data:image/png;base64,AA==' }] });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    mock.adapter.readFile = vi.fn().mockRejectedValue(new Error('File temporarily unavailable'));
    mock.emit({ method: 'item/completed', params: { threadId: 'thr_existing', turnId: 'turn_1', item: { id: 'echo', clientId, type: 'userMessage', content: [{ type: 'localImage', path: '/tmp/upload.png' }] } } });
    await new Promise(resolve => setTimeout(resolve, 0));
    expect(api.realtimeHistoryQueue.value.flatMap(e => e.parts).filter(p => p.type === 'file')).toEqual([expect.objectContaining({ url: 'data:image/png;base64,AA==' })]);
    api.disconnect();
  });

  it.each(['image', 'localImage'])('keeps sent images single when echoed as %s', async (kind) => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Look', { input: [{ type: 'text', text: 'Look' }, { type: 'image', url: 'data:image/png;base64,AA==' }, { type: 'image', url: 'data:image/png;base64,AA==' }] });
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const initial = api.realtimeHistoryQueue.value.find(e => e.info.role === 'user')?.parts.filter(p => p.type === 'file');
    expect(initial).toHaveLength(2);
    mock.emit({ method: 'item/completed', params: { threadId: api.activeThreadId.value, turnId: 'turn_1', item: { type: 'userMessage', id: 'echo', clientId, content: [{ type: 'text', text: 'Look' }, ...[0, 1].map(i => kind === 'image' ? { type: 'image', url: 'data:image/png;base64,AA==' } : { type: 'localImage', path: '/tmp/sent-' + i + '.png' })] } } });
    const files = api.realtimeHistoryQueue.value.find(e => e.info.role === 'user')?.parts.filter(p => p.type === 'file');
    expect(files).toHaveLength(2);
    expect(files?.map(p => p.id)).toEqual(initial?.map(p => p.id));
    expect(mock.adapter.sendPrompt).toHaveBeenCalledTimes(1);
    api.disconnect();
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
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;

    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('turn_old:')),
    ).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.startsWith('pending-turn:')),
    ).toBe(true);
    expect(
      api.realtimeHistoryQueue.value.find((entry) => entry.info.role === 'user')?.info.id,
    ).toBe(`turn_2:user:${clientId}`);
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
    mock.adapter.sendPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<CodexPromptResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Race test.');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;
    const userId = `turn_race:user:${clientId}`;
    mock.emit({ method: 'item/agentMessage/delta', params: { delta: 'Early' } });
    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_race', status: 'inProgress' },
    });
    await pendingSend;

    const userEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'user',
    );
    expect(userEntries).toHaveLength(1);
    expect(userEntries[0]?.info.id).toBe(userId);
    expect(userEntries[0]?.parts[0]).toMatchObject({
      id: `${userId}:text`,
      text: 'Race test.',
    });
    expect(userEntries.some((entry) => entry.info.id.includes('pending-turn:'))).toBe(false);
    expect(Object.values(api.realtimeMessageAliases.value)).toContain(userId);
  });

  it('keeps successive streamed assistant items independently through completion', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Multiple replies');
    for (const [itemId, text] of [['a1', 'First reply'], ['a2', 'Second reply']]) {
      mock.emit({ method: 'item/agentMessage/delta', params: { itemId, turnId: 'turn_1', delta: text } });
      expect(api.realtimeStreamingPart.value?.part.text).toBe(text);
      mock.emit({ method: 'item/completed', params: { turnId: 'turn_1', item: { id: itemId, type: 'agentMessage', text } } });
    }
    const replies = api.realtimeHistoryQueue.value.flatMap(entry => entry.parts).filter(part => part.type === 'text' && part.text.endsWith('reply'));
    expect(replies.map(part => part.type === 'text' ? part.text : '')).toEqual(['First reply', 'Second reply']);
    expect(new Set(replies.map(part => part.messageID)).size).toBe(2);
    mock.emit({ method: 'item/completed', params: { turnId: 'turn_1', item: { id: 'a1', type: 'agentMessage', text: 'First reply amended' } } });
    expect(api.realtimeStreamingPart.value?.part.text).toBe('Second reply');
    expect(api.transcript.value.filter(entry => entry.role === 'assistant').slice(-2).map(entry => entry.text)).toEqual(['First reply amended', 'Second reply']);
  });

  it('updates realtimeStreamingPart on agent message deltas', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Stream test.');

    expect(api.realtimeStreamingPart.value).toBeNull();

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

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'assistant',
    );
    expect(assistantEntries).toHaveLength(1);
    const textParts = assistantEntries[0]?.parts.filter((part) => part.type === 'text') ?? [];
    expect(textParts).toHaveLength(1);
    expect(textParts[0]?.id).toBe('turn_1:assistant:agent-1:text');
    expect(textParts[0]).toMatchObject({ messageID: 'turn_1:assistant:agent-1', text: 'Hello, world!' });
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
      params: {
        item: {
          id: 'cmd-1',
          type: 'commandExecution',
          command: ['ls'],
          cwd: '/repo',
          aggregatedOutput: 'file.txt',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'agent-1', type: 'agentMessage', text: 'Done' } },
    });

    const assistantEntries = api.realtimeHistoryQueue.value.filter(
      (entry) => entry.info.role === 'assistant',
    );
    expect(assistantEntries).toHaveLength(2);
    expect(assistantEntries[0]?.parts.some((part) => part.type === 'tool')).toBe(true);
    expect(
      assistantEntries[1]?.parts.some(
        (part) => part.type === 'text' && 'text' in part && part.text === 'Done',
      ),
    ).toBe(true);
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

  it('keeps summary and raw reasoning separate and displays the summary with separators', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Interleave reasoning.');

    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'summary one' },
    });
    mock.emit({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'raw one' },
    });
    mock.emit({
      method: 'item/reasoning/summaryPartAdded',
      params: { itemId: 'reasoning-interleaved' },
    });
    mock.emit({
      method: 'item/reasoning/textDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'raw two' },
    });
    mock.emit({
      method: 'item/reasoning/summaryTextDelta',
      params: { itemId: 'reasoning-interleaved', delta: 'summary two' },
    });

    expect(api.reasoningStreams.value['reasoning-interleaved']).toEqual({
      summary: 'summary one\n---\nsummary two',
      raw: 'raw oneraw two',
    });
    expect(api.realtimeReasoningPart.value?.part).toMatchObject({
      id: 'reasoning-interleaved',
      text: 'summary one\n---\nsummary two',
      sessionID: 'thr_existing',
      type: 'reasoning',
    });
    expect(api.realtimeReasoningPart.value?.info.role).toBe('assistant');
  });

  it('keeps thread-goal set and clear as distinct guarded mutations and results', async () => {
    const mock = createAdapterMock();
    const goal = {
      threadId: 'thr_existing',
      objective: 'Ship the change',
      status: 'active' as const,
      tokenBudget: null,
      tokensUsed: 1,
      timeUsedSeconds: 2,
      createdAt: 3,
      updatedAt: 4,
    };
    mock.adapter.getThreadGoal = vi.fn().mockResolvedValue({ goal });
    mock.adapter.setThreadGoal = vi.fn().mockResolvedValue({ goal });
    mock.adapter.clearThreadGoal = vi.fn().mockResolvedValue({ cleared: true });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.refreshThreadGoal();
    await expect(api.setThreadGoal({ objective: 'Ship the change' })).resolves.toEqual({ goal });
    await expect(api.clearThreadGoal()).resolves.toEqual({ cleared: true });

    expect(mock.adapter.setThreadGoal).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      objective: 'Ship the change',
    });
    expect(mock.adapter.clearThreadGoal).toHaveBeenCalledWith({ threadId: 'thr_existing' });
    expect(api.threadGoal.value).toBeNull();
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

    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'cmd-1', delta: 'running output' },
    });
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
    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'cmd-1'),
    );
    expect(toolEntry).toBeDefined();
    const toolPart = toolEntry?.parts.find((part) => part.id === 'cmd-1');
    expect(toolPart).toMatchObject({ type: 'tool', state: { status: 'completed' } });
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: { output: 'running outputfinal output' },
    });
  });

  it('falls back to running output while preserving finalized title and metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete a tool with streamed output.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-fallback',
          type: 'commandExecution',
          command: ['printf', 'ok'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'cmd-fallback', delta: 'streamed output' },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-fallback',
          type: 'commandExecution',
          command: ['printf', 'ok'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'cmd-fallback');
    expect(toolPart).toMatchObject({
      type: 'tool',
      tool: 'bash',
      state: {
        status: 'completed',
        output: 'streamed output',
        title: 'printf ok',
        metadata: { source: 'codex', codexStatus: 'completed' },
      },
    });
  });

  it('uses running title and metadata when a completed item has no canonical tool part', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Complete a forward-compatible tool.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'future-tool',
          type: 'commandExecution',
          command: ['echo', 'fallback'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'future-tool',
          type: 'futureTool',
          status: 'completed',
          aggregatedOutput: 'future output',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'future-tool');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'completed',
        output: 'future output',
        title: 'echo fallback',
        metadata: { source: 'codex', codexStatus: 'completed' },
      },
    });
  });

  it('preserves failed and declined status when completion has no canonical tool part', async () => {
    // Given: both tools are running, but completion uses an unknown item type.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Complete tools without canonical parts.');

    for (const id of ['future-failed', 'future-declined'] as const) {
      mock.emit({
        method: 'item/started',
        params: {
          item: { id, type: 'commandExecution', command: ['echo', id], cwd: '/repo' },
        },
      });
    }

    // When: the server reports terminal failures that the normalizer does not know yet.
    for (const [id, status] of [
      ['future-failed', 'failed'],
      ['future-declined', 'declined'],
    ] as const) {
      mock.emit({
        method: 'item/completed',
        params: { item: { id, type: 'futureTool', status } },
      });
    }

    // Then: the running record still becomes an error with the wire status preserved.
    for (const [id, status] of [
      ['future-failed', 'failed'],
      ['future-declined', 'declined'],
    ] as const) {
      const toolPart = api.realtimeHistoryQueue.value
        .flatMap((entry) => entry.parts)
        .find((part) => part.id === id);
      expect(toolPart).toMatchObject({
        type: 'tool',
        state: { status: 'error', error: status, metadata: { codexStatus: status } },
      });
    }
  });

  it('keeps default error and live-completed metadata fallbacks on the public path', async () => {
    // Given: a live completed record without metadata and a live error record without metadata.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise terminal fallbacks.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'live-completed',
          type: 'commandExecution',
          command: ['echo', 'live'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'live-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
        },
      },
    });

    const liveCompleted = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'live-completed',
    );
    const liveError = api.realtimeToolParts.value.find((entry) => entry.part.id === 'live-error');
    if (!liveCompleted || !liveError) throw new Error('Expected live tool records');
    const completedState = {
      status: 'completed',
      input: {},
      output: 'live output',
      title: 'live title',
      metadata: { source: 'codex' },
      time: { start: 1, end: 2 },
    } satisfies Extract<typeof liveCompleted.part.state, { status: 'completed' }>;
    const errorState = {
      status: 'error',
      input: {},
      error: '',
      metadata: { source: 'codex' },
      time: { start: 1, end: 2 },
    } satisfies Extract<typeof liveError.part.state, { status: 'error' }>;
    Reflect.deleteProperty(completedState, 'metadata');
    Reflect.deleteProperty(errorState, 'metadata');
    api.realtimeToolParts.value = [
      { ...liveCompleted, part: { ...liveCompleted.part, state: completedState } },
      { ...liveError, part: { ...liveError.part, state: errorState } },
    ];

    // When: completion arrives without a canonical part, output, or wire status.
    for (const id of ['live-completed', 'live-error'] as const) {
      mock.emit({ method: 'item/completed', params: { item: { id, type: 'futureTool' } } });
    }

    // Then: completed metadata uses the source fallback and errors use the default message.
    const parts = api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(parts.find((part) => part.id === 'live-completed')).toMatchObject({
      state: {
        status: 'completed',
        output: 'live output',
        title: 'live title',
        metadata: { source: 'codex' },
      },
    });
    expect(parts.find((part) => part.id === 'live-error')).toMatchObject({
      state: { status: 'error', error: 'Codex tool failed', metadata: { source: 'codex' } },
    });
  });

  it('uses safe public completion fallbacks for absent and malformed running metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise running metadata fallbacks.');

    for (const id of ['missing-running-metadata', 'malformed-running-metadata'] as const) {
      mock.emit({
        method: 'item/started',
        params: { item: { id, type: 'commandExecution', command: ['echo', id], cwd: '/repo' } },
      });
    }
    const missing = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'missing-running-metadata',
    );
    const malformed = api.realtimeToolParts.value.find(
      (entry) => entry.part.id === 'malformed-running-metadata',
    );
    if (
      !missing ||
      !malformed ||
      missing.part.state.status !== 'running' ||
      malformed.part.state.status !== 'running'
    ) {
      throw new Error('Expected running tool records');
    }
    const missingState = { ...missing.part.state };
    Reflect.deleteProperty(missingState, 'metadata');
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === missing.part.id
        ? { ...entry, part: { ...entry.part, state: missingState } }
        : entry.part.id === malformed.part.id
          ? {
              ...entry,
              part: {
                ...entry.part,
                state: {
                  ...entry.part.state,
                  metadata: { output: 42, codexStatus: { bad: true } },
                },
              },
            }
          : entry,
    );

    for (const id of ['missing-running-metadata', 'malformed-running-metadata'] as const) {
      mock.emit({ method: 'item/completed', params: { item: { id, type: 'futureTool' } } });
    }

    const parts = api.realtimeHistoryQueue.value.flatMap((entry) => entry.parts);
    expect(parts.find((part) => part.id === 'missing-running-metadata')).toMatchObject({
      state: { status: 'completed', output: '', metadata: { source: 'codex' } },
    });
    expect(parts.find((part) => part.id === 'malformed-running-metadata')).toMatchObject({
      state: {
        status: 'completed',
        output: '',
        metadata: { output: 42, codexStatus: { bad: true } },
      },
    });
  });

  it('falls back to completion time and empty output for pending public tool state', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Exercise pending completion fallback.');
    mock.emit({
      method: 'item/started',
      params: {
        item: { id: 'pending-tool', type: 'commandExecution', command: ['echo', 'pending'] },
      },
    });
    const pending = api.realtimeToolParts.value.find((entry) => entry.part.id === 'pending-tool');
    if (!pending) throw new Error('Expected pending tool record');
    const pendingState = {
      status: 'pending',
      input: pending.part.state.input,
      raw: 'pending',
    } satisfies ToolStatePending;
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === 'pending-tool'
        ? { ...entry, part: { ...entry.part, state: pendingState } }
        : entry,
    );

    mock.emit({
      method: 'item/completed',
      params: { item: { id: 'pending-tool', type: 'futureTool' } },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'pending-tool');
    expect(toolPart).toMatchObject({
      state: {
        status: 'completed',
        output: '',
        title: 'bash',
        time: { start: expect.any(Number) },
      },
    });
  });

  it('replaces streamed command output with finalized output from the alternate delta method', async () => {
    // Given: a command is running and streams through item/commandExecution/outputDelta.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize command output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'command-delta',
          type: 'commandExecution',
          command: ['echo', 'ok'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/commandExecution/outputDelta',
      params: { itemId: 'command-delta', delta: 'streamed command output' },
    });

    // When: the finalized item supplies canonical output without aggregatedOutput.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'command-delta',
          type: 'commandExecution',
          command: ['echo', 'ok'],
          cwd: '/repo',
          status: 'completed',
          output: 'canonical command output',
        },
      },
    });

    // Then: canonical output replaces the streamed fallback.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'command-delta');
    expect(toolPart).toMatchObject({
      state: { status: 'completed', output: 'canonical command output' },
    });
  });

  it('replaces streamed file output from item/fileChange/outputDelta', async () => {
    // Given: a file change is running and streams through its item-specific delta method.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize file output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'file-delta',
          type: 'fileChange',
          changes: [{ path: 'example.ts', diff: '' }],
        },
      },
    });
    mock.emit({
      method: 'item/fileChange/outputDelta',
      params: { itemId: 'file-delta', delta: 'streamed file output' },
    });

    // When: the finalized file change supplies its canonical diff.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'file-delta',
          type: 'fileChange',
          status: 'completed',
          changes: [{ path: 'example.ts', diff: 'canonical file output' }],
        },
      },
    });

    // Then: canonical file output replaces streamed output and metadata follows it.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'file-delta');
    expect(toolPart).toMatchObject({
      state: {
        status: 'completed',
        output: 'canonical file output',
        metadata: { filediff: { patch: 'canonical file output' } },
      },
    });
  });

  it('prefers finalized title over the running title', async () => {
    // Given: a running command has an initial title.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Finalize the command title.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'title-final',
          type: 'commandExecution',
          command: ['echo', 'running'],
          cwd: '/repo',
        },
      },
    });

    // When: completion supplies a different canonical command title.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'title-final',
          type: 'commandExecution',
          command: ['echo', 'finalized'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    // Then: the finalized title wins.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'title-final');
    expect(toolPart).toMatchObject({ state: { status: 'completed', title: 'echo finalized' } });
  });

  it('uses finalized input in the error branch', async () => {
    // Given: a file change is running with an initial input path.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Fail a file change.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'input-error',
          type: 'fileChange',
          changes: [{ path: 'started.ts', diff: '' }],
        },
      },
    });

    // When: the failed completion supplies its final input path.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'input-error',
          type: 'fileChange',
          status: 'failed',
          changes: [{ path: 'final.ts', diff: '' }],
        },
      },
    });

    // Then: error state input comes from the finalized part.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'input-error');
    expect(toolPart).toMatchObject({
      state: { status: 'error', input: { files: ['final.ts'], filePath: 'final.ts' } },
    });
  });

  it('concatenates streamed and finalized output before applying error status', async () => {
    // Given: streamed output is attached to a running command with a failed wire status.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Fail after streamed output.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'output-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'command/exec/outputDelta',
      params: { callId: 'output-error', delta: 'streamed error output' },
    });
    const running = api.realtimeToolParts.value.find((entry) => entry.part.id === 'output-error');
    if (!running || running.part.state.status !== 'running')
      throw new Error('Expected running tool');
    const runningState = running.part.state;
    api.realtimeToolParts.value = api.realtimeToolParts.value.map((entry) =>
      entry.part.id === 'output-error'
        ? {
            ...entry,
            part: {
              ...entry.part,
              state: {
                ...runningState,
                metadata: { ...runningState.metadata, codexStatus: 'failed' },
              },
            },
          }
        : entry,
    );

    // When: completion supplies finalized output without a status field.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'output-error',
          type: 'commandExecution',
          command: ['echo', 'error'],
          cwd: '/repo',
          aggregatedOutput: 'finalized error output',
        },
      },
    });

    // Then: the error message preserves the same output precedence as success.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'output-error');
    expect(toolPart).toMatchObject({
      state: { status: 'error', error: 'streamed error outputfinalized error output' },
    });
  });

  it('preserves the running time.start through completion', async () => {
    // Given: a running command with an observable start time.
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.sendPrompt('Preserve tool timing.');
    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'time-start',
          type: 'commandExecution',
          command: ['echo', 'time'],
          cwd: '/repo',
        },
      },
    });
    const running = api.realtimeToolParts.value.find((entry) => entry.part.id === 'time-start');
    if (!running || running.part.state.status !== 'running')
      throw new Error('Expected running tool');
    const start = running.part.state.time.start;

    // When: the command completes normally.
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'time-start',
          type: 'commandExecution',
          command: ['echo', 'time'],
          cwd: '/repo',
          status: 'completed',
        },
      },
    });

    // Then: completion keeps the original start timestamp.
    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'time-start');
    expect(toolPart).toMatchObject({ state: { status: 'completed', time: { start } } });
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
      const cached = storageGetJSON<{ entries?: Array<{ parts?: Array<{ id?: string }> }> }>(
        cacheKey,
      );
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

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'web-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'web-1');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'error',
        error: 'Query: vite docs',
        metadata: { source: 'codex', codexStatus: 'failed' },
      },
    });
    expect(api.realtimeToolParts.value).toHaveLength(0);
  });

  it('maps declined tool completion to error state with the wire status metadata', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    await api.sendPrompt('Decline a tool.');

    mock.emit({
      method: 'item/started',
      params: {
        item: {
          id: 'cmd-declined',
          type: 'commandExecution',
          command: ['rm', '-rf', '/tmp/example'],
          cwd: '/repo',
        },
      },
    });
    mock.emit({
      method: 'item/completed',
      params: {
        item: {
          id: 'cmd-declined',
          type: 'commandExecution',
          command: ['rm', '-rf', '/tmp/example'],
          cwd: '/repo',
          status: 'declined',
        },
      },
    });

    const toolPart = api.realtimeHistoryQueue.value
      .flatMap((entry) => entry.parts)
      .find((part) => part.id === 'cmd-declined');
    expect(toolPart).toMatchObject({
      type: 'tool',
      state: {
        status: 'error',
        error: 'declined',
        metadata: { source: 'codex', codexStatus: 'declined' },
      },
    });
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

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-started-1'),
    );
    const toolPart = toolEntry?.parts.find((part) => part.id === 'edit-started-1');
    const expectedPatch =
      '## File changed\n\nPath: empty.ts\n\nStatus: completed\n\n(Codex did not provide a unified diff.)';
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

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'web-started-1'),
    );
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

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-1'),
    );
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

    const toolEntry = api.realtimeHistoryQueue.value.find((entry) =>
      entry.parts.some((part) => part.id === 'edit-2'),
    );
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
    mock.adapter.sendPrompt = vi.fn().mockImplementation(
      () =>
        new Promise<CodexPromptResult>((resolve) => {
          resolveSend = resolve;
        }),
    );
    const api = useCodexApi({ adapterFactory: () => mock.adapter });

    await api.connect();
    const pendingSend = api.sendPrompt('Pending thread switch');
    const clientId = vi.mocked(mock.adapter.sendPrompt).mock.lastCall?.[0].clientUserMessageId;

    expect(
      api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:')),
    ).toBe(true);

    await api.selectThread('thr_existing');

    expect(
      api.realtimeHistoryQueue.value.some((entry) => entry.info.id.includes('pending-turn:')),
    ).toBe(false);
    expect(
      Object.keys(api.realtimeMessageAliases.value).some((key) => key.includes('pending-turn:')),
    ).toBe(false);

    expect(resolveSend).not.toBeNull();
    resolveSend!({
      threadId: 'thr_existing',
      turn: { id: 'turn_after_switch', status: 'inProgress' },
    });
    await pendingSend;

    expect(
      api.realtimeHistoryQueue.value.some((entry) => entry.info.id === `turn_after_switch:user:${clientId}`),
    ).toBe(false);
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
    expect(api.collaborationModesError.value).toBe('method not found');
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

  it('clears collaboration mode state when disconnected', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.adapter.listCollaborationModes = vi
      .fn()
      .mockResolvedValue({
        data: [{ name: 'Plan', mode: 'plan', model: null, reasoningEffort: null }],
      });
    await api.refreshCollaborationModes();

    api.disconnectTransport();

    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesLoading.value).toBe(false);
    expect(api.collaborationModesError.value).toBeNull();
  });

  it.each([false, true])(
    'ignores a late collaboration failure after a newer refresh (reconnect=%s)',
    async (reconnect) => {
      const mock = createAdapterMock();
      const api = useCodexApi({ adapterFactory: () => mock.adapter });
      await api.connect();
      await api.refreshCollaborationModes();
      const stale = deferred<void>();
      mock.adapter.listCollaborationModes = vi.fn(async () => {
        await stale.promise;
        throw new Error('stale failure');
      });
      const refresh = api.refreshCollaborationModes();
      const modes = [{ name: 'Plan', mode: 'plan', model: null, reasoningEffort: null }];
      mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: modes });
      if (reconnect) await api.connect();
      await api.refreshCollaborationModes();

      stale.resolve();
      await refresh;

      expect(api.collaborationModes.value).toEqual(modes);
      expect(api.collaborationModesError.value).toBeNull();
    },
  );

  it('clears collaboration errors after a successful empty response', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => {});
    mock.adapter.listCollaborationModes = vi.fn().mockRejectedValue(new Error('failed'));
    await api.refreshCollaborationModes();
    mock.adapter.listCollaborationModes = vi.fn().mockResolvedValue({ data: [] });

    await api.refreshCollaborationModes();

    expect(api.collaborationModes.value).toEqual([]);
    expect(api.collaborationModesError.value).toBeNull();
    warnSpy.mockRestore();
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
      mock.adapter.listThreads = vi
        .fn()
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
      mock.adapter.listThreads = vi
        .fn()
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
      mock.adapter.listThreads = vi
        .fn()
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
      mock.adapter.listThreads = vi
        .fn()
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
      mock.adapter.listThreads = vi
        .fn()
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'openai',
              createdAt: 900,
              updatedAt: 950,
            },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'openai',
              createdAt: 1,
              updatedAt: 2,
            },
          ],
          nextCursor: null,
        })
        .mockResolvedValueOnce({
          data: [
            {
              id: 'thr_shared',
              preview: 'Shared',
              modelProvider: 'omniroute',
              createdAt: 100,
              updatedAt: 200,
            },
          ],
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

      api.replyElicitationRequest('codex-elicitation:string:elicitation-1', 'accept', {
        region: 'eu',
      });

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
      mock.emit({
        method: 'serverRequest/resolved',
        params: { requestId: 'elicitation-resolved' },
      });

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
          questions: [
            {
              id: 'target',
              header: 'Deployment target',
              question: 'Where should this deploy?',
              isOther: true,
              isSecret: true,
              options: [{ label: 'staging', description: 'Staging environment' }],
            },
          ],
        },
      });

      expect(api.toolUserInputRequests.value).toEqual([
        {
          requestId: 'tool-input',
          itemId: 'item-1',
          threadId: 'thr_existing',
          turnId: 'turn_1',
          questions: [
            {
              id: 'target',
              header: 'Deployment target',
              text: 'Where should this deploy?',
              isOther: true,
              isSecret: true,
              options: [{ label: 'staging', description: 'Staging environment' }],
            },
          ],
        },
      ]);

      await api.respondToToolUserInput('tool-input', [
        { questionId: 'target', response: 'staging' },
      ]);

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

      expect(api.dynamicToolCalls.value).toEqual([
        {
          requestId: 9,
          callId: 'call-1',
          namespace: 'vis',
          toolName: 'deploy',
          arguments: { target: 'staging' },
          threadId: 'thr_existing',
          turnId: 'turn_1',
        },
      ]);

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
