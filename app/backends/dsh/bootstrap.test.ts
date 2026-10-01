import { describe, expect, it, vi } from 'vitest';

import type { ProjectState } from '../../types/worker-state';
import type { DshMuxClient, DshMuxStreamHandle } from '../../utils/dshMux';
import type { DshMappedSession } from './dshAdapter';
import { mapDshSessionItem } from './dshAdapter';
import type { DshJsonValue } from './types';
import { useDshMessageBridge } from '../../composables/useDshMessageBridge';
import {
  bootstrapDshWorkspace,
  type DshBootstrapBridge,
  type DshBootstrapNormalizer,
  type DshBootstrapSessionSource,
  type DshHistoryPageFetcher,
  type DshHistoryWindow,
} from './bootstrap';

// ---------------------------------------------------------------------------
// Fixtures — shapes captured live (docs/dsh.md §7.1/§7.2/§8.2 +
// .omo/evidence/dsh-web-adapt/task-7/replay-boundary-contract.md)
// ---------------------------------------------------------------------------

const REPO_DIR = '/tmp/dsh/repo';
const NOTES_DIR = '/tmp/dsh/notes';

/** A `session/follow` first frame: the authoritative full snapshot (R1/R2). */
const SESSION_FOLLOW_SNAPSHOT: DshJsonValue = {
  type: 'snapshot',
  header: {
    version: 4,
    id: 'session-root',
    createdAt: 1790747615647,
    cwd: REPO_DIR,
    isSeeded: false,
    agentPreset: 'standard',
  },
  cursor: 4,
  records: [
    { type: 'event', event: { type: 'permission/preset', seq: 0, time: 1, data: { preset: 'workspace-write' } } },
    { type: 'event', event: { type: 'session/title', seq: 4, time: 2, data: { title: 'Root session' } } },
  ],
  hasMore: false,
  projections: { asOfSeq: 4, values: { title: 'Root session' } },
};

function mappedSession(overrides: Partial<DshMappedSession> & Pick<DshMappedSession, 'id'>): DshMappedSession {
  return {
    projectID: 'ws-git',
    projectId: 'ws-git',
    workspaceId: 'ws-git',
    title: 'Session',
    status: 'unknown',
    directory: REPO_DIR,
    time: { created: 1, updated: 2 },
    ...overrides,
  };
}

/**
 * Report order is adversarial on purpose: the child session is listed FIRST,
 * the archived root second, so an implementation that takes `sessions[0]` (or
 * forgets either filter) selects the wrong default entry.
 */
function sessionsFixture(): DshMappedSession[] {
  return [
    mappedSession({ id: 'session-child', parentID: 'session-root', title: 'Child session' }),
    mappedSession({ id: 'session-archived', title: 'Archived session', time: { created: 1, updated: 3, archived: 1 } }),
    mappedSession({ id: 'session-root', title: 'Root session' }),
    mappedSession({ id: 'session-pinned', title: 'Pinned session', time: { created: 1, updated: 4, pinned: 1 } }),
    mappedSession({
      id: 'session-notes',
      workspaceId: 'ws-plain',
      projectID: 'ws-plain',
      projectId: 'ws-plain',
      directory: NOTES_DIR,
      title: 'Notes session',
    }),
  ];
}

function sessionSource(sessions: readonly DshMappedSession[]): DshBootstrapSessionSource {
  return { listSessions: vi.fn(async () => sessions) };
}

// ---------------------------------------------------------------------------
// Injectable fakes
// ---------------------------------------------------------------------------

type OpenCall = { endpoint: string; args: Record<string, unknown> };

type FakeMux = {
  client: DshMuxClient;
  opened: OpenCall[];
  cancelled: string[];
  connectCalls: () => number;
  /** Deliver the deferred first frame for `endpoint` (deferred opens only). */
  flush(endpoint: string, value: unknown): void;
  /** Fail every in-flight stream for `endpoint` (protocol/transport failure). */
  fail(endpoint: string, error: Error): void;
  isDeferred(endpoint: string): boolean;
};

/**
 * `{ defer: 'session/follow' }` keeps that stream's first frame pending so a
 * test can switch backends mid-flight, exactly like the kimi bootstrap test's
 * deferred `connect()`.
 */
function fakeMux(frames: Record<string, unknown>, options: { defer?: string } = {}): FakeMux {
  const opened: OpenCall[] = [];
  const cancelled: string[] = [];
  const deliveries = new Map<string, Array<(value: DshJsonValue | undefined) => void>>();
  const rejections = new Map<string, Array<(error: Error) => void>>();
  let counter = 0;
  let connectCalls = 0;

  const client = {
    connect: vi.fn(async () => {
      connectCalls += 1;
    }),
    open: vi.fn((endpoint: string, payload: { args: Record<string, unknown> }) => {
      opened.push({ endpoint, args: payload.args });
      const streamId = `stream-${(counter += 1)}`;
      const itemListeners = new Set<(value: DshJsonValue | undefined) => void>();
      // Follow streams are downlink-only: the handle promise settles on `end`
      // or `error` only, so the first frame always arrives through `onItem`.
      const promise = new Promise<readonly (DshJsonValue | undefined)[]>((_resolve, reject) => {
        const queue = rejections.get(endpoint) ?? [];
        queue.push(reject);
        rejections.set(endpoint, queue);
      });
      void promise.catch(() => undefined);
      const handle: DshMuxStreamHandle = {
        streamId,
        promise,
        onItem(listener) {
          itemListeners.add(listener);
          return () => {
            itemListeners.delete(listener);
          };
        },
        cancel: () => {
          cancelled.push(streamId);
        },
      };
      if (options.defer === endpoint) {
        const queue = deliveries.get(endpoint) ?? [];
        queue.push((value) => {
          const listeners = [...itemListeners];
          for (const listener of listeners) listener(value);
        });
        deliveries.set(endpoint, queue);
        return handle;
      }
      const value = frames[endpoint];
      if (value !== undefined) {
        // Real mux frames arrive on a later task, after the caller attached its
        // `onItem` listener synchronously below `open()`.
        queueMicrotask(() => {
          const listeners = [...itemListeners];
          for (const listener of listeners) listener(value as DshJsonValue);
        });
      }
      return handle;
    }),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  } as unknown as DshMuxClient;

  return {
    client,
    opened,
    cancelled,
    connectCalls: () => connectCalls,
    flush(endpoint, value) {
      const queue = deliveries.get(endpoint) ?? [];
      deliveries.delete(endpoint);
      for (const deliver of queue) deliver(value as DshJsonValue);
    },
    fail(endpoint, error) {
      for (const reject of rejections.get(endpoint) ?? []) reject(error);
      rejections.delete(endpoint);
    },
    isDeferred: (endpoint) => options.defer === endpoint,
  };
}

function messageBridge() {
  return {
    attachFollow: vi.fn(),
    applyHistory: vi.fn(),
    stop: vi.fn(),
  } satisfies DshBootstrapBridge;
}

/**
 * A mux whose follow handle keeps delivering after the first frame, so a test
 * can drive the frames the bootstrap did NOT consume itself.
 */
function liveMux(firstFrames: Record<string, unknown> = {}) {
  const opened: Array<{ endpoint: string; args: Record<string, unknown> }> = [];
  const handles: Array<{ streamId: string; assistantStream: boolean; listeners: Set<(value: DshJsonValue | undefined) => void> }> =
    [];
  let counter = 0;
  const client = {
    connect: vi.fn(async () => undefined),
    open: vi.fn((endpoint: string, payload: { args: Record<string, unknown> }) => {
      opened.push({ endpoint, args: payload.args });
      const itemListeners = new Set<(value: DshJsonValue | undefined) => void>();
      const promise = new Promise<readonly (DshJsonValue | undefined)[]>(() => undefined);
      void promise.catch(() => undefined);
      const request = payload.args.request;
      const handle = {
        streamId: `stream-${(counter += 1)}`,
        assistantStream: typeof request === 'object' && request !== null && 'assistantStream' in request && request.assistantStream === true,
        listeners: itemListeners,
        promise,
        onItem(listener: (value: DshJsonValue | undefined) => void) {
          itemListeners.add(listener);
          return () => {
            itemListeners.delete(listener);
          };
        },
        cancel: () => undefined,
      };
      handles.push(handle);
      const first = firstFrames[endpoint];
      if (first !== undefined) {
        // Real mux frames arrive on a later task, after the caller attached
        // its `onItem` listener synchronously below `open()`.
        queueMicrotask(() => {
          for (const listener of [...handle.listeners]) listener(first as DshJsonValue);
        });
      }
      return handle;
    }),
    cancel: vi.fn(),
    disconnect: vi.fn(),
    isConnected: vi.fn(() => true),
  };
  return {
    client: client as unknown as DshMuxClient,
    opened,
    deliverAssistant(frame: DshJsonValue) {
      for (const handle of handles) {
        if (!handle.assistantStream) continue;
        for (const listener of handle.listeners) listener({ type: 'assistant-stream', frame });
      }
    },
    deliver(value: DshJsonValue | undefined) {
      for (const handle of handles) {
        for (const listener of [...handle.listeners]) listener(value);
      }
    },
  };
}

class RecordingMessageStore {
  readonly history: unknown[] = [];
  readonly messages = new Map<string, unknown>();
  readonly parts = new Map<string, unknown>();
  updateMessage = vi.fn((info: unknown) => {
    this.messages.set((info as { id: string }).id, info);
  });
  updatePart = vi.fn((part: unknown) => {
    this.parts.set((part as { id: string }).id, part);
  });
  loadHistory(entries: unknown[]) {
    this.history.push(...entries);
  }
}


function normalizer(cursor = 4) {
  return {
    normalizeSnapshot: vi.fn((_snapshot: DshJsonValue | undefined) => ({
      cursor,
      entries: [`snapshot:${cursor}`],
    })),
    normalizeHistoryRecords: vi.fn((records: readonly DshJsonValue[]) =>
      records.map((record) => `record:${JSON.stringify(record)}`),
    ),
  } satisfies DshBootstrapNormalizer;
}

function pageFetcher(windows: readonly DshHistoryWindow[]) {
  const calls: Array<{ sessionId: string; beforeSeq: number }> = [];
  let index = 0;
  const fetcher = vi.fn(async (request: { sessionId: string; beforeSeq: number }) => {
    calls.push(request);
    const window = windows[Math.min(index, windows.length - 1)];
    index += 1;
    return window;
  }) as unknown as DshHistoryPageFetcher & { mock: { calls: unknown[] } };
  return { fetcher, calls };
}

function emptyWindow(): DshHistoryWindow {
  return { records: [], hasMore: false };
}

function windowOf(records: readonly DshJsonValue[], lowestSeq: number, hasMore: boolean): DshHistoryWindow {
  return { records, hasMore, lowestSeq };
}

const OLDER_RECORDS: readonly DshJsonValue[] = [
  { type: 'event', event: { type: 'session/title', seq: 3, time: 5, data: { title: 'older' } } },
];

function harness(input: {
  sessions: readonly DshMappedSession[];
  pages?: readonly DshHistoryWindow[];
  cursor?: number;
  deferFollow?: boolean;
}) {
  const mux = fakeMux({ 'session/follow': SESSION_FOLLOW_SNAPSHOT }, { defer: input.deferFollow ? 'session/follow' : undefined });
  const bridge = messageBridge();
  const pages = pageFetcher(input.pages ?? [windowOf(OLDER_RECORDS, 3, false), emptyWindow()]);
  const normalize = normalizer(input.cursor ?? 4);
  const commit = vi.fn();
  return { mux, bridge, pages, normalize, commit };
}

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

describe('bootstrapDshWorkspace', () => {
  it('fills the project tree, selects the first non-archived non-child session, and subscribes its follow', async () => {
    const { mux, bridge, pages, normalize, commit } = harness({ sessions: sessionsFixture() });
    const source = sessionSource(sessionsFixture());

    const result = await bootstrapDshWorkspace({
      adapter: source,
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    // Stage 1+2: the session tree source (workspace/follow baseline joined onto
    // session/list) is the only data source — no registry, no health check only.
    expect(source.listSessions).toHaveBeenCalledOnce();

    // Stage 3: serverState.projects + selection.
    expect(commit).toHaveBeenCalledWith({
      projects: expect.any(Object),
      selectedProjectId: 'ws-git',
      selectedSessionId: 'session-root',
    });
    const projects = commit.mock.calls[0][0].projects as Record<string, ProjectState>;
    expect(Object.keys(projects).sort()).toEqual(['ws-git', 'ws-plain']);
    expect(projects['ws-git'].worktree).toBe(REPO_DIR);
    const repoSandbox = projects['ws-git'].sandboxes[REPO_DIR];
    expect(Object.keys(repoSandbox.sessions).sort()).toEqual([
      'session-archived',
      'session-child',
      'session-pinned',
      'session-root',
    ]);
    expect(repoSandbox.rootSessions).not.toContain('session-child');
    expect(repoSandbox.sessions['session-archived'].timeArchived).toBe(1);
    expect(repoSandbox.sessions['session-root'].timeArchived).toBeUndefined();
    expect(projects['ws-plain'].sandboxes[NOTES_DIR].sessions['session-notes'].id).toBe('session-notes');

    // Stage 4: default entry excludes archived AND child sessions.
    expect(commit.mock.calls[0][0].selectedSessionId).not.toBe('session-child');
    expect(commit.mock.calls[0][0].selectedSessionId).not.toBe('session-archived');

    // Stage 5: session/follow opened for the selected session only.
    expect(mux.opened).toEqual([
      {
        endpoint: 'session/follow',
        args: { request: { address: { kind: 'session', sessionId: 'session-root' }, assistantStream: true } },
      },
    ]);
    expect(normalize.normalizeSnapshot).toHaveBeenCalledWith(SESSION_FOLLOW_SNAPSHOT);

    // Stage 6: history backfill below the snapshot cursor (R6 open upper bound:
    // cursor 4 → beforeSeq 5), applied before the live subscription.
    expect(pages.calls).toEqual([{ sessionId: 'session-root', beforeSeq: 5 }]);
    expect(bridge.applyHistory).toHaveBeenCalledWith([
      'snapshot:4',
      'record:{"type":"event","event":{"type":"session/title","seq":3,"time":5,"data":{"title":"older"}}}',
    ]);
    // Stage 6: the live follow stream is attached to the bridge exactly once,
    // after the snapshot + history have been applied to it — bound to the
    // entry session the pipeline itself opened it for.
    expect(bridge.attachFollow).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-1' }),
      'session-root',
    );

    // Tree data source for Todo 21 + the live follow handle for Todo 19.
    expect(result.follow?.streamId).toBe('stream-1');
    expect(result.tree.archivedSessionIds).toEqual(['session-archived']);
    expect(result.tree.pinnedSessionIds).toEqual(['session-pinned']);
    expect(result.tree.sessions.map((session) => session.id)).toContain('session-notes');
    const liveProjects: Record<string, ProjectState> = {};
    result.tree.upsertSession(liveProjects, mappedSession({ id: 'session-live', title: 'Live session' }));
    expect(liveProjects['ws-git'].sandboxes[REPO_DIR].sessions['session-live'].title).toBe('Live session');

    // Happy path keeps the transport and the bridge alive.
    expect(bridge.stop).not.toHaveBeenCalled();
    expect(mux.client.disconnect).not.toHaveBeenCalled();
  });

  it('never selects an archived or child session as the default entry', async () => {
    // Every root session is archived and the only other entry is a child.
    const sessions = [
      mappedSession({ id: 'session-child', parentID: 'session-archived', title: 'Child session' }),
      mappedSession({ id: 'session-archived', title: 'Archived session', time: { created: 1, updated: 3, archived: 1 } }),
    ];
    const { mux, bridge, pages, normalize, commit } = harness({ sessions });

    await bootstrapDshWorkspace({
      adapter: sessionSource(sessions),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    expect(commit).toHaveBeenCalledWith({
      projects: expect.any(Object),
      selectedProjectId: '',
      selectedSessionId: '',
    });
    const projects = commit.mock.calls[0][0].projects as Record<string, ProjectState>;
    // Misleading success output guard: the tree is still filled, not skipped.
    expect(Object.keys(repoSessionIds(projects))).toEqual(['session-archived', 'session-child']);
    expect(mux.opened).toEqual([]);
    expect(bridge.attachFollow).not.toHaveBeenCalled();
    expect(bridge.applyHistory).not.toHaveBeenCalled();
    expect(pages.calls).toEqual([]);
  });

  it('opens the follow for the root session when the live wire lists a child first (D5)', async () => {
    // Live order (task-44 wire-shape.json): the NEWEST session is a subagent
    // child. The entry filter can only exclude it if the production mapper
    // reads the wire's `parentSessionId`; a child selected as the entry is
    // addressed `{kind:'session'}` and dsh rejects it with "subagent Sessions
    // require their durable parent address" (reproduced live in ui-recon.json).
    const child = mapDshSessionItem({
      sessionId: 'session-child',
      parentSessionId: 'session-root',
      cwd: REPO_DIR,
      updatedAt: 2,
    });
    const root = mapDshSessionItem({ sessionId: 'session-root', cwd: REPO_DIR, updatedAt: 1 });
    const { mux, bridge, pages, normalize, commit } = harness({ sessions: [child, root] });

    await bootstrapDshWorkspace({
      adapter: sessionSource([child, root]),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    expect(child.parentID).toBe('session-root');
    expect(commit.mock.calls[0][0].selectedSessionId).toBe('session-root');
    expect(mux.opened).toEqual([
      {
        endpoint: 'session/follow',
        args: { request: { address: { kind: 'session', sessionId: 'session-root' }, assistantStream: true } },
      },
    ]);
    expect(bridge.attachFollow).toHaveBeenCalledWith(
      expect.objectContaining({ streamId: 'stream-1' }),
      'session-root',
    );
  });

  it('classifies archived and pinned sessions without dropping them from the tree', async () => {
    const sessions = [
      mappedSession({ id: 'session-archived', title: 'Archived session', time: { created: 1, updated: 3, archived: 1 } }),
      mappedSession({ id: 'session-pinned', title: 'Pinned session', time: { created: 1, updated: 4, pinned: 1 } }),
      mappedSession({ id: 'session-plain', title: 'Plain session' }),
    ];
    const { mux, bridge, pages, normalize, commit } = harness({ sessions });

    const result = await bootstrapDshWorkspace({
      adapter: sessionSource(sessions),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    const projects = commit.mock.calls[0][0].projects as Record<string, ProjectState>;
    const sandbox = projects['ws-git'].sandboxes[REPO_DIR];
    expect(sandbox.sessions['session-archived'].timeArchived).toBe(1);
    expect(sandbox.sessions['session-pinned'].timeArchived).toBeUndefined();
    expect(sandbox.sessions['session-plain'].timeArchived).toBeUndefined();
    expect(Object.keys(sandbox.sessions).sort()).toEqual(['session-archived', 'session-pinned', 'session-plain']);
    expect(result.tree.archivedSessionIds).toEqual(['session-archived']);
    expect(result.tree.pinnedSessionIds).toEqual(['session-pinned']);
    // A pinned root IS a valid default entry; only archived/child are excluded.
    expect(commit.mock.calls[0][0].selectedSessionId).toBe('session-pinned');
  });

  it('presents an empty tree for an empty workspace without throwing', async () => {
    const { mux, bridge, pages, normalize, commit } = harness({ sessions: [] });

    const result = await bootstrapDshWorkspace({
      adapter: sessionSource([]),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    expect(commit).toHaveBeenCalledWith({ projects: {}, selectedProjectId: '', selectedSessionId: '' });
    expect(mux.opened).toEqual([]);
    expect(bridge.attachFollow).not.toHaveBeenCalled();
    expect(bridge.applyHistory).not.toHaveBeenCalled();
    expect(pages.calls).toEqual([]);
    expect(result.follow).toBeUndefined();
    // The transport stays up so the first session created in an empty workspace
    // can open its own follow without a reconnect (kimi bootstrap precedent).
    expect(mux.connectCalls()).toBe(1);
    expect(mux.client.disconnect).not.toHaveBeenCalled();
  });

  it('walks session/page windows backwards with an open upper bound', async () => {
    const { mux, bridge, pages, normalize, commit } = harness({
      sessions: sessionsFixture(),
      cursor: 100,
      pages: [windowOf(OLDER_RECORDS, 40, true), windowOf(OLDER_RECORDS, 12, true), emptyWindow()],
    });

    await bootstrapDshWorkspace({
      adapter: sessionSource(sessionsFixture()),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    // cursor 100 → beforeSeq 101; every later window starts at the previous
    // window's lowest seq (open upper bound, R6 — never the wire hasMore).
    expect(pages.calls).toEqual([
      { sessionId: 'session-root', beforeSeq: 101 },
      { sessionId: 'session-root', beforeSeq: 40 },
      { sessionId: 'session-root', beforeSeq: 12 },
    ]);
    expect(bridge.applyHistory).toHaveBeenCalledWith([
      'snapshot:100',
      'record:{"type":"event","event":{"type":"session/title","seq":3,"time":5,"data":{"title":"older"}}}',
      'record:{"type":"event","event":{"type":"session/title","seq":3,"time":5,"data":{"title":"older"}}}',
    ]);
  });

  it('stops paging when a window stops making progress', async () => {
    // A hostile fetcher that keeps claiming older history with a frozen
    // lowestSeq must not loop forever.
    const { mux, bridge, pages, normalize, commit } = harness({
      sessions: sessionsFixture(),
      cursor: 100,
      pages: [windowOf(OLDER_RECORDS, 40, true), windowOf(OLDER_RECORDS, 40, true), emptyWindow()],
    });

    await bootstrapDshWorkspace({
      adapter: sessionSource(sessionsFixture()),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    expect(pages.calls).toEqual([
      { sessionId: 'session-root', beforeSeq: 101 },
      { sessionId: 'session-root', beforeSeq: 40 },
    ]);
    expect(commit).toHaveBeenCalledOnce();
  });

  it('discards a stale commit and disposes the transport when the backend switches mid-flight', async () => {
    const { mux, bridge, pages, normalize, commit } = harness({ sessions: sessionsFixture(), deferFollow: true });
    let current = true;

    const pending = bootstrapDshWorkspace({
      adapter: sessionSource(sessionsFixture()),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => current,
      commit,
    });

    await vi.waitFor(() => expect(mux.opened.length).toBe(1));
    current = false;
    mux.flush('session/follow', SESSION_FOLLOW_SNAPSHOT);
    await pending;

    expect(commit).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledOnce();
    // Downlink-only follow streams are half-closed with cancel, never `end` (R13).
    expect(mux.cancelled).toEqual(['stream-1']);
    expect(mux.client.disconnect).toHaveBeenCalledOnce();
  });

  it('disposes the transport and rethrows when the session follow stream fails', async () => {
    const { mux, bridge, pages, normalize, commit } = harness({ sessions: sessionsFixture(), deferFollow: true });

    const pending = bootstrapDshWorkspace({
      adapter: sessionSource(sessionsFixture()),
      mux: mux.client,
      createBridge: () => bridge,
      normalize,
      fetchPage: pages.fetcher,
      isCurrent: () => true,
      commit,
    });

    await vi.waitFor(() => expect(mux.opened.length).toBe(1));
    mux.fail('session/follow', new Error('dsh mux: host cancelled stream stream-1'));

    await expect(pending).rejects.toThrow('dsh mux: host cancelled stream stream-1');
    expect(commit).not.toHaveBeenCalled();
    expect(bridge.stop).toHaveBeenCalledOnce();
    expect(mux.cancelled).toEqual(['stream-1']);
    expect(mux.client.disconnect).toHaveBeenCalledOnce();
  });

  it('binds the adopted follow to the entry session so live frames reach the store', async () => {
    // Defect D3: the pipeline consumed the snapshot itself and then handed the
    // handle over with NO session id, so `handleFollowFrame` could not resolve
    // one and every later live frame returned early (empty message list, zero
    // popup windows). Runs the REAL message bridge as the injected one.
    const mux = liveMux({ 'session/follow': SESSION_FOLLOW_SNAPSHOT });
    const store = new RecordingMessageStore();
    const bridge = useDshMessageBridge({
      mux: mux.client,
      rpc: { baseUrl: 'http://localhost:23004/dsh' },
      msg: store,
    });
    const commit = vi.fn();

    await bootstrapDshWorkspace({
      adapter: sessionSource(sessionsFixture()),
      mux: mux.client,
      createBridge: () => bridge,
      normalize: normalizer(),
      fetchPage: () => Promise.resolve(emptyWindow()),
      isCurrent: () => true,
      commit,
    });

    expect(commit).toHaveBeenCalledWith(
      expect.objectContaining({ selectedSessionId: 'session-root' }),
    );
    const appliedBefore = store.messages.size;

    mux.deliver({
      type: 'event',
      event: {
        type: 'assistant/message',
        seq: 9,
        time: 7,
        data: {
          turn: 1,
          step: 1,
          message: { role: 'assistant', content: [{ type: 'text', text: 'Live after bootstrap' }] },
        },
      },
    } as DshJsonValue);

    expect(store.messages.size).toBeGreaterThan(appliedBefore);
    expect(bridge.sessionIds()).toContain('session-root');
    const texts = [...store.parts.values()].map((part) => (part as { text?: string }).text);
    expect(texts).toContain('Live after bootstrap');
    expect(bridge.syncState('session-root')).toEqual({ kind: 'live', cursor: 9 });
  });

  it('receives volatile assistant deltas on the initial selected session before durable completion', async () => {
    // Given: the follow provider only streams assistant frames when requested.
    const mux = liveMux({ 'session/follow': SESSION_FOLLOW_SNAPSHOT });
    const store = new RecordingMessageStore();
    const bridge = useDshMessageBridge({ mux: mux.client, rpc: { baseUrl: 'http://localhost:23004/dsh' }, msg: store });
    await bootstrapDshWorkspace({ adapter: sessionSource(sessionsFixture()), mux: mux.client,
      createBridge: () => bridge, normalize: normalizer(), fetchPage: () => Promise.resolve(emptyWindow()),
      isCurrent: () => true, commit: vi.fn() });
    // When: the initial selected session streams without a durable message yet.
    mux.deliverAssistant({ type: 'start', attemptId: 'initial', turn: 1, step: 1 });
    mux.deliverAssistant({ type: 'chunk', attemptId: 'initial', index: 0, chunk: { type: 'text-delta', text: 'Live initial response' } });
    // Then: the shared message store immediately exposes the streamed response.
    expect([...store.parts.values()]).toEqual([expect.objectContaining({ type: 'text', text: 'Live initial response' })]);
    bridge.stop();
  });
});

function repoSessionIds(projects: Record<string, ProjectState>): Record<string, unknown> {
  return projects['ws-git']?.sandboxes[REPO_DIR]?.sessions ?? {};
}
