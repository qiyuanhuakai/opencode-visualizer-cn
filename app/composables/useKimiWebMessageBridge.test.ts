import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { KimiWebMessage, KimiWebPage, KimiWebSnapshot } from '../utils/kimiWeb';
import type {
  KimiWebWsAck,
  KimiWebWsCloseInfo,
  KimiWebWsCursor,
  KimiWebWsFrame,
  KimiWebWsResyncRequest,
} from '../utils/kimiWebWs';
import type { MessageInfo, MessagePart } from '../types/sse';
import {
  useKimiWebMessageBridge,
  type KimiWebMessageSource,
} from './useKimiWebMessageBridge';

const SESSION_ID = 'session_e0158012-f869-4d98-b4d4-5921a8686e24';
const EPOCH = 'ep_01M30ZNJTBH5G6NKA2S115YMPJ';
const FIXTURES_DIR = [
  join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures'),
  join(process.cwd(), 'backends', 'kimiWeb', 'fixtures'),
].find((directory) => existsSync(directory)) ?? join(process.cwd(), 'app', 'backends', 'kimiWeb', 'fixtures');

function fixtureFrames(name: string): KimiWebWsFrame[] {
  return readFileSync(join(FIXTURES_DIR, name), 'utf8')
    .split('\n')
    .filter(Boolean)
    .map((line): KimiWebWsFrame => JSON.parse(line));
}

const liveFrames = fixtureFrames('wire-session-live.jsonl');
const derivedFrames = fixtureFrames('wire-spec-derived.jsonl');

function frame(type: string, occurrence = 0): KimiWebWsFrame {
  const found = [...liveFrames, ...derivedFrames].filter((entry) => entry.type === type)[occurrence];
  if (!found) throw new Error(`Missing fixture frame: ${type}[${occurrence}]`);
  return found;
}

function derivedFrame(type: string): KimiWebWsFrame {
  const found = derivedFrames.find((entry) => entry.type === type);
  if (!found) throw new Error(`Missing derived fixture frame: ${type}`);
  return found;
}

function deferred<T>() {
  let resolvePromise: (value: T) => void = () => undefined;
  const promise = new Promise<T>((resolve) => {
    resolvePromise = resolve;
  });
  return { promise, resolve: resolvePromise };
}

class FakeSource implements KimiWebMessageSource {
  private readonly frameListeners = new Set<(value: KimiWebWsFrame) => void>();
  private readonly resyncListeners = new Set<(value: KimiWebWsResyncRequest) => void>();
  private readonly closeListeners = new Set<(value: KimiWebWsCloseInfo) => void>();
  private readonly reconnectStartListeners = new Set<() => void>();
  private readonly reconnectReadyListeners = new Set<(value: KimiWebWsAck) => void>();
  readonly pendingAck = deferred<KimiWebWsAck>();

  subscribe(_sessionIds: string[], _cursors?: Record<string, KimiWebWsCursor>) {
    return this.pendingAck.promise;
  }

  subscriptions() {
    return [SESSION_ID];
  }

  onFrame(listener: (value: KimiWebWsFrame) => void) {
    this.frameListeners.add(listener);
    return () => this.frameListeners.delete(listener);
  }

  onResyncRequired(listener: (value: KimiWebWsResyncRequest) => void) {
    this.resyncListeners.add(listener);
    return () => this.resyncListeners.delete(listener);
  }

  onClose(listener: (value: KimiWebWsCloseInfo) => void) {
    this.closeListeners.add(listener);
    return () => this.closeListeners.delete(listener);
  }

  onReconnectStart(listener: () => void) {
    this.reconnectStartListeners.add(listener);
    return () => this.reconnectStartListeners.delete(listener);
  }

  onReconnectReady(listener: (value: KimiWebWsAck) => void) {
    this.reconnectReadyListeners.add(listener);
    return () => this.reconnectReadyListeners.delete(listener);
  }

  emitFrame(value: KimiWebWsFrame) {
    for (const listener of this.frameListeners) listener(value);
  }

  emitResync() {
    for (const listener of this.resyncListeners) {
      listener({ sessionId: SESSION_ID, reason: 'buffer_overflow', currentSeq: 21, epoch: EPOCH, source: 'frame' });
    }
  }

  emitClose() {
    for (const listener of this.closeListeners) {
      listener({
        code: 1001,
        reason: 'heartbeat timeout',
        wasClean: true,
        manual: false,
        classification: { kind: 'heartbeat-timeout', detail: 'heartbeat timeout' },
      });
    }
  }

  emitReconnectStart() {
    for (const listener of this.reconnectStartListeners) listener();
  }

  emitReconnectReady(seq: number, epoch = EPOCH) {
    const value: KimiWebWsAck = {
      id: 'reconnect-hello',
      code: 0,
      payload: { cursors: { [SESSION_ID]: { seq, epoch } }, resync_required: [] },
    };
    for (const listener of this.reconnectReadyListeners) listener(value);
  }

  ack(seq: number) {
    this.pendingAck.resolve({
      id: 'subscribe-1',
      code: 0,
      payload: { cursors: { [SESSION_ID]: { seq, epoch: EPOCH } }, resync_required: [] },
    });
  }
}

function createHarness(options: {
  getSnapshot?: () => Promise<KimiWebSnapshot>;
  getMessages?: () => Promise<KimiWebPage<KimiWebMessage>>;
  maxBufferedFrames?: number;
} = {}) {
  const source = new FakeSource();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  const updateMessage = vi.fn((info: MessageInfo) => messages.set(info.id, info));
  const updatePart = vi.fn((part: MessagePart) => parts.set(part.id, part));
  const loadHistory = vi.fn((entries: Array<{ info: MessageInfo; parts: MessagePart[] }>) => {
    for (const entry of entries) {
      if (!entry.info || !Array.isArray(entry.parts)) continue;
      messages.set(entry.info.id, entry.info);
      for (const part of entry.parts) parts.set(part.id, part);
    }
  });
  const removeMessage = vi.fn((messageId: string) => {
    messages.delete(messageId);
    for (const [partId, part] of parts) {
      if (part.messageID === messageId) parts.delete(partId);
    }
  });
  const applySnapshot = vi.fn();
  const onToolPart = vi.fn();
  const onLiveReasoning = vi.fn();
  const onLiveSubagent = vi.fn();
  const onReconcilePart = vi.fn();
  const onSyncStateChange = vi.fn();
  const bridge = useKimiWebMessageBridge({
    client: source,
    restClient: {
      getSnapshot: options.getSnapshot ?? vi.fn<() => Promise<KimiWebSnapshot>>(),
      getMessages: options.getMessages ?? vi.fn(async () => ({ items: [], has_more: false })),
    },
    msg: { updateMessage, updatePart, loadHistory, removeMessage },
    applySnapshot,
    onToolPart,
    onLiveReasoning,
    onLiveSubagent,
    onReconcilePart,
    onSyncStateChange,
    maxBufferedFrames: options.maxBufferedFrames,
  });
  return {
    source, bridge, messages, parts, loadHistory, removeMessage, applySnapshot,
    onToolPart, onLiveReasoning, onLiveSubagent, onReconcilePart, onSyncStateChange,
  };
}

function restAssistant(text: string, id = 'msg_server_assistant'): KimiWebMessage {
  return {
    id,
    session_id: SESSION_ID,
    role: 'assistant',
    content: [{ type: 'text', text }],
    created_at: '2026-09-21T03:27:08.130Z',
  };
}

function snapshot(overrides: Partial<KimiWebSnapshot> = {}): KimiWebSnapshot {
  return {
    as_of_seq: 21,
    epoch: EPOCH,
    session: {
      id: SESSION_ID,
      workspace_id: 'workspace-1',
      title: 'Fixture',
      busy: true,
      main_turn_active: true,
      pending_interaction: 'none',
      archived: false,
    },
    messages: { items: [] },
    in_flight_turn: null,
    ...overrides,
  };
}

function delta(seq: number, text: string, offset = 0, epoch = EPOCH): KimiWebWsFrame {
  const base = frame('assistant.delta');
  return {
    ...base,
    seq,
    epoch,
    offset,
    session_id: SESSION_ID,
    payload: {
      ...(base.payload && typeof base.payload === 'object' ? base.payload : {}),
      sessionId: SESSION_ID,
      agentId: 'main',
      turnId: 0,
      delta: text,
    },
  };
}

async function enterLive(source: FakeSource, bridge: ReturnType<typeof useKimiWebMessageBridge>, seq: number) {
  const subscribing = bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq, epoch: EPOCH } });
  source.ack(seq);
  await subscribing;
}

describe('useKimiWebMessageBridge', () => {
  it('writes a live fixture delta into the message store', async () => {
    const { source, bridge, parts } = createHarness();
    await enterLive(source, bridge, 9);

    source.emitFrame(frame('turn.step.started'));
    source.emitFrame(frame('assistant.delta'));

    expect([...parts.values()]).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hi! What can I help' }),
    ]);
  });

  it('suppresses replay callbacks and restores live semantics on the first post-ack frame', async () => {
    const { source, bridge, onToolPart } = createHarness();
    const subscribing = bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq: 21, epoch: EPOCH } });

    source.emitFrame(frame('tool.call.started'));
    expect(onToolPart).not.toHaveBeenCalled();
    expect(bridge.syncState(SESSION_ID).kind).toBe('replaying');

    source.ack(22);
    await subscribing;
    source.emitFrame(frame('tool.result'));

    expect(bridge.syncState(SESSION_ID).kind).toBe('live');
    expect(onToolPart).toHaveBeenCalledOnce();
    expect(onToolPart).toHaveBeenCalledWith(
      expect.objectContaining({ state: expect.objectContaining({ status: 'completed' }) }),
    );
  });

  it('keeps failed turn completion authoritative when prompt.completed follows it', async () => {
    const { source, bridge, messages } = createHarness();
    await enterLive(source, bridge, 62);

    source.emitFrame(derivedFrame('turn.ended'));
    source.emitFrame({ ...frame('prompt.completed'), seq: 64 });

    const failed = [...messages.values()].find((message) => message.role === 'assistant');
    expect(failed).toMatchObject({ error: { name: 'KimiWebTurnError' } });
    expect(bridge.sessionState(SESSION_ID)?.completion).toMatchObject({ reason: 'failed' });
  });

  it('writes usage, work state, and step state into session state', async () => {
    const { source, bridge } = createHarness();
    await enterLive(source, bridge, 9);

    source.emitFrame(frame('turn.step.started'));
    source.emitFrame(frame('turn.step.completed'));
    source.emitFrame({ ...frame('event.session.work_changed'), seq: 12 });
    source.emitFrame(frame('agent.status.updated', 4));

    expect(bridge.sessionState(SESSION_ID)).toMatchObject({
      busy: true,
      contextTokens: 20379,
      step: { phase: 'completed', step: 1 },
      usage: { total: { output: 32 } },
    });
  });

  it('buffers during snapshot rebuild, suppresses callbacks, then resumes live', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const getSnapshot = vi.fn(() => snapshotRequest.promise);
    const { source, bridge, parts, applySnapshot, onToolPart } = createHarness({ getSnapshot });
    await enterLive(source, bridge, 21);
    source.emitResync();
    source.emitFrame(frame('assistant.delta'));

    snapshotRequest.resolve({
      as_of_seq: 21,
      epoch: EPOCH,
      session: { id: SESSION_ID, workspace_id: 'workspace-1', title: 'Fixture', busy: true, main_turn_active: true, pending_interaction: 'none', archived: false },
      messages: { items: [] },
      in_flight_turn: { turn_id: 0, assistant_text: 'Snapshot prefix: ', current_prompt_id: 'prompt-1' },
    });
    await vi.waitFor(() => expect(applySnapshot).toHaveBeenCalledOnce());

    expect(onToolPart).not.toHaveBeenCalled();
    expect([...parts.values()]).toContainEqual(
      expect.objectContaining({ type: 'text', text: 'Snapshot prefix: Hi! What can I help' }),
    );
    expect(bridge.syncState(SESSION_ID).kind).toBe('live');
    source.emitFrame(frame('tool.call.started'));
    expect(onToolPart).toHaveBeenCalledOnce();
  });

  it('loads history through the replay-suppressed path', () => {
    const { bridge, loadHistory, onToolPart, onLiveReasoning, onLiveSubagent } = createHarness();
    const entries = [{ fixture: 'Todo 15 normalized history' }];

    bridge.applyHistory(entries);

    expect(loadHistory).toHaveBeenCalledWith(entries);
    expect(onToolPart).not.toHaveBeenCalled();
    expect(onLiveReasoning).not.toHaveBeenCalled();
    expect(onLiveSubagent).not.toHaveBeenCalled();
  });

  it('reconciles a plain reconnect from the REST tail without duplicates and keeps recovery non-busy', async () => {
    const tailRequest = deferred<KimiWebPage<KimiWebMessage>>();
    const getMessages = vi.fn(() => tailRequest.promise);
    const { source, bridge, parts, onSyncStateChange } = createHarness({ getMessages });
    await enterLive(source, bridge, 9);
    source.emitFrame(frame('event.session.work_changed'));
    source.emitFrame(delta(10, 'speculative'));
    onSyncStateChange.mockClear();

    source.emitClose();
    expect(bridge.sessionState(SESSION_ID)).toMatchObject({ busy: false, mainTurnActive: false });
    source.emitReconnectStart();
    source.emitReconnectReady(10);
    expect(bridge.syncState(SESSION_ID).kind).toBe('degraded');

    tailRequest.resolve({ items: [restAssistant('authoritative')], has_more: false });
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));

    const textParts = [...parts.values()].filter((part) => part.type === 'text');
    expect(textParts).toEqual([expect.objectContaining({ text: 'authoritative' })]);
    expect(onSyncStateChange.mock.calls.map(([, state]) => state.kind)).toEqual([
      'disconnected', 'replaying', 'degraded', 'live',
    ]);
  });

  it('uses snapshot content replacement then appends buffered same-seq volatile deltas in arrival order', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const { source, bridge, parts } = createHarness({ getSnapshot: () => snapshotRequest.promise });
    await enterLive(source, bridge, 20);
    source.emitResync();
    source.emitFrame(delta(21, 'Snapshot prefix'));
    source.emitFrame(delta(21, ' + later', 1));

    snapshotRequest.resolve(snapshot({
      in_flight_turn: {
        turn_id: 0,
        assistant_text: 'Snapshot prefix',
        current_prompt_id: 'prompt-1',
      },
    }));
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));

    expect([...parts.values()].filter((part) => part.type === 'text')).toContainEqual(
      expect.objectContaining({ text: 'Snapshot prefix + later' }),
    );
  });

  it('drops a stale-epoch snapshot and rebuilds from the new epoch', async () => {
    const oldRequest = deferred<KimiWebSnapshot>();
    const newRequest = deferred<KimiWebSnapshot>();
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => oldRequest.promise)
      .mockImplementationOnce(() => newRequest.promise);
    const { source, bridge, applySnapshot } = createHarness({ getSnapshot });
    await enterLive(source, bridge, 20);
    source.emitResync();
    source.emitFrame({ ...frame('turn.started'), seq: 1, epoch: 'ep_new' });

    oldRequest.resolve(snapshot());
    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    expect(applySnapshot).not.toHaveBeenCalled();

    newRequest.resolve(snapshot({ as_of_seq: 1, epoch: 'ep_new' }));
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID)).toMatchObject({
      kind: 'live', cursor: { seq: 1, epoch: 'ep_new' },
    }));
    expect(applySnapshot).toHaveBeenCalledOnce();
  });

  it('drops snapshot responses after the bridge is stopped', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const { source, bridge, applySnapshot } = createHarness({ getSnapshot: () => snapshotRequest.promise });
    await enterLive(source, bridge, 20);
    source.emitResync();
    bridge.stop();

    snapshotRequest.resolve(snapshot());
    await Promise.resolve();
    await Promise.resolve();
    expect(applySnapshot).not.toHaveBeenCalled();
    expect(bridge.syncState(SESSION_ID).kind).toBe('disconnected');
  });

  it('restarts snapshot recovery when the rebuilding buffer overflows', async () => {
    const first = deferred<KimiWebSnapshot>();
    const second = deferred<KimiWebSnapshot>();
    const getSnapshot = vi.fn()
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise);
    const { source, bridge } = createHarness({ getSnapshot, maxBufferedFrames: 2 });
    await enterLive(source, bridge, 20);
    source.emitResync();
    source.emitFrame(delta(21, 'a'));
    source.emitFrame(delta(21, 'b', 1));
    source.emitFrame(delta(21, 'c', 2));

    await vi.waitFor(() => expect(getSnapshot).toHaveBeenCalledTimes(2));
    first.resolve(snapshot());
    second.resolve(snapshot({ in_flight_turn: { turn_id: 0, assistant_text: 'abc' } }));
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));
  });

  it('fences a late REST tail so it cannot overwrite newer live frames', async () => {
    const tailRequest = deferred<KimiWebPage<KimiWebMessage>>();
    const { source, bridge, parts } = createHarness({ getMessages: () => tailRequest.promise });
    await enterLive(source, bridge, 9);
    source.emitClose();
    source.emitReconnectStart();
    source.emitReconnectReady(10);
    source.emitFrame(delta(11, 'new live'));
    tailRequest.resolve({ items: [restAssistant('stale REST')], has_more: false });
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));

    const texts = [...parts.values()]
      .filter((part): part is Extract<MessagePart, { type: 'text' }> => part.type === 'text')
      .map((part) => part.text);
    expect(texts).toContain('new live');
    expect(texts).not.toContain('stale REST');
  });

  it('routes terminal replay parts through reconcile-only without opening new windows', async () => {
    const { source, bridge, onToolPart, onReconcilePart } = createHarness();
    const subscribing = bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq: 20, epoch: EPOCH } });
    source.emitFrame(frame('tool.call.started'));
    source.emitFrame(frame('tool.result'));

    expect(onToolPart).not.toHaveBeenCalled();
    expect(onReconcilePart).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ type: 'tool', state: expect.objectContaining({ status: 'completed' }) }),
      'tool',
    );
    source.ack(22);
    await subscribing;
  });
});
