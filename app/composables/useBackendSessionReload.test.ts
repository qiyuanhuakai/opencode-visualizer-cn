import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { KimiWebMessage } from '../utils/kimiWeb';
import { KimiWebError } from '../utils/kimiWeb';
import { createSessionReloadFixture } from './useBackendSessionReload.test-helpers';
import { useMessages } from './useMessages';

const KIMI_FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

function kimiFixtureMessages(): KimiWebMessage[] {
  const raw = JSON.parse(
    readFileSync(join(KIMI_FIXTURES_DIR, 'rest-messages-after-p3.json'), 'utf8'),
  ) as { data: { items: KimiWebMessage[] } };
  return raw.data.items;
}

function kimiEntryIds(messages: KimiWebMessage[]): string[] {
  return [...messages]
    .reverse()
    .filter((message) => message.metadata?.origin?.kind !== 'injection')
    .filter((message) => message.role !== 'tool')
    .map((message) => message.id);
}

describe('useBackendSessionReload', () => {
  it('keeps Codex history loading until the final output anchor settles', async () => {
    let finishAnchor = () => {};
    const anchorOutputToBottom = vi.fn(() => new Promise<void>((resolve) => {
      finishAnchor = resolve;
    }));
    const { reload, options } = createSessionReloadFixture({
      activeBackendKind: ref('codex'),
      anchorOutputToBottom,
    });
    const loading = reload.reloadSelectedSessionState('thread-1');
    expect(options.isLoadingHistory.value).toBe(true);
    await vi.waitFor(() => expect(anchorOutputToBottom).toHaveBeenCalledOnce());
    expect(options.isLoadingHistory.value).toBe(true);
    finishAnchor();
    await loading;
    expect(options.isLoadingHistory.value).toBe(false);
  });

  it('keeps a completed root snapshot cacheable when child hydration fails', async () => {
    vi.stubGlobal('requestAnimationFrame', (callback: FrameRequestCallback) => {
      callback(0);
      return 0;
    });
    const activeBackendKind = ref<'opencode'>('opencode');
    const activeDirectory = ref('/repo');
    const sessionReloadRequestId = ref(0);
    const deferredSessionReloadId = ref<string | null>(null);
    const hydrateReferencedSubagents = vi
      .fn()
      .mockRejectedValue(new Error('child hydration failed'));
    const fetchRootSessionHistory = vi.fn().mockResolvedValue({ requestId: 42, loaded: true });
    const {
      reload: { reloadSelectedSessionState },
      mocks,
    } = createSessionReloadFixture({
      activeBackendKind,
      activeDirectory,
      getMessageCacheNamespace: () => 'opencode:primary:/repo',
      sessionReloadRequestId,
      deferredSessionReloadId,
      fetchRootSessionHistory,
      hydrateReferencedSubagents,
    });

    try {
      await reloadSelectedSessionState('session-1');
      expect(hydrateReferencedSubagents).toHaveBeenCalledWith('session-1', 1);
      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();

      await reloadSelectedSessionState('session-2', 'session-1');

      expect(mocks.msg.saveSessionState).toHaveBeenCalledWith({
        namespace: 'opencode:primary:/repo',
        sessionId: 'session-1',
      });

      fetchRootSessionHistory.mockResolvedValue({ requestId: 43, loaded: false });
      await reloadSelectedSessionState('session-failed', 'session-2');
      mocks.msg.saveSessionState.mockClear();

      await reloadSelectedSessionState('session-3', 'session-failed');

      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
    } finally {
      vi.unstubAllGlobals();
    }
  });

  it('reloads Codex session history through unified reload runtime', async () => {
    const selectThread = vi.fn().mockResolvedValue(undefined);
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref('codex'),
      getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
      codexApi: {
        activeThreadId: ref('other-thread'),
        selectThread,
      },
      codexHistory: ref([{ id: 'history-1' }]),
    });

    await reload.reloadSelectedSessionState('thread-1', 'thread-old');

    expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
    expect(selectThread).toHaveBeenCalledWith('thread-1');
    expect(mocks.msg.reset).toHaveBeenCalled();
    expect(mocks.msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
  });

  it.each([false, true])(
    'resets Codex same-session history only when explicitly requested: %s',
    async (forceReset) => {
      const selectThread = vi.fn().mockResolvedValue(undefined);
      const { reload, mocks } = createSessionReloadFixture({
        activeBackendKind: ref('codex'),
        getMessageCacheNamespace: () => 'codex:http://127.0.0.1:4500:/repo',
        codexApi: {
          activeThreadId: ref('thread-1'),
          selectThread,
        },
        codexHistory: ref([{ id: 'history-1' }, { id: 'history-2' }]),
      });

      await reload.reloadSelectedSessionState('thread-1', undefined, forceReset);

      expect(mocks.msg.saveSessionState).not.toHaveBeenCalled();
      expect(selectThread).not.toHaveBeenCalled();
      expect(mocks.msg.reset).toHaveBeenCalledTimes(forceReset ? 1 : 0);
      expect(mocks.msg.loadHistory).toHaveBeenCalledWith([
        { id: 'history-1' },
        { id: 'history-2' },
      ]);
    },
  );

  it('uses cache for OpenCode session reload and skips root fetch', async () => {
    const fetchRootSessionHistory = vi.fn();
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'opencode'>('opencode'),
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      fetchRootSessionHistory,
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(7),
      scheduleDescendantSessionHistoryHydration,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    await reload.reloadSelectedSessionState('session-1');

    expect(mocks.msg.tryLoadFromCache).toHaveBeenCalledWith({
      namespace: 'opencode:http://127.0.0.1:4096:/repo',
      sessionId: 'session-1',
    });
    expect(fetchRootSessionHistory).not.toHaveBeenCalled();
    expect(scheduleDescendantSessionHistoryHydration).toHaveBeenCalledWith('session-1', 7, 1);
  });

  it('waits for referenced subagent metadata before hydrating exact child histories', async () => {
    let finishHydration: (sessionIds: string[]) => void = () => {};
    const hydrateReferencedSubagents = vi.fn(
      () =>
        new Promise<string[]>((resolve) => {
          finishHydration = resolve;
        }),
    );
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const sessionReloadRequestId = ref(0);
    const { reload, mocks } = createSessionReloadFixture({
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      sessionReloadRequestId,
      reserveRootHistoryRequestId: vi.fn().mockReturnValue(12),
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    const pendingReload = reload.reloadSelectedSessionState('root-session');
    await vi.waitFor(() =>
      expect(hydrateReferencedSubagents).toHaveBeenCalledWith('root-session', 1),
    );
    expect(scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();

    finishHydration(['child-a', 'child-b']);
    await pendingReload;

    expect(scheduleDescendantSessionHistoryHydration).toHaveBeenCalledWith('root-session', 12, 1, [
      'child-a',
      'child-b',
    ]);
  });

  it('does not schedule child history after a metadata wait is superseded', async () => {
    let finishHydration: (sessionIds: string[]) => void = () => {};
    const sessionReloadRequestId = ref(0);
    const scheduleDescendantSessionHistoryHydration = vi.fn();
    const reserveRootHistoryRequestId = vi.fn().mockReturnValue(3);
    const { reload, mocks } = createSessionReloadFixture({
      getMessageCacheNamespace: () => 'opencode:http://127.0.0.1:4096:/repo',
      sessionReloadRequestId,
      reserveRootHistoryRequestId,
      scheduleDescendantSessionHistoryHydration,
      hydrateReferencedSubagents: () =>
        new Promise<string[]>((resolve) => {
          finishHydration = resolve;
        }),
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    const pendingReload = reload.reloadSelectedSessionState('root-session');
    await vi.waitFor(() => expect(reserveRootHistoryRequestId).toHaveBeenCalled());
    sessionReloadRequestId.value += 1;
    finishHydration(['stale-child']);
    await pendingReload;

    expect(scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();
  });

  it('saves the old materialized view under its original backend identity', async () => {
    const activeBackendKind = ref<'opencode' | 'acp'>('opencode');
    const activeDirectory = ref('/repo-a');
    let namespace = 'opencode:http://127.0.0.1:4096:/repo-a';
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind,
      activeDirectory,
      getMessageCacheNamespace: () => namespace,
    });
    mocks.msg.tryLoadFromCache.mockReturnValue(true);

    await reload.reloadSelectedSessionState('shared-session');
    activeBackendKind.value = 'acp';
    activeDirectory.value = '/repo-b';
    namespace = 'acp:agent-b:/repo-b';
    await reload.reloadSelectedSessionState('next-session', 'shared-session');

    expect(mocks.msg.saveSessionState).toHaveBeenCalledWith({
      namespace: 'opencode:http://127.0.0.1:4096:/repo-a',
      sessionId: 'shared-session',
    });
    expect(mocks.msg.tryLoadFromCache).toHaveBeenLastCalledWith({
      namespace: 'acp:agent-b:/repo-b',
      sessionId: 'next-session',
    });
  });
});

describe('useBackendSessionReload kimi-web history', () => {
  it('pages backwards and feeds chronological, injection-free entries to loadHistory', async () => {
    const newestFirst = kimiFixtureMessages();
    const pageOne = newestFirst.slice(0, 6);
    const pageTwo = newestFirst.slice(6);
    const getMessages = vi.fn(
      async (_sessionId: string, query?: { before_id?: string }) =>
        query?.before_id
          ? { items: pageTwo, has_more: false }
          : { items: pageOne, has_more: true },
    );
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'kimi-web'>('kimi-web'),
      kimiWebApi: { getMessages },
    });

    await reload.reloadSelectedSessionState('kimi-session');

    expect(getMessages).toHaveBeenCalledTimes(2);
    expect(getMessages.mock.calls[1]?.[1]?.before_id).toBe(pageOne.at(-1)?.id);
    expect(mocks.msg.loadHistory).toHaveBeenCalledTimes(1);
    const entries = mocks.msg.loadHistory.mock.calls[0]?.[0] as Array<{ info: { id: string } }>;
    expect(entries.map((entry) => entry.info.id)).toEqual(kimiEntryIds(newestFirst));
    expect(entries.some((entry) => entry.info.id.endsWith('_000001'))).toBe(false);
  });

  it('never invokes popup or descendant callbacks during a kimi-web history load', async () => {
    const getMessages = vi.fn(async () => ({ items: kimiFixtureMessages(), has_more: false }));
    const hydrateReferencedSubagents = vi.fn();
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'kimi-web'>('kimi-web'),
      kimiWebApi: { getMessages },
      hydrateReferencedSubagents,
    });

    await reload.reloadSelectedSessionState('kimi-session');

    expect(mocks.msg.loadHistory).toHaveBeenCalledTimes(1);
    expect(hydrateReferencedSubagents).not.toHaveBeenCalled();
    expect(mocks.scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();
    expect(mocks.codexReapplyBackfill).not.toHaveBeenCalled();
    expect(mocks.msg.tryLoadFromCache).not.toHaveBeenCalled();
  });

  it('discards kimi-web pages that resolve after a session switch', async () => {
    const newestFirst = kimiFixtureMessages();
    let resolveSlow: (value: { items: KimiWebMessage[]; has_more: boolean }) => void = () => {};
    const getMessages = vi.fn((sessionId: string) =>
      sessionId === 'slow'
        ? new Promise<{ items: KimiWebMessage[]; has_more: boolean }>((resolve) => {
            resolveSlow = resolve;
          })
        : Promise.resolve({ items: [], has_more: false }),
    );
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'kimi-web'>('kimi-web'),
      kimiWebApi: { getMessages },
    });

    const pending = reload.reloadSelectedSessionState('slow');
    await vi.waitFor(() => expect(getMessages).toHaveBeenCalledWith('slow', expect.anything()));
    await reload.reloadSelectedSessionState('current', 'slow');
    mocks.msg.loadHistory.mockClear();

    resolveSlow({ items: newestFirst, has_more: false });
    await pending;

    expect(mocks.msg.loadHistory).not.toHaveBeenCalled();
  });

  it('reports a bounded history when the kimi-web page cap is reached', async () => {
    const sample = kimiFixtureMessages()[1]!;
    const getMessages = vi.fn(async () => ({ items: [sample], has_more: true }));
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'kimi-web'>('kimi-web'),
      kimiWebApi: { getMessages },
      kimiWebHistoryMaxPages: 3,
    });

    await reload.reloadSelectedSessionState('kimi-session');

    expect(getMessages).toHaveBeenCalledTimes(3);
    expect(mocks.onKimiWebHistoryTruncated).toHaveBeenCalledWith({
      sessionId: 'kimi-session',
      pages: 3,
    });
  });

  it('surfaces a mid-pagination envelope failure without publishing a truncated view', async () => {
    const newestFirst = kimiFixtureMessages();
    let calls = 0;
    const getMessages = vi.fn(async () => {
      calls += 1;
      if (calls === 1) return { items: newestFirst.slice(0, 6), has_more: true };
      throw new KimiWebError(40401, 'session missing');
    });
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref<'kimi-web'>('kimi-web'),
      kimiWebApi: { getMessages },
    });

    await expect(reload.reloadSelectedSessionState('kimi-session')).rejects.toBeInstanceOf(
      KimiWebError,
    );
    expect(mocks.msg.loadHistory).not.toHaveBeenCalled();
  });
});

// R7/S5b: an empty-id reload is never reached by the `if (newId)` reset, so stale messages survive.
describe('empty session reload clears stale messages (R7/S5b)', () => {
  it('clears the previous backend messages when the reload targets an empty session id', async () => {
    const store = useMessages();
    store.reset();
    store.loadHistory([
      {
        info: { id: 'stale-prev-backend-message', sessionID: 'codex-session', role: 'user' },
      },
    ]);
    expect(store.messages.value.size).toBe(1);
    expect(store.get('stale-prev-backend-message')).toBeDefined();

    const { reload } = createSessionReloadFixture({
      activeBackendKind: ref<'codex'>('codex'),
      msg: store,
    });

    await reload.reloadSelectedSessionState('');

    expect(
      store.get('stale-prev-backend-message'),
      'reloading an empty session id must clear the previous backend messages (R7/S5b)',
    ).toBeUndefined();
    expect(store.messages.value.size).toBe(0);
  });

  it('characterization: a Codex session switch still resets before loading history', async () => {
    const selectThread = vi.fn().mockResolvedValue(undefined);
    const { reload, mocks } = createSessionReloadFixture({
      activeBackendKind: ref('codex'),
      codexApi: {
        activeThreadId: ref('other-thread'),
        selectThread,
      },
      codexHistory: ref([{ id: 'history-1' }]),
    });

    await reload.reloadSelectedSessionState('thread-1', 'thread-old');

    expect(mocks.msg.reset).toHaveBeenCalledTimes(1);
    expect(mocks.msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
    expect(mocks.msg.reset.mock.invocationCallOrder[0]).toBeLessThan(
      mocks.msg.loadHistory.mock.invocationCallOrder[0]!,
    );
  });
});
