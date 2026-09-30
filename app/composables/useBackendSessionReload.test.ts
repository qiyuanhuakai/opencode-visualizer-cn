import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { KimiWebMessage } from '../utils/kimiWeb';
import { KimiWebError } from '../utils/kimiWeb';
import type { DshSessionRecord } from '../backends/dsh/types';
import { createSessionReloadFixture, type ReloadOptions } from './useBackendSessionReload.test-helpers';
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
    expect(anchorOutputToBottom).toHaveBeenCalledWith(false);
  });

  it('keeps Codex history usable when output anchoring times out', async () => {
    const { reload, options, mocks } = createSessionReloadFixture({
      activeBackendKind: ref('codex'),
      codexHistory: ref([{ id: 'history-1' }]),
      anchorOutputToBottom: vi.fn().mockRejectedValue(new Error('Render timeout')),
    });
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => {});
    try {
      await reload.reloadSelectedSessionState('thread-1');
      expect(mocks.msg.loadHistory).toHaveBeenCalledWith([{ id: 'history-1' }]);
      expect(options.isLoadingHistory.value).toBe(false);
      expect(options.focusInput).toHaveBeenCalledOnce();
      expect(errorSpy).toHaveBeenCalledWith('[codex] Output anchoring failed:', expect.objectContaining({ message: 'Render timeout' }));
    } finally {
      errorSpy.mockRestore();
    }
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
    const entries = mocks.msg.loadHistory.mock.calls[0]?.[0] as Array<{ info: { id: string; sessionID: string; role: string } }>;
    expect(entries.filter((entry) => entry.info.sessionID === newestFirst[0]?.session_id)
      .map((entry) => entry.info.id)).toEqual(kimiEntryIds(newestFirst));
    expect(entries.filter((entry) => entry.info.sessionID.endsWith(':agent-0:0'))
      .map((entry) => entry.info.role)).toEqual(['user', 'assistant']);
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

// ---------------------------------------------------------------------------
// dsh `session/page` history branch (plan Todo 26)
// ---------------------------------------------------------------------------

const DSH_SESSION_ID = 'session-06ee930d-7d74-42b1-928d-ac8fdd4376bf';
const DSH_CHILD_SESSION_ID = 'session-4d0e6409-6de0-4cb5-a6b0-de3c6d54b7c1';
const DSH_CURSOR = 17;

function dshPageRequests(normalized: Record<string, unknown>) {
  return normalized as { address: Record<string, unknown>; beforeSeq: number; throughSeq: number };
}

function createDshReloadFixture(
  fetchPage: NonNullable<ReloadOptions['dshApi']>['fetchPage'],
  overrides: Partial<ReloadOptions> = {},
) {
  const refreshAuth = vi.fn<() => Promise<void>>(async () => {});
  const onDshHistoryTruncated =
    vi.fn<NonNullable<ReloadOptions['onDshHistoryTruncated']>>();
  const fixture = createSessionReloadFixture({
    activeBackendKind: ref<'dsh'>('dsh'),
    dshApi: { fetchPage, refreshAuth },
    dshWatermark: () => DSH_CURSOR,
    onDshHistoryTruncated,
    ...overrides,
  });
  return { ...fixture, refreshAuth, onDshHistoryTruncated };
}

function dshRecord(seq: number, type: string, time: number): DshSessionRecord {
  return {
    type: 'event',
    event: { type, seq, time, data: { turn: 1, reason: { kind: 'completed' } } } as DshSessionRecord['event'],
  };
}

describe('useBackendSessionReload dsh history', () => {
  it('pages session/page backwards and publishes chronological entries', async () => {
    const windows: DshSessionRecord[][] = [
      [dshRecord(14, 'turn/start', 1), dshRecord(15, 'assistant/message', 2)],
      [dshRecord(11, 'user/message', 3), dshRecord(12, 'assistant/message', 4)],
      [],
    ];
    let call = 0;
    const fetchPage = vi.fn(async (request) => {
      dshPageRequests(request);
      const window = windows[call] ?? [];
      call += 1;
      return { type: 'server-response', rpcId: 'rpc-1', result: { ok: true, value: { records: window, hasMore: false } } };
    });
    const { reload, mocks } = createDshReloadFixture(fetchPage);

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    const requests = fetchPage.mock.calls.map(([request]) => dshPageRequests(request));
    expect(requests[0]).toMatchObject({ beforeSeq: DSH_CURSOR + 1, throughSeq: DSH_CURSOR });
    expect(requests[0]?.address).toEqual({ kind: 'session', sessionId: DSH_SESSION_ID });
    expect(requests[1]?.beforeSeq).toBe(14);
    expect(requests[2]?.beforeSeq).toBe(11);
    expect(mocks.msg.loadHistory).toHaveBeenCalledTimes(1);
  });

  it('never pages a dsh session that has no history yet', async () => {
    const fetchPage = vi.fn(async () => ({ records: [] }));
    const { reload, mocks, onDshHistoryTruncated } = createDshReloadFixture(fetchPage, {
      dshWatermark: () => -1,
    });

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(fetchPage).not.toHaveBeenCalled();
    expect(mocks.msg.loadHistory).toHaveBeenCalledWith([]);
    expect(onDshHistoryTruncated).not.toHaveBeenCalled();
  });

  it('does not issue loadHistory while another history load still owns the session', async () => {
    const fetchPage = vi.fn(async () => ({ records: [dshRecord(1, 'user/message', 1)] }));
    const { reload, options } = createDshReloadFixture(fetchPage, {
      isLoadingHistory: ref(true),
    });

    const pending = reload.reloadSelectedSessionState(DSH_SESSION_ID);
    expect(fetchPage).not.toHaveBeenCalled();

    options.isLoadingHistory.value = false;
    await pending;

    expect(fetchPage).toHaveBeenCalled();
    expect(options.isLoadingHistory.value).toBe(false);
  });

  it('surfaces a mid-pagination page error without publishing a truncated view', async () => {
    let call = 0;
    const fetchPage = vi.fn(async () => {
      call += 1;
      if (call === 1) return { records: [dshRecord(3, 'user/message', 1)] };
      throw new Error('gateway unavailable');
    });
    const { reload, mocks } = createDshReloadFixture(fetchPage);

    await expect(reload.reloadSelectedSessionState(DSH_SESSION_ID)).rejects.toThrow('gateway unavailable');
    expect(mocks.msg.loadHistory).not.toHaveBeenCalled();
  });

  it('refreshes authorization once before retrying a rejected page', async () => {
    let unauthorized = true;
    const fetchPage = vi.fn(async () => {
      if (unauthorized) {
        unauthorized = false;
        return { status: 401 };
      }
      return { records: [] };
    });
    const { reload, refreshAuth, options } = createDshReloadFixture(fetchPage);

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(refreshAuth).toHaveBeenCalledTimes(1);
    expect(fetchPage).toHaveBeenCalledTimes(2);
    expect(options.isLoadingHistory.value).toBe(false);
  });

  it('reports a bounded dsh history when the page cap is reached', async () => {
    const fetchPage = vi.fn(async (rawRequest) => {
      const { beforeSeq } = dshPageRequests(rawRequest);
      return { records: [dshRecord(beforeSeq - 1, 'user/message', beforeSeq)], hasMore: true };
    });
    const { reload, onDshHistoryTruncated } = createDshReloadFixture(fetchPage, {
      dshHistoryMaxPages: 3,
    });

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(fetchPage).toHaveBeenCalledTimes(3);
    expect(onDshHistoryTruncated).toHaveBeenCalledWith({
      sessionId: DSH_SESSION_ID,
      pages: 3,
    });
  });

  it('pages a subagent child through its own address, never interleaved', async () => {
    const fetchPage = vi.fn(async (rawRequest) => {
      const request = dshPageRequests(rawRequest);
      if (request.address.kind === 'subagent') {
        return { records: [], hasMore: false };
      }
      return { records: [dshRecord(4, 'user/message', 1)], hasMore: false };
    });
    const dshChildAddresses = vi.fn(() => [
      {
        address: {
          kind: 'subagent' as const,
          parentSessionId: DSH_SESSION_ID,
          childSessionId: DSH_CHILD_SESSION_ID,
          mode: 'one-shot' as const,
        },
        source: 'session/list' as const,
        matched: 'parent' as const,
        throughSeq: 3,
      },
    ]);
    const { reload, mocks } = createDshReloadFixture(fetchPage, { dshChildAddresses });

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    const addresses = fetchPage.mock.calls.map(([request]) => dshPageRequests(request).address);
    expect(addresses[0]).toEqual({ kind: 'session', sessionId: DSH_SESSION_ID });
    expect(addresses).toContainEqual({
      kind: 'subagent',
      parentSessionId: DSH_SESSION_ID,
      childSessionId: DSH_CHILD_SESSION_ID,
      mode: 'one-shot',
    });
    expect(mocks.msg.loadHistory).toHaveBeenCalledTimes(1);
  });

  it('never invokes popup or descendant callbacks during a dsh history load', async () => {
    const hydrateReferencedSubagents = vi.fn();
    const fetchPage = vi.fn(async () => ({ records: [dshRecord(2, 'user/message', 1)] }));
    const { reload, mocks } = createDshReloadFixture(fetchPage, { hydrateReferencedSubagents });

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(mocks.msg.loadHistory).toHaveBeenCalledTimes(1);
    expect(hydrateReferencedSubagents).not.toHaveBeenCalled();
    expect(mocks.scheduleDescendantSessionHistoryHydration).not.toHaveBeenCalled();
    expect(mocks.codexReapplyBackfill).not.toHaveBeenCalled();
    expect(mocks.msg.tryLoadFromCache).not.toHaveBeenCalled();
  });

  it('hands normalized entries to the dsh bridge when one is wired', async () => {
    const applyHistory = vi.fn();
    const fetchPage = vi.fn(async () => ({ records: [dshRecord(2, 'user/message', 1)] }));
    const { reload, mocks } = createDshReloadFixture(fetchPage, {
      dshBridge: { applyHistory },
    });

    await reload.reloadSelectedSessionState(DSH_SESSION_ID);

    expect(applyHistory).toHaveBeenCalledTimes(1);
    expect(mocks.msg.loadHistory).not.toHaveBeenCalled();
  });

  it('discards dsh pages that resolve after a session switch', async () => {
    let resolveSlow: (value: unknown) => void = () => {};
    const fetchPage = vi.fn(
      (rawRequest) =>
        dshPageRequests(rawRequest).address.sessionId === 'slow'
          ? new Promise((resolve) => {
              resolveSlow = resolve;
            })
          : Promise.resolve({ records: [] }),
    );
    const { reload, mocks } = createDshReloadFixture(fetchPage);

    const pending = reload.reloadSelectedSessionState('slow');
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalled());
    await reload.reloadSelectedSessionState('current', 'slow');
    mocks.msg.loadHistory.mockClear();

    resolveSlow({ records: [dshRecord(9, 'user/message', 1)] });
    await pending;

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
