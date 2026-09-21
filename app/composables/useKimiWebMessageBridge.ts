import {
  createKimiWebNormalizer,
  type KimiWebNormalizeOp,
  type KimiWebNormalizeResult,
  type KimiWebNormalizer,
} from '../backends/kimiWeb/normalize';
import type { KimiWebSnapshot } from '../utils/kimiWeb';
import type { KimiWebWsAck, KimiWebWsCursor, KimiWebWsFrame } from '../utils/kimiWebWs';
import type { MessageInfo } from '../types/sse';
import type {
  KimiWebBridgeSessionState,
  KimiWebMessageBridgeOptions,
  KimiWebSessionPatch,
  KimiWebStatus,
  KimiWebSyncState,
} from './kimiWebMessageBridgeTypes';

export type {
  KimiWebBridgeSessionState,
  KimiWebMessageBridgeOptions,
  KimiWebMessageSource,
  KimiWebSyncState,
} from './kimiWebMessageBridgeTypes';

type FrameOrigin = 'live' | 'durable-replay' | 'snapshot-rebuild';

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function assertNever(value: never): never {
  throw new Error(`Unhandled Kimi Web normalize op: ${JSON.stringify(value)}`);
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
  const rebuildGenerations = new Map<string, number>();
  const appliedDurable = new Set<string>();

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
    sessionStates.set(sessionId, { ...sessionStates.get(sessionId), sessionId, sync });
  }

  function mergeSession(sessionId: string, patch: KimiWebSessionPatch) {
    const sync = syncStates.get(sessionId) ?? { kind: 'disconnected' as const };
    sessionStates.set(sessionId, { ...sessionStates.get(sessionId), ...patch, sessionId, sync });
  }

  function applyAgentStatus(sessionId: string, status: KimiWebStatus) {
    if (!status) return;
    mergeSession(sessionId, {
      usage: status.usage,
      contextTokens: status.contextTokens,
      maxContextTokens: status.maxContextTokens,
      planMode: status.planMode,
    });
  }

  function applyOp(op: KimiWebNormalizeOp, result: KimiWebNormalizeResult, origin: FrameOrigin) {
    switch (op.kind) {
      case 'message':
        messages.set(op.message.id, op.message);
        options.msg.updateMessage(op.message);
        return;
      case 'part': {
        options.msg.updatePart(op.part);
        if (origin !== 'live') return;
        const info = messages.get(op.part.messageID);
        if (op.part.type === 'tool') options.onToolPart?.(op.part);
        else if (info && op.part.sessionID !== result.sessionId) options.onLiveSubagent?.(info, op.part);
        else if (info && op.part.type === 'reasoning') options.onLiveReasoning?.(info, op.part);
        return;
      }
      case 'turn':
        if (op.phase === 'ended' && (op.reason === 'completed' || op.reason === 'cancelled' || op.reason === 'failed')) {
          mergeSession(op.sessionId, { completion: { reason: op.reason, error: op.error } });
        }
        return;
      case 'step':
        mergeSession(op.sessionId, { step: op });
        return;
      case 'agent':
        if (op.phase === 'status') applyAgentStatus(op.sessionId, op.status);
        return;
      case 'session':
        mergeSession(op.sessionId, {
          busy: op.busy,
          mainTurnActive: op.mainTurnActive,
          pendingInteraction: op.pendingInteraction,
          lastTurnReason: op.lastTurnReason,
          status: op.status,
          currentPromptId: op.currentPromptId,
        });
        options.onSessionEvent?.(op);
        return;
      case 'prompt':
      case 'interaction':
      case 'subagent':
      case 'compaction':
      case 'error':
      case 'warning':
        return;
      default:
        return assertNever(op);
    }
  }

  function normalize(frame: KimiWebWsFrame, origin: FrameOrigin) {
    const sessionId = frame.session_id ?? '__global__';
    const result = normalizerFor(sessionId).ingest(frame);
    for (const op of result.ops) applyOp(op, result, origin);
  }

  function acceptFrame(frame: KimiWebWsFrame, forcedOrigin?: FrameOrigin) {
    const sessionId = frame.session_id;
    if (!sessionId) {
      normalize(frame, forcedOrigin ?? 'durable-replay');
      return;
    }
    const sync = syncStates.get(sessionId) ?? { kind: 'disconnected' as const };
    if (sync.kind === 'rebuilding' && !forcedOrigin) {
      setSync(sessionId, { kind: 'rebuilding', buffered: [...sync.buffered, frame] });
      return;
    }
    if (frame.volatile === true) {
      // Contract §6.2 lines 203-205: volatile frames share the durable opener's seq;
      // filtering them by seq<=cursor/U would discard valid live deltas.
      normalize(frame, forcedOrigin ?? (sync.kind === 'live' ? 'live' : 'durable-replay'));
      return;
    }
    if (typeof frame.seq !== 'number') {
      normalize(frame, forcedOrigin ?? (sync.kind === 'live' ? 'live' : 'durable-replay'));
      return;
    }
    const durableKey = `${sessionId}:${frame.epoch ?? ''}:${frame.seq}`;
    if (appliedDurable.has(durableKey)) return;
    if (sync.kind === 'live' && sync.cursor.epoch === frame.epoch) {
      if (frame.seq <= sync.cursor.seq) return;
      if (frame.seq > sync.cursor.seq + 1) {
        startRebuild(sessionId, [frame]);
        return;
      }
      setSync(sessionId, { kind: 'live', cursor: { seq: frame.seq, epoch: sync.cursor.epoch } });
    }
    appliedDurable.add(durableKey);
    normalize(frame, forcedOrigin ?? (sync.kind === 'live' ? 'live' : 'durable-replay'));
  }

  function seedInFlight(snapshot: KimiWebSnapshot) {
    const turn = snapshot.in_flight_turn;
    if (!turn) return;
    const base = {
      seq: snapshot.as_of_seq,
      epoch: snapshot.epoch,
      session_id: snapshot.session.id,
    };
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

  async function rebuild(sessionId: string, generation: number) {
    const snapshot = await options.restClient.getSnapshot(sessionId);
    if (rebuildGenerations.get(sessionId) !== generation) return;
    await options.applySnapshot(snapshot);
    if (rebuildGenerations.get(sessionId) !== generation) return;

    normalizerFor(sessionId).reset();
    seedInFlight(snapshot);
    const rebuilding = syncStates.get(sessionId);
    const buffered = rebuilding?.kind === 'rebuilding' ? rebuilding.buffered : [];
    setSync(sessionId, { kind: 'live', cursor: { seq: snapshot.as_of_seq, epoch: snapshot.epoch } });
    const durable = buffered
      .filter((entry) => entry.volatile !== true && typeof entry.seq === 'number')
      .sort((left, right) => (left.seq ?? 0) - (right.seq ?? 0));
    for (const entry of durable) acceptFrame(entry, 'snapshot-rebuild');
    for (const entry of buffered.filter((item) => item.volatile === true)) {
      const { offset: _connectionLocalOffset, seq: _sharedOpenerSeq, ...appendOnlyFrame } = entry;
      acceptFrame(appendOnlyFrame, 'snapshot-rebuild');
    }
  }

  function startRebuild(sessionId: string, initial: readonly KimiWebWsFrame[] = []) {
    const current = syncStates.get(sessionId);
    if (current?.kind === 'rebuilding') {
      setSync(sessionId, { kind: 'rebuilding', buffered: [...current.buffered, ...initial] });
      return;
    }
    const generation = (rebuildGenerations.get(sessionId) ?? 0) + 1;
    rebuildGenerations.set(sessionId, generation);
    setSync(sessionId, { kind: 'rebuilding', buffered: [...initial] });
    void rebuild(sessionId, generation);
  }

  const unsubscribers = [
    options.client.onFrame((frame) => acceptFrame(frame)),
    options.client.onResyncRequired((request) => startRebuild(request.sessionId)),
    options.client.onClose(() => {
      for (const sessionId of options.client.subscriptions()) setSync(sessionId, { kind: 'disconnected' });
    }),
  ];

  return {
    async subscribe(sessionIds: string[], cursors?: Record<string, KimiWebWsCursor>) {
      for (const sessionId of sessionIds) {
        // Contract §6.1 lines 177-185 and evidence map 2.2/2.3: replay starts when
        // subscribe is sent and ends only when this exact control promise resolves its ack.
        setSync(sessionId, { kind: 'replaying', boundary: 'matching-subscribe-ack' });
      }
      const ack = await options.client.subscribe(sessionIds, cursors);
      for (const sessionId of sessionIds) {
        if (ackNeedsResync(ack, sessionId)) startRebuild(sessionId);
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
      for (const unsubscribe of unsubscribers) unsubscribe();
      for (const sessionId of options.client.subscriptions()) setSync(sessionId, { kind: 'disconnected' });
    },
  };
}
