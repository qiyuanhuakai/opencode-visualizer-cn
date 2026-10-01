import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';
import { describe, expect, it, vi } from 'vitest';
import { watch, nextTick } from 'vue';

import { kimiWebMessagesToHistoryEntries } from '../backends/kimiWeb/historyEntries';
import type { KimiWebAgentTranscript, KimiWebMessage, KimiWebPage, KimiWebSnapshot } from '../utils/kimiWeb';
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
  getAgentTranscript?: () => Promise<KimiWebAgentTranscript>;
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
  const onSessionModeChange = vi.fn();
  const onSessionEvent = vi.fn();
  const bridge = useKimiWebMessageBridge({
    client: source,
    restClient: {
      getSnapshot: options.getSnapshot ?? vi.fn<() => Promise<KimiWebSnapshot>>(),
      getMessages: options.getMessages ?? vi.fn(async () => ({ items: [], has_more: false })),
      getAgentTranscript: options.getAgentTranscript,
    },
    msg: { updateMessage, updatePart, loadHistory, removeMessage },
    applySnapshot,
    onToolPart,
    onLiveReasoning,
    onLiveSubagent,
    onReconcilePart,
    onSyncStateChange,
    onSessionModeChange,
    onSessionEvent,
    maxBufferedFrames: options.maxBufferedFrames,
  });
  return {
    source, bridge, messages, parts, loadHistory, removeMessage, applySnapshot, onSessionEvent,
    onToolPart, onLiveReasoning, onLiveSubagent, onReconcilePart, onSyncStateChange, onSessionModeChange,
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

function statusFrame(
  seq: number,
  status: Readonly<Record<string, unknown>>,
  agentId = 'main',
  volatile = true,
): KimiWebWsFrame {
  const base = derivedFrame('agent.status.updated');
  return {
    ...base,
    seq,
    volatile,
    payload: {
      type: 'agent.status.updated',
      ...status,
      agentId,
      sessionId: SESSION_ID,
    },
  };
}

async function enterLive(source: FakeSource, bridge: ReturnType<typeof useKimiWebMessageBridge>, seq: number) {
  const subscribing = bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq, epoch: EPOCH } });
  source.ack(seq);
  await subscribing;
}

describe('useKimiWebMessageBridge', () => {
  it('attaches a spawned child to its task card and counts only active children', async () => {
    const { source, bridge, parts } = createHarness();
    await enterLive(source, bridge, 36);
    const started = frame('tool.call.started', 1);
    const spawned = frame('subagent.spawned');
    const completed = frame('subagent.completed');
    source.emitFrame({ ...started, seq: 37 });
    source.emitFrame({ ...spawned, seq: 38 });
    const childId = `${SESSION_ID}:agent-0:0`;
    expect(bridge.activeSubagentIds(SESSION_ID)).toEqual([childId]);
    expect([...parts.values()].find((part) => part.type === 'tool' && part.callID === 'tool_3ydieXPUScwcnZ3KzDPcfeDx'))
      .toMatchObject({ metadata: { sessionIds: [childId] } });
    source.emitFrame({ ...completed, seq: 39 });
    expect(bridge.activeSubagentIds(SESSION_ID)).toEqual([]);
    bridge.stop();
  });
  it('forwards global lifecycle events for sessions that were never selected', () => {
    // Given
    const harness = createHarness();
    // When
    harness.source.emitFrame({ type: 'event.session.archived', session_id: '__global__',
      seq: 5, epoch: 'global-epoch', payload: { sessionId: 'other', workspace_id: 'workspace' } });
    // Then
    expect(harness.onSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'other', phase: 'archived' }), expect.objectContaining({ origin: 'live' }));
    expect(harness.messages.size).toBe(0);
    harness.bridge.stop();
  });

  it('forwards a newly created session before it has a subscription', () => {
    // Given
    const harness = createHarness();
    // When
    harness.source.emitFrame({ type: 'event.session.created', session_id: 'other', seq: 1,
      epoch: 'other-epoch', payload: { session: { id: 'other', workspace_id: 'workspace' } } });
    // Then
    expect(harness.onSessionEvent).toHaveBeenCalledWith(expect.objectContaining({ sessionId: 'other', phase: 'created' }), expect.objectContaining({ origin: 'live' }));
    harness.bridge.stop();
  });
  it('keeps a live response under its submitted user root before and after history replay', async () => {
    const { source, bridge, messages, parts, loadHistory } = createHarness();
    const ready = bridge.subscribe([SESSION_ID]);
    source.ack(0);
    await ready;
    const user = { id: 'msg-live-user', session_id: SESSION_ID, role: 'user' as const,
      content: [{ type: 'text' as const, text: 'Reply only VIS_KIMI_202_OK.' }],
      created_at: '2026-09-22T13:22:47.892Z' };
    source.emitFrame({ type: 'prompt.submitted', seq: 1, epoch: EPOCH, session_id: SESSION_ID, payload: {
      agentId: 'main', promptId: user.id, userMessageId: user.id, status: 'running',
      content: user.content, createdAt: user.created_at, time: 1790083367893,
    } });
    source.emitFrame({ type: 'turn.started', seq: 2, epoch: EPOCH, session_id: SESSION_ID,
      payload: { agentId: 'main', turnId: 2, promptId: user.id, time: 1790083367903 } });
    source.emitFrame({ type: 'turn.step.started', seq: 3, epoch: EPOCH, session_id: SESSION_ID,
      payload: { agentId: 'main', turnId: 2, step: 1, stepId: 'step-2', time: 1790083367904 } });
    const assistant = [...messages.values()].find((message) => message.role === 'assistant');
    expect(messages.get(user.id)).toMatchObject({ role: 'user' });
    expect(assistant).toMatchObject({ parentID: user.id });
    expect(parts.get(user.id + ':text:0')).toMatchObject({ text: user.content[0]?.text });
    expect(loadHistory).not.toHaveBeenCalled();
    bridge.applyHistory(kimiWebMessagesToHistoryEntries([user]));
    expect([...messages.values()].filter((message) => message.role === 'user')).toHaveLength(1);
    expect(messages.get(assistant?.id ?? '')).toMatchObject({ parentID: user.id });
    bridge.stop();
  });

  it('writes a live fixture delta into the message store', async () => {
    const { source, bridge, parts } = createHarness();
    await enterLive(source, bridge, 9);

    source.emitFrame(frame('turn.step.started'));
    source.emitFrame(frame('assistant.delta'));

    expect([...parts.values()]).toEqual([
      expect.objectContaining({ type: 'text', text: 'Hi! What can I help' }),
    ]);
  });

  it('segments a live turn into one text part per utterance instead of one per-turn blob', async () => {
    const { source, bridge, parts } = createHarness();
    const subscribing = bridge.subscribe([SESSION_ID], { [SESSION_ID]: { seq: 4, epoch: EPOCH } });
    for (const entry of liveFrames) source.emitFrame(entry);
    source.ack(liveFrames.at(-1)?.seq ?? 0);
    await subscribing;

    const byMessage = new Map<string, string>();
    for (const part of parts.values()) {
      if (part.type === 'text' && part.messageID.startsWith(`${SESSION_ID}:main:2:`)) {
        byMessage.set(part.messageID, part.text);
      }
    }
    // turn 2's seq 36 and seq 51 utterances must stand as two separate messages.
    expect([...byMessage.keys()]).toEqual([
      `${SESSION_ID}:main:2:0`,
      `${SESSION_ID}:main:2:1`,
    ]);
    expect(byMessage.get(`${SESSION_ID}:main:2:0`)).toContain('AgentSwarm');
    expect(byMessage.get(`${SESSION_ID}:main:2:0`)).not.toContain("subagent's answer");
    expect(byMessage.get(`${SESSION_ID}:main:2:1`)).toContain("subagent's answer");
    bridge.stop();
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

  it('notifies context consumers when live agent usage changes', async () => {
    const { source, bridge } = createHarness();
    await enterLive(source, bridge, 9);
    const changed = vi.fn();
    const stop = watch(() => bridge.sessionState(SESSION_ID)?.contextTokens, changed);
    source.emitFrame(frame('agent.status.updated', 4));
    await nextTick();
    expect(changed).toHaveBeenCalledWith(20379, undefined, expect.any(Function));
    stop();
  });

  it('publishes permission plan swarm and tower from main-agent status', async () => {
    const { source, bridge, onSessionModeChange } = createHarness();
    await enterLive(source, bridge, 75);

    source.emitFrame(statusFrame(76, {
      permission: 'manual',
      planMode: true,
      swarmMode: false,
      towerMode: true,
    }));

    const patch = { permission: 'manual', planMode: true, swarmMode: false, towerMode: true };
    expect(bridge.sessionState(SESSION_ID)).toMatchObject(patch);
    expect(onSessionModeChange).toHaveBeenCalledWith(
      SESSION_ID,
      patch,
      { epoch: EPOCH, sequence: 76, origin: 'live' },
    );
  });

  it('preserves known modes when a later status omits them', async () => {
    const { source, bridge, onSessionModeChange } = createHarness();
    await enterLive(source, bridge, 75);
    const modes = { permission: 'auto', planMode: true, swarmMode: true, towerMode: false };
    source.emitFrame(statusFrame(76, modes));

    source.emitFrame(statusFrame(77, { contextTokens: 42, usage: { total: { output: 1 } } }));

    expect(bridge.sessionState(SESSION_ID)).toMatchObject(modes);
    expect(onSessionModeChange).toHaveBeenCalledOnce();
  });

  it('preserves explicit false', async () => {
    const { source, bridge, onSessionModeChange } = createHarness();
    await enterLive(source, bridge, 75);
    source.emitFrame(statusFrame(76, { planMode: true, swarmMode: true, towerMode: true }));

    source.emitFrame(statusFrame(77, { planMode: false, swarmMode: false, towerMode: false }));

    expect(bridge.sessionState(SESSION_ID)).toMatchObject({ planMode: false, swarmMode: false, towerMode: false });
    expect(onSessionModeChange).toHaveBeenLastCalledWith(
      SESSION_ID,
      { planMode: false, swarmMode: false, towerMode: false },
      { epoch: EPOCH, sequence: 77, origin: 'live' },
    );
  });

  it('does not apply subagent modes to the session composer', async () => {
    const { source, bridge, onSessionModeChange } = createHarness();
    await enterLive(source, bridge, 75);
    const mainModes = { permission: 'manual', planMode: false, swarmMode: false, towerMode: false };
    source.emitFrame(statusFrame(76, mainModes));
    onSessionModeChange.mockClear();

    source.emitFrame(statusFrame(77, {
      permission: 'yolo',
      planMode: true,
      swarmMode: true,
      towerMode: true,
    }, 'agent-0'));

    expect(bridge.sessionState(SESSION_ID)).toMatchObject(mainModes);
    expect(onSessionModeChange).not.toHaveBeenCalled();
  });

  it('publishes event ordering context without duplicating rejected replay frames', async () => {
    const { source, bridge, onSessionModeChange } = createHarness();
    await enterLive(source, bridge, 75);
    const update = statusFrame(76, { permission: 'manual', planMode: true }, 'main', false);

    source.emitFrame(update);
    source.emitFrame(update);

    expect(onSessionModeChange).toHaveBeenCalledOnce();
    expect(onSessionModeChange).toHaveBeenCalledWith(
      SESSION_ID,
      { permission: 'manual', planMode: true },
      { epoch: EPOCH, sequence: 76, origin: 'live' },
    );
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

  it.each([false, true])('parents live task continuations to the latest loaded user (snapshot reset: %s)', async (reset) => {
    // Given a reloaded session whose user prompts arrived before this WS connection.
    const { source, bridge, messages } = createHarness({ getSnapshot: async () => snapshot({ messages: { items: [] } }) });
    bridge.applyHistory(kimiWebMessagesToHistoryEntries([
      { id: 'older-user', session_id: SESSION_ID, role: 'user', created_at: '2026-09-21T01:00:00Z', content: [{ type: 'text', text: 'Older' }] },
      { id: 'latest-user', session_id: SESSION_ID, role: 'user', created_at: '2026-09-21T02:00:00Z', content: [{ type: 'text', text: 'Latest' }] },
      { id: 'other-session-user', session_id: 'another-session', role: 'user', created_at: '2026-09-21T03:00:00Z', content: [{ type: 'text', text: 'Other' }] },
    ]));
    await enterLive(source, bridge, 21);
    if (reset) {
      source.emitResync();
      await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));
    }
    bridge.applyHistory(kimiWebMessagesToHistoryEntries([
      { id: 'old-page-user', session_id: SESSION_ID, role: 'user', created_at: '2026-09-20T01:00:00Z', content: [{ type: 'text', text: 'Older page' }] },
    ]));

    // When a background task submits a hidden prompt and the main agent continues.
    source.emitFrame({ type: 'prompt.submitted', seq: 22, epoch: EPOCH, session_id: SESSION_ID, payload: {
      agentId: 'main', promptId: 'task-prompt', userMessageId: 'task-user',
      content: [{ type: 'text', text: 'Task completed' }], metadata: { origin: { kind: 'task' } },
    } });
    source.emitFrame({ type: 'turn.started', seq: 23, epoch: EPOCH, session_id: SESSION_ID,
      payload: { agentId: 'main', turnId: 7, promptId: 'task-prompt' } });
    source.emitFrame({ type: 'turn.step.started', seq: 24, epoch: EPOCH, session_id: SESSION_ID,
      payload: { agentId: 'main', turnId: 7, step: 1 } });

    // Then no orphan card is manufactured and the other session cannot steal the parent.
    expect(messages.get(`${SESSION_ID}:main:7:0`)).toHaveProperty('parentID', 'latest-user');
    expect(messages.has('task-user')).toBe(false);
    bridge.stop();
  });

  it('restores per-card transcript usage when a snapshot replaces live messages', async () => {
    // Given a snapshot row without usage and its persisted transcript step.
    const transcript: KimiWebAgentTranscript = { agent_id: 'main', has_more: false, items: [{
      kind: 'turn', turnId: 't1', ordinal: 1, state: 'completed', steps: [{
        stepId: 't1.1', usage: { inputOther: 13, output: 29, inputCacheRead: 37, inputCacheCreation: 5 },
        frames: [{ kind: 'text', frameId: 'f1', role: 'assistant', text: 'Completed result' }],
      }],
    }] };
    const { source, bridge, messages } = createHarness({
      getSnapshot: async () => snapshot({ messages: { items: [restAssistant('Completed result')] } }),
      getAgentTranscript: async () => transcript,
    });
    await enterLive(source, bridge, 21);

    // When the bridge rebuilds from the persisted snapshot.
    source.emitResync();
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));

    // Then the replacement card retains its step usage.
    expect(messages.get('msg_server_assistant')).toHaveProperty('tokens', {
      input: 13, output: 29, reasoning: 0, cache: { read: 37, write: 5 },
    });
    bridge.stop();
  });

  it('hydrates usage and context from the snapshot during rebuild', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const { source, bridge } = createHarness({ getSnapshot: () => snapshotRequest.promise });
    await enterLive(source, bridge, 21);
    source.emitResync();
    snapshotRequest.resolve(snapshot({
      session: {
        id: SESSION_ID,
        workspace_id: 'workspace-1',
        title: 'Fixture',
        busy: true,
        main_turn_active: true,
        pending_interaction: 'none',
        archived: false,
        usage: {
          input_tokens: 128,
          output_tokens: 64,
          cache_read_tokens: 32,
          cache_creation_tokens: 16,
          total_cost_usd: 0.01,
          context_tokens: 21109,
          context_limit: 320000,
          turn_count: 3,
        },
      },
    }));
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));
    expect(bridge.sessionState(SESSION_ID)).toMatchObject({
      contextTokens: 21109,
      maxContextTokens: 320000,
      usage: { total: { inputOther: 128, output: 64, inputCacheRead: 32, inputCacheCreation: 16 } },
    });
    bridge.stop();
  });

  it('keeps live context when the rebuild snapshot carries no usage', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const { source, bridge } = createHarness({ getSnapshot: () => snapshotRequest.promise });
    await enterLive(source, bridge, 9);
    source.emitFrame(statusFrame(10, { contextTokens: 20379, maxContextTokens: 320000 }));
    expect(bridge.sessionState(SESSION_ID)).toMatchObject({ contextTokens: 20379, maxContextTokens: 320000 });

    source.emitResync();
    snapshotRequest.resolve(snapshot());
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));
    expect(bridge.sessionState(SESSION_ID)).toMatchObject({ contextTokens: 20379, maxContextTokens: 320000 });
    bridge.stop();
  });

  it('loads history through the replay-suppressed path', () => {
    const { bridge, loadHistory, onToolPart, onLiveReasoning, onLiveSubagent } = createHarness();
    const entries = kimiWebMessagesToHistoryEntries([{ id: 'history-assistant', session_id: SESSION_ID,
      role: 'assistant', content: [
        { type: 'thinking', thinking: 'Historical reasoning' },
        { type: 'tool_use', tool_call_id: 'history-tool', tool_name: 'Read', input: {} },
      ],
    }]);

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

  it('keeps appending the in-flight step live tail after a mid-step rebuild instead of dropping it as stale', async () => {
    const snapshotRequest = deferred<KimiWebSnapshot>();
    const { source, bridge, parts } = createHarness({ getSnapshot: () => snapshotRequest.promise });
    await enterLive(source, bridge, 30);
    source.emitResync();

    // as_of_seq (30) is past the step opener (25) because durable frames landed
    // mid-step, so the live tail carries seq 25 — smaller than the snapshot seq.
    // The seeded group must not treat it as a stale earlier utterance.
    snapshotRequest.resolve(snapshot({
      as_of_seq: 30,
      in_flight_turn: {
        turn_id: 0,
        assistant_text: 'Snapshot prefix',
        current_prompt_id: 'prompt-1',
      },
    }));
    await vi.waitFor(() => expect(bridge.syncState(SESSION_ID).kind).toBe('live'));

    source.emitFrame(delta(25, ' + tail', 15));

    expect([...parts.values()].filter((part) => part.type === 'text')).toContainEqual(
      expect.objectContaining({ text: 'Snapshot prefix + tail' }),
    );
    expect(bridge.normalizerStats(SESSION_ID)?.staleDeltaCount).toBe(0);
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
