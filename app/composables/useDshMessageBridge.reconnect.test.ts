/**
 * Todo 23 — reconnect / replay-boundary hardening for `useDshMessageBridge`.
 *
 * The per-session sync state machine (live → degraded → rebuilding → live,
 * mirroring the kimi Todo 22 precedent) translated to the dsh replay boundary
 * contract (task 7, R1–R16). The adversarial classes under test are the ones
 * the plan names: stale state (late / duplicate / stale-snapshot), resumable
 * flows (busy and pending approvals are re-derived, never falsely restored),
 * and misleading success output (every recovery test asserts FINAL store
 * content equality against a clean single-snapshot golden run — never merely
 * that "a reconnect happened").
 *
 * Contract anchors exercised here:
 *   R1  a snapshot is authoritative full state: the superseded part set is
 *       explicitly cleared through the shared facade's existing `removeMessage`
 *       API and re-applied; already-applied seqs are never replayed;
 *   R2  cursor == asOfSeq == max(seq) is the single watermark;
 *   R4  reconnect recovery is snapshot-only — `session/page` is NEVER used as
 *       the reconnect gap filler (history-only windows per R5/R6 instead);
 *   R9  reopen order: `$events` → follow streams; each stream waits for its
 *       own first frame (ready / snapshot);
 *   R10 clientId is per-connection — a dropped connection voids it;
 *   R11 `$events` is at-most-once: pending approvals are re-derived from the
 *       follow snapshot state, never waited for as replays;
 *   R14 binary / invalid-json frames are fatal: no reconnect;
 *   R15 late frames of dead streams never mutate state;
 *   R16 a host `error` frame kills the stream — recovery is a FRESH open.
 */
import { describe, expect, it, vi } from 'vitest';

import { loadDshWireFixture } from '../backends/dsh/fixtures';
import type {
  DshClientRequest,
  DshJsonValue,
  DshRpcArgs,
  DshSessionEventType,
  DshSessionRecord,
} from '../backends/dsh/types';
import type { MessageInfo, MessagePart } from '../types/sse';
import { DshMuxError } from '../utils/dshMux';
import { createDshSessionSyncState, dshFollowFrameSeq } from './dshSyncStateMachine';
import type {
  DshApprovalRequest,
  DshBridgeStreamHandle,
  DshMessageBridgeOptions,
  DshWaterfallOutcome,
} from './dshMessageBridgeTypes';
import { useDshMessageBridge } from './useDshMessageBridge';

// ---------------------------------------------------------------------------
// Real wire fixture (version-gated by the sidecar, dsh@0.2.0-rc.2)
// ---------------------------------------------------------------------------

const readyFrame = (() => {
  const frame = loadDshWireFixture('wire-events-ready.jsonl').frames[0];
  if (frame.type !== 'item' || frame.value === undefined) throw new Error('fixture is not an item frame');
  return frame.value;
})();

const SESSION_ID = 'session-reconnect-6f1a-4c22-9b8d-2e5a7c901234';

function record(type: DshSessionEventType, seq: number, data: Record<string, unknown>): DshSessionRecord {
  return { type: 'event', event: { type, seq, time: 1790692597000 + seq, data: data as never } };
}

function snapshot(
  sessionId: string,
  records: readonly DshSessionRecord[],
  cursor: number,
  version = 4,
): DshJsonValue {
  return {
    type: 'snapshot',
    header: {
      version,
      id: sessionId,
      createdAt: 1790692532388,
      cwd: '/tmp/opencode/dsh-probe/wsroot',
      isSeeded: false,
      agentPreset: 'standard',
    },
    cursor,
    records,
    hasMore: false,
    projections: { asOfSeq: cursor, values: {} },
  } as unknown as DshJsonValue;
}

/**
 * A cumulative turn log: seq 0 is `turn/start`, seq n is the nth durable
 * assistant message carrying the cumulative text (durable messages REPLACE
 * the streamed text — the whole log reads as `words 1..n`).
 */
function wordLog(words: readonly string[]): DshSessionRecord[] {
  const records: DshSessionRecord[] = [record('turn/start', 0, { turn: 1 })];
  let text = '';
  for (const [index, word] of words.entries()) {
    text = index === 0 ? word : `${text} ${word}`;
    records.push(record('assistant/message', index + 1, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text }] },
    }));
  }
  return records;
}

/** Live `assistant-stream` start: binds the attempt to the turn it streams into. */
function streamStart(attemptId: string, turn: number, step: number): DshJsonValue {
  return {
    type: 'assistant-stream',
    frame: { type: 'start', attemptId, turn, step },
  } as unknown as DshJsonValue;
}

/** Live `assistant-stream` chunk: volatile, carries no seq. */
function streamChunk(attemptId: string, index: number, text: string): DshJsonValue {
  return {
    type: 'assistant-stream',
    frame: {
      type: 'chunk',
      attemptId,
      index,
      chunk: { type: 'text-delta', text },
      time: 1790692598000 + index,
    },
  } as unknown as DshJsonValue;
}

function approvalFrame(eventId: string): DshJsonValue {
  return {
    type: 'waterfall',
    event: 'approval/request',
    eventId,
    agentId: 'agent-main',
    request: { toolName: 'bash', arguments: { command: 'ls -la' } },
  } as unknown as DshJsonValue;
}

function eventIdOf(frame: DshJsonValue): string {
  const value = frame as { eventId?: unknown };
  if (typeof value.eventId !== 'string') throw new Error('frame has no eventId');
  return value.eventId;
}

function readyWith(clientId: string): DshJsonValue {
  return { type: 'ready', clientId, host: { home: '/home/x' } } as unknown as DshJsonValue;
}

const flush = async (): Promise<void> => {
  await Promise.resolve();
  await Promise.resolve();
};

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

class FakeStream implements DshBridgeStreamHandle {
  readonly streamId: string;
  readonly listeners = new Set<(value: DshJsonValue | undefined) => void>();
  cancelled = false;
  private failStream!: (error: Error) => void;
  readonly promise: Promise<readonly (DshJsonValue | undefined)[]>;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.promise = new Promise<readonly (DshJsonValue | undefined)[]>((_resolve, reject) => {
      this.failStream = reject;
    });
    void this.promise.catch(() => undefined);
  }

  onItem(listener: (value: DshJsonValue | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  cancel(): void {
    this.cancelled = true;
  }

  emit(value: DshJsonValue | undefined): void {
    const listeners = [...this.listeners];
    for (const listener of listeners) listener(value);
  }

  drop(error: Error): void {
    this.failStream(error);
  }
}

class FakeMux {
  readonly opened: Array<{ endpoint: string; payload: DshRpcArgs; stream: FakeStream }> = [];
  private readonly lostListeners = new Set<(info: { code?: number; reason?: string }) => void>();
  private readonly readyListeners = new Set<() => void>();

  open(endpoint: string, payload: DshRpcArgs): DshBridgeStreamHandle {
    const stream = new FakeStream(`${endpoint}#${this.opened.length + 1}`);
    this.opened.push({ endpoint, payload, stream });
    return stream;
  }

  onConnectionLost(listener: (info: { code?: number; reason?: string }) => void): () => void {
    this.lostListeners.add(listener);
    return () => this.lostListeners.delete(listener);
  }

  onReconnectReady(listener: () => void): () => void {
    this.readyListeners.add(listener);
    return () => this.readyListeners.delete(listener);
  }

  /** The host closed the socket (heartbeat loss / 1001): backoff + reopen. */
  loseConnection(info: { code?: number; reason?: string } = {}): void {
    const listeners = [...this.lostListeners];
    for (const listener of listeners) listener(info);
  }

  /** The reconnected socket is open and in-flight streams were re-opened (R9). */
  reconnectReady(): void {
    const listeners = [...this.readyListeners];
    for (const listener of listeners) listener();
  }

  events(): FakeStream {
    const found = this.opened.find((entry) => entry.endpoint === '$events');
    if (!found) throw new Error('no $events stream was opened');
    return found.stream;
  }

  followStreams(): FakeStream[] {
    return this.opened.filter((entry) => entry.endpoint === 'session/follow').map((entry) => entry.stream);
  }
}

/** The message facade: identity-keyed like the real `useMessages` store, with the existing `removeMessage` API. */
class RecordingMessageStore {
  readonly messages = new Map<string, MessageInfo>();
  readonly parts = new Map<string, MessagePart>();
  readonly removals: string[] = [];
  readonly history: unknown[] = [];
  messageUpserts = 0;

  updateMessage(info: MessageInfo): void {
    this.messageUpserts += 1;
    this.messages.set(info.id, info);
  }

  updatePart(part: MessagePart): void {
    this.parts.set(part.id, part);
  }

  loadHistory(entries: unknown[]): void {
    this.history.push(...entries);
  }

  removeMessage(id: string): void {
    this.removals.push(id);
    this.messages.delete(id);
    const owned = [...this.parts];
    for (const [partId, part] of owned) {
      if (part.messageID === id) this.parts.delete(partId);
    }
  }

  /** Full content dump for golden equality (no counters, no bookkeeping). */
  dump(): unknown {
    const sortedEntries = (map: Map<string, unknown>) =>
      [...map.entries()].sort(([left], [right]) => left.localeCompare(right));
    return {
      messages: sortedEntries(this.messages),
      parts: sortedEntries(this.parts),
    };
  }

  textOf(messageId: string): string | undefined {
    const part = this.parts.get(`${messageId}:text`);
    return part !== undefined && part.type === 'text' ? part.text : undefined;
  }
}

class WaterfallProviderDouble {
  private readonly pending = new Map<string, { promise: Promise<void>; resolve: () => void; settled: boolean }>();

  expectPending(eventId: string): void {
    if (this.pending.has(eventId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.pending.set(eventId, { promise, resolve, settled: false });
  }

  settle(eventId: string): void {
    const entry = this.pending.get(eventId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.resolve();
  }

  settled(eventId: string): Promise<void> {
    const entry = this.pending.get(eventId);
    if (!entry) return new Promise<void>(() => undefined);
    return entry.promise;
  }

  isSettled(eventId: string): boolean {
    return this.pending.get(eventId)?.settled ?? false;
  }

  pendingCount(): number {
    let count = 0;
    for (const entry of this.pending.values()) if (!entry.settled) count += 1;
    return count;
  }
}

type CapturedResultCall = {
  url: string;
  method: string;
  body: DshClientRequest;
};

type PageCall = { sessionId: string; throughSeq: number; beforeSeq: number };

function jsonResponse(body: unknown) {
  const text = JSON.stringify(body);
  return {
    ok: true,
    status: 200,
    headers: new Headers({ 'content-type': 'application/json' }),
    text: async () => text,
    arrayBuffer: async () => new TextEncoder().encode(text).buffer,
  } as unknown as Response;
}

/** Scripted derivation hook: one deferred resolver per invocation, in order. */
function deferredApprovals() {
  const resolvers: Array<(list: DshApprovalRequest[]) => void> = [];
  const options = {
    reconcileApprovals: (sessionId: string) =>
      new Promise<DshApprovalRequest[]>((resolve) => {
        resolvers.push((list) => resolve(sessionId === SESSION_ID ? list : []));
      }),
    /** Resolve the nth (0-based) derivation with the given pending approvals. */
    resolve(index: number, list: DshApprovalRequest[]): void {
      resolvers[index](list);
    },
    count: () => resolvers.length,
  };
  return options;
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(overrides: Partial<DshMessageBridgeOptions> = {}) {
  const mux = new FakeMux();
  const provider = new WaterfallProviderDouble();
  const store = new RecordingMessageStore();
  const calls: CapturedResultCall[] = [];
  const pages: PageCall[] = [];
  let pageWindows: DshSessionRecord[][] = [];

  const fetcher = async (
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string },
  ): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as DshClientRequest;
    calls.push({ url, method: init.method, body });
    const args = body.payload.args as { eventId?: unknown };
    if (typeof args.eventId === 'string') provider.settle(args.eventId);
    return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
  };

  const pageFetcher = vi.fn(async (request: PageCall) => {
    pages.push(request);
    const records = pageWindows.shift() ?? [];
    return { records: records as unknown as DshJsonValue[] };
  });

  const bridge = useDshMessageBridge({
    mux,
    rpc: { baseUrl: 'http://localhost:23004/dsh', fetcher },
    msg: store,
    fetchPage: pageFetcher,
    ...overrides,
  });

  return {
    bridge,
    mux,
    provider,
    store,
    calls,
    pages,
    /** Script the records the next `session/page` window returns. */
    scriptPages(...windows: DshSessionRecord[][]): void {
      pageWindows = windows;
    },
    argsOf(call: CapturedResultCall): { clientId?: unknown; eventId?: unknown; outcome?: unknown } {
      return call.body.payload.args as { clientId?: unknown; eventId?: unknown; outcome?: unknown };
    },
  };
}

function emitWaterfall(harness: Harness, frame: DshJsonValue): void {
  harness.provider.expectPending(eventIdOf(frame));
  harness.mux.events().emit(frame);
}

/** Apply only the final state to a fresh bridge: the golden reference. */
function goldenStore(records: readonly DshSessionRecord[], cursor: number): unknown {
  const harness = createHarness();
  const follow = new FakeStream('golden-follow');
  harness.bridge.attachFollow(follow);
  follow.emit(snapshot(SESSION_ID, records, cursor));
  return harness.store.dump();
}

// ---------------------------------------------------------------------------
// 1. Connection lifecycle: live → degraded → rebuilding → live (R9/R10)
// ---------------------------------------------------------------------------

describe('dsh message bridge — connection lifecycle (Todo 23)', () => {
  it('degrades on connection loss: voids the per-connection clientId, clears busy and drops the dead broadcast approvals (R10/R11)', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-lost'));

    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 2 });
    expect(harness.bridge.sessionState()?.busy).toBe(true);
    expect(harness.bridge.clientId()).toBeDefined();
    expect(harness.bridge.pendingApprovals()).toHaveLength(1);

    harness.mux.loseConnection({ code: 1001, reason: 'heartbeat lost' });

    // The UI shows a degraded session, never a false live/busy state.
    expect(harness.bridge.syncState()).toEqual({ kind: 'degraded', cursor: 2 });
    expect(harness.bridge.sessionState()?.busy).toBe(false);
    // R10: the dropped connection's clientId is void from here on.
    expect(harness.bridge.clientId()).toBeUndefined();
    // R11: approvals came from the dead broadcast — the reconnect snapshot
    // re-derives them from session state instead of waiting for replays.
    expect(harness.bridge.pendingApprovals()).toHaveLength(0);
  });

  it('moves degraded → rebuilding on reconnect and switches to the snapshot as authoritative full state (R9/R1)', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));
    harness.mux.loseConnection({ code: 1001 });

    harness.mux.reconnectReady();
    expect(harness.bridge.syncState()).toEqual({ kind: 'rebuilding', cursor: 2 });

    // The re-opened follow stream's first frame is the full snapshot (R9).
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three']), 3));
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 3 });
    expect(harness.bridge.cursor()).toBe(3);
    // R1: authoritative switch — the superseded part set was explicitly
    // cleared through the shared facade, then re-applied from the snapshot.
    expect(harness.store.removals).toContain(`${SESSION_ID}:t1`);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two three');
    // Final content equals a clean single apply of the same final state.
    expect(harness.store.dump()).toEqual(goldenStore(wordLog(['one', 'two', 'three']), 3));
  });
});

// ---------------------------------------------------------------------------
// 2. Disconnect-window recovery: no loss, no duplication (R1/R4)
// ---------------------------------------------------------------------------

describe('dsh message bridge — disconnect window recovery (Todo 23)', () => {
  it('recovers the disconnect window from the snapshot without replaying applied events', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four', 'five']), 5));
    harness.mux.loseConnection({ code: 1001 });

    // Two events produced during the window arrive in flight on the dying
    // connection: they are held for the authoritative switch, not applied.
    follow.emit(wordLog(['one', 'two', 'three', 'four', 'five', 'six', 'seven'])[6]);
    follow.emit(wordLog(['one', 'two', 'three', 'four', 'five', 'six', 'seven'])[7]);
    harness.mux.reconnectReady();
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four', 'five', 'six', 'seven']), 7));

    expect(harness.bridge.cursor()).toBe(7);
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 7 });
    // No loss / no duplication: the final store is identical to a clean single
    // apply of the same final state (the snapshot covered the buffered window
    // frames, so they were never replayed on top of it).
    expect(harness.store.dump()).toEqual(
      goldenStore(wordLog(['one', 'two', 'three', 'four', 'five', 'six', 'seven']), 7),
    );
  });

  it('buffers frames admitted while rebuilding and applies them in seq order after the snapshot', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    const full = wordLog(['one', 'two', 'three', 'four', 'five', 'six', 'seven', 'eight', 'nine', 'ten']);
    follow.emit(snapshot(SESSION_ID, full.slice(0, 6), 5));

    // A gap: seq 8 arrives while 6 and 7 were lost in transit. The session must
    // rebuild from authority instead of silently skipping the missing seqs.
    follow.emit(full[8]);
    expect(harness.bridge.syncState().kind).toBe('rebuilding');
    // R16-style recovery: a FRESH follow open (new streamId, same session).
    // (The attached stream came in through attachFollow, so the mux seam only
    // ever shows the bridge's own opens: $events first, then the fresh follow.)
    const reopened = harness.mux.opened.filter((entry) => entry.endpoint === 'session/follow');
    expect(reopened).toHaveLength(1);
    expect(reopened[0].payload).toEqual({
      args: { request: { address: { kind: 'session', sessionId: SESSION_ID } } },
    });
    const fresh = reopened[0].stream;
    expect(fresh.streamId).not.toBe('sf1');

    // Frames keep arriving while the authoritative snapshot is pending.
    follow.emit(full[9]);
    follow.emit(full[10]);
    expect(harness.bridge.cursor()).toBe(5);

    // The fresh stream's snapshot covers 0..7; the buffered 8,9,10 are then
    // applied in arrival order on top of it — final content is the full log.
    fresh.emit(snapshot(SESSION_ID, full.slice(0, 8), 7));
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 10 });
    expect(harness.store.dump()).toEqual(goldenStore(full, 10));
  });

  it('drops a stale snapshot instead of overwriting newer state (cursor compare)', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four', 'five']), 5));

    // A second stream (legal: concurrent follow of one session) delivers a
    // LATE snapshot whose cursor is behind the applied watermark.
    const stale = new FakeStream('sf-stale');
    harness.bridge.attachFollow(stale);
    stale.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three']), 3));
    expect(harness.bridge.cursor()).toBe(5);
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 5 });
    expect(harness.store.removals).toHaveLength(0);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two three four five');

    // A late record at or below the watermark is dropped, never replayed.
    stale.emit(record('assistant/message', 4, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'stale replay' }] },
    }));
    expect(harness.bridge.cursor()).toBe(5);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two three four five');

    // A genuinely newer snapshot still switches authoritatively.
    stale.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four', 'five', 'six']), 6));
    expect(harness.bridge.cursor()).toBe(6);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two three four five six');
  });
});

// ---------------------------------------------------------------------------
// 3. UI state honesty: busy/streaming are re-derived, never falsely restored (R11)
// ---------------------------------------------------------------------------

describe('dsh message bridge — resumable flows after reconnect (Todo 23)', () => {
  it('re-derives busy from the snapshot turn records; durable content replaces the streamed delta', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, [record('turn/start', 0, { turn: 1 })], 0));
    follow.emit(streamStart('a1', 1, 1));
    follow.emit(streamChunk('a1', 0, 'partial '));
    expect(harness.bridge.sessionState()?.busy).toBe(true);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('partial ');

    harness.mux.loseConnection({ code: 1001 });
    // No false streaming state while the transport is down.
    expect(harness.bridge.sessionState()?.busy).toBe(false);
    harness.mux.reconnectReady();
    expect(harness.bridge.syncState()).toEqual({ kind: 'rebuilding', cursor: 0 });

    // The turn ENDED during the window: the authoritative snapshot carries
    // turn/end, so busy is re-derived false (not the stale pre-drop true).
    const finalRecords = [
      record('turn/start', 0, { turn: 1 }),
      record('assistant/message', 1, {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'partial final answer' }] },
      }),
      record('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }),
    ];
    follow.emit(snapshot(SESSION_ID, finalRecords, 2));

    expect(harness.bridge.sessionState()?.busy).toBe(false);
    expect(harness.bridge.sessionState()?.completion).toEqual({ kind: 'completed' });
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('partial final answer');
    expect(harness.store.dump()).toEqual(goldenStore(finalRecords, 2));
  });

  it('re-derives busy TRUE when the authoritative snapshot still shows an in-flight turn', () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    const inFlight = [
      record('turn/start', 0, { turn: 1 }),
      record('assistant/message', 1, {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'still going' }] },
      }),
    ];
    follow.emit(snapshot(SESSION_ID, inFlight, 1));
    expect(harness.bridge.sessionState()?.busy).toBe(true);

    harness.mux.loseConnection({ code: 1001 });
    expect(harness.bridge.sessionState()?.busy).toBe(false);
    harness.mux.reconnectReady();
    follow.emit(snapshot(SESSION_ID, inFlight, 1));

    // busy comes from the snapshot's turn records — authoritative, not stale.
    expect(harness.bridge.sessionState()?.busy).toBe(true);
  });

  it('re-derives pending approvals from session state and never answers with the dead connection clientId (R10/R11)', async () => {
    const derived: string[] = [];
    const approvals = deferredApprovals();
    const harness = createHarness({
      reconcileApprovals: approvals.reconcileApprovals,
      onApprovalRequest: (request) => {
        derived.push(request.eventId);
        harness.provider.expectPending(request.eventId);
      },
    });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, [record('turn/start', 0, { turn: 1 })], 0));
    await flush();
    expect(approvals.count()).toBe(1);

    // No ready frame yet: the approval is surfaced and the user's answer is
    // held back (no connection clientId to answer with).
    emitWaterfall(harness, approvalFrame('evt-dead'));
    expect(derived).toEqual(['evt-dead']);
    harness.bridge.resolveApproval('evt-dead', { kind: 'next' });
    await flush();
    expect(harness.calls).toHaveLength(0);

    // The connection dies; the new one gets a fresh per-connection clientId.
    harness.mux.loseConnection({ code: 1001 });
    harness.mux.reconnectReady();
    harness.mux.events().emit(readyWith('client-B'));
    await flush();
    // The held answer belonged to the dead connection: it is dropped, never
    // flushed with a clientId the request does not belong to.
    expect(harness.calls).toHaveLength(0);

    // The reconnect snapshot re-derives the pending approvals from session
    // state — including the one whose answer was dropped.
    follow.emit(snapshot(SESSION_ID, [record('turn/start', 0, { turn: 1 })], 0));
    await flush();
    expect(approvals.count()).toBe(2);
    approvals.resolve(1, [
      { eventId: 'evt-dead', agentId: 'agent-main', sessionId: SESSION_ID, request: { toolName: 'bash' } },
      { eventId: 'evt-recovered', agentId: 'agent-main', sessionId: SESSION_ID, request: { toolName: 'write' } },
    ]);
    await flush();

    expect(derived).toEqual(['evt-dead', 'evt-dead', 'evt-recovered']);
    expect(harness.bridge.pendingApprovals().map((entry) => entry.eventId)).toEqual([
      'evt-dead',
      'evt-recovered',
    ]);
    harness.bridge.resolveApproval('evt-recovered', { kind: 'next' });
    await harness.provider.settled('evt-recovered');
    expect(harness.calls).toHaveLength(1);
    expect(harness.argsOf(harness.calls[0])).toEqual({
      clientId: 'client-B',
      eventId: 'evt-recovered',
      outcome: { kind: 'next' },
    });
    // The dead event was never answered on any connection.
    expect(harness.provider.isSettled('evt-dead')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 4. session/page history fill: R5/R6 params, R4 never as reconnect gap fill
// ---------------------------------------------------------------------------

describe('dsh message bridge — session/page history window (Todo 23)', () => {
  it('fills a history window below the cursor with contract params and never duplicates', async () => {
    const onToolPart = vi.fn();
    const harness = createHarness({ onToolPart });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    const words = ['a', 'b', 'c', 'd', 'e', 'f', 'g', 'h', 'i', 'j'];
    follow.emit(snapshot(SESSION_ID, wordLog(words), 10));
    const before = harness.store.dump();
    // The window below the open upper bound: seq 0..5.
    harness.scriptPages(wordLog(words).slice(0, 6));

    // beforeSeq is the OPEN upper bound; throughSeq must be ≤ cursor (R6).
    const fill = await harness.bridge.fillHistoryWindow(SESSION_ID, { beforeSeq: 6 });
    expect(harness.pages).toEqual([{ sessionId: SESSION_ID, beforeSeq: 6, throughSeq: 10 }]);
    expect(fill).toEqual({
      ok: true,
      request: { sessionId: SESSION_ID, beforeSeq: 6, throughSeq: 10 },
      applied: 0,
      duplicates: 6,
    });
    // The window was already covered by the snapshot: idempotent, no popups.
    expect(harness.store.dump()).toEqual(before);
    expect(harness.bridge.cursor()).toBe(10);
    expect(onToolPart).not.toHaveBeenCalled();
  });

  it('applies a page window through the replay path (no popups) when it carries records the bridge has not applied', async () => {
    const onToolPart = vi.fn();
    const onReconcilePart = vi.fn();
    const harness = createHarness({ onToolPart, onReconcilePart });
    const follow = new FakeStream('sf1');
    // Join-time binding: bootstrap consumed the snapshot, so the session is
    // known before the bridge's first (live) frame arrives.
    harness.bridge.attachFollow(follow, SESSION_ID);
    follow.emit(record('assistant/message', 11, {
      turn: 2,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'live join' }] },
    }));
    expect(harness.bridge.cursor()).toBe(11);
    harness.scriptPages(wordLog(['old turn']));

    const fill = await harness.bridge.fillHistoryWindow(SESSION_ID);
    expect(fill).toEqual({
      ok: true,
      request: { sessionId: SESSION_ID, throughSeq: 11, beforeSeq: 12 },
      applied: 2,
      duplicates: 0,
    });
    // History arrives as replay: close-only callbacks, never popups.
    expect(onToolPart).not.toHaveBeenCalled();
    expect(onReconcilePart).toHaveBeenCalled();
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('old turn');
    expect(harness.store.textOf(`${SESSION_ID}:t2`)).toBe('live join');
    // History replay must not fabricate transient UI state: the window's
    // partial turn (start without end) never sets busy.
    expect(harness.bridge.sessionState()?.busy).toBeFalsy();
  });

  it('refuses page requests above the watermark and never pages during reconnect recovery (R4/R6)', async () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));

    // throughSeq above the cursor is a wire bad-request: refuse client-side.
    harness.scriptPages(wordLog(['nope']));
    const above = await harness.bridge.fillHistoryWindow(SESSION_ID, { throughSeq: 99 });
    expect(above).toEqual({ ok: false, reason: 'through-seq-above-cursor' });
    // A window reaching above the watermark is not history-only.
    const aboveWindow = await harness.bridge.fillHistoryWindow(SESSION_ID, { beforeSeq: 99 });
    expect(aboveWindow).toEqual({ ok: false, reason: 'before-seq-above-cursor' });
    expect(harness.pages).toHaveLength(0);

    // A full loss → recovery cycle never touches session/page (R4).
    harness.mux.loseConnection({ code: 1001 });
    harness.mux.reconnectReady();
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three']), 3));
    expect(harness.bridge.cursor()).toBe(3);
    expect(harness.pages).toHaveLength(0);
  });

  it('refuses a page fill while no follow watermark exists (R7)', async () => {
    const harness = createHarness();
    const fill = await harness.bridge.fillHistoryWindow('session-unknown');
    expect(fill).toEqual({ ok: false, reason: 'no-watermark' });
    expect(harness.pages).toHaveLength(0);
  });

  it('drops a page fill that a snapshot superseded mid-flight (generation fence)', async () => {
    const onReconcilePart = vi.fn();
    let releasePage!: (records: DshSessionRecord[]) => void;
    const pageFetcher = vi.fn(
      () =>
        new Promise<{ records: DshSessionRecord[] }>((resolve) => {
          releasePage = (records) => resolve({ records: records as never });
        }),
    );
    const harness = createHarness({ onReconcilePart, fetchPage: pageFetcher as never });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three']), 3));

    // A slow history window is in flight when the reconnect snapshot lands.
    const fill = harness.bridge.fillHistoryWindow(SESSION_ID, { beforeSeq: 2 });
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four']), 4));
    const reconcileCalls = onReconcilePart.mock.calls.length;
    releasePage(wordLog(['one']));
    const result = await fill;

    expect(result).toEqual({ ok: false, reason: 'stale' });
    expect(harness.bridge.cursor()).toBe(4);
    // The stale window applied nothing: no new replay traffic after the fence.
    expect(onReconcilePart.mock.calls.length).toBe(reconcileCalls);
  });
});

// ---------------------------------------------------------------------------
// 5. Fatal frames, stale commits, late frames (R14/R15, generation discipline)
// ---------------------------------------------------------------------------

describe('dsh message bridge — terminal and stale commits (Todo 23)', () => {
  it('marks the session detached on a fatal frame and does not reconnect (R14)', async () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));
    const opensBefore = harness.mux.opened.length;

    follow.drop(new DshMuxError('binary-frame', 'dsh mux: binary frame received'));
    await flush();

    expect(harness.bridge.syncState()).toEqual({ kind: 'detached' });
    // A protocol violation is the client's own bug: no reconnect (R14).
    expect(harness.mux.opened).toHaveLength(opensBefore);

    // R15: a late frame on the dead stream never mutates state.
    follow.emit(record('assistant/message', 3, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'text', text: 'late' }] },
    }));
    expect(harness.bridge.cursor()).toBe(2);
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two');
  });

  it('re-opens a fresh follow stream with a new streamId when the host errors the stream (R16)', async () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));

    follow.drop(
      new DshMuxError('stream-error', 'api gateway: Remote stream uplink item after end', {
        remoteError: { code: 'gateway/protocol', message: 'stream failed' } as never,
      }),
    );
    await flush();

    // The stream is dead: the bridge rebuilds with a FRESH open (same
    // connection, new streamId — measured legal, never a 1008).
    expect(harness.bridge.syncState()).toEqual({ kind: 'rebuilding', cursor: 2 });
    const reopened = harness.mux.opened.filter((entry) => entry.endpoint === 'session/follow');
    expect(reopened).toHaveLength(1);
    expect(reopened[0].stream.streamId).not.toBe('sf1');
    expect(reopened[0].payload).toEqual({
      args: { request: { address: { kind: 'session', sessionId: SESSION_ID } } },
    });

    reopened[0].stream.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three']), 3));
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 3 });
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('one two three');
  });

  it('fences a stale reconciliation commit after a backend switch (generation discipline)', async () => {
    const derived: string[] = [];
    const approvals = deferredApprovals();
    const harness = createHarness({
      reconcileApprovals: approvals.reconcileApprovals,
      onApprovalRequest: (request) => {
        derived.push(request.eventId);
        harness.provider.expectPending(request.eventId);
      },
    });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, wordLog(['one', 'two']), 2));
    await flush();
    expect(approvals.count()).toBe(1);

    // Backend switch: a fresh authoritative snapshot lands on a new stream
    // before the old attempt's deferred derivation resolves.
    const switched = new FakeStream('sf-switched');
    harness.bridge.attachFollow(switched);
    switched.emit(snapshot(SESSION_ID, wordLog(['one', 'two', 'three', 'four', 'five', 'six']), 6));
    await flush();
    expect(harness.bridge.cursor()).toBe(6);
    expect(approvals.count()).toBe(2);

    // The stale attempt's approval derivation lands late: dropped.
    approvals.resolve(0, [
      { eventId: 'evt-stale', agentId: 'agent-main', sessionId: SESSION_ID, request: {} },
    ]);
    await flush();
    expect(derived).toEqual([]);

    // The current attempt's derivation still applies.
    approvals.resolve(1, [
      { eventId: 'evt-current', agentId: 'agent-main', sessionId: SESSION_ID, request: {} },
    ]);
    await flush();
    expect(derived).toEqual(['evt-current']);
  });
});

// ---------------------------------------------------------------------------
// 6. Pure state machine unit table (the invariants, without I/O)
// ---------------------------------------------------------------------------

describe('dsh session sync state machine (Todo 23)', () => {
  it('follows live → degraded → rebuilding → live with generation fencing', () => {
    const sync = createDshSessionSyncState();
    expect(sync.phase()).toBe('live');
    const first = sync.generation();

    sync.markConnectionLost();
    expect(sync.phase()).toBe('degraded');
    expect(sync.isCurrent(first)).toBe(false);

    sync.markAwaitingSnapshot();
    expect(sync.phase()).toBe('rebuilding');

    sync.commitSnapshot(9, 4);
    expect(sync.phase()).toBe('live');
    expect(sync.cursor()).toBe(9);
  });

  it('admits the first frame unsynchronized, then gates duplicates and gaps', () => {
    const sync = createDshSessionSyncState();
    const frame = (seq: number) => ({ type: 'event', event: { type: 'session/title', seq, time: 1, data: {} } });

    // Joining mid-stream: the first frame is accepted whatever its seq.
    expect(sync.admitFrame(frame(11))).toEqual({ action: 'apply' });
    sync.noteApplied(11);
    expect(sync.cursor()).toBe(11);

    expect(sync.admitFrame(frame(11))).toEqual({ action: 'drop' });
    expect(sync.admitFrame(frame(12))).toEqual({ action: 'apply' });
    // A gap forces a rebuild instead of silently skipping seqs.
    expect(sync.admitFrame(frame(15))).toEqual({ action: 'gap' });
    expect(sync.phase()).toBe('rebuilding');
    expect(sync.bufferedCount()).toBe(1);
  });

  it('plans history page windows with the R6 bounds', () => {
    const sync = createDshSessionSyncState();
    expect(sync.planHistoryPage({ sessionId: 's' })).toEqual({
      ok: false,
      reason: 'no-watermark',
    });

    sync.commitSnapshot(10, 4);
    const plan = sync.planHistoryPage({ sessionId: 's' });
    expect(plan.ok).toBe(true);
    if (!plan.ok) throw new Error('expected a page plan');
    expect(plan.request).toEqual({ sessionId: 's', throughSeq: 10, beforeSeq: 11 });
    expect(sync.planHistoryPage({ sessionId: 's', beforeSeq: 6 })).toEqual({
      ok: true,
      request: { sessionId: 's', throughSeq: 10, beforeSeq: 6 },
    });
    expect(sync.planHistoryPage({ sessionId: 's', throughSeq: 11 })).toEqual({
      ok: false,
      reason: 'through-seq-above-cursor',
    });
    expect(sync.planHistoryPage({ sessionId: 's', beforeSeq: 12 })).toEqual({
      ok: false,
      reason: 'before-seq-above-cursor',
    });
  });

  it('caps the rebuild buffer and extracts the follow frame seq', () => {
    const sync = createDshSessionSyncState({ maxBufferedFrames: 3 });
    sync.markConnectionLost();
    sync.markAwaitingSnapshot();
    const frame = (seq: number) => ({ type: 'event', event: { type: 'session/title', seq, time: 1, data: {} } });
    for (const seq of [1, 2, 3]) expect(sync.admitFrame(frame(seq))).toEqual({ action: 'buffer' });
    expect(sync.bufferedCount()).toBe(3);

    // Overflow discards the queue (the pending snapshot is a full replay) and
    // fences whatever was waiting on the old buffer.
    const generation = sync.generation();
    expect(sync.admitFrame(frame(4))).toEqual({ action: 'buffer' });
    expect(sync.bufferedCount()).toBe(0);
    expect(sync.isCurrent(generation)).toBe(false);
    expect(sync.admitFrame(frame(5))).toEqual({ action: 'buffer' });
    expect(sync.bufferedCount()).toBe(1);

    expect(dshFollowFrameSeq({ type: 'event', event: { type: 'x', seq: 7 } })).toBe(7);
    expect(dshFollowFrameSeq({ type: 'item', value: { type: 'event', event: { seq: 8 } } })).toBe(8);
    expect(dshFollowFrameSeq({ type: 'snapshot' })).toBeUndefined();
    expect(dshFollowFrameSeq(undefined)).toBeUndefined();
  });

  it('treats a version change as a new sequence and a lower cursor as stale', () => {
    const sync = createDshSessionSyncState();
    sync.commitSnapshot(17, 4);
    expect(sync.planSnapshot({ cursor: 5, version: 4 })).toEqual({ action: 'drop-stale' });

    // A new snapshot version discards the old sequence (epoch change).
    expect(sync.planSnapshot({ cursor: 2, version: 5 })).toEqual({ action: 'apply', buffered: [] });
    sync.commitSnapshot(2, 5);
    expect(sync.cursor()).toBe(2);
    expect(sync.planSnapshot({ cursor: 5, version: 5 })).toEqual({ action: 'apply', buffered: [] });
  });
});

// ---------------------------------------------------------------------------
// 7. Landed behavior stays intact while restoring live semantics
// ---------------------------------------------------------------------------

describe('dsh message bridge — live semantics after hardening (Todo 23)', () => {
  it('keeps applying live frames with popup surfaces after a recovery cycle', () => {
    const onToolPart = vi.fn();
    const harness = createHarness({ onToolPart });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, [record('turn/start', 0, { turn: 1 })], 0));
    harness.mux.loseConnection({ code: 1001 });
    harness.mux.reconnectReady();
    follow.emit(snapshot(SESSION_ID, [record('turn/start', 0, { turn: 1 })], 0));

    follow.emit(record('tool/call', 1, {
      turn: 1,
      step: 1,
      callId: 'call-live',
      name: 'read',
      arguments: { path: 'a.ts' },
    }));
    expect(onToolPart).toHaveBeenCalledTimes(1);
    expect(onToolPart.mock.calls[0][0]).toMatchObject({ type: 'tool', callID: 'call-live' });
    expect(harness.bridge.syncState()).toEqual({ kind: 'live', cursor: 1 });

    // A live volatile assistant delta still streams while live.
    follow.emit(streamStart('a9', 1, 1));
    follow.emit(streamChunk('a9', 0, 'delta '));
    expect(harness.store.textOf(`${SESSION_ID}:t1`)).toBe('delta ');
  });

  it('keeps the terminal waterfall answer path intact across a degraded window', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-alive'));
    harness.mux.loseConnection({ code: 1001 });
    harness.mux.reconnectReady();
    harness.mux.events().emit(readyWith('client-C'));
    emitWaterfall(harness, approvalFrame('evt-after'));

    harness.bridge.resolveApproval('evt-alive', { kind: 'result', value: { approved: true } });
    harness.bridge.resolveApproval('evt-after', { kind: 'next' });
    await Promise.all([harness.provider.settled('evt-alive'), harness.provider.settled('evt-after')]);
    expect(harness.calls).toHaveLength(2);
    const outcomes = harness.calls.map((call) => harness.argsOf(call).outcome as DshWaterfallOutcome);
    expect(outcomes.map((outcome) => outcome.kind)).toEqual(['result', 'next']);
  });
});
