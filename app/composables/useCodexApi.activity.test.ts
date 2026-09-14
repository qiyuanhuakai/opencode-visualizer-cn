import { beforeEach, describe, expect, it, vi } from 'vitest';
import { useCodexApi } from './useCodexApi';
import { useCodexWorkspace } from './useCodexWorkspace';
import type {
  CodexAdapter,
  CodexPromptResult,
  CodexThreadListResult,
} from '../backends/codex/codexAdapter';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';

describe('useCodexApi', () => {
  beforeEach(resetCodexApiTestState);

  it('restores the running turn and interrupt target when selecting an active thread after refresh', async () => {
    const mock = createAdapterMock();
    const turn = { id: 'restored-turn', status: 'inProgress', items: [] };
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: { id: 'thr_existing', turns: [turn] },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    await api.selectThread('thr_existing');
    expect(api.activeTurn.value).toEqual(turn);
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thr_existing', status: 'active' },
    });
    await api.interruptActiveTurn();
    expect(mock.adapter.interruptTurn).toHaveBeenCalledWith({
      threadId: 'thr_existing',
      turnId: 'restored-turn',
    });
    expect(
      useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status,
    ).toBe('idle');
  });

  it('restores the latest running turn returned by resume', async () => {
    const mock = createAdapterMock();
    const turn = { id: 'resumed-turn', status: 'inProgress', items: [] };
    vi.mocked(mock.adapter.resumeThread).mockResolvedValue({
      thread: { id: 'thr_existing', turns: [turn] },
    });
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
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: { id: 'thr_existing', turns: [turn] },
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const selecting = api.selectThread('thr_existing');
    await vi.waitFor(() => expect(mock.adapter.resumeThread).toHaveBeenCalled());
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { ...turn, status: 'completed' } },
    });
    reply.resolve({ thread: { id: 'thr_existing', turns: [turn] } });
    await selecting;
    expect(api.activeTurn.value?.status).toBe('completed');
  });

  it('does not restore a historical completed turn as active', async () => {
    const mock = createAdapterMock();
    vi.mocked(mock.adapter.readThread).mockResolvedValue({
      thread: { id: 'thr_existing', turns: [{ id: 'past', status: 'completed', items: [] }] },
    });
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
    reply.resolve({
      thread: {
        id: 'thr_existing',
        turns: [{ id: 'older-turn', status: 'inProgress', items: [] }],
      },
    });
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
    reply.resolve({
      thread: {
        id: 'thr_existing',
        turns: [{ id: 'stale-turn', status: 'inProgress', items: [] }],
      },
    });
    await firstSelection;
    expect(api.activeThreadId.value).toBe('thr_other');
    expect(api.activeTurn.value).toBeNull();
  });

  it('retains green idle only for participating threads across page reload and isolates connections', async () => {
    const mock = createAdapterMock();
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [
        { id: 'thr_existing', status: { type: 'active' } },
        { id: 'untouched', status: { type: 'idle' } },
      ],
      nextCursor: null,
    });
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect('ws://localhost:9001/codex');
    const workspace = useCodexWorkspace(api);
    const sessions = () => workspace.project.value.sandboxes['/'].sessions;
    expect(sessions()['thr_existing'].status).toBe('busy');
    mock.adapter.listThreads = vi.fn().mockResolvedValue({
      data: [
        { id: 'thr_existing', status: { type: 'idle' } },
        { id: 'untouched', status: { type: 'idle' } },
      ],
      nextCursor: null,
    });
    await api.refreshThreads();
    expect(sessions()['thr_existing'].status).toBe('idle');
    expect(sessions()['untouched'].status).toBe('unknown');
    api.disconnect();
    const restored = useCodexApi({ adapterFactory: () => mock.adapter });
    await restored.connect('ws://localhost:9001/codex');
    expect(
      useCodexWorkspace(restored).project.value.sandboxes['/'].sessions['thr_existing'].status,
    ).toBe('idle');
    await restored.connect('ws://localhost:9002/codex');
    expect(
      useCodexWorkspace(restored).project.value.sandboxes['/'].sessions['thr_existing'].status,
    ).toBe('unknown');
    restored.disconnect();
  });

  it('applies short background activity notifications without waiting for a list refresh', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const workspace = useCodexWorkspace(api);
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'background', status: { type: 'active' } },
    });
    expect(workspace.project.value.sandboxes['/'].sessions['background']?.status).toBe('busy');
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'background', status: { type: 'idle' } },
    });
    expect(workspace.project.value.sandboxes['/'].sessions['background']?.status).toBe('idle');
    api.disconnect();
  });

  it('does not replace a newer idle notification with an older busy list response', async () => {
    const mock = createAdapterMock();
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thr_existing', status: 'active' },
    });
    const listing = deferred<CodexThreadListResult>();
    mock.adapter.listThreads = vi.fn(() => listing.promise);
    const refresh = api.refreshThreads();
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thr_existing', status: 'idle' },
    });
    listing.resolve({ data: [{ id: 'thr_existing', status: 'active' }], nextCursor: null });
    await refresh;
    expect(
      useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status,
    ).toBe('idle');
    api.disconnect();
  });

  it('does not revive completed activity when the send response arrives last', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect();
    const send = api.sendPrompt('Fast turn');
    mock.emit({
      method: 'turn/started',
      params: { threadId: 'thr_existing', turn: { id: 'fast', status: 'inProgress' } },
    });
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'fast', status: 'completed' } },
    });
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'fast', status: 'inProgress' } });
    await send;
    expect(api.activeTurn.value?.status).toBe('completed');
    expect(
      useCodexWorkspace(api).project.value.sandboxes['/'].sessions['thr_existing'].status,
    ).toBe('idle');
    api.disconnect();
  });

  it('does not carry a running thread or a late send into another connection', async () => {
    const mock = createAdapterMock();
    const reply = deferred<CodexPromptResult>();
    mock.adapter.sendPrompt = vi.fn(() => reply.promise);
    const api = useCodexApi({ adapterFactory: () => mock.adapter });
    await api.connect('ws://localhost:9001/codex');
    mock.emit({
      method: 'thread/status/changed',
      params: { threadId: 'thr_existing', status: 'active' },
    });
    const send = api.sendPrompt('Previous connection');
    mock.adapter.listThreads = vi
      .fn()
      .mockResolvedValue({ data: [{ id: 'other', status: 'idle' }], nextCursor: null });
    await api.connect('ws://localhost:9002/codex');
    expect(api.threads.value.map((thread) => thread.id)).toEqual(['other']);
    reply.resolve({ threadId: 'thr_existing', turn: { id: 'late', status: 'inProgress' } });
    await send;
    expect(api.participatedThreadIds.value.size).toBe(0);
    expect(api.activeThreadId.value).toBe('other');
    api.disconnect();
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
    mock.emit({
      method: 'turn/started',
      params: { threadId: 'thr_existing', turn: { id: 'turn-running', status: 'inProgress' } },
    });
    vi.spyOn(mock.adapter, 'interruptTurn').mockRejectedValueOnce(
      new Error('Interruption rejected'),
    );
    await expect(api.interruptActiveTurn()).rejects.toThrow('Interruption rejected');
    expect(api.activeTurn.value?.status).toBe('inProgress');
    mock.emit({
      method: 'turn/completed',
      params: { threadId: 'thr_existing', turn: { id: 'turn-running', status: 'completed' } },
    });
    expect(onTaskCompleted).toHaveBeenCalledExactlyOnceWith({
      sessionId: 'thr_existing',
      completionId: 'turn-running',
    });
  });

  it.each(['new turn', 'new connection'] as const)(
    'does not overwrite a %s with a late interruption response',
    async (mode) => {
      const first = createAdapterMock();
      const second = createAdapterMock();
      const interrupted = deferred<Awaited<ReturnType<CodexAdapter['interruptTurn']>>>();
      vi.spyOn(first.adapter, 'interruptTurn').mockReturnValueOnce(interrupted.promise);
      const onTaskCompleted = vi.fn();
      let connection = 0;
      const api = useCodexApi({
        adapterFactory: () => (connection++ === 0 ? first.adapter : second.adapter),
        onTaskCompleted,
      });
      await api.connect();
      first.emit({
        method: 'turn/started',
        params: { threadId: 'thr_existing', turn: { id: 'turn-shared', status: 'inProgress' } },
      });
      const pendingInterruption = api.interruptActiveTurn();
      if (mode === 'new connection') {
        api.disconnectTransport();
        await api.connect();
      }
      const current = mode === 'new connection' ? second : first;
      const turnId = mode === 'new connection' ? 'turn-shared' : 'turn-new';
      current.emit({
        method: 'turn/started',
        params: { threadId: 'thr_existing', turn: { id: turnId, status: 'inProgress' } },
      });
      interrupted.resolve({});
      await pendingInterruption;
      expect(api.activeTurn.value).toMatchObject({ id: turnId, status: 'inProgress' });
      current.emit({
        method: 'turn/completed',
        params: { threadId: 'thr_existing', turn: { id: turnId, status: 'completed' } },
      });
      expect(onTaskCompleted).toHaveBeenCalledExactlyOnceWith({
        sessionId: 'thr_existing',
        completionId: turnId,
      });
    },
  );

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
});
