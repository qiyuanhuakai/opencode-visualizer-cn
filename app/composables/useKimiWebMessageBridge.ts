import {
  createKimiWebNormalizer,
  type KimiWebNormalizer,
} from '../backends/kimiWeb/normalize';
import type { KimiWebSnapshot } from '../utils/kimiWeb';
import type { KimiWebWsAck, KimiWebWsCursor, KimiWebWsFrame } from '../utils/kimiWebWs';
import type { MessageInfo } from '../types/sse';
import {
  authoritativeEntries,
  snapshotBoundaryFrames,
  tailEntries,
} from './kimiWebMessageReconcile';
import { createKimiWebOpApplier } from './kimiWebMessageOps';
import type {
  KimiWebBridgeSessionState,
  KimiWebFrameOrigin,
  KimiWebMessageBridgeOptions,
  KimiWebSessionPatch,
  KimiWebSyncState,
} from './kimiWebMessageBridgeTypes';

export type {
  KimiWebBridgeSessionState,
  KimiWebMessageBridgeOptions,
  KimiWebMessageSource,
  KimiWebSyncState,
} from './kimiWebMessageBridgeTypes';

const DEFAULT_MAX_BUFFERED_FRAMES = 1000;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function ackCursor(ack: KimiWebWsAck, sessionId: string): KimiWebWsCursor | undefined {
  const cursors = isRecord(ack.payload?.cursors) ? ack.payload.cursors : undefined;
  const cursor = isRecord(cursors?.[sessionId]) ? cursors[sessionId] : undefined;
  return typeof cursor?.seq === 'number' && typeof cursor.epoch === 'string'
    ? { seq: cursor.seq, epoch: cursor.epoch }
    : undefined;
}

function ackNeedsResync(ack: KimiWebWsAck, sessionId: string): boolean {
  return Array.isArray(ack.payload?.resync_required) && ack.payload.resync_required.includes(sessionId);
}

export function useKimiWebMessageBridge(options: KimiWebMessageBridgeOptions) {
  const syncStates = new Map<string, KimiWebSyncState>();
  const sessionStates = new Map<string, KimiWebBridgeSessionState>();
  const normalizers = new Map<string, KimiWebNormalizer>();
  const messages = new Map<string, MessageInfo>();
  const ownedMessageIds = new Map<string, Set<string>>();
  const recoveryGenerations = new Map<string, number>();
  const mutationGenerations = new Map<string, number>();
  const latestCursors = new Map<string, KimiWebWsCursor>();
  const appliedDurable = new Set<string>();
  const maxBufferedFrames = options.maxBufferedFrames ?? DEFAULT_MAX_BUFFERED_FRAMES;
  let stopped = false;

  const normalizerFor = (sessionId: string) => {
    let normalizer = normalizers.get(sessionId);
    if (!normalizer) {
      normalizer = createKimiWebNormalizer();
      normalizers.set(sessionId, normalizer);
    }
    return normalizer;
  };

  function setSync(sessionId: string, sync: KimiWebSyncState) {
    syncStates.set(sessionId, sync);
    if (sync.kind === 'live' || sync.kind === 'degraded') latestCursors.set(sessionId, sync.cursor);
    sessionStates.set(sessionId, { ...sessionStates.get(sessionId), sessionId, sync });
    options.onSyncStateChange?.(sessionId, sync);
  }

  function mergeSession(sessionId: string, patch: KimiWebSessionPatch) {
    const sync = syncStates.get(sessionId) ?? { kind: 'disconnected' as const };
    sessionStates.set(sessionId, { ...sessionStates.get(sessionId), ...patch, sessionId, sync });
  }

  function ownMessage(sessionId: string, info: MessageInfo) {
    let ids = ownedMessageIds.get(sessionId);
    if (!ids) {
      ids = new Set();
      ownedMessageIds.set(sessionId, ids);
    }
    ids.add(info.id);
  }

  function removeSupersededMessages(sessionId: string) {
    for (const messageId of ownedMessageIds.get(sessionId) ?? []) {
      options.msg.removeMessage(messageId);
      messages.delete(messageId);
    }
    ownedMessageIds.delete(sessionId);
  }

  function applyAuthoritativeEntries(entries: ReturnType<typeof authoritativeEntries>) {
    options.msg.loadHistory(entries);
    for (const entry of entries) messages.set(entry.info.id, entry.info);
  }

  const applyOp = createKimiWebOpApplier({ bridge: options, messages, ownMessage, mergeSession });

  function normalize(frame: KimiWebWsFrame, origin: KimiWebFrameOrigin) {
    const sessionId = frame.session_id ?? '__global__';
    const result = normalizerFor(sessionId).ingest(frame);
    const frameContext = { epoch: frame.epoch, sequence: frame.seq, origin };
    for (const op of result.ops) applyOp(op, result, frameContext);
  }

  function nextRecoveryGeneration(sessionId: string) {
    const generation = (recoveryGenerations.get(sessionId) ?? 0) + 1;
    recoveryGenerations.set(sessionId, generation);
    return generation;
  }

  function bumpMutation(sessionId: string) {
    mutationGenerations.set(sessionId, (mutationGenerations.get(sessionId) ?? 0) + 1);
  }

  function clearEpochState(sessionId: string) {
    removeSupersededMessages(sessionId);
    normalizerFor(sessionId).reset();
    for (const key of [...appliedDurable]) {
      if (key.startsWith(`${sessionId}:`)) appliedDurable.delete(key);
    }
    mergeSession(sessionId, { busy: false, mainTurnActive: false });
  }

  function frameOrigin(sync: KimiWebSyncState): KimiWebFrameOrigin {
    return sync.kind === 'live' ? 'live' : 'durable-replay';
  }

  function bufferRebuildingFrame(sessionId: string, sync: Extract<KimiWebSyncState, { kind: 'rebuilding' }>, frame: KimiWebWsFrame) {
    if (frame.epoch && sync.epoch && frame.epoch !== sync.epoch) {
      clearEpochState(sessionId);
      startRebuild(sessionId, [frame], frame.epoch, true);
      return;
    }
    const buffered = [...sync.buffered, frame];
    if (buffered.length > maxBufferedFrames) {
      startRebuild(sessionId, [], frame.epoch ?? sync.epoch, true);
      return;
    }
    setSync(sessionId, { kind: 'rebuilding', buffered, epoch: sync.epoch ?? frame.epoch });
  }

  function acceptDurableFrame(
    sessionId: string,
    frame: KimiWebWsFrame & { seq: number },
    sync: KimiWebSyncState,
    forcedOrigin?: KimiWebFrameOrigin,
  ) {
    const durableKey = `${sessionId}:${frame.epoch ?? ''}:${frame.seq}`;
    if (appliedDurable.has(durableKey)) return;
    if ((sync.kind === 'live' || sync.kind === 'degraded') && sync.cursor.epoch === frame.epoch) {
      if (frame.seq <= sync.cursor.seq) return;
      if (frame.seq > sync.cursor.seq + 1) {
        startRebuild(sessionId, [frame], frame.epoch);
        return;
      }
      const cursor = { seq: frame.seq, epoch: sync.cursor.epoch };
      setSync(sessionId, sync.kind === 'live' ? { kind: 'live', cursor } : { kind: 'degraded', cursor });
    }
    appliedDurable.add(durableKey);
    bumpMutation(sessionId);
    normalize(frame, forcedOrigin ?? frameOrigin(sync));
  }

  function acceptFrame(frame: KimiWebWsFrame, forcedOrigin?: KimiWebFrameOrigin) {
    const sessionId = frame.session_id;
    if (!sessionId) {
      normalize(frame, forcedOrigin ?? 'durable-replay');
      return;
    }
    const sync = syncStates.get(sessionId) ?? { kind: 'disconnected' as const };
    if (sync.kind === 'disconnected' && !forcedOrigin) return;
    if (sync.kind === 'rebuilding' && !forcedOrigin) {
      bufferRebuildingFrame(sessionId, sync, frame);
      return;
    }

    const knownEpoch = latestCursors.get(sessionId)?.epoch;
    if (!forcedOrigin && frame.epoch && knownEpoch && frame.epoch !== knownEpoch) {
      clearEpochState(sessionId);
      startRebuild(sessionId, [frame], frame.epoch, true);
      return;
    }
    if (frame.volatile === true || typeof frame.seq !== 'number') {
      bumpMutation(sessionId);
      normalize(frame, forcedOrigin ?? frameOrigin(sync));
      return;
    }
    acceptDurableFrame(sessionId, frame as KimiWebWsFrame & { seq: number }, sync, forcedOrigin);
  }

  function seedInFlight(snapshot: KimiWebSnapshot) {
    const turn = snapshot.in_flight_turn;
    if (!turn) return;
    const base = { seq: snapshot.as_of_seq, epoch: snapshot.epoch, session_id: snapshot.session.id };
    normalize({
      ...base,
      type: 'turn.started',
      payload: {
        sessionId: snapshot.session.id,
        agentId: 'main',
        turnId: turn.turn_id,
        promptId: turn.current_prompt_id,
      },
    }, 'snapshot-rebuild');
    if (turn.thinking_text) {
      normalize({ ...base, type: 'thinking.delta', volatile: true, payload: {
        sessionId: snapshot.session.id, agentId: 'main', turnId: turn.turn_id, delta: turn.thinking_text,
      } }, 'snapshot-rebuild');
    }
    if (turn.assistant_text) {
      normalize({ ...base, type: 'assistant.delta', volatile: true, payload: {
        sessionId: snapshot.session.id, agentId: 'main', turnId: turn.turn_id, delta: turn.assistant_text,
      } }, 'snapshot-rebuild');
    }
  }

  function drainSnapshotBuffer(sessionId: string, snapshot: KimiWebSnapshot, buffered: readonly KimiWebWsFrame[]) {
    let seq = snapshot.as_of_seq;
    for (const frame of snapshotBoundaryFrames(snapshot, buffered)) {
      if (frame.volatile !== true && typeof frame.seq === 'number') {
        if (frame.seq > seq + 1) {
          startRebuild(sessionId, [frame], frame.epoch ?? snapshot.epoch, true);
          return undefined;
        }
        seq = Math.max(seq, frame.seq);
        appliedDurable.add(`${sessionId}:${frame.epoch ?? snapshot.epoch}:${frame.seq}`);
      }
      bumpMutation(sessionId);
      normalize(frame, 'snapshot-rebuild');
    }
    return { seq, epoch: snapshot.epoch };
  }

  async function rebuild(sessionId: string, generation: number, expectedEpoch?: string) {
    const snapshot = await options.restClient.getSnapshot(sessionId);
    if (stopped || recoveryGenerations.get(sessionId) !== generation) return;
    if (expectedEpoch && snapshot.epoch !== expectedEpoch) {
      startRebuild(sessionId, [], expectedEpoch, true);
      return;
    }
    await options.applySnapshot(snapshot);
    if (stopped || recoveryGenerations.get(sessionId) !== generation) return;

    const rebuilding = syncStates.get(sessionId);
    if (rebuilding?.kind !== 'rebuilding') return;
    clearEpochState(sessionId);
    applyAuthoritativeEntries(authoritativeEntries(snapshot));
    mergeSession(sessionId, {
      busy: snapshot.session.busy,
      mainTurnActive: snapshot.session.main_turn_active,
      pendingInteraction: snapshot.session.pending_interaction,
      lastTurnReason: snapshot.session.last_turn_reason,
      currentPromptId: snapshot.session.current_prompt_id,
    });
    seedInFlight(snapshot);
    const cursor = drainSnapshotBuffer(sessionId, snapshot, rebuilding.buffered);
    if (!cursor || recoveryGenerations.get(sessionId) !== generation) return;
    setSync(sessionId, { kind: 'live', cursor });
  }

  function startRebuild(
    sessionId: string,
    initial: readonly KimiWebWsFrame[] = [],
    epoch?: string,
    force = false,
  ) {
    const current = syncStates.get(sessionId);
    if (current?.kind === 'rebuilding' && !force) {
      for (const frame of initial) bufferRebuildingFrame(sessionId, current, frame);
      return;
    }
    const generation = nextRecoveryGeneration(sessionId);
    setSync(sessionId, { kind: 'rebuilding', buffered: [...initial], epoch });
    void rebuild(sessionId, generation, epoch).catch(() => undefined);
  }

  async function reconcileTail(sessionId: string, ack: KimiWebWsAck) {
    const cursor = ackCursor(ack, sessionId) ?? latestCursors.get(sessionId);
    if (!cursor) return;
    const generation = nextRecoveryGeneration(sessionId);
    const mutationFence = mutationGenerations.get(sessionId) ?? 0;
    setSync(sessionId, { kind: 'degraded', cursor });
    const page = await options.restClient.getMessages(sessionId);
    if (stopped || recoveryGenerations.get(sessionId) !== generation) return;
    if (syncStates.get(sessionId)?.kind === 'rebuilding') return;
    if ((mutationGenerations.get(sessionId) ?? 0) !== mutationFence) {
      const latest = latestCursors.get(sessionId) ?? cursor;
      setSync(sessionId, { kind: 'live', cursor: latest });
      return;
    }
    removeSupersededMessages(sessionId);
    applyAuthoritativeEntries(tailEntries(page.items));
    setSync(sessionId, { kind: 'live', cursor });
  }

  function reconnectStart() {
    for (const sessionId of options.client.subscriptions()) {
      nextRecoveryGeneration(sessionId);
      normalizerFor(sessionId).reset();
      mergeSession(sessionId, { busy: false, mainTurnActive: false });
      setSync(sessionId, { kind: 'replaying', boundary: 'matching-subscribe-ack' });
    }
  }

  function reconnectReady(ack: KimiWebWsAck) {
    for (const sessionId of options.client.subscriptions()) {
      if (syncStates.get(sessionId)?.kind === 'rebuilding') continue;
      if (ackNeedsResync(ack, sessionId)) startRebuild(sessionId, [], ackCursor(ack, sessionId)?.epoch);
      else void reconcileTail(sessionId, ack).catch(() => undefined);
    }
  }

  const unsubscribers: Array<() => void> = [
    options.client.onFrame((frame) => acceptFrame(frame)),
    options.client.onResyncRequired((request) => {
      clearEpochState(request.sessionId);
      startRebuild(request.sessionId, [], request.epoch, true);
    }),
    options.client.onClose(() => {
      for (const sessionId of options.client.subscriptions()) {
        const kind = syncStates.get(sessionId)?.kind;
        if (kind === 'replaying' || kind === 'degraded' || kind === 'rebuilding') continue;
        mergeSession(sessionId, { busy: false, mainTurnActive: false });
        setSync(sessionId, { kind: 'disconnected' });
      }
    }),
  ];
  if (options.client.onReconnectStart) unsubscribers.push(options.client.onReconnectStart(reconnectStart));
  if (options.client.onReconnectReady) unsubscribers.push(options.client.onReconnectReady(reconnectReady));

  return {
    async subscribe(sessionIds: string[], cursors?: Record<string, KimiWebWsCursor>) {
      for (const sessionId of sessionIds) {
        if (cursors?.[sessionId]) latestCursors.set(sessionId, cursors[sessionId]);
        // Replay contract §6.1 lines 177-185: replay starts at subscribe send and
        // ends only at the matching ack, which is emitted after durable replay.
        setSync(sessionId, { kind: 'replaying', boundary: 'matching-subscribe-ack' });
      }
      const ack = await options.client.subscribe(sessionIds, cursors);
      for (const sessionId of sessionIds) {
        if (ackNeedsResync(ack, sessionId)) startRebuild(sessionId, [], ackCursor(ack, sessionId)?.epoch);
        else {
          const cursor = ackCursor(ack, sessionId) ?? cursors?.[sessionId];
          if (cursor) setSync(sessionId, { kind: 'live', cursor });
        }
      }
      return ack;
    },
    applyHistory(entries: unknown[]) {
      options.msg.loadHistory(entries);
    },
    sessionState: (sessionId: string) => sessionStates.get(sessionId),
    syncState: (sessionId: string): KimiWebSyncState =>
      syncStates.get(sessionId) ?? { kind: 'disconnected' },
    normalizerStats: (sessionId: string) => normalizers.get(sessionId)?.stats(),
    stop() {
      stopped = true;
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const sessionId of options.client.subscriptions()) {
        nextRecoveryGeneration(sessionId);
        mergeSession(sessionId, { busy: false, mainTurnActive: false });
        setSync(sessionId, { kind: 'disconnected' });
      }
    },
  };
}
