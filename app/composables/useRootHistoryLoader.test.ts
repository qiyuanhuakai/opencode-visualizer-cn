import { ref } from 'vue';
import { describe, expect, it, vi } from 'vitest';
import { useMessages } from './useMessages';
import { useRootHistoryLoader, type UserMessageMeta } from './useRootHistoryLoader';

type Deferred<T> = {
  readonly promise: Promise<T>;
  readonly resolve: (value: T) => void;
};

function deferred<T>(): Deferred<T> {
  let resolve = (_value: T) => {};
  const promise = new Promise<T>((finish) => {
    resolve = finish;
  });
  return { promise, resolve };
}

function historyEntry(id: string, created: number) {
  return {
    info: {
      id,
      sessionID: 'root-session',
      role: 'user',
      agent: 'build',
      model: { providerID: 'provider-a', modelID: 'model-a', variant: 'fast' },
      time: { created },
    },
    parts: [],
  };
}

function createLoader(overrides: Partial<Parameters<typeof useRootHistoryLoader>[0]> = {}) {
  const selectedSessionId = ref('root-session');
  const activeBackendKind = ref<'opencode' | 'acp'>('opencode');
  const userMessageMetaById = ref<Record<string, UserMessageMeta>>({
    retained: { agent: 'retained' },
  });
  const userMessageTimeById = ref<Record<string, number>>({ retained: 7 });
  const directory = ref('/repo');
  const messages = useMessages();
  messages.reset();
  const listSessionMessages = vi.fn(async () => [historyEntry('message-1', 11)]);
  const refreshAcpMetadata = vi.fn(async () => {});
  const log = vi.fn();
  const loader = useRootHistoryLoader({
    selectedSessionId,
    activeBackendKind,
    userMessageMetaById,
    userMessageTimeById,
    getSelectedDirectory: () => directory.value,
    listSessionMessages,
    loadHistoryIncrementally: messages.loadHistoryIncrementally,
    refreshAcpMetadata,
    log,
    ...overrides,
  });
  return {
    loader,
    selectedSessionId,
    activeBackendKind,
    userMessageMetaById,
    userMessageTimeById,
    directory,
    messages,
    listSessionMessages,
    refreshAcpMetadata,
    log,
  };
}

describe('useRootHistoryLoader', () => {
  it('Given root and child history, When both load, Then only the root allocates a request and both maps publish safe clones', async () => {
    const fixture = createLoader();

    const root = await fixture.loader.fetchRootSessionHistory('root-session');
    const childLoaded = await fixture.loader.fetchHistory('child-session', {
      isSubagentMessage: true,
      rootRequestId: root.requestId,
      rootSessionId: 'root-session',
    });

    expect(root).toEqual({ requestId: 1, loaded: true });
    expect(childLoaded).toBe(true);
    expect(fixture.loader.currentRootRequestId()).toBe(1);
    expect(fixture.listSessionMessages).toHaveBeenCalledTimes(2);
    expect(fixture.userMessageMetaById.value).toEqual({
      retained: { agent: 'retained' },
      'message-1': {
        agent: 'build',
        providerId: 'provider-a',
        modelId: 'model-a',
        variant: 'fast',
      },
    });
    expect(fixture.userMessageTimeById.value).toEqual({ retained: 7, 'message-1': 11 });
    expect(Object.getPrototypeOf(fixture.userMessageMetaById.value)).toBeNull();
    expect(Object.getPrototypeOf(fixture.userMessageTimeById.value)).toBeNull();
  });

  it('Given out-of-order root responses, When the older response resolves last, Then it cannot load or publish', async () => {
    const older = deferred<Array<Record<string, unknown>>>();
    const newer = deferred<Array<Record<string, unknown>>>();
    const listSessionMessages = vi
      .fn<(sessionId: string) => Promise<Array<Record<string, unknown>>>>()
      .mockReturnValueOnce(older.promise)
      .mockReturnValueOnce(newer.promise);
    const fixture = createLoader({ listSessionMessages });

    const olderLoad = fixture.loader.fetchRootSessionHistory('root-session');
    fixture.selectedSessionId.value = 'next-session';
    const newerLoad = fixture.loader.fetchRootSessionHistory('next-session');
    newer.resolve([historyEntry('newer', 22)]);
    expect(await newerLoad).toEqual({ requestId: 2, loaded: true });
    older.resolve([historyEntry('older', 11)]);

    expect(await olderLoad).toEqual({ requestId: 2, loaded: false });
    expect(fixture.userMessageMetaById.value).toHaveProperty('newer');
    expect(fixture.userMessageMetaById.value).not.toHaveProperty('older');
  });

  it('Given the directory changes during the request, When history resolves, Then it is discarded', async () => {
    const response = deferred<Array<Record<string, unknown>>>();
    const fixture = createLoader({ listSessionMessages: vi.fn(() => response.promise) });

    const load = fixture.loader.fetchRootSessionHistory('root-session');
    fixture.directory.value = '/other-repo';
    response.resolve([historyEntry('stale-directory', 11)]);

    expect(await load).toEqual({ requestId: 1, loaded: false });
    expect(fixture.messages.messages.value.size).toBe(0);
    expect(fixture.userMessageMetaById.value).not.toHaveProperty('stale-directory');
  });

  it('Given selection changes between chunks, When incremental loading yields, Then later chunks and maps stay unpublished', async () => {
    const selectedSessionId = ref('root-session');
    const messages = useMessages();
    const loadHistoryIncrementally = vi.fn(
      (entries: unknown[], options: { readonly shouldContinue: () => boolean }) =>
        messages.loadHistoryIncrementally(entries, {
          ...options,
          chunkSize: 1,
          yieldControl: async () => {
            selectedSessionId.value = 'next-session';
          },
        }),
    );
    const fixture = createLoader({
      selectedSessionId,
      listSessionMessages: vi.fn(async () => [historyEntry('first', 1), historyEntry('second', 2)]),
      loadHistoryIncrementally,
    });

    const result = await fixture.loader.fetchRootSessionHistory('root-session');

    expect(result).toEqual({ requestId: 1, loaded: false });
    expect(messages.messages.value.size).toBe(1);
    expect(fixture.userMessageMetaById.value).not.toHaveProperty('first');
    expect(fixture.userMessageTimeById.value).not.toHaveProperty('first');
  });

  it('Given prototype-shaped IDs, When metadata publishes, Then they remain own properties without prototype pollution', async () => {
    const fixture = createLoader({
      listSessionMessages: vi.fn(async () => [
        historyEntry('__proto__', 1),
        historyEntry('constructor', 2),
      ]),
    });

    expect((await fixture.loader.fetchRootSessionHistory('root-session')).loaded).toBe(true);

    expect(Object.hasOwn(fixture.userMessageMetaById.value, '__proto__')).toBe(true);
    expect(Object.hasOwn(fixture.userMessageMetaById.value, 'constructor')).toBe(true);
    expect(Object.hasOwn(fixture.userMessageTimeById.value, '__proto__')).toBe(true);
    expect(Object.hasOwn(fixture.userMessageTimeById.value, 'constructor')).toBe(true);
    expect(Object.getPrototypeOf(fixture.userMessageMetaById.value)).toBeNull();
    expect(Object.getPrototypeOf(fixture.userMessageTimeById.value)).toBeNull();
  });

  it('Given ACP history, When loading succeeds, Then agent and command metadata refresh together', async () => {
    const fixture = createLoader();
    fixture.activeBackendKind.value = 'acp';

    expect((await fixture.loader.fetchRootSessionHistory('root-session')).loaded).toBe(true);

    expect(fixture.refreshAcpMetadata).toHaveBeenCalledTimes(1);
  });

  it('Given a non-array backend response, When root history loads, Then it rejects the response without ingestion', async () => {
    const fixture = createLoader({ listSessionMessages: vi.fn(async () => ({ entries: [] })) });

    const result = await fixture.loader.fetchRootSessionHistory('root-session');

    expect(result).toEqual({ requestId: 1, loaded: false });
    expect(fixture.messages.messages.value.size).toBe(0);
  });

  it('Given the backend rejects, When root history loads, Then it preserves the false result and reports the failure', async () => {
    const failure = new Error('history unavailable');
    const fixture = createLoader({
      listSessionMessages: vi.fn(async () => Promise.reject(failure)),
    });

    const result = await fixture.loader.fetchRootSessionHistory('root-session');

    expect(result).toEqual({ requestId: 1, loaded: false });
    expect(fixture.log).toHaveBeenCalledWith('History load failed', failure);
  });
});
