import { afterEach, expect, it, vi } from 'vitest';
import type { SessionHistoryPage } from '../../types/sessionDatabase';

afterEach(() => { vi.unstubAllGlobals(); vi.resetModules(); });

function entry(id: string, text = id) {
  return {
    info: { id, sessionID: 'thread', role: 'assistant', parentID: 'user', time: { created: 1 } },
    parts: [{ id: `${id}:part`, messageID: id, sessionID: 'thread', type: 'reasoning', text, time: { start: 1 } }],
  };
}

function fixture() {
  const batches: unknown[][] = [];
  const listeners = new Set<(threadId: string) => void>();
  const database = {
    readHistory: vi.fn<() => Promise<SessionHistoryPage>>(async () => ({ entries: [entry('durable')], nextCursor: null })),
    upsertHistory: vi.fn(async (request: { threadId: string; entries: unknown[] }) => { batches.push(request.entries); }),
    clearHistory: vi.fn(async () => {}),
    flush: vi.fn(async () => {}),
    onHistoryChanged: (listener: (threadId: string) => void) => {
      listeners.add(listener);
      return () => { listeners.delete(listener); };
    },
  };
  const syncRead = vi.fn(() => { throw new Error('history must not use synchronous IPC'); });
  const syncWrite = vi.fn(() => { throw new Error('history must not use synchronous IPC'); });
  vi.stubGlobal('window', { electronAPI: { sessionDatabase: database, persistentStorage: { getItem: syncRead, setItem: syncWrite } } });
  return { database, batches, syncRead, syncWrite, listeners };
}

it('retains earlier native entries when a later save contains only a new completion', async () => {
  const f = fixture();
  const storage = await import('./auxiliaryStorage');
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('first')] });
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('second')] });
  await storage.flushCodexAuxiliaryStorage();
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ version: 1, threadId: 'thread', entries: [entry('first'), entry('second')] });
  expect(f.batches).toEqual([[entry('first')], [entry('second')]]);
  expect(f.syncRead).not.toHaveBeenCalled();
  expect(f.syncWrite).not.toHaveBeenCalled();
});

it('only sends changed native parts when the growing queue is saved again', async () => {
  const f = fixture();
  const storage = await import('./auxiliaryStorage');
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('first')] });
  await storage.flushCodexAuxiliaryStorage();
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('first'), entry('second')] });
  await storage.flushCodexAuxiliaryStorage();
  expect(f.batches).toEqual([[entry('first')], [entry('second')]]);
});

it('reports failed native writes at flush and retries without losing the local history', async () => {
  const f = fixture();
  f.database.upsertHistory.mockRejectedValueOnce(new Error('database full'));
  const storage = await import('./auxiliaryStorage');
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('first')] });
  await expect(storage.flushCodexAuxiliaryStorage()).rejects.toThrow('database full');
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ version: 1, threadId: 'thread', entries: [entry('first')] });
  await storage.flushCodexAuxiliaryStorage();
  expect(f.batches).toEqual([[entry('first')]]);
});

it('does not retry a failed old upsert after the thread has been cleared', async () => {
  const f = fixture();
  f.database.upsertHistory.mockRejectedValueOnce(new Error('database full'));
  const storage = await import('./auxiliaryStorage');
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('first')] });
  await expect(storage.flushCodexAuxiliaryStorage()).rejects.toThrow('database full');
  storage.removeCodexAuxiliarySnapshot('thread');
  await storage.flushCodexAuxiliaryStorage();
  expect(storage.readCodexAuxiliarySnapshot('thread')).toBeNull();
  expect(f.database.clearHistory).toHaveBeenCalledWith({ threadId: 'thread' });
  expect(f.batches).toEqual([]);
});

it('hydrates all native pages before making stored history available without synchronous IPC', async () => {
  const f = fixture();
  f.database.readHistory.mockResolvedValueOnce({ entries: [entry('page-one')], nextCursor: '1' });
  f.database.readHistory.mockResolvedValueOnce({ entries: [entry('page-two')], nextCursor: null });
  const storage = await import('./auxiliaryStorage');
  await Reflect.apply(storage.initializeCodexAuxiliaryStorage, undefined, ['thread']);
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ version: 1, threadId: 'thread', entries: [entry('page-one'), entry('page-two')] });
  expect(f.syncRead).not.toHaveBeenCalled();
});

it('retains a completion received while native history hydration is pending', async () => {
  const f = fixture();
  let finish: (page: SessionHistoryPage) => void = () => {};
  f.database.readHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const storage = await import('./auxiliaryStorage');
  const hydration = Reflect.apply(storage.initializeCodexAuxiliaryStorage, undefined, ['thread']);
  storage.writeCodexAuxiliarySnapshot('thread', { version: 1, threadId: 'thread', entries: [entry('live')] });
  finish({ entries: [entry('old')], nextCursor: null });
  await hydration;
  expect(storage.readCodexAuxiliarySnapshot('thread')).toEqual({ version: 1, threadId: 'thread', entries: [entry('old'), entry('live')] });
});

it('does not resurrect a cleared thread when an earlier hydration completes', async () => {
  const f = fixture();
  let finish: (page: SessionHistoryPage) => void = () => {};
  f.database.readHistory.mockImplementationOnce(() => new Promise(resolve => { finish = resolve; }));
  const storage = await import('./auxiliaryStorage');
  const hydration = Reflect.apply(storage.initializeCodexAuxiliaryStorage, undefined, ['thread']);
  storage.removeCodexAuxiliarySnapshot('thread');
  finish({ entries: [entry('old')], nextCursor: null });
  await hydration;
  expect(storage.readCodexAuxiliarySnapshot('thread')).toBeNull();
});

it('persists a nested tool state mutated in place after an earlier save', async () => {
  const f = fixture();
  const storage = await import('./auxiliaryStorage');
  const value = entry('tool');
  const tool = { ...value, parts: [{ ...value.parts[0], type: 'tool', state: { status: 'running', output: '' } }] };
  const snapshot = { version: 1, threadId: 'thread', entries: [tool] };
  storage.writeCodexAuxiliarySnapshot('thread', snapshot);
  await storage.flushCodexAuxiliaryStorage();
  tool.parts[0]!.state.output = 'finished output';
  tool.parts[0]!.state.status = 'completed';
  storage.writeCodexAuxiliarySnapshot('thread', snapshot);
  await storage.flushCodexAuxiliaryStorage();
  expect(f.batches).toHaveLength(2);
  expect(f.batches[1]).toEqual([tool]);
});

it('refreshes from remote invalidation and reflects remote deletion', async () => {
  const f = fixture();
  const storage = await import('./auxiliaryStorage');
  const native = await import('./nativeAuxiliaryStorage');
  await storage.initializeCodexAuxiliaryStorage('thread');
  const changed = vi.fn();
  const remove = native.onNativeAuxiliaryHistoryChanged(changed);
  f.database.readHistory.mockResolvedValueOnce({ entries: [], nextCursor: null });
  for (const listener of f.listeners) listener('thread');
  await vi.waitFor(() => expect(changed).toHaveBeenCalledWith('thread'));
  expect(storage.readCodexAuxiliarySnapshot('thread')).toBeNull();
  remove();
});

it('detects mutations to history previously restored into the live queue', async () => {
  const f = fixture();
  const storage = await import('./auxiliaryStorage');
  const history = await import('./auxiliaryHistory');
  await storage.initializeCodexAuxiliaryStorage('thread');
  const restored = history.loadCodexAuxiliaryHistory('thread');
  restored[0]!.info.time.created = 2;
  history.saveCodexAuxiliaryHistory('thread', restored);
  await storage.flushCodexAuxiliaryStorage();
  expect(f.batches).toHaveLength(1);
  expect(f.batches[0]).toEqual([{ info: restored[0]!.info, parts: [] }]);
});
