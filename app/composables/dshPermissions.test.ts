/**
 * Todo 28 — dsh permission presets + approval waterfall → permission UI.
 *
 * Two responsibilities are proven end-to-end against the REAL `useDshMessageBridge`
 * and the REAL version-gated wire fixtures (never hand-waved):
 *
 *   1. preset state machine: the real session events `permission/preset`,
 *      `sandbox/mode`, `approval/policy` (docs/dsh.md §8.3), the snapshot
 *      header `agentPreset` (docs/dsh.md §8.2) and the `permissions.currentValue`
 *      projection drive a read-only preset selector. No write endpoint was
 *      probed for 0.2.0-rc.2 (plan Todo 28 / review blocker #6), so the selector
 *      is explicitly read-only and emits NO mutation request.
 *   2. approval waterfall: an `approval/request` frame is surfaced through the
 *      shared permission window; the user's decision is mapped onto dsh's EXACT
 *      outcome vocabulary and posted to `POST /dsh/$events/result` as the full
 *      client-request envelope with `payload.args = {clientId, eventId, outcome}`.
 *
 * The dsh model provider is modelled as a *pending promise* that only settles
 * when the answer POST really lands (mirrors `useDshMessageBridge.test.ts`), so
 * the settle assertions prove the agent turn resumes — including on the
 * DEGRADED path where the approval UI is hidden (review blocker #7: a silently
 * dropped frame hangs the turn forever).
 *
 * Outcome vocabulary is pinned to dsh 0.2.0-rc.2 source:
 *   `@deepseek-ai/dsh-client-ui-approval` answers with the strings
 *   `"allowed-once"` / `"rejected"`, and `@deepseek-ai/dsh-api-gateway`
 *   `dispatchWaterfall` wraps them as `{kind:"result", value:"…"}` on the
 *   `$events/result` wire. `{kind:"rejected"}` is the gateway's listener-FAILURE
 *   shape (fail-closed `unavailable`), which is exactly what a safe degradation
 *   must send.
 */
import { describe, expect, it } from 'vitest';

import { loadDshWireFixture } from '../backends/dsh/fixtures';
import type {
  DshClientRequest,
  DshJsonValue,
  DshRpcArgs,
  DshSessionRecord,
} from '../backends/dsh/types';
import type { MessageInfo, MessagePart } from '../types/sse';
import type { DshApprovalRequest, DshBridgeStreamHandle } from './dshMessageBridgeTypes';
import type { PermissionRequest } from './usePermissions';
import { useDshMessageBridge } from './useDshMessageBridge';
import {
  DSH_APPROVAL_ALLOWED_ONCE,
  DSH_APPROVAL_REJECTED,
  createDshPermissions,
  dshApprovalOutcomeFromReply,
  dshApprovalRequestId,
  dshApprovalToPermissionRequest,
  parseDshApprovalRequestId,
} from './dshPermissions';

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

const SESSION_RECORDS = (followSnapshot as { records: DshSessionRecord[] }).records;

function approvalFrame(eventId: string): DshJsonValue {
  return {
    type: 'waterfall',
    event: 'approval/request',
    eventId,
    agentId: 'agent-main',
    request: { toolName: 'bash', callId: 'call-1', reason: 'needs privileged execution' },
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

  cancel(): void {
    this.cancelled = true;
  }

  emit(value: DshJsonValue | undefined): void {
    for (const listener of [...this.listeners]) listener(value);
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

/** The dsh host: every waterfall request blocks the turn until the answer lands. */
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

  settle(eventId: string): void {
    const entry = this.pending.get(eventId);
    if (!entry || entry.settled) return;
    entry.settled = true;
    entry.resolve();
  }

  /** Never resolves for an unregistered event, so a dropped frame fails by timeout. */
  settled(eventId: string): Promise<void> {
    const entry = this.pending.get(eventId);
    if (!entry) return new Promise<void>(() => undefined);
    return entry.promise;
  }

  isSettled(eventId: string): boolean {
    return this.pending.get(eventId)?.settled ?? false;
  }
}

class FakeMessageStore {
  readonly messages = new Map<string, MessageInfo>();
  readonly parts = new Map<string, MessagePart>();
  readonly history: unknown[] = [];

  updateMessage(info: MessageInfo): void {
    this.messages.set(info.id, info);
  }

  updatePart(part: MessagePart): void {
    this.parts.set(part.id, part);
  }

  loadHistory(entries: unknown[]): void {
    this.history.push(...entries);
  }
}

type CapturedResultCall = {
  url: string;
  method: string;
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

function argsOf(call: CapturedResultCall): {
  clientId?: unknown;
  eventId?: unknown;
  outcome?: unknown;
} {
  return call.body.payload.args as { clientId?: unknown; eventId?: unknown; outcome?: unknown };
}

function createHarness(permsOptions: Parameters<typeof createDshPermissions>[0] = {}) {
  const mux = new FakeMux();
  const provider = new WaterfallProviderDouble();
  const store = new FakeMessageStore();
  const calls: CapturedResultCall[] = [];

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

  const perms = createDshPermissions(permsOptions);
  const bridge = useDshMessageBridge({
    mux,
    rpc: { baseUrl: 'http://localhost:23004/dsh', fetcher },
    msg: store,
    onSessionEvent: (op) => perms.handleSessionEvent(op),
  });
  perms.attach(bridge);

  return { bridge, mux, provider, store, calls, perms };
}

/** Emit a waterfall frame the way the host would: the turn blocks on it. */
function emitWaterfall(harness: ReturnType<typeof createHarness>, frame: DshJsonValue): void {
  harness.provider.expectPending(eventIdOf(frame));
  harness.mux.events().emit(frame);
}

// ---------------------------------------------------------------------------
// 1. Preset state machine — real event shapes, read-only selector
// ---------------------------------------------------------------------------

describe('dsh permissions — permission presets (read-only, docs §8.3)', () => {
  it('ingests the real permission/preset + sandbox/mode + approval/policy event shapes', () => {
    const perms = createDshPermissions();
    // Exactly the data payloads from the real snapshot fixture (seq 0-2).
    expect(perms.ingestEvent('permission/preset', { preset: 'workspace-write' })).toBe(true);
    expect(perms.ingestEvent('sandbox/mode', { mode: 'workspace-write' })).toBe(true);
    expect(perms.ingestEvent('approval/policy', { policy: 'ask' })).toBe(true);

    expect(perms.state.permissionPreset).toBe('workspace-write');
    expect(perms.state.sandboxMode).toBe('workspace-write');
    expect(perms.state.approvalPolicy).toBe('ask');
    expect(perms.selector.value.current).toBe('workspace-write');
    expect(perms.selector.value.writable).toBe(false);
  });

  it('tracks agentPreset from the snapshot header and projections', () => {
    const perms = createDshPermissions();
    expect(perms.ingestSnapshotHeader({ version: 4, agentPreset: 'standard' })).toBe(true);
    expect(perms.state.agentPreset).toBe('standard');

    expect(
      perms.ingestProjections({
        agentPreset: 'reviewer',
        permissions: { currentValue: 'read-only' },
      }),
    ).toBe(true);
    expect(perms.state.agentPreset).toBe('reviewer');
    expect(perms.state.permissionPreset).toBe('read-only');
  });

  it('tracks agent-preset/selected as a session-level selector update', () => {
    const perms = createDshPermissions();
    expect(perms.ingestEvent('agent-preset/selected', { agentPreset: 'standard' })).toBe(true);
    expect(perms.state.agentPreset).toBe('standard');
  });

  it('is driven by the REAL follow snapshot through the bridge onSessionEvent', () => {
    const perms = createDshPermissions();
    const mux = new FakeMux();
    const bridge = useDshMessageBridge({
      mux,
      rpc: { baseUrl: 'http://localhost:23004/dsh', fetcher: async () => jsonResponse({}) },
      msg: new FakeMessageStore(),
      onSessionEvent: (op) => perms.handleSessionEvent(op),
    });
    const follow = mux.open('session/follow', { args: {} }) as FakeStream;
    bridge.attachFollow(follow);
    perms.ingestSnapshot(followSnapshot as unknown as Record<string, unknown>);
    follow.emit(followSnapshot);

    // The real fixture records permission/preset, sandbox/mode, approval/policy.
    expect(SESSION_RECORDS.length).toBeGreaterThanOrEqual(3);
    expect(perms.state.permissionPreset).toBe('workspace-write');
    expect(perms.state.sandboxMode).toBe('workspace-write');
    expect(perms.state.approvalPolicy).toBe('ask');
    expect(perms.state.agentPreset).toBe('standard');
  });

  it('never emits a mutation request (no write endpoint probed for 0.2.0-rc.2)', () => {
    const perms = createDshPermissions();
    perms.ingestEvent('permission/preset', { preset: 'danger-full-access' });
    expect(perms.selectPreset('read-only')).toBe(false);
    expect(perms.state.permissionPreset).toBe('danger-full-access');
    expect(perms.selector.value.writable).toBe(false);
  });

  it('ignores malformed preset payloads without crashing or changing state', () => {
    const perms = createDshPermissions();
    expect(perms.ingestEvent('permission/preset', { preset: 42 })).toBe(false);
    expect(perms.ingestEvent('sandbox/mode', null)).toBe(false);
    expect(perms.ingestEvent('approval/policy', 'ask')).toBe(false);
    expect(perms.ingestSnapshotHeader(null)).toBe(false);
    expect(perms.state.permissionPreset).toBe('');
    expect(perms.state.sandboxMode).toBe('');
  });
});

// ---------------------------------------------------------------------------
// 2. Outcome vocabulary + request mapping (pure)
// ---------------------------------------------------------------------------

describe('dsh permissions — approval outcome vocabulary', () => {
  it('maps allow (once/always) to {kind:result, value:allowed-once}', () => {
    expect(dshApprovalOutcomeFromReply('once')).toEqual({
      kind: 'result',
      value: DSH_APPROVAL_ALLOWED_ONCE,
    });
    // dsh stores no session-scoped grant: allow_always degrades to allowed-once (§9/§520).
    expect(dshApprovalOutcomeFromReply('always')).toEqual({
      kind: 'result',
      value: DSH_APPROVAL_ALLOWED_ONCE,
    });
  });

  it('maps deny to {kind:result, value:rejected} — NOT the gateway listener-failure kind', () => {
    expect(dshApprovalOutcomeFromReply('reject')).toEqual({
      kind: 'result',
      value: DSH_APPROVAL_REJECTED,
    });
  });

  it('fails closed for an unknown reply with the safe-rejection kind', () => {
    const outcome = dshApprovalOutcomeFromReply('nonsense');
    expect(outcome.kind).toBe('rejected');
  });

  it('maps the request id round-trip and the permission window shape', () => {
    const request: DshApprovalRequest = {
      eventId: 'evt-1',
      agentId: 'agent-main',
      sessionId: SESSION_ID,
      request: { toolName: 'bash', callId: 'call-1', reason: 'privileged' },
    };
    const mapped = dshApprovalToPermissionRequest(request);
    expect(mapped.id).toBe(dshApprovalRequestId('evt-1'));
    expect(parseDshApprovalRequestId(mapped.id)).toBe('evt-1');
    expect(mapped.sessionID).toBe(SESSION_ID);
    expect(mapped.permission).toBe('bash');
    // dsh has no session-scoped approval store: the always list stays empty.
    expect(mapped.always).toEqual([]);
    expect(mapped.metadata.reason).toBe('privileged');
    expect(mapped.tool).toEqual({ messageID: 'call-1', callID: 'call-1' });
  });

  it('renders a malformed approval payload as a generic request instead of crashing', () => {
    const mapped = dshApprovalToPermissionRequest({
      eventId: 'evt-bad',
      agentId: 'agent-main',
      sessionId: SESSION_ID,
      request: 'not-an-object' as unknown as DshJsonValue,
    });
    expect(mapped.permission).toBe('approval');
    expect(mapped.patterns).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// 3. Approval waterfall → permission window → POST /dsh/$events/result
// ---------------------------------------------------------------------------

describe('dsh permissions — approval waterfall wiring', () => {
  it('opens the permission window on approval/request and leaves the turn pending', () => {
    const opened: PermissionRequest[] = [];
    const harness = createHarness({ openPermissionWindow: (request) => opened.push(request) });
    const follow = new FakeStream('sf1');
    harness.bridge.attachFollow(follow);
    follow.emit(followSnapshot);
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-allow'));

    expect(opened).toHaveLength(1);
    expect(opened[0].id).toBe(dshApprovalRequestId('evt-allow'));
    expect(opened[0].sessionID).toBe(SESSION_ID);
    expect(harness.calls).toHaveLength(0);
    expect(harness.provider.isSettled('evt-allow')).toBe(false);
    expect(harness.perms.pendingPermissionRequestIds()).toEqual([dshApprovalRequestId('evt-allow')]);
  });

  it('allow → {kind:result, value:allowed-once} in the full client-request envelope', async () => {
    const opened: PermissionRequest[] = [];
    const closed: string[] = [];
    const harness = createHarness({
      openPermissionWindow: (request) => opened.push(request),
      closePermissionWindow: (id) => closed.push(id),
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-allow-2'));

    harness.perms.replyToPermission(opened[0].id, 'once');
    await harness.provider.settled('evt-allow-2');

    expect(harness.provider.isSettled('evt-allow-2')).toBe(true);
    expect(harness.calls).toHaveLength(1);
    const call = harness.calls[0];
    expect(call.url).toBe('http://localhost:23004/dsh/$events/result');
    expect(call.method).toBe('POST');
    expect(call.body.type).toBe('client-request');
    expect(call.body.method).toBe('$events/result');
    expect(Object.keys(call.body).sort()).toEqual(['method', 'payload', 'rpcId', 'type']);
    // clientId from the current $events ready frame; eventId from the request frame.
    expect(argsOf(call)).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-allow-2',
      outcome: { kind: 'result', value: DSH_APPROVAL_ALLOWED_ONCE },
    });
    expect(closed).toEqual([dshApprovalRequestId('evt-allow-2')]);
    expect(harness.perms.pendingPermissionRequestIds()).toEqual([]);
  });

  it('deny → {kind:result, value:rejected}', async () => {
    const opened: PermissionRequest[] = [];
    const harness = createHarness({ openPermissionWindow: (request) => opened.push(request) });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-deny'));

    harness.perms.replyToPermission(opened[0].id, 'reject');
    await harness.provider.settled('evt-deny');

    expect(argsOf(harness.calls[0])).toEqual({
      clientId: READY_CLIENT_ID,
      eventId: 'evt-deny',
      outcome: { kind: 'result', value: DSH_APPROVAL_REJECTED },
    });
  });

  it('an unknown UI reply fails closed with the safe-rejection kind so the turn still settles', async () => {
    const opened: PermissionRequest[] = [];
    const harness = createHarness({ openPermissionWindow: (request) => opened.push(request) });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-unknown-reply'));

    harness.perms.replyToPermission(opened[0].id, 'definitely-not-a-reply');
    await harness.provider.settled('evt-unknown-reply');

    const outcome = argsOf(harness.calls[0]).outcome as { kind: string };
    expect(outcome.kind).toBe('rejected');
  });

  it('handles a malformed approval frame without crashing and still settles it', async () => {
    const opened: PermissionRequest[] = [];
    const harness = createHarness({ openPermissionWindow: (request) => opened.push(request) });
    harness.mux.events().emit(readyFrame);
    const frame = {
      type: 'waterfall',
      event: 'approval/request',
      eventId: 'evt-malformed',
      agentId: 'agent-main',
      request: 'not-an-object',
    } as unknown as DshJsonValue;
    emitWaterfall(harness, frame);

    expect(opened).toHaveLength(1);
    expect(opened[0].permission).toBe('approval');
    harness.perms.replyToPermission(opened[0].id, 'once');
    await harness.provider.settled('evt-malformed');
    expect(harness.provider.isSettled('evt-malformed')).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// 4. Degradation — the approval UI is hidden/handicapped: MUST still settle
// ---------------------------------------------------------------------------

describe('dsh permissions — capability degradation (anti-hang, review blocker #7)', () => {
  it('sends a safe rejection when the approval UI is disabled — no permission window opens', async () => {
    const opened: PermissionRequest[] = [];
    const harness = createHarness({
      approvalUiEnabled: false,
      openPermissionWindow: (request) => opened.push(request),
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-degraded'));

    // The UI never appears...
    expect(opened).toHaveLength(0);
    // ...but the pending provider promise SETTLES: the turn resumes with a rejection.
    await harness.provider.settled('evt-degraded');
    expect(harness.provider.isSettled('evt-degraded')).toBe(true);
    expect(harness.calls).toHaveLength(1);
    const outcome = argsOf(harness.calls[0]).outcome as { kind: string };
    expect(outcome.kind).toBe('rejected');
    expect(argsOf(harness.calls[0]).clientId).toBe(READY_CLIENT_ID);
    expect(argsOf(harness.calls[0]).eventId).toBe('evt-degraded');
  });

  it('rejects every already-pending approval when the UI is disabled mid-flight', async () => {
    const opened: PermissionRequest[] = [];
    const closed: string[] = [];
    const harness = createHarness({
      openPermissionWindow: (request) => opened.push(request),
      closePermissionWindow: (id) => closed.push(id),
    });
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-mid-1'));
    emitWaterfall(harness, approvalFrame('evt-mid-2'));
    expect(harness.provider.isSettled('evt-mid-1')).toBe(false);

    harness.perms.setApprovalUiEnabled(false);
    await Promise.all([
      harness.provider.settled('evt-mid-1'),
      harness.provider.settled('evt-mid-2'),
    ]);

    expect(harness.provider.isSettled('evt-mid-1')).toBe(true);
    expect(harness.provider.isSettled('evt-mid-2')).toBe(true);
    expect(harness.calls).toHaveLength(2);
    expect(closed.sort()).toEqual([
      dshApprovalRequestId('evt-mid-1'),
      dshApprovalRequestId('evt-mid-2'),
    ]);
    expect(harness.perms.pendingPermissionRequestIds()).toEqual([]);
  });

  it('rejects a pending approval if no permission window sink is wired', async () => {
    const harness = createHarness();
    harness.mux.events().emit(readyFrame);
    emitWaterfall(harness, approvalFrame('evt-no-sink'));
    await harness.provider.settled('evt-no-sink');
    expect(harness.provider.isSettled('evt-no-sink')).toBe(true);
    const outcome = argsOf(harness.calls[0]).outcome as { kind: string };
    expect(outcome.kind).toBe('rejected');
  });
});
