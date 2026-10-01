/**
 * Neutral operation union emitted by the dsh normalizer.
 *
 * Maps `session/follow` records (`{type:'event',event:{type,seq,time,data}}`) into
 * the existing `MessageInfo` / `MessagePart` shapes without touching the shared
 * contracts (memory #801). Terminal state derives ONLY from `turn/end`
 * `reason.kind`; nothing else is a success or failure signal.
 */
import type { MessageInfo, MessagePart } from '../../types/sse';
import type { DshSessionAddress, DshSessionRecord } from './types';

/**
 * `turn/end` reason (`docs/dsh.md` §8.3: `completed` | `error` | `aborted` | ...).
 * Declared locally because `types.ts` is a landed contract this task must not touch.
 */
export type DshTurnReasonKind = 'completed' | 'error' | 'aborted' | 'cancelled' | (string & {});

export type DshTurnReason = {
  readonly kind: DshTurnReasonKind;
  readonly code?: string;
  readonly message?: string;
};

export type DshNormalizeOp =
  /** A `MessageInfo` upsert (assistant turn, or user message pushed by the inbox). */
  | { kind: 'message'; message: MessageInfo }
  /** A `MessagePart` upsert; `delta` carries the incremental slice for live UI. */
  | { kind: 'part'; part: MessagePart; delta?: string }
  /** Turn lifecycle; `reason` only on `ended` and is authoritative. */
  | { kind: 'turn'; phase: 'started' | 'ended'; sessionId: string; turn: number; time: number;
      reason?: DshTurnReason }
  /** Step lifecycle inside a turn. */
  | { kind: 'step'; phase: 'started' | 'completed'; sessionId: string; turn: number; step: number;
      time: number }
  /** Session-level policy defaults (`permission/preset` etc.). */
  | { kind: 'policy'; policy: 'permission-preset' | 'sandbox-mode' | 'approval-policy'; value: string;
      time: number }
  /** A user message spliced into the session (`agent/inbox/spliced` / `user/message`). */
  | { kind: 'user-message'; sessionId: string; messageId: string; sourceKind: string; rpcId?: string;
      role: string; time: number }
  /** A system-injected message (`system/message`). */
  | { kind: 'system-message'; sessionId: string; turn: number; step: number; role: string; text: string;
      time: number }
  /** `session/title` + `session/title-llm-request`. */
  | { kind: 'session-title'; sessionId: string; title: string; messageSeqs: readonly number[];
      sourceKind: string; time: number }
  /** LLM request envelope (`request/header` / `request/context`). */
  | { kind: 'request'; phase: 'header' | 'context'; sessionId: string; provider?: string; model?: string;
      contextWindow?: number; reasoningEffort?: string; tools?: readonly string[]; time: number }
  /** Subagent child-session terminal (and completion) mapping. */
  | { kind: 'subagent'; phase: 'terminal' | 'completed'; parentSessionId: string; childSessionId: string;
      mode: string; turn: number;
      reason?: DshTurnReason; time: number }
  /** A turn/step failure surfaced as a message error. */
  | { kind: 'error'; sessionId?: string; code?: string; message: string; time: number };

export type DshNormalizeResult = {
  eventType: string;
  sessionId?: string;
  /** True when the record was already applied (replay / duplicate seq). */
  duplicate: boolean;
  /** Number of duplicate records detected in this ingest call. */
  duplicateCount: number;
  ops: DshNormalizeOp[];
};

export type DshNormalizeStats = {
  frames: number;
  appliedRecordCount: number;
  duplicateRecordCount: number;
  duplicateDeltaCount: number;
  staleDeltaCount: number;
  ignoredEventCount: number;
  unknownEventCount: number;
  malformedCount: number;
};

export type DshNormalizerOptions = {
  /** Subagent child-session address when the caller pages a child (`session/page`). */
  address?: DshSessionAddress;
  now?: () => number;
};

export type DshNormalizer = {
  /** Ingest one wire payload: mux frame, follow frame, record, or page result. */
  ingest(raw: unknown): DshNormalizeResult;
  stats(): DshNormalizeStats;
  reset(): void;
  /** Applied seq high-water mark (`cursor` of the authoritative snapshot). */
  cursor(): number;
  /** Session id learned from the snapshot header (or the page caller). */
  sessionId(): string;
  /** Address the normalizer is bound to (subagent children included). */
  address(): DshSessionAddress | undefined;
  /** Records replayed into this normalizer (test/introspection helper). */
  appliedRecords(): readonly DshSessionRecord[];
};
