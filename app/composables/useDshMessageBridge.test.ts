/**
 * Todo 19 — `useDshMessageBridge` (dsh web 0.2.0-rc.2, docs/dsh.md §8.1/§8.2).
 *
 * The bridge hangs BOTH mux streams the dsh control plane needs — the `$events`
 * logical stream (ready / emit / waterfall / cancel) and the target session's
 * `session/follow` (snapshot + incremental items) — and owns the two rules
 * that keep a turn from hanging forever:
 *
 *   1. every `waterfall` frame gets a terminal answer through
 *      `POST /dsh/$events/result` whose body is the FULL client-request
 *      envelope with `payload.args = {clientId, eventId, outcome}` (the
 *      protocol correction: `{args:{…}}` is the envelope payload, not the
 *      whole HTTP body);
 *   2. `user-questions/request` and a capability-degraded approval UI are
 *      answered with the safe-rejection outcome — never recorded and dropped
 *      (docs/dsh.md:368: an unanswered waterfall request hangs the agent's
 *      turn forever — review blocker #7).
 *
 * The test double below models the dsh side as a *provider* whose pending
 * request promise only settles when an answer POST actually lands, so the
 * settle assertions prove the turn would resume — not merely that a fetch
 * was invoked. A waterfall frame whose answer never arrives therefore NEVER
 * settles its promise and the test fails by timeout instead of passing.
 *
 * Fidelity: the ready frame and the follow snapshot are loaded from the real
 * version-gated wire fixtures (`.meta.json` anchors dsh@0.2.0-rc.2). The
 * waterfall frames themselves have no live capture yet (DEEPSEEK_API_KEY was
 * absent in the task-6 run — see degraded-capture-record.md), so they are
 * shaped strictly after the `DshEventsWaterfallFrame` contract in
 * `app/backends/dsh/types.ts` / docs/dsh.md §8.1; the bridge treats the
 * request payload as an opaque value either way.
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
import type {
  DshApprovalRequest,
  DshBridgeStreamHandle,
  DshMessageBridgeOptions,
  DshWaterfallOutcome,
} from './dshMessageBridgeTypes';
import { useDshMessageBridge } from './useDshMessageBridge';
import { DshMuxError } from '../utils/dshMux';

// ---------------------------------------------------------------------------
// Real wire fixtures (version-gated by the sidecars)
// ---------------------------------------------------------------------------

const readyFrame = (() => {
  const frame = loadDshWireFixture('wire-events-ready.jsonl').frames[0];
  if (frame.type !== 'item' || frame.value === undefined) throw new Error('fixture is not an item frame');
  return frame.value;
})();

const READY_CLIENT_ID = (() => {
  const value = readyFrame as { clientId?: unknown };
  if (typeof value.clientId !== 'string') throw new Error('ready fixture has no clientId');
  return value.clientId;
})();

const followSnapshot = (() => {
  const frame = loadDshWireFixture('wire-session-follow-snapshot.jsonl').frames[0];
  if (frame.type !== 'item' || frame.value === undefined) throw new Error('fixture is not an item frame');
  return frame.value;
})();

const SESSION_ID = (() => {
  const header = (followSnapshot as { header?: { id?: unknown } }).header;
  if (typeof header?.id !== 'string') throw new Error('snapshot fixture has no session id');
  return header.id;
})();

const snapshotRecords = (followSnapshot as { records: DshSessionRecord[] }).records;
const CHILD_SESSION_ID = 'session-child-9f1c-4d2b-8a7e-11c3d5e7f901';

function record(type: DshSessionEventType, seq: number, data: Record<string, unknown>): DshSessionRecord {
  return { type: 'event', event: { type, seq, time: 1790692597000 + seq, data: data as never } };
}

function snapshot(
  sessionId: string,
  records: readonly DshSessionRecord[],
  cursor: number,
): DshJsonValue {
  return {
    type: 'snapshot',
    header: {
      version: 4,
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

function approvalFrame(eventId: string): DshJsonValue {
  return {
    type: 'waterfall',
    event: 'approval/request',
    eventId,
    agentId: 'agent-main',
    request: { toolName: 'bash', arguments: { command: 'ls -la' } },
  } as unknown as DshJsonValue;
}

function userQuestionsFrame(eventId: string): DshJsonValue {
  return {
    type: 'waterfall',
    event: 'user-questions/request',
    eventId,
    agentId: 'agent-main',
    request: { questions: [{ id: 'q1', question: 'which branch?' }] },
  } as unknown as DshJsonValue;
}

function eventIdOf(frame: DshJsonValue): string {
  const value = frame as { eventId?: unknown };
  if (typeof value.eventId !== 'string') throw new Error('frame has no eventId');
  return value.eventId;
}

// ---------------------------------------------------------------------------
// Doubles
// ---------------------------------------------------------------------------

class FakeStream implements DshBridgeStreamHandle {
  readonly streamId: string;
  readonly listeners = new Set<(value: DshJsonValue | undefined) => void>();
  cancelled = false;
  private releaseStream!: () => void;
  private failStream!: (error: Error) => void;
  readonly promise: Promise<readonly (DshJsonValue | undefined)[]>;

  constructor(streamId: string) {
    this.streamId = streamId;
    this.promise = new Promise<readonly (DshJsonValue | undefined)[]>((resolve, reject) => {
      this.releaseStream = () => resolve([]);
      this.failStream = reject;
    });
    void this.promise.catch(() => undefined);
  }

  onItem(listener: (value: DshJsonValue | undefined) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }

  /** Half-close is `cancel`; this handle exposes no uplink `end` by design (R13). */
  cancel(): void {
    this.cancelled = true;
  }

  emit(value: DshJsonValue | undefined): void {
    const current = [...this.listeners];
    for (const listener of current) listener(value);
  }

  drop(error: Error): void {
    this.failStream(error);
  }

  end(): void {
    this.releaseStream();
  }
}

class FakeMux {
  readonly opened: Array<{ endpoint: string; payload: DshRpcArgs; stream: FakeStream }> = [];

  open(endpoint: string, payload: DshRpcArgs): DshBridgeStreamHandle {
    const stream = new FakeStream(`${endpoint}#${this.opened.length + 1}`);
    this.opened.push({ endpoint, payload, stream });
    return stream;
  }

  events(): FakeStream {
    const found = this.opened.find((entry) => entry.endpoint === '$events');
    if (!found) throw new Error('no $events stream was opened');
    return found.stream;
  }
}

/**
 * The dsh host, modelled as a provider: every waterfall request blocks the
 * turn until the answer POST lands, which is exactly the hang documented at
 * docs/dsh.md:368.
 */
class WaterfallProviderDouble {
  private readonly pending = new Map<
    string,
    { promise: Promise<void>; resolve: () => void; settled: boolean }
  >();

  expectPending(eventId: string): void {
    if (this.pending.has(eventId)) return;
    let resolve!: () => void;
    const promise = new Promise<void>((res) => {
      resolve = res;
    });
    this.pending.set(eventId, { promise, resolve, settled: false });
  }

  /** Called when the answer POST actually lands: the turn resumes. */
  settle(eventId: string): void {
    const entry = this.pending.get(eventId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.resolve();
  }

  /** Never resolves for an unregistered event, so a dropped frame fails the test. */
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
  authorization?: string;
  body: DshClientRequest;
};

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

class FakeMessageStore {
  readonly messages = new Map<string, MessageInfo>();
  readonly parts = new Map<string, MessagePart>();
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
}

type Harness = ReturnType<typeof createHarness>;

function createHarness(overrides: Partial<DshMessageBridgeOptions> = {}) {
  const mux = new FakeMux();
  const provider = new WaterfallProviderDouble();
  const store = new FakeMessageStore();
  const calls: CapturedResultCall[] = [];

  const fetcher = async (
    url: string,
    init: { method: 'POST'; headers: Record<string, string>; body: string },
  ): Promise<Response> => {
    const body = JSON.parse(String(init.body)) as DshClientRequest;
    calls.push({ url, method: init.method, authorization: init.headers?.Authorization, body });
    const args = body.payload.args as { eventId?: unknown };
    if (typeof args.eventId === 'string') provider.settle(args.eventId);
    return jsonResponse({ type: 'server-response', rpcId: body.rpcId, result: { ok: true, value: {} } });
  };

  const bridge = useDshMessageBridge({
    mux,
    rpc: { baseUrl: 'http://localhost:23004/dsh', fetcher },
    msg: store,
    ...overrides,
  });

  return { bridge, mux, provider, store, calls };
}

/** Emit a waterfall frame the way the host would: the turn blocks on it. */
function emitWaterfall(
  harness: Harness,
  frame: DshJsonValue,
): void {
  harness.provider.expectPending(eventIdOf(frame));
  harness.mux.events().emit(frame);
}

function argsOf(call: CapturedResultCall): {
  clientId?: unknown;
  eventId?: unknown;
  outcome?: unknown;
} {
  return call.body.payload.args as { clientId?: unknown; eventId?: unknown; outcome?: unknown };
}

// ---------------------------------------------------------------------------
// 1. Dual-stream attach
// ---------------------------------------------------------------------------

describe('dsh message bridge — dual attach ($events + session/follow)', () => {
  it('opens the mux $events stream with the empty args envelope', () => {
    const { mux } = createHarness();
    expect(mux.opened).toHaveLength(1);
    expect(mux.opened[0].endpoint).toBe('$events');
    expect(mux.opened[0].payload).toEqual({ args: {} });
  });

  it('captures the per-connection clientId from the real ready frame', () => {
    const { bridge, mux } = createHarness();
    expect(bridge.clientId()).toBeUndefined();
    mux.events().emit(readyFrame);
    expect(bridge.clientId()).toBe(READY_CLIENT_ID);
  });

  it('routes follow stream frames into the message store through the landed normalizer', () => {
    const { bridge, store } = createHarness();
    const follow = new FakeStream('sf1');
    bridge.attachFollow(follow);
    follow.emit(followSnapshot);
    expect(store.messages.size).toBeGreaterThan(0);
    expect(bridge.cursor()).toBe(17);
    expect(bridge.sessionIds()).toEqual([SESSION_ID]);
  });
});

// ---------------------------------------------------------------------------

describe('dsh message bridge — bootstrap join binding (defect D2)', () => {
  it('creates the sync machine for a follow bound at attach time', () => {
    // The bootstrap consumed this stream's snapshot, so the bridge is the only
    // place the machine can come from: without it `syncState` reports
    // `detached` and the composer refuses the very first send.
    const { bridge } = createHarness();
    const follow = new FakeStream('sf-bootstrap');

    bridge.attachFollow(follow, SESSION_ID);

    expect(bridge.syncState(SESSION_ID)).toEqual({ kind: 'live', cursor: -1 });
    expect(bridge.syncState()).toEqual({ kind: 'live', cursor: -1 });
  });

  it('does not clobber a published phase when re-binding an existing session', () => {
    const { bridge } = createHarness();
    const first = new FakeStream('sf-live');
    bridge.attachFollow(first, SESSION_ID);
    first.emit(followSnapshot);
    expect(bridge.syncState(SESSION_ID).kind).toBe('live');

    const reopened = new FakeStream('sf-reopened');
    bridge.attachFollow(reopened, SESSION_ID);

    expect(bridge.syncState(SESSION_ID).kind).toBe('live');
    expect(bridge.cursor(SESSION_ID)).toBe(17);
  });

  it('applies live frames of a bootstrap-adopted stream without a re-taught snapshot', () => {
    const { bridge, store } = createHarness();
    const follow = new FakeStream('sf-bootstrap-live');
    bridge.attachFollow(follow, SESSION_ID);

    follow.emit(
      record('assistant/message', 18, {
        turn: 1,
        step: 1,
        message: { role: 'assistant', content: [{ type: 'text', text: 'Live after bootstrap' }] },
      }),
    );

    expect(bridge.sessionIds()).toEqual([SESSION_ID]);
    expect(store.messages.size).toBeGreaterThan(0);
    const texts = [...store.parts.values()].map((part) => (part as { text?: string }).text);
    expect(texts).toContain('Live after bootstrap');
  });
});

// ---------------------------------------------------------------------------
// 2. approval/request → permission UI surface → terminal answer
// ---------------------------------------------------------------------------

describe('dsh message bridge — approval/request waterfall', () => {
  it('surfaces the request to the permission UI and leaves the turn pending until answered', async () => {
    const approvals: DshApprovalRequest[] = [];
    const harness = createHarness({
      onApprovalRequest: (request) => approvals.push(request),
    });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(followSnapshot);
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-approval-1'));

    expect(approvals).toHaveLength(1);
    expect(approvals[0].eventId).toBe('evt-approval-1');
    expect(approvals[0].agentId).toBe('agent-main');
    expect(approvals[0].sessionId).toBe(SESSION_ID);
    expect(harness.bridge.pendingApprovals().map((entry) => entry.eventId)).toEqual(['evt-approval-1']);
    // The turn is still hanging: nothing was sent, nothing settled.
    expect(harness.calls).toHaveLength(0);
    expect(harness.provider.isSettled('evt-approval-1')).toBe(false);
    expect(harness.provider.pendingCount()).toBe(1);

    harness.bridge.resolveApproval('evt-approval-1', { kind: 'result', value: { approved: true } });

    // Only NOW does the provider's pending request promise resolve.
    await harness.provider.settled('evt-approval-1');
    expect(harness.provider.pendingCount()).toBe(0);
    expect(harness.calls).toHaveLength(1);
  });

  it('answers with the FULL client-request envelope and payload.args {clientId,eventId,outcome}', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-approval-2'));
    harness.bridge.resolveApproval('evt-approval-2', { kind: 'result', value: { approved: true } });
    await harness.provider.settled('evt-approval-2');

    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call.url).toBe('http://localhost:23004/dsh/$events/result');
    expect(call.method).toBe('POST');
    expect(call.body.type).toBe('client-request');
    expect(call.body.method).toBe('$events/result');
    expect(typeof call.body.rpcId).toBe('string');
    expect(call.body.rpcId.length).toBeGreaterThan(0);
    // The protocol correction: args are the ENVELOPE PAYLOAD, not the body.
    expect(Object.keys(call.body).sort()).toEqual(['method', 'payload', 'rpcId', 'type']);
    expect(argsOf(call)).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-approval-2',
      outcome: { kind: 'result', value: { approved: true } },
    });
  });

  it('sends each approval as its own envelope (fresh rpcId per answer)', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-a'));
    emitWaterfall(harness, approvalFrame('evt-b'));
    harness.bridge.resolveApproval('evt-a', { kind: 'next' });
    harness.bridge.resolveApproval('evt-b', { kind: 'next' });
    await Promise.all([harness.provider.settled('evt-a'), harness.provider.settled('evt-b')]);
    expect(harness.calls).toHaveLength(2);
    expect(harness.calls[0].body.rpcId).not.toBe(harness.calls[1].body.rpcId);
    expect(argsOf(harness.calls[1])).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-b',
      outcome: { kind: 'next' },
    });
  });

  it('host cancel clears the pending approval and suppresses any later answer', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-cancelled'));
    expect(harness.bridge.pendingApprovals()).toHaveLength(1);

    harness.mux.events().emit({ type: 'cancel', eventId: 'evt-cancelled' } as unknown as DshJsonValue);
    expect(harness.bridge.pendingApprovals()).toHaveLength(0);

    harness.bridge.resolveApproval('evt-cancelled', { kind: 'next' });
    await Promise.resolve();
    expect(harness.calls).toHaveLength(0);
    expect(harness.provider.isSettled('evt-cancelled')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// 3. Terminal responses — the "agent hangs forever" bug class
// ---------------------------------------------------------------------------

describe('dsh message bridge — terminal responses (review blocker #7)', () => {
  it('answers user-questions/request with a safe rejection and settles the pending turn', async () => {
    const approvals: DshApprovalRequest[] = [];
    const harness = createHarness({
      onApprovalRequest: (request) => approvals.push(request),
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, userQuestionsFrame('evt-questions-1'));

    // No question UI exists; the frame must NOT be silently dropped.
    expect(approvals).toHaveLength(0);
    await harness.provider.settled('evt-questions-1');

    expect(harness.calls).toHaveLength(1);
    const outcome = argsOf(harness.calls[0]).outcome as DshWaterfallOutcome;
    expect(outcome.kind).toBe('rejected');
    expect(argsOf(harness.calls[0])).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-questions-1',
      outcome,
    });
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('answers an unknown waterfall event instead of silently dropping it', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, {
      type: 'waterfall',
      event: 'not-in-the-whitelist/request',
      eventId: 'evt-unknown-1',
      agentId: 'agent-main',
      request: {},
    } as unknown as DshJsonValue);

    await harness.provider.settled('evt-unknown-1');
    expect(harness.calls).toHaveLength(1);
    const outcome = argsOf(harness.calls[0]).outcome as DshWaterfallOutcome;
    expect(outcome.kind).toBe('rejected');
  });

  it('answers every pending approval with a safe rejection when the UI closes by degradation', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-degraded-1'));
    emitWaterfall(harness, approvalFrame('evt-degraded-2'));
    expect(harness.provider.pendingCount()).toBe(2);

    harness.bridge.rejectAllApprovals('approval UI unavailable (capability degraded)');

    await Promise.all([
      harness.provider.settled('evt-degraded-1'),
      harness.provider.settled('evt-degraded-2'),
    ]);
    expect(harness.provider.pendingCount()).toBe(0);
    expect(harness.calls).toHaveLength(2);
    for (const call of harness.calls) {
      const outcome = argsOf(call).outcome as DshWaterfallOutcome;
      expect(outcome.kind).toBe('rejected');
      expect(outcome.kind === 'rejected' ? outcome.error.message : '').toContain('degraded');
    }
    expect(harness.bridge.pendingApprovals()).toHaveLength(0);
  });

  it('stop() answers pending approvals and cancels BOTH streams (never an uplink end)', async () => {
    const harness = createHarness();
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    const events = harness.mux.events();
    events.emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-stop-1'));

    harness.bridge.stop();

    await harness.provider.settled('evt-stop-1');
    expect(harness.calls).toHaveLength(1);
    expect((argsOf(harness.calls[0]).outcome as DshWaterfallOutcome).kind).toBe('rejected');
    expect(events.cancelled).toBe(true);
    expect(follow.cancelled).toBe(true);
  });

  it('does not answer the same eventId twice (double close is idempotent)', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-once'));
    harness.bridge.rejectAllApprovals('first close');
    harness.bridge.rejectAllApprovals('second close');
    harness.bridge.resolveApproval('evt-once', { kind: 'next' });
    await harness.provider.settled('evt-once');
    expect(harness.calls).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// 4. Popup callback surface (Metis #6) + replay suppression
// ---------------------------------------------------------------------------

describe('dsh message bridge — popup callback surface', () => {
  const liveRecords: DshSessionRecord[] = [
    record('turn/start', 0, { turn: 1 }),
    record('assistant/message', 1, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'planning the edit' }] },
    }),
    record('tool/call', 2, { turn: 1, step: 1, callId: 'call-1', name: 'read', arguments: { path: 'a.ts' } }),
  ];

  it('keeps the three callback surfaces silent during snapshot rebuild and history load', () => {
    const onToolPart = vi.fn();
    const onLiveReasoning = vi.fn();
    const onLiveSubagent = vi.fn();
    const onReconcilePart = vi.fn();
    const harness = createHarness({ onToolPart, onLiveReasoning, onLiveSubagent, onReconcilePart });

    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, liveRecords, 2));
    harness.bridge.applyHistory(['history-entry-1', 'history-entry-2']);

    expect(onToolPart).not.toHaveBeenCalled();
    expect(onLiveReasoning).not.toHaveBeenCalled();
    expect(onLiveSubagent).not.toHaveBeenCalled();
    // Replay only closes existing windows; it never opens a new one.
    expect(onReconcilePart).toHaveBeenCalled();
    expect(harness.store.history).toEqual(['history-entry-1', 'history-entry-2']);
  });

  it('fires onToolPart for live items only', () => {
    const onToolPart = vi.fn();
    const onLiveReasoning = vi.fn();
    const onLiveSubagent = vi.fn();
    const harness = createHarness({ onToolPart, onLiveReasoning, onLiveSubagent });

    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(snapshot(SESSION_ID, liveRecords, 2));
    follow.emit(record('tool/call', 3, {
      turn: 1,
      step: 1,
      callId: 'call-2',
      name: 'grep',
      arguments: { pattern: 'x' },
    }));
    follow.emit(record('assistant/message', 4, {
      turn: 1,
      step: 1,
      message: { role: 'assistant', content: [{ type: 'reasoning', text: 'checking the diff' }] },
    }));

    expect(onToolPart).toHaveBeenCalledTimes(1);
    expect(onToolPart.mock.calls[0][0]).toMatchObject({ type: 'tool', callID: 'call-2' });
    expect(onLiveReasoning).toHaveBeenCalledTimes(1);
    expect(onLiveReasoning.mock.calls[0][1]).toMatchObject({ type: 'reasoning', text: 'checking the diff' });
    expect(onLiveSubagent).not.toHaveBeenCalled();
  });

  it('routes child-session live parts to onLiveSubagent', () => {
    const onLiveSubagent = vi.fn();
    const onToolPart = vi.fn();
    const harness = createHarness({ onLiveSubagent, onToolPart });

    const parent = new FakeStream('sf-parent');
    harness.bridge.attachFollow(parent);
    parent.emit(snapshot(SESSION_ID, [], 0));

    const child = new FakeStream('sf-child');
    harness.bridge.attachFollow(child);
    child.emit(snapshot(CHILD_SESSION_ID, [], 0));
    child.emit(record('tool/call', 1, {
      turn: 1,
      step: 1,
      callId: 'child-call-1',
      name: 'read',
      arguments: { path: 'b.ts' },
    }));

    expect(onLiveSubagent).toHaveBeenCalledTimes(1);
    expect(onLiveSubagent.mock.calls[0][1]).toMatchObject({ type: 'tool', callID: 'child-call-1' });
    expect(onToolPart).not.toHaveBeenCalled();
  });

  it('preserves a child address in popup metadata and terminal events', () => {
    // Given: a parent and an explicitly addressed child follow stream.
    const onLiveSubagent = vi.fn();
    const onSessionEvent = vi.fn();
    const harness = createHarness({ onLiveSubagent, onSessionEvent });
    harness.bridge.attachFollow(new FakeStream('parent'), SESSION_ID);
    const child = new FakeStream('child');
    harness.bridge.attachFollow(child, { kind: 'subagent', parentSessionId: SESSION_ID, childSessionId: CHILD_SESSION_ID, mode: 'one-shot' });
    child.emit(snapshot(CHILD_SESSION_ID, [], 0));
    // When: child output and completion arrive.
    child.emit(record('assistant/message', 1, { turn: 1, step: 1, message: { content: [{ type: 'text', text: 'child answer' }] } }));
    child.emit(record('turn/end', 2, { turn: 1, reason: { kind: 'completed' } }));
    // Then: both rendering metadata and completion retain parent linkage.
    expect(onLiveSubagent).toHaveBeenCalledWith(expect.objectContaining({ agent: 'subagent' }), expect.objectContaining({
      metadata: expect.objectContaining({ subagent: { parentSessionId: SESSION_ID, childSessionId: CHILD_SESSION_ID, mode: 'one-shot' } }),
    }));
    expect(onSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ kind: 'subagent', parentSessionId: SESSION_ID, childSessionId: CHILD_SESSION_ID, phase: 'completed' }), expect.anything());
    harness.bridge.stop();
  });

  it('reopens a failed child stream with its original subagent address', async () => {
    // Given: an attached child stream.
    const harness = createHarness();
    const child = new FakeStream('child');
    const address = { kind: 'subagent', parentSessionId: SESSION_ID, childSessionId: CHILD_SESSION_ID, mode: 'one-shot' } as const;
    harness.bridge.attachFollow(child, address);
    child.emit(snapshot(CHILD_SESSION_ID, [], 0));
    // When: the host kills this logical stream.
    child.drop(new DshMuxError('stream-error', 'child stream failed'));
    await Promise.resolve();
    // Then: recovery uses the same address, including parent and mode.
    expect(harness.mux.opened.at(-1)).toMatchObject({ endpoint: 'session/follow', payload: { args: { request: { address } } } });
    harness.bridge.stop();
  });

  it('pages child history using the child address', async () => {
    // Given: a child snapshot has established its own sequence watermark.
    const fetchPage = vi.fn(async () => ({ records: [] }));
    const harness = createHarness({ fetchPage });
    const address = { kind: 'subagent', parentSessionId: SESSION_ID, childSessionId: CHILD_SESSION_ID, mode: 'one-shot' } as const;
    const child = new FakeStream('child');
    harness.bridge.attachFollow(child, address);
    child.emit(snapshot(CHILD_SESSION_ID, [], 5));
    // When: older child history is requested.
    await harness.bridge.fillHistoryWindow(CHILD_SESSION_ID);
    // Then: the RPC source receives the child namespace, never the parent namespace.
    expect(fetchPage).toHaveBeenCalledWith({ sessionId: CHILD_SESSION_ID, address, throughSeq: 5, beforeSeq: 6 });
    harness.bridge.stop();
  });

  it('routes a newly selected root through root callbacks after another root was attached', () => {
    // Given: the shared bridge first followed root A.
    const onLiveSubagent = vi.fn();
    const onToolPart = vi.fn();
    const harness = createHarness({ onLiveSubagent, onToolPart });
    harness.bridge.attachFollow(new FakeStream('root-a'), SESSION_ID);
    const rootB = new FakeStream('root-b');
    harness.bridge.attachFollow(rootB, 'root-b');
    rootB.emit(snapshot('root-b', [], 0));
    // When: selected root B emits a live tool.
    rootB.emit(record('tool/call', 1, { turn: 1, step: 1, callId: 'root-b-tool', name: 'read', arguments: {} }));
    // Then: the tool follows the root surface and default accessors follow B.
    expect(onToolPart).toHaveBeenCalledWith(expect.objectContaining({ sessionID: 'root-b', callID: 'root-b-tool' }));
    expect(onLiveSubagent).not.toHaveBeenCalled();
    expect(harness.bridge.sessionState()?.sessionId).toBe('root-b');
    harness.bridge.stop();
  });

  it('ignores detached stream errors and permits reattaching the same session', async () => {
    // Given: selection leaves a followed session while its stream is failing.
    const harness = createHarness();
    const old = new FakeStream('old');
    harness.bridge.attachFollow(old, SESSION_ID);
    old.emit(snapshot(SESSION_ID, [], 0));
    // When: it is detached, a late error arrives, then selection returns.
    harness.bridge.detachFollow(SESSION_ID);
    old.drop(new DshMuxError('stream-error', 'late error'));
    await Promise.resolve();
    const replacement = new FakeStream('replacement');
    harness.bridge.attachFollow(replacement, SESSION_ID);
    replacement.emit(snapshot(SESSION_ID, [], 0));
    replacement.emit(record('tool/call', 1, { turn: 1, callId: 'new-tool', name: 'read', arguments: {} }));
    // Then: no ghost recovery opens and the replacement publishes live output.
    expect(harness.mux.opened.filter((entry) => entry.endpoint === 'session/follow')).toEqual([]);
    expect(old.cancelled).toBe(true);
    expect(old.listeners.size).toBe(0);
    expect([...harness.store.parts.values()]).toEqual([expect.objectContaining({ type: 'tool', callID: 'new-tool' })]);
    harness.bridge.stop();
  });
});

// ---------------------------------------------------------------------------
// 5. Reconnect continuation (Todo 7 contract: snapshot + cursor)
// ---------------------------------------------------------------------------

describe('dsh message bridge — reconnect continuation', () => {
  it('replays a reconnect snapshot as authoritative full state: no loss, no duplication', () => {
    const onToolPart = vi.fn();
    const sessionEvents: string[] = [];
    const harness = createHarness({
      onToolPart,
      onSessionEvent: (op) => sessionEvents.push(op.kind),
    });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);

    follow.emit(followSnapshot);
    const afterFirstIds = [...harness.store.messages.keys()].sort();
    const upsertsAfterFirst = harness.store.messageUpserts;
    expect(afterFirstIds.length).toBeGreaterThan(0);
    // One snapshot apply emits several upserts per message identity (turn group
    // + attempt + terminal), so upserts > identities is the correct invariant.
    expect(upsertsAfterFirst).toBeGreaterThan(afterFirstIds.length);
    expect(harness.bridge.cursor()).toBe(17);

    // Disconnect window: the session-log producer appends one more record
    // (the task-7 probe's calibration event: rename → session/title).
    const reconnectSnapshot = snapshot(
      SESSION_ID,
      [...snapshotRecords, record('session/title', 18, { title: 'renamed after reconnect' })],
      18,
    );
    follow.emit(reconnectSnapshot);

    // No loss: the cursor advanced past the disconnect window; the new record
    // produced its op (title observed through the session-event hook).
    expect(harness.bridge.cursor()).toBe(18);
    expect(sessionEvents).toContain('session-title');
    // No duplication: replayed records upsert the SAME identities, so the store
    // never gained a second entry for a replayed message.
    expect([...harness.store.messages.keys()].sort()).toEqual(afterFirstIds);
    expect(harness.store.messageUpserts).toBeGreaterThan(upsertsAfterFirst);
    // Replay suppresses popups.
    expect(onToolPart).not.toHaveBeenCalled();
  });

  it('rotates clientId per connection: a stale clientId is never answered with (R10)', async () => {
    const harness = createHarness();
    const events = harness.mux.events();
    events.emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-conn-1'));
    harness.bridge.resolveApproval('evt-conn-1', { kind: 'next' });
    await harness.provider.settled('evt-conn-1');
    expect(argsOf(harness.calls[0])).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-conn-1',
      outcome: { kind: 'next' },
    });

    // Socket drops: the per-connection clientId is void from here on.
    events.drop(new Error('socket closed'));
    await Promise.resolve();
    expect(harness.bridge.clientId()).toBeUndefined();

    // The re-opened stream answers only after its new ready frame arrives.
    emitWaterfall(harness, approvalFrame('evt-conn-2'));
    harness.bridge.resolveApproval('evt-conn-2', { kind: 'next' });
    await Promise.resolve();
    expect(harness.calls).toHaveLength(1);

    events.emit({ type: 'ready', clientId: 'client-new-conn', host: { home: '/home/x' } } as unknown as DshJsonValue);
    await harness.provider.settled('evt-conn-2');
    expect(harness.calls).toHaveLength(2);
    expect(argsOf(harness.calls[1])).toEqual({
      clientId: 'client-new-conn',
      eventId: 'evt-conn-2',
      outcome: { kind: 'next' },
    });
  });

  it('re-derives pending approvals from session state after a reconnect snapshot (R11 hook)', async () => {
    const derived: DshApprovalRequest[] = [];
    const harness = createHarness({
      reconcileApprovals: (sessionId) =>
        sessionId === SESSION_ID
          ? [{
            eventId: 'evt-recovered',
            agentId: 'agent-main',
            sessionId,
            request: { toolName: 'bash' },
          }]
          : [],
      onApprovalRequest: (request) => {
        derived.push(request);
        harness.provider.expectPending(request.eventId);
      },
    });
    harness.mux.events().emit(readyFrame);
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);

    // Reconnect: a fresh full snapshot arrives on the live stream.
    follow.emit(followSnapshot);

    expect(derived.map((entry) => entry.eventId)).toEqual(['evt-recovered']);
    harness.bridge.resolveApproval('evt-recovered', { kind: 'result', value: { approved: false } });
    await harness.provider.settled('evt-recovered');
    expect(harness.calls).toHaveLength(1);
    expect(argsOf(harness.calls[0]).eventId).toBe('evt-recovered');
  });
});

// ---------------------------------------------------------------------------
// 6. Robustness — whitelist frames and malformed input never crash
// ---------------------------------------------------------------------------

describe('dsh message bridge — robustness', () => {
  it('ignores unknown and malformed $events frames without crashing or answering', () => {
    const harness = createHarness();
    const events = harness.mux.events();
    events.emit({ type: 'nonsense' } as unknown as DshJsonValue);
    events.emit({ type: 'emit', event: 'api-session/added', args: [{ id: 'x' }] } as unknown as DshJsonValue);
    events.emit(undefined);
    events.emit(null as unknown as DshJsonValue);
    expect(harness.bridge.clientId()).toBeUndefined();
    expect(harness.calls).toHaveLength(0);
    expect(harness.provider.pendingCount()).toBe(0);
  });

  it('surfaces $events emit broadcasts to the observation hook', () => {
    const emitted: Array<{ event: string; args: readonly DshJsonValue[] }> = [];
    const harness = createHarness({
      onEventsEmit: (event, args) => emitted.push({ event, args }),
    });
    harness.mux.events().emit({
      type: 'emit',
      event: 'api-session/added',
      args: [{ sessionId: SESSION_ID }],
    } as unknown as DshJsonValue);
    expect(emitted).toEqual([{ event: 'api-session/added', args: [{ sessionId: SESSION_ID }] }]);
  });

  it('reports a failed answer through the error hook instead of a false success', async () => {
    const failures: string[] = [];
    const harness = createHarness({
      onWaterfallResponseError: (eventId) => failures.push(eventId),
      rpc: {
        baseUrl: 'http://localhost:23004/dsh',
        fetcher: async () => {
          throw new Error('bridge unreachable');
        },
      },
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-failed'));
    harness.bridge.resolveApproval('evt-failed', { kind: 'next' });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(failures).toEqual(['evt-failed']);
  });

  it('accepts a ws:// bridge url by deriving the http prefix (deriveDshBridgeHttpUrl)', async () => {
    const urls: string[] = [];
    const harness = createHarness({
      rpc: {
        baseUrl: 'ws://localhost:23004/dsh/ws',
        fetcher: async (url: string) => {
          urls.push(url);
          harness.provider.settle('evt-ws');
          return jsonResponse({
            type: 'server-response',
            rpcId: 'dsh-1',
            result: { ok: true, value: { clientId: READY_CLIENT_ID, eventId: 'evt-ws', outcome: { kind: 'next' } } },
          });
        },
      },
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-ws'));
    harness.bridge.resolveApproval('evt-ws', { kind: 'next' });
    await harness.provider.settled('evt-ws');
    expect(urls).toEqual(['http://localhost:23004/dsh/$events/result']);
  });
});
