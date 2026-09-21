import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';

import type { KimiWebSnapshot } from '../utils/kimiWeb';
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

  emitFrame(value: KimiWebWsFrame) {
    for (const listener of this.frameListeners) listener(value);
  }

  emitResync() {
    for (const listener of this.resyncListeners) {
      listener({ sessionId: SESSION_ID, reason: 'buffer_overflow', currentSeq: 21, epoch: EPOCH, source: 'frame' });
    }
  }

  ack(seq: number) {
    this.pendingAck.resolve({
      id: 'subscribe-1',
      code: 0,
      payload: { cursors: { [SESSION_ID]: { seq, epoch: EPOCH } }, resync_required: [] },
    });
  }
}

function createHarness(getSnapshot = vi.fn<() => Promise<KimiWebSnapshot>>()) {
  const source = new FakeSource();
  const messages = new Map<string, MessageInfo>();
  const parts = new Map<string, MessagePart>();
  const updateMessage = vi.fn((info: MessageInfo) => messages.set(info.id, info));
  const updatePart = vi.fn((part: MessagePart) => parts.set(part.id, part));
  const loadHistory = vi.fn();
  const applySnapshot = vi.fn();
  const onToolPart = vi.fn();
  const onLiveReasoning = vi.fn();
  const onLiveSubagent = vi.fn();
  const bridge = useKimiWebMessageBridge({
    client: source,
    restClient: { getSnapshot },
    msg: { updateMessage, updatePart, loadHistory },
    applySnapshot,
    onToolPart,
    onLiveReasoning,
    onLiveSubagent,
  });
  return { source, bridge, messages, parts, loadHistory, applySnapshot, onToolPart, onLiveReasoning, onLiveSubagent };
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
    const { source, bridge, parts, applySnapshot, onToolPart } = createHarness(getSnapshot);
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
});
