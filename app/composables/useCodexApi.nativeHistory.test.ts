import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import { normalizeCodexTurnsToHistory } from '../backends/codex/normalize';
import { createAdapterMock, deferred, resetCodexApiTestState } from './useCodexApi.test-helpers';
import { useCodexApi } from './useCodexApi';

const storage = vi.hoisted(() => ({
  initialize: vi.fn<(threadId?: string) => Promise<void>>(),
  cached: new Map<string, CodexCanonicalHistoryEntry[]>(),
  listeners: new Set<(threadId: string) => void>(),
  load: vi.fn<(threadId: string) => CodexCanonicalHistoryEntry[]>(),
  save: vi.fn(),
}));

vi.mock('../backends/codex/auxiliaryStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../backends/codex/auxiliaryStorage')>(),
  initializeCodexAuxiliaryStorage: storage.initialize,
}));
vi.mock('../backends/codex/nativeAuxiliaryStorage', async (importOriginal) => ({
  ...await importOriginal<typeof import('../backends/codex/nativeAuxiliaryStorage')>(),
  nativeAuxiliaryDatabase: () => ({}),
  onNativeAuxiliaryHistoryChanged: (listener: (threadId: string) => void) => {
    storage.listeners.add(listener);
    return () => storage.listeners.delete(listener);
  },
}));
vi.mock('../backends/codex/auxiliaryHistory', async (importOriginal) => ({
  ...await importOriginal<typeof import('../backends/codex/auxiliaryHistory')>(),
  loadCodexAuxiliaryHistory: storage.load,
  saveCodexAuxiliaryHistory: storage.save,
}));

const instances: ReturnType<typeof useCodexApi>[] = [];

function setup() {
  const mock = createAdapterMock();
  const api = useCodexApi({ adapterFactory: () => mock.adapter });
  instances.push(api);
  return { api, mock };
}

function history(threadId: string, id: string): CodexCanonicalHistoryEntry[] {
  return normalizeCodexTurnsToHistory({
    sessionId: threadId,
    turns: [{ id: 'turn_old', createdAt: 100, items: [
      { id: 'u1', type: 'userMessage', content: [{ type: 'text', text: 'prompt' }] },
      { id, type: 'commandExecution', command: 'ls', status: 'completed', aggregatedOutput: id },
    ] }],
  }).filter(entry => entry.info.role === 'assistant');
}

function partIds(api: ReturnType<typeof useCodexApi>) {
  return api.realtimeHistoryQueue.value.flatMap(entry => entry.parts.map(part => part.id));
}

beforeEach(() => {
  resetCodexApiTestState();
  storage.cached.clear();
  storage.listeners.clear();
  storage.initialize.mockImplementation(async () => {});
  storage.load.mockImplementation(threadId => storage.cached.get(threadId) ?? []);
});

afterEach(() => {
  for (const api of instances.splice(0)) api.disconnect();
});

describe('Codex native auxiliary history integration', () => {
  it('waits for selected thread hydration before restoring cached history', async () => {
    const hydration = deferred<void>();
    storage.initialize.mockImplementation(threadId => threadId ? hydration.promise : Promise.resolve());
    const { api, mock } = setup();
    await api.connect();
    const selecting = api.selectThread('thread-a');
    await vi.waitFor(() => expect(mock.adapter.readThread).toHaveBeenCalled());
    expect(storage.initialize).toHaveBeenCalledWith('thread-a');
    expect(api.loadingThread.value).toBe(true);
    expect(storage.load).not.toHaveBeenCalled();

    storage.cached.set('thread-a', history('thread-a', 'cached-tool'));
    hydration.resolve();
    await selecting;
    expect(partIds(api)).toEqual(['cached-tool']);
    expect(api.loadingThread.value).toBe(false);
  });

  it('retains live tool and answer completions received while hydration is pending', async () => {
    const hydration = deferred<void>();
    storage.initialize.mockImplementation(threadId => threadId ? hydration.promise : Promise.resolve());
    const { api, mock } = setup();
    await api.connect();
    const selecting = api.selectThread('thread-a');
    await vi.waitFor(() => expect(mock.adapter.readThread).toHaveBeenCalled());
    for (const item of [
      { id: 'live-tool', type: 'commandExecution', command: 'pwd', status: 'completed', aggregatedOutput: 'live' },
      { id: 'live-answer', type: 'agentMessage', text: 'live answer' },
    ]) mock.emit({ method: 'item/completed', params: { threadId: 'thread-a', turnId: 'turn_old', item } });
    storage.cached.set('thread-a', history('thread-a', 'cached-tool'));
    hydration.resolve();
    await selecting;
    expect(partIds(api)).toEqual(expect.arrayContaining(['cached-tool', 'live-tool', 'turn_old:assistant:live-answer:text']));
  });

  it('does not publish an obsolete selection when its hydration completes last', async () => {
    const hydrationA = deferred<void>();
    storage.initialize.mockImplementation(threadId => threadId === 'thread-a' ? hydrationA.promise : Promise.resolve());
    const { api } = setup();
    await api.connect();
    const selectingA = api.selectThread('thread-a');
    await vi.waitFor(() => expect(storage.initialize).toHaveBeenCalledWith('thread-a'));
    storage.cached.set('thread-b', history('thread-b', 'tool-b'));
    await api.selectThread('thread-b');
    storage.cached.set('thread-a', history('thread-a', 'tool-a'));
    hydrationA.resolve();
    await selectingA;
    expect(api.activeThreadId.value).toBe('thread-b');
    expect(partIds(api)).toEqual(['tool-b']);
    expect(api.canonicalHistory.value.every(entry => entry.info.sessionID === 'thread-b')).toBe(true);
  });

  it('restores remote hydrated changes only for the selected current connection and unsubscribes', async () => {
    const { api, mock } = setup();
    await api.connect();
    await api.selectThread('thread-a');
    expect(storage.listeners.size).toBe(1);
    const listener = [...storage.listeners][0];
    if (!listener) throw new Error('Native invalidation listener was not registered');
    storage.cached.set('thread-b', history('thread-b', 'unselected-tool'));
    listener('thread-b');
    expect(partIds(api)).toEqual([]);
    storage.cached.set('thread-a', history('thread-a', 'remote-tool'));
    listener('thread-a');
    expect(partIds(api)).toEqual(['remote-tool']);

    mock.emit({ method: 'item/completed', params: {
      threadId: 'thread-a', turnId: 'turn_old',
      item: { id: 'live-answer', type: 'agentMessage', text: 'Keep this answer' },
    } });
    storage.cached.set('thread-a', []);
    listener('thread-a');
    expect(partIds(api)).toEqual(['turn_old:assistant:live-answer:text']);

    api.disconnect();
    expect(storage.listeners.size).toBe(0);
    storage.cached.set('thread-a', history('thread-a', 'stale-connection-tool'));
    listener('thread-a');
    expect(partIds(api)).toEqual(['turn_old:assistant:live-answer:text']);
  });

  it('appends background native completion without reading the entire cached history', async () => {
    const { api, mock } = setup();
    await api.connect();
    await api.selectThread('thread-a');
    storage.load.mockClear();
    storage.save.mockClear();
    mock.emit({ method: 'item/completed', params: {
      threadId: 'thread-b', turnId: 'turn-b',
      item: { id: 'new-tool', type: 'commandExecution', command: 'pwd', status: 'completed' },
    } });
    expect(storage.load).not.toHaveBeenCalled();
    expect(storage.save).toHaveBeenCalledWith('thread-b', [expect.objectContaining({
      parts: [expect.objectContaining({ id: 'new-tool' })],
    })]);
  });
});
