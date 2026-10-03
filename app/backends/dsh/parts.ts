/**
 * Per-turn aggregation state (delta buckets, tool parts) plus the
 * `MessageInfo` / `MessagePart` construction shared by the event handlers.
 *
 * Dedup lives here, not only in the seq gate:
 *   - `appliedSeqs`     — replay/snapshot idempotence (replay contract R1/R2)
 *   - `appliedChunks`   — live-delta vs durable attempt-stream chunk identity
 *   - `sealedGroups`    — a durable full message replaces streamed deltas
 *                         (kimi L43 lesson: never append the complete fragment)
 */
import type {
  AssistantMessageInfo,
  MessageError,
  MessageInfo,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';
import type { DshSessionAddress, DshSessionRecord, DshSessionWireEvent } from './types';
import type { DshNormalizeOp, DshNormalizeStats } from './ops';
import { sumDshAttemptUsage, type DshMessageTokens } from './tokenUsage';

export type DshJson = Record<string, unknown>;

export function isRecord(value: unknown): value is DshJson {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export function asString(value: unknown): string {
  return typeof value === 'string' ? value : '';
}

export function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

export function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

export function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** `data.message` when nested, otherwise the data itself (wire puts it inline). */
export function messageOf(data: unknown): DshJson {
  if (!isRecord(data)) return {};
  const nested = data.message;
  return isRecord(nested) ? nested : data;
}

/** Flattened text of a content-part array (`[{type:'text'|'reasoning',text}]`). */
export function textOfContent(content: unknown, kind: 'text' | 'reasoning'): string {
  return asArray(content)
    .filter((part): part is DshJson => isRecord(part))
    .filter((part) => asString(part.type) === kind)
    .map((part) => asString(part.text))
    .join('');
}

export type DshDeltaBucket = { text: string; chunks: Map<number, string>; extras: string[] };

export const newBucket = (): DshDeltaBucket => ({ text: '', chunks: new Map(), extras: [] });

export function aggregate(bucket: DshDeltaBucket): string {
  const ordered = [...bucket.chunks.entries()].sort((left, right) => left[0] - right[0]).map(([, text]) => text);
  return bucket.text + ordered.join('') + bucket.extras.join('');
}

/**
 * Apply one delta to a bucket. Returns `undefined` when the chunk was already
 * applied (duplicate) or arrived after the bucket was sealed by a durable
 * message (stale) — both cases must produce no op.
 */
export function applyDelta(
  core: DshCore,
  bucket: DshDeltaBucket,
  key: string,
  index: number | undefined,
  delta: string,
): { text: string; delta?: string } | undefined {
  if (index !== undefined) {
    if (core.appliedChunks.has(key)) {
      core.stats.duplicateDeltaCount += 1;
      return undefined;
    }
    core.appliedChunks.add(key);
    bucket.chunks.set(index, delta);
    return { text: aggregate(bucket), delta };
  }
  bucket.extras.push(delta);
  return { text: aggregate(bucket), delta: delta || undefined };
}

export type DshGroup = {
  sessionId: string;
  parentSessionId?: string;
  turn: number;
  step: number;
  messageID: string;
  startedAt: number;
  endedAt?: number;
  usageAttempt: number;
  usageByAttempt: Map<number, DshMessageTokens>;
  model: { providerID: string; modelID: string; variant?: string };
  error?: MessageError;
  finish?: string;
  text: DshDeltaBucket;
  reasoning: DshDeltaBucket;
};

export type DshCore = {
  now: () => number;
  stats: DshNormalizeStats;
  address: DshSessionAddress | undefined;
  sessionId: string;
  cursor: number;
  appliedSeqs: Set<number>;
  appliedChunks: Set<string>;
  appliedMessages: Set<string>;
  pendingUserMessageIds: string[];
  turnParents: Map<number, string>;
  activeTurn: number;
  lastUserMessageId: string;
  sessionTitle: string;
  sealedGroups: Set<string>;
  groups: Map<string, DshGroup>;
  toolParts: Map<string, ToolPart>;
  model: { providerID: string; modelID: string; variant?: string };
  /** Agent identity carried on the shared message: dsh's session agent preset. */
  agentPreset: string;
  permissionPreset: string;
  turnPermissionPresets: Map<number, string>;
  userMessages: Map<string, UserMessageInfo>;
  records: DshSessionRecord[];
  attempts: Map<string, { turn: number; step: number }>;
};

/** Shared part metadata; subagent children carry their parent linkage. */
export function partMeta(core: DshCore, extra?: Record<string, unknown>): Record<string, unknown> {
  return { source: 'dsh-web', ...subagentMeta(core), ...extra };
}

/** Session-level (non-message) metadata, used by policy ops. */
export function moduleLevelMeta(extra?: Record<string, unknown>): Record<string, unknown> {
  return { source: 'dsh-web', ...extra };
}

/** Subagent identity pair, or `{}` for a plain session. */
export function subagentMeta(core: DshCore): Record<string, unknown> {
  const address = core.address;
  return address?.kind === 'subagent'
    ? { subagent: { parentSessionId: address.parentSessionId, childSessionId: address.childSessionId, mode: address.mode } }
    : {};
}

export function toolPartKeyOf(sessionId: string, messageID: string, callId: string): string {
  return `${sessionId}|${messageID}:tool:${callId}`;
}

export function groupKeyOf(sessionId: string, turn: number, step = 1): string {
  return `${sessionId}|${turn}|${step}`;
}

export function buildMessage(core: DshCore, group: DshGroup): AssistantMessageInfo {
  const message: AssistantMessageInfo = {
    id: group.messageID,
    sessionID: group.sessionId,
    role: 'assistant',
    time: { created: group.startedAt, completed: group.endedAt },
    parentID: core.turnParents.get(group.turn) ?? core.lastUserMessageId,
    modelID: group.model.modelID,
    providerID: group.model.providerID,
    variant: group.model.variant,
    mode: '',
    agent: agentLabelOf(core),
    permissionPreset: core.turnPermissionPresets.get(group.turn) || undefined,
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: sumDshAttemptUsage(group.usageByAttempt),
  };
  if (group.error) message.error = group.error;
  if (group.finish) message.finish = group.finish;
  return message;
}

export function agentLabelOf(core: DshCore): string {
  return core.address?.kind === 'subagent' ? 'subagent' : core.agentPreset;
}

export function userMessageOf(core: DshCore, sessionId: string, messageId: string, time: number, permissionPreset = core.permissionPreset): UserMessageInfo {
  const message: UserMessageInfo = {
    id: messageId,
    sessionID: sessionId,
    role: 'user',
    time: { created: time },
    agent: agentLabelOf(core),
    permissionPreset: permissionPreset || undefined,
    model: { providerID: core.model.providerID, modelID: core.model.modelID },
    variant: core.model.variant,
  };
  core.userMessages.set(messageId, message);
  return message;
}

export function ensureGroup(
  core: DshCore,
  sessionId: string,
  turn: number,
  time: number | undefined,
  ops: DshNormalizeOp[],
  step = 1,
): DshGroup {
  if (!core.turnPermissionPresets.has(turn)) core.turnPermissionPresets.set(turn, core.permissionPreset);
  const key = groupKeyOf(sessionId, turn, step);
  let group = core.groups.get(key);
  if (!group) {
    group = {
      sessionId,
      ...(core.address?.kind === 'subagent'
        ? { parentSessionId: core.address.parentSessionId }
        : {}),
      turn,
      step,
      messageID: `${sessionId}:t${turn}${step === 1 ? '' : `:s${step}`}`,
      startedAt: time ?? core.now(),
      usageAttempt: 0,
      usageByAttempt: new Map(),
      model: { ...core.model },
      text: newBucket(),
      reasoning: newBucket(),
    };
    core.groups.set(key, group);
    ops.push({ kind: 'message', message: buildMessage(core, group) });
  }
  return group;
}

export function textPartOf(core: DshCore, group: DshGroup, extra?: Record<string, unknown>): TextPart {
  return {
    id: `${group.messageID}:text`,
    sessionID: group.sessionId,
    messageID: group.messageID,
    type: 'text',
    text: aggregate(group.text),
    time: { start: group.startedAt, end: group.endedAt },
    metadata: partMeta(core, extra),
  };
}

export function reasoningPartOf(core: DshCore, group: DshGroup, extra?: Record<string, unknown>): ReasoningPart {
  return {
    id: `${group.messageID}:reasoning`,
    sessionID: group.sessionId,
    messageID: group.messageID,
    type: 'reasoning',
    text: aggregate(group.reasoning),
    metadata: partMeta(core, extra),
    time: { start: group.startedAt, end: group.endedAt },
  };
}

/**
 * Emit the closing parts of a turn. `forceText` keeps an (possibly empty) text
 * part so a terminal turn still exposes a part carrying the terminal marker.
 */
export function terminalParts(
  core: DshCore,
  group: DshGroup,
  forceText: boolean,
  extra: Record<string, unknown> | undefined,
  ops: DshNormalizeOp[],
) {
  const text = aggregate(group.text);
  if (forceText || text) ops.push({ kind: 'part', part: textPartOf(core, group, extra) });
  if (aggregate(group.reasoning)) ops.push({ kind: 'part', part: reasoningPartOf(core, group, extra) });
}

export function toolPartOf(core: DshCore, group: DshGroup, callId: string, tool: string): ToolPart {
  return {
    id: `${group.messageID}:tool:${callId}`,
    sessionID: group.sessionId,
    messageID: group.messageID,
    type: 'tool',
    callID: callId,
    tool,
    state: { status: 'pending', input: {}, raw: '' },
    metadata: partMeta(core),
  };
}

/**
 * Turn reason of `turn/end` (`reason.kind` is authoritative).
 * The failure payload nests differently by producer: `turn/end` puts it under
 * `reason.error.failure`, an attempt's `finish` chunk under `reason.failure`.
 */
export function turnReasonOf(data: unknown): { kind: string; code?: string; message?: string } {
  const reason = isRecord(data) ? data.reason : undefined;
  const source = isRecord(reason) ? reason : {};
  const error = isRecord(source.error) ? source.error : {};
  const failure = isRecord(error.failure) ? error.failure : (isRecord(source.failure) ? source.failure : {});
  return {
    kind: asString(source.kind) || 'unknown',
    code: asString(error.code) || asString(failure.code) || undefined,
    message: asString(error.message) || asString(failure.message) || undefined,
  };
}

/** Subagent identity of an address, or `undefined` for a plain session. */
export function subagentOf(address: DshSessionAddress | undefined) {
  return address?.kind === 'subagent' ? address : undefined;
}

export type { DshSessionAddress, DshSessionRecord, DshSessionWireEvent, MessageInfo };
