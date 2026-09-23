/**
 * Kimi Web WS event normalizer (kimi web 0.43.0, docs/kimi.md).
 *
 * Maps wire events into the existing `MessageInfo`/`MessagePart` shapes without
 * touching the shared contracts. Completion state derives ONLY from
 * `turn.ended.reason`; `prompt.completed` is never a success signal.
 *
 * State is centralized here for Todo 14/16 reuse, including the subagent
 * identity mapping `{session_id}:{agent_id}:{turn_id}` (kimi has no independent
 * sub-session id: children are agents inside the parent session).
 */
import { AGENT_HANDLERS } from './handlers-agent';
import { CORE_HANDLERS } from './handlers-core';
import { EVENT_HANDLERS } from './handlers-events';
import type {
  KimiWebNormalizeOp,
  KimiWebNormalizeResult,
  KimiWebNormalizeStats,
  KimiWebNormalizer,
} from './ops';
import { sessionOf, type KimiWebCore } from './parts';
import {
  KIMI_WEB_IGNORED_EVENTS,
  isRecord,
  kimiWebSubagentSessionId,
  type KimiWebPayload,
  type KimiWebWireFrame,
} from './wire';

const HANDLERS = { ...CORE_HANDLERS, ...AGENT_HANDLERS, ...EVENT_HANDLERS };

function asWireFrame(value: unknown): KimiWebWireFrame | undefined {
  if (!isRecord(value) || typeof value.type !== 'string') return undefined;
  return value as unknown as KimiWebWireFrame;
}

export function createKimiWebNormalizer(options: { now?: () => number } = {}): KimiWebNormalizer {
  const stats: KimiWebNormalizeStats = {
    frames: 0, unknownEventCount: 0, ignoredEventCount: 0, staleDeltaCount: 0, duplicateDeltaCount: 0,
  };
  const subagentKeys = new Map<string, string>();
  const core: KimiWebCore = {
    now: options.now ?? (() => Date.now()),
    stats,
    groups: new Map(),
    toolParts: new Map(),
    agentTurns: new Map(),
    agentModels: new Map(),
    agentUsage: new Map(),
    agentProfiles: new Map(),
    promptIds: new Map(),
    promptUserMessageIds: new Map(),
    subagentIdentity(sessionId: string, agentId: string, turnId?: number) {
      if (!agentId || agentId === 'main') return sessionId;
      const key = `${sessionId}|${agentId}`;
      const existing = subagentKeys.get(key);
      if (existing) return existing;
      const seeded = kimiWebSubagentSessionId(sessionId, agentId, turnId ?? core.agentTurns.get(key) ?? 0);
      subagentKeys.set(key, seeded);
      return seeded;
    },
  };

  return {
    ingest(raw: unknown): KimiWebNormalizeResult {
      stats.frames += 1;
      let frame: KimiWebWireFrame | undefined;
      if (typeof raw === 'string') {
        try {
          frame = asWireFrame(JSON.parse(raw));
        } catch {
          frame = undefined;
        }
      } else {
        frame = asWireFrame(raw);
      }
      if (!frame) {
        stats.unknownEventCount += 1;
        return { eventType: '', volatile: false, ops: [] };
      }
      const payload: KimiWebPayload = isRecord(frame.payload) ? frame.payload : {};
      const ops: KimiWebNormalizeOp[] = [];
      const handler = HANDLERS[frame.type];
      if (handler) {
        handler(core, frame, payload, ops);
      } else if (KIMI_WEB_IGNORED_EVENTS.has(frame.type)) {
        stats.ignoredEventCount += 1;
      } else {
        stats.unknownEventCount += 1;
      }
      return {
        eventType: frame.type,
        sessionId: sessionOf(frame, payload) || undefined,
        volatile: frame.volatile === true,
        ops,
      };
    },
    stats() {
      return { ...stats };
    },
    reset() {
      core.groups.clear();
      core.toolParts.clear();
      subagentKeys.clear();
      core.agentTurns.clear();
      core.agentModels.clear();
      core.agentUsage.clear();
      core.agentProfiles.clear();
      core.promptIds.clear();
      core.promptUserMessageIds.clear();
    },
    subagentSessionId(sessionId: string, agentId: string, turnId?: number) {
      return core.subagentIdentity(sessionId, agentId, turnId);
    },
  };
}

export {
  KIMI_WEB_IGNORED_EVENTS,
  KIMI_WEB_SUPPORTED_EVENTS,
  kimiWebSubagentSessionId,
  resolveKimiWebToolName,
} from './wire';
export type {
  KimiWebAgentStatus,
  KimiWebTurnError,
  KimiWebTurnReason,
  KimiWebUsage,
  KimiWebUsageReport,
  KimiWebWireFrame,
} from './wire';
export type { KimiWebNormalizeOp, KimiWebNormalizeResult, KimiWebNormalizeStats, KimiWebNormalizer } from './ops';
