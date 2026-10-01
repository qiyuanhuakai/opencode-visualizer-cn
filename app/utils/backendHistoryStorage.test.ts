import { afterEach, beforeEach, expect, it, vi } from 'vitest';
import type { MessagePart } from '../types/sse';
import { createBackendHistoryStorage, type BackendHistoryEntry } from './backendHistoryStorage';

function createOpenCodeSubagentHistoryStorage(scope: string) { return createBackendHistoryStorage({ backend: 'opencode', scope }); }

function entry(id: string, text = id): BackendHistoryEntry {
  return {
    info: { id, sessionID: 'child', role: 'user', time: { created: id === 'first' ? 1 : 2 }, agent: 'build', model: { providerID: 'test', modelID: 'test' } },
    parts: [{ id: `${id}-text`, messageID: id, sessionID: 'child', type: 'text', text }],
  };
}

beforeEach(() => { localStorage.clear(); vi.stubGlobal('indexedDB', undefined); });
afterEach(() => { vi.restoreAllMocks(); vi.unstubAllGlobals(); });

it('restores persisted history in a fresh module and instance after reload', async () => {
  // Given
  const original = createOpenCodeSubagentHistoryStorage('reload');
  await original.merge('child', [entry('first')]);
  await original.flush();
  // When
  vi.resetModules();
  const reloaded = await import('./backendHistoryStorage');
  const restored = await reloaded.createBackendHistoryStorage({ backend: 'opencode', scope: 'reload' }).read('child');
  // Then
  expect(restored).toEqual([entry('first')]);
});

it('retains earlier messages and terminal text/tool output when responses are empty or partial', async () => {
  // Given
  const store = createOpenCodeSubagentHistoryStorage('partial');
  const tool: MessagePart = { id: 'tool', messageID: 'first', sessionID: 'child', type: 'tool', callID: 'call', tool: 'bash', state: { status: 'completed', input: {}, output: 'complete output', title: 'done', metadata: {}, time: { start: 1, end: 2 } } };
  await store.merge('child', [{ ...entry('first', 'complete text'), parts: [...entry('first', 'complete text').parts, tool] }]);
  await store.merge('child', []);
  // When
  const merged = await store.merge('child', [{ ...entry('first', 'complete'), parts: [...entry('first', 'complete').parts, { ...tool, state: { status: 'running', input: {}, time: { start: 1 } } }] }, entry('second')]);
  // Then
  expect(merged).toEqual([{ ...entry('first', 'complete text'), parts: [...entry('first', 'complete text').parts, tool] }, entry('second')]);
});

it('serializes concurrent merges from different instances without dropping messages', async () => {
  // Given
  const first = createOpenCodeSubagentHistoryStorage('concurrent');
  const second = createOpenCodeSubagentHistoryStorage('concurrent');
  // When
  await Promise.all([first.merge('child', [entry('first')]), second.merge('child', [entry('second')])]);
  // Then
  expect(await first.read('child')).toEqual([entry('first'), entry('second')]);
});

it('isolates scopes and sessions without exposing backend identity in keys', async () => {
  // Given
  const store = createOpenCodeSubagentHistoryStorage('https://user:secret@example.com/private');
  await store.merge('child', [entry('first')]);
  // When
  const otherScope = await createOpenCodeSubagentHistoryStorage('https://other.example.com/private').read('child');
  const otherSession = await store.read('other');
  // Then
  expect(otherScope).toEqual([]);
  expect(otherSession).toEqual([]);
  expect(localStorage.key(0)).not.toMatch(/secret|example|private/);
});

it('reports quota errors while retaining data and retries persistence on flush', async () => {
  // Given
  const store = createOpenCodeSubagentHistoryStorage('quota');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  const write = vi.spyOn(localStorage, 'setItem').mockImplementation(() => { throw new DOMException('full', 'QuotaExceededError'); });
  await store.merge('child', [entry('first')]);
  // When
  await expect(store.flush()).rejects.toThrow();
  expect(await store.read('child')).toEqual([entry('first')]);
  write.mockRestore();
  await store.flush();
  // Then
  expect(log).toHaveBeenCalled();
  vi.resetModules();
  const reloaded = await import('./backendHistoryStorage');
  expect(await reloaded.createBackendHistoryStorage({ backend: 'opencode', scope: 'quota' }).read('child')).toEqual([entry('first')]);
});


it('uses namespaced native history and paginated reads without synchronous storage', async () => {
  // Given
  const pages = vi.fn().mockResolvedValueOnce({ entries: [entry('first')], nextCursor: 'next' }).mockResolvedValueOnce({ entries: [entry('second')], nextCursor: null });
  const upsert = vi.fn(async () => {});
  const syncRead = vi.fn(() => { throw new Error('unexpected sync storage'); });
  vi.stubGlobal('window', { electronAPI: { sessionDatabase: { readHistory: pages, upsertHistory: upsert, flush: vi.fn(async () => {}) }, persistentStorage: { getItem: syncRead } } });
  const store = createBackendHistoryStorage({ backend: 'opencode', scope: 'native' });
  // When
  const merged = await store.merge('child', [entry('third')]);
  // Then
  expect(merged.map(item => item.info.id)).toEqual(['first', 'second', 'third']);
  expect(pages.mock.calls[0]?.[0]).toMatchObject({ threadId: 'child', namespace: expect.stringMatching(/^backend-history-v1:[a-f0-9]{32}$/) });
  expect(pages.mock.calls[1]?.[0]).toMatchObject({ cursor: 'next' });
  expect(upsert).toHaveBeenCalledWith(expect.objectContaining({ threadId: 'child', entries: [entry('third')] }));
  expect(syncRead).not.toHaveBeenCalled();
});

it('retains cached entries when native reads fail and persists them after recovery', async () => {
  // Given
  const pages = vi.fn().mockResolvedValue({ entries: [], nextCursor: null });
  const upsert = vi.fn(async () => {});
  vi.stubGlobal('window', { electronAPI: { sessionDatabase: { readHistory: pages, upsertHistory: upsert, flush: vi.fn(async () => {}) } } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = createBackendHistoryStorage({ backend: 'opencode', scope: 'native-error' });
  await store.merge('child', [entry('first')]);
  pages.mockRejectedValue(new Error('database offline'));
  // When
  const result = await store.merge('child', [entry('second')]);
  // Then
  expect(result).toEqual([entry('first'), entry('second')]);
  await expect(store.flush()).rejects.toThrow('database offline');
  pages.mockResolvedValue({ entries: [], nextCursor: null });
  await store.flush();
  expect(upsert).toHaveBeenLastCalledWith(expect.objectContaining({ entries: [entry('first'), entry('second')] }));
});

it('retains already persisted native entries when a fresh instance cannot write its new entry', async () => {
  // Given
  const pages = vi.fn().mockResolvedValue({ entries: [entry('first')], nextCursor: null });
  const upsert = vi.fn().mockRejectedValue(new Error('disk full'));
  vi.stubGlobal('window', { electronAPI: { sessionDatabase: { readHistory: pages, upsertHistory: upsert, flush: vi.fn(async () => {}) } } });
  vi.spyOn(console, 'error').mockImplementation(() => {});
  const store = createBackendHistoryStorage({ backend: 'opencode', scope: 'fresh-write-error' });
  // When
  const result = await store.merge('child', [entry('second')]);
  // Then
  expect(result).toEqual([entry('first'), entry('second')]);
  pages.mockRejectedValue(new Error('offline'));
  expect(await store.read('child')).toEqual([entry('first'), entry('second')]);
});
