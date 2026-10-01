/**
 * Per-utterance aggregation state (volatile delta buckets, utterance groups)
 * plus the MessageInfo / MessagePart construction shared by the event handlers.
 *
 * A kimi "turn" is a sequence of "steps" (utterances): each step opens with a
 * durable `turn.step.started` carrying a fresh seq, and every volatile delta of
 * that step shares that seq. REST history exposes one row per step, so live text
 * is segmented per utterance rather than aggregated per turn.
 */
import type {
  AssistantMessageInfo,
  MessageError,
  MessageInfo,
  ReasoningPart,
  TextPart,
  ToolPart,
} from '../../types/sse';
import type { KimiWebNormalizeOp, KimiWebNormalizeStats } from './ops';
import {
  asNumber,
  asString,
  type KimiWebPayload,
  type KimiWebUsageReport,
  type KimiWebWireFrame,
} from './wire';

export type DeltaBucket = { seq: number; text: string; chunks: Map<number, string>; extras: string[] };
export const newBucket = (): DeltaBucket => ({ seq: -1, text: '', chunks: new Map(), extras: [] });

export type KimiWebGroup = {
  key: string;
  sessionId: string;
  agentId: string;
  turnId: number;
  sessionID: string;
  messageID: string;
  startedAt: number;
  endedAt?: number;
  parentId: string;
  /** seq that opened this utterance; undefined when no durable opener was seen. */
  openSeq?: number;
  usage?: { inputOther: number; output: number; inputCacheRead: number; inputCacheCreation: number };
  usageStepIds: Set<string>;
  error?: MessageError;
  text: DeltaBucket;
  reasoning: DeltaBucket;
};

export type KimiWebCore = {
  now: () => number;
  stats: KimiWebNormalizeStats;
  groups: Map<string, KimiWebGroup>;
  toolParts: Map<string, ToolPart>;
  agentTurns: Map<string, number>;
  agentModels: Map<string, { providerID: string; modelID: string }>;
  agentUsage: Map<string, KimiWebUsageReport>;
  agentProfiles: Map<string, { effort?: string; permission?: string }>;
  agentContexts: Map<string, { contextTokens?: number; maxContextTokens?: number }>;
  promptIds: Map<string, string>;
  promptUserMessageIds: Map<string, string>;
  lastUserMessageIds: Map<string, string>;
  /** `${sessionId}|${agentId}|${turnId}` -> group key of the currently open utterance. */
  currentStep: Map<string, string>;
  /** `${sessionId}|${agentId}|${turnId}` -> group key of the last opened utterance (turn.ended finalization). */
  lastStepKey: Map<string, string>;
  /** `${sessionId}|${agentId}|${turnId}` -> next monotonic utterance counter. */
  stepCounters: Map<string, number>;
  /** `${sessionId}|${agentId}|${callId}` -> owning messageID (tool.result shares no seq with its call). */
  toolMessages: Map<string, string>;
  /** `${sessionId}|${agentId}` -> parent messageID for a spawned subagent. */
  subagentParents: Map<string, string>;
  subagentIdentity: (sessionId: string, agentId: string, turnId?: number) => string;
};

export function sessionOf(frame: KimiWebWireFrame, payload: KimiWebPayload): string {
  const fromPayload = asString(payload.sessionId);
  if (fromPayload) return fromPayload;
  const envelope = asString(frame.session_id);
  return envelope && envelope !== '__global__' ? envelope : '';
}

export function aggregate(bucket: DeltaBucket): string {
  const ordered = [...bucket.chunks.entries()].sort((left, right) => left[0] - right[0]).map(([, text]) => text);
  return bucket.text + ordered.join('') + bucket.extras.join('');
}

export function applyDelta(
  core: KimiWebCore,
  bucket: DeltaBucket,
  seq: number | undefined,
  offset: number | undefined,
  delta: string,
) {
  if (seq !== undefined) {
    if (seq < bucket.seq) {
      core.stats.staleDeltaCount += 1;
      return undefined;
    }
    if (seq > bucket.seq) {
      bucket.text = aggregate(bucket);
      bucket.seq = seq;
      bucket.chunks.clear();
      bucket.extras = [];
    }
  }
  if (offset === undefined) {
    if (delta) bucket.extras.push(delta);
    return { text: aggregate(bucket), delta: delta || undefined };
  }
  if (bucket.chunks.has(offset)) {
    core.stats.duplicateDeltaCount += 1;
    return undefined;
  }
  bucket.chunks.set(offset, delta);
  return { text: aggregate(bucket), delta };
}

export function buildMessage(core: KimiWebCore, group: KimiWebGroup): MessageInfo {
  const profile = core.agentProfiles.get(`${group.sessionId}|${group.agentId}`);
  const usage = group.usage;
  const model = core.agentModels.get(`${group.sessionId}|${group.agentId}`) ?? {
    providerID: 'kimi-code',
    modelID: 'unknown',
  };
  const context = core.agentContexts.get(`${group.sessionId}|${group.agentId}`);
  const message: AssistantMessageInfo = {
    id: group.messageID,
    sessionID: group.sessionID,
    role: 'assistant',
    time: { created: group.startedAt, completed: group.endedAt },
    parentID: group.parentId,
    modelID: model.modelID,
    providerID: model.providerID,
    mode: profile?.permission ?? '',
    agent: group.agentId,
    ...(profile?.effort ? { variant: profile.effort } : {}),
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: {
      input: usage?.inputOther ?? 0,
      output: usage?.output ?? 0,
      reasoning: 0,
      cache: { read: usage?.inputCacheRead ?? 0, write: usage?.inputCacheCreation ?? 0 },
    },
    ...(context && context.contextTokens !== undefined && Number.isFinite(context.contextTokens)
      ? { contextTokens: context.contextTokens }
      : {}),
    ...(context && context.maxContextTokens !== undefined && Number.isFinite(context.maxContextTokens)
      ? { maxContextTokens: context.maxContextTokens }
      : {}),
  };
  if (group.error) message.error = group.error;
  return message;
}

export function findCurrentGroup(
  core: KimiWebCore,
  sessionId: string,
  agentId: string,
  turnId: number,
): KimiWebGroup | undefined {
  const key = core.currentStep.get(`${sessionId}|${agentId}|${turnId}`);
  return key ? core.groups.get(key) : undefined;
}

/**
 * Opens a new utterance group. The key carries a monotonic per-(session, agent,
 * turn) counter rather than the uuid stepId so `byTimeThenId` ordering stays
 * deterministic; the messageID mirrors that counter.
 */
export function openUtteranceGroup(
  core: KimiWebCore,
  sessionId: string,
  agentId: string,
  turnId: number,
  payload: KimiWebPayload,
  ops: KimiWebNormalizeOp[],
  openSeq?: number,
): KimiWebGroup {
  const sessionID = core.subagentIdentity(sessionId, agentId, turnId);
  const counterKey = `${sessionId}|${agentId}|${turnId}`;
  let counter = core.stepCounters.get(counterKey) ?? 0;
  let key = `${sessionID}|${turnId}|${counter}`;
  while (core.groups.has(key)) {
    counter += 1;
    key = `${sessionID}|${turnId}|${counter}`;
  }
  core.stepCounters.set(counterKey, counter + 1);
  const utteranceKey = String(counter);
  const promptId = asString(payload.promptId) || core.promptIds.get(`${sessionId}|${agentId}`) || '';
  // A prompt id is not a message id: when no prompt→user-message mapping exists
  // (system-trigger prompts, main-agent continuation turns), falling back to the
  // raw promptId manufactures an orphan root in the message store. Fall back to
  // the session's last user message so every assistant parent resolves to a real
  // message; only a session with no user message at all keeps the raw promptId.
  const group: KimiWebGroup = {
    key,
    sessionId,
    agentId,
    turnId,
    sessionID,
    messageID: `${sessionID}:${agentId}:${turnId}:${utteranceKey}`,
    startedAt: asNumber(payload.time) ?? core.now(),
    openSeq,
    parentId:
      core.subagentParents.get(`${sessionId}|${agentId}`) ||
      core.promptUserMessageIds.get(`${sessionId}|${promptId}`) ||
      core.lastUserMessageIds.get(sessionId) ||
      promptId,
    usageStepIds: new Set(),
    text: newBucket(),
    reasoning: newBucket(),
  };
  core.groups.set(key, group);
  // Turn-level alias for out-of-scope handlers-agent.ts, which resolves the active
  // group by `${sessionID}|${turnId}`. It tracks the latest utterance group, so an
  // agent.status.updated lands context on the current card. Between a step.completed
  // and the next step.started it points at the just-ended group; that is harmless
  // because the next group is rebuilt with the latest context attached anyway.
  core.groups.set(`${sessionID}|${turnId}`, group);
  core.currentStep.set(counterKey, key);
  core.lastStepKey.set(counterKey, key);
  core.agentTurns.set(`${sessionId}|${agentId}`, turnId);
  ops.push({ kind: 'message', message: buildMessage(core, group) });
  return group;
}

export function resolveToolMessageId(
  core: KimiWebCore,
  sessionId: string,
  agentId: string,
  callId: string,
): string {
  const direct = core.toolMessages.get(`${sessionId}|${agentId}|${callId}`);
  if (direct) return direct;
  for (const part of core.toolParts.values()) {
    if (part.callID === callId) return part.messageID;
  }
  return '';
}

export function textPartOf(group: KimiWebGroup): TextPart {
  return {
    id: `${group.messageID}:text`,
    sessionID: group.sessionID,
    messageID: group.messageID,
    type: 'text',
    text: aggregate(group.text),
    time: { start: group.startedAt, end: group.endedAt },
    metadata: { source: 'kimi-web' },
  };
}

export function reasoningPartOf(group: KimiWebGroup): ReasoningPart {
  return {
    id: `${group.messageID}:reasoning`,
    sessionID: group.sessionID,
    messageID: group.messageID,
    type: 'reasoning',
    text: aggregate(group.reasoning),
    metadata: { source: 'kimi-web' },
    time: { start: group.startedAt, end: group.endedAt },
  };
}

export function terminalParts(group: KimiWebGroup, forceText: boolean, ops: KimiWebNormalizeOp[]) {
  if (forceText || aggregate(group.text)) ops.push({ kind: 'part', part: textPartOf(group) });
  if (aggregate(group.reasoning)) ops.push({ kind: 'part', part: reasoningPartOf(group) });
}
