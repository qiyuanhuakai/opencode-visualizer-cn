/**
 * Per-turn aggregation state (volatile delta buckets, turn groups) plus the
 * MessageInfo / MessagePart construction shared by the event handlers.
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
  sessionId: string;
  agentId: string;
  turnId: number;
  sessionID: string;
  messageID: string;
  startedAt: number;
  endedAt?: number;
  parentId: string;
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
  promptIds: Map<string, string>;
  promptUserMessageIds: Map<string, string>;
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
  };
  if (group.error) message.error = group.error;
  return message;
}

export function ensureGroup(
  core: KimiWebCore,
  sessionId: string,
  agentId: string,
  turnId: number,
  payload: KimiWebPayload,
  ops: KimiWebNormalizeOp[],
): KimiWebGroup {
  const sessionID = core.subagentIdentity(sessionId, agentId, turnId);
  const key = `${sessionID}|${turnId}`;
  let group = core.groups.get(key);
  if (!group) {
    const promptId = asString(payload.promptId) || core.promptIds.get(`${sessionId}|${agentId}`) || '';
    group = {
      sessionId,
      agentId,
      turnId,
      sessionID,
      messageID: `${sessionID}:${agentId}:${turnId}`,
      startedAt: asNumber(payload.time) ?? core.now(),
      parentId: core.promptUserMessageIds.get(`${sessionId}|${promptId}`) || promptId,
      usageStepIds: new Set(),
      text: newBucket(),
      reasoning: newBucket(),
    };
    core.groups.set(key, group);
    ops.push({ kind: 'message', message: buildMessage(core, group) });
  }
  core.agentTurns.set(`${sessionId}|${agentId}`, turnId);
  return group;
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

export function toolPartKey(core: KimiWebCore, sessionId: string, agentId: string, turnId: number, callId: string) {
  const group = core.groups.get(`${core.subagentIdentity(sessionId, agentId, turnId)}|${turnId}`);
  return group ? `${group.messageID}:tool:${callId}` : '';
}
