/**
 * Turn / step / message / assistant-stream / tool event handlers.
 *
 * Every handler receives the decoded wire event plus the shared `DshCore` state
 * and pushes neutral ops; nothing here mutates the shared `MessageInfo` /
 * `MessagePart` contracts.
 */
import type { ToolPart } from '../../types/sse';
import {
  aggregate,
  applyDelta,
  asArray,
  asNumber,
  asString,
  buildMessage,
  ensureGroup,
  groupKeyOf,
  isRecord,
  subagentOf,
  messageOf,
  partMeta,
  reasoningPartOf,
  textOfContent,
  textPartOf,
  terminalParts,
  toolPartOf,
  turnReasonOf,
  userMessageOf,
  type DshCore,
  type DshGroup,
} from './parts';
import type { DshNormalizeOp } from './ops';
import type { DshSessionWireEvent } from './types';

export type DshHandler = (core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) => void;

const dataOf = (event: DshSessionWireEvent): Record<string, unknown> =>
  isRecord(event.data) ? event.data : {};

function handleTurnStart(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const turn = asNumber(data.turn) ?? 0;
  ensureGroup(core, core.sessionId, turn, event.time, ops);
  ops.push({ kind: 'turn', phase: 'started', sessionId: core.sessionId, turn, time: event.time });
}

function handleTurnEnd(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const turn = asNumber(data.turn) ?? 0;
  const group = ensureGroup(core, core.sessionId, turn, event.time, ops);
  const reason = turnReasonOf(data);
  const terminal = reason.kind !== 'completed';
  group.endedAt = event.time;
  if (reason.kind === 'error') {
    group.error = {
      name: 'DshTurnError',
      data: { code: reason.code, message: reason.message ?? 'dsh turn failed' },
    };
    group.finish = 'error';
  } else if (terminal) {
    group.finish = reason.kind;
  } else {
    group.finish = 'stop';
  }
  core.sealedGroups.add(groupKeyOf(group.sessionId, group.turn));
  ops.push({ kind: 'message', message: buildMessage(core, group) });
  terminalParts(
    core,
    group,
    reason.kind === 'aborted' || reason.kind === 'cancelled',
    terminal ? { terminal: reason.kind } : undefined,
    ops,
  );
  ops.push({
    kind: 'turn', phase: 'ended', sessionId: core.sessionId, turn, time: event.time, reason,
  });
  const subagent = subagentOf(core.address);
  if (subagent) {
    ops.push({
      kind: 'subagent',
      phase: reason.kind === 'completed' ? 'completed' : 'terminal',
      parentSessionId: subagent.parentSessionId,
      childSessionId: subagent.childSessionId,
      mode: subagent.mode,
      turn,
      reason,
      time: event.time,
    });
  }
}

function handleStepStart(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  ops.push({
    kind: 'step',
    phase: 'started',
    sessionId: core.sessionId,
    turn: asNumber(data.turn) ?? 0,
    step: asNumber(data.step) ?? 0,
    time: event.time,
  });
}

function handleStepEnd(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  ops.push({
    kind: 'step',
    phase: 'completed',
    sessionId: core.sessionId,
    turn: asNumber(data.turn) ?? 0,
    step: asNumber(data.step) ?? 0,
    time: event.time,
  });
}

/** User messages pushed by `agent/inbox/spliced` or materialized as `user/message`. */
function handleUserMessage(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const messageId = asString(data.id);
  if (!messageId || core.appliedMessages.has(messageId)) return;
  core.appliedMessages.add(messageId);
  const source = isRecord(data.source) ? data.source : {};
  const content = asArray(data.content);
  const time = event.time;
  ops.push({ kind: 'message', message: userMessageOf(core, core.sessionId, messageId, time) });
  const part = {
    id: `${messageId}:text`,
    sessionID: core.sessionId,
    messageID: messageId,
    type: 'text' as const,
    text: textOfContent(content, 'text'),
    time: { start: time },
    metadata: partMeta(core, {
      sourceKind: asString(source.kind) || 'user',
      ...(asString(source.rpcId) ? { rpcId: asString(source.rpcId) } : {}),
    }),
  };
  ops.push({ kind: 'part', part });
  ops.push({
    kind: 'user-message',
    sessionId: core.sessionId,
    messageId,
    sourceKind: asString(source.kind) || 'user',
    rpcId: asString(source.rpcId) || undefined,
    role: asString(data.role) || 'user',
    time,
  });
}

function handleSystemMessage(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const message = messageOf(data);
  const text = textOfContent(message.content, 'text');
  if (!text) return;
  ops.push({
    kind: 'system-message',
    sessionId: core.sessionId,
    turn: asNumber(data.turn) ?? 0,
    step: asNumber(data.step) ?? 0,
    role: asString(message.role) || 'system',
    text,
    time: event.time,
  });
}

/**
 * Durable full assistant message. Replaces (never appends to) any streamed
 * deltas — the kimi L43 lesson, where appending the server's complete fragment
 * duplicated the whole message.
 */
function handleAssistantMessage(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const turn = asNumber(data.turn) ?? 0;
  const group = ensureGroup(core, core.sessionId, turn, event.time, ops);
  const message = messageOf(data);
  const text = textOfContent(message.content, 'text');
  const reasoning = textOfContent(message.content, 'reasoning');
  const key = groupKeyOf(group.sessionId, group.turn);
  const unchanged = core.sealedGroups.has(key)
    && aggregate(group.text) === text
    && aggregate(group.reasoning) === reasoning;
  group.text = { text, chunks: new Map(), extras: [] };
  group.reasoning = { text: reasoning, chunks: new Map(), extras: [] };
  core.sealedGroups.add(key);
  if (unchanged) return;
  ops.push({ kind: 'message', message: buildMessage(core, group) });
  ops.push({ kind: 'part', part: textPartOf(core, group) });
  if (reasoning) ops.push({ kind: 'part', part: reasoningPartOf(core, group) });
}

/**
 * Durable attempt record: the captured chunk stream of one assistant attempt.
 * The same chunk identity space as the live `assistant-stream` frames, so a
 * delta already applied live is not applied twice here.
 */
function handleAssistantAttempt(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const turn = asNumber(data.turn) ?? 0;
  const group = ensureGroup(core, core.sessionId, turn, event.time, ops);
  applyStreamChunks(core, group, asArray(data.stream), event.time, ops);
  ops.push({ kind: 'message', message: buildMessage(core, group) });
}

function applyStreamChunks(
  core: DshCore,
  group: DshGroup,
  stream: readonly unknown[],
  time: number,
  ops: DshNormalizeOp[],
) {
  for (const [index, raw] of stream.entries()) {
    if (!isRecord(raw)) continue;
    applyChunk(core, group, index, isRecord(raw.chunk) ? raw.chunk : {}, time, ops);
  }
}

/**
 * Apply one attempt chunk. `index` is the chunk's wire index, shared by the
 * live `assistant-stream` frames and the durable attempt stream, which is what
 * makes the same chunk applied twice (once live, once durably) collapse.
 */
function applyChunk(
  core: DshCore,
  group: DshGroup,
  index: number,
  chunk: Record<string, unknown>,
  time: number,
  ops: DshNormalizeOp[],
) {
  const type = asString(chunk.type);
  if (!type) return;
  const key = groupKeyOf(group.sessionId, group.turn);
  const chunkKey = `${key}|${index}`;
  if (core.sealedGroups.has(key)) {
    core.stats.staleDeltaCount += 1;
    return;
  }
  if (type === 'text-delta') {
    const applied = applyDelta(core, group.text, chunkKey, index, asString(chunk.text));
    if (applied) ops.push({ kind: 'part', part: textPartOf(core, group), delta: applied.delta });
    return;
  }
  if (type === 'reasoning-delta') {
    const applied = applyDelta(core, group.reasoning, chunkKey, index, asString(chunk.text));
    if (applied) ops.push({ kind: 'part', part: reasoningPartOf(core, group), delta: applied.delta });
    return;
  }
  if (type === 'tool-call') {
    const callId = asString(chunk.callId);
    if (!callId) return;
    const part = toolPartOf(core, group, callId, asString(chunk.name) || 'other');
    const args = isRecord(chunk.arguments) ? chunk.arguments : {};
    part.state = { status: 'pending', input: args, raw: JSON.stringify(args) };
    core.toolParts.set(part.id, part);
    ops.push({ kind: 'part', part });
    return;
  }
  if (type === 'tool-result') {
    const part = resolveToolPart(core, group, asString(chunk.callId));
    if (!part) return;
    finishToolPart(core, part, chunk, time);
    ops.push({ kind: 'part', part });
    return;
  }
  if (type === 'finish') {
    const reason = turnReasonOf(chunk);
    if (reason.kind === 'error') {
      group.error = {
        name: 'DshTurnError',
        data: { code: reason.code, message: reason.message ?? 'dsh attempt failed' },
      };
      group.finish = 'error';
    } else if (reason.kind === 'completed') {
      group.finish = 'stop';
    } else {
      group.finish = reason.kind;
    }
    core.sealedGroups.add(key);
    ops.push({ kind: 'message', message: buildMessage(core, group) });
  }
}

function handleToolCall(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const callId = asString(data.callId);
  if (!callId) return;
  const group = ensureGroup(core, core.sessionId, asNumber(data.turn) ?? 0, event.time, ops);
  const part = toolPartOf(core, group, callId, asString(data.name) || 'other');
  const args = isRecord(data.arguments) ? data.arguments : {};
  part.state = { status: 'pending', input: args, raw: JSON.stringify(args) };
  core.toolParts.set(part.id, part);
  ops.push({ kind: 'part', part });
}

function handleToolResult(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const group = ensureGroup(core, core.sessionId, asNumber(data.turn) ?? 0, event.time, ops);
  const callId = asString(data.callId);
  const existing = resolveToolPart(core, group, callId);
  if (!existing) return;
  const message = messageOf(data);
  const output = textOfContent(message.content, 'text') || asString(data.output);
  const errorText = asString(data.error);
  const time = event.time;
  const start = existing.state.status === 'pending' ? time : existing.state.time.start;
  const finished: ToolPart = errorText
    ? {
      ...existing,
      state: {
        status: 'error', input: existing.state.input, error: errorText,
        metadata: partMeta(core), time: { start, end: time },
      },
    }
    : {
      ...existing,
      state: {
        status: 'completed', input: existing.state.input, output,
        title: existing.tool, metadata: partMeta(core), time: { start, end: time },
      },
    };
  core.toolParts.set(finished.id, finished);
  ops.push({ kind: 'part', part: finished });
}

/** Resolve a tool part by call id, falling back to the group's newest pending call. */
function resolveToolPart(core: DshCore, group: { messageID: string }, callId: string): ToolPart | undefined {
  if (callId) return core.toolParts.get(`${group.messageID}:tool:${callId}`);
  const prefix = `${group.messageID}:tool:`;
  const pending = [...core.toolParts.values()]
    .filter((part) => part.id.startsWith(prefix) && part.state.status === 'pending')
    .at(-1);
  return pending;
}

function finishToolPart(core: DshCore, part: ToolPart, chunk: Record<string, unknown>, time: number) {
  const errorText = asString(chunk.error);
  const output = textOfContent(chunk.output, 'text') || asString(chunk.output);
  const start = part.state.status === 'pending' ? time : part.state.time.start;
  const finished: ToolPart = errorText
    ? {
      ...part,
      state: {
        status: 'error', input: part.state.input, error: errorText,
        metadata: partMeta(core), time: { start, end: time },
      },
    }
    : {
      ...part,
      state: {
        status: 'completed', input: part.state.input, output,
        title: part.tool, metadata: partMeta(core), time: { start, end: time },
      },
    };
  core.toolParts.set(finished.id, finished);
  Object.assign(part, finished);
}

/**
 * Bind a live `assistant-stream` `start` frame to the turn it streams into, so
 * a later chunk can find its group without carrying the turn on every frame.
 */
export function registerAssistantAttempt(core: DshCore, attemptId: string, turn: number, step: number) {
  if (!attemptId) return;
  core.attempts.set(attemptId, { turn, step });
}

/**
 * Live `assistant-stream` chunk: same dedup identity space as the durable
 * attempt. The wire chunk frame carries no turn, so the attempt→turn binding
 * registered by its `start` frame is what resolves the holding group.
 */
export function applyLiveAssistantChunk(
  core: DshCore,
  attemptId: string,
  index: number,
  chunk: Record<string, unknown>,
  time: number,
  ops: DshNormalizeOp[],
) {
  const turn = core.attempts.get(attemptId)?.turn ?? 0;
  const group = ensureGroup(core, core.sessionId, turn, time, ops);
  applyChunk(core, group, index, chunk, time, ops);
}

export const CORE_HANDLERS: Record<string, DshHandler> = {
  'turn/start': handleTurnStart,
  'turn/end': handleTurnEnd,
  'step/start': handleStepStart,
  'step/end': handleStepEnd,
  'user/message': handleUserMessage,
  'system/message': handleSystemMessage,
  'assistant/message': handleAssistantMessage,
  'assistant/attempt': handleAssistantAttempt,
  'tool/call': handleToolCall,
  'tool/result': handleToolResult,
};

