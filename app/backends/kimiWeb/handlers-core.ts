/**
 * Turn / step / volatile-delta / tool / agent event handlers.
 */
import type { ToolPart } from '../../types/sse';
import type { KimiWebNormalizeOp } from './ops';
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  resolveKimiWebToolName,
  textOf,
  turnReason,
  type KimiWebPayload,
  type KimiWebUsage,
  type KimiWebWireFrame,
} from './wire';
import {
  applyDelta,
  buildMessage,
  ensureGroup,
  reasoningPartOf,
  sessionOf,
  terminalParts,
  textPartOf,
  toolPartKey,
  type KimiWebCore,
} from './parts';

export type KimiWebHandler = (
  core: KimiWebCore,
  frame: KimiWebWireFrame,
  payload: KimiWebPayload,
  ops: KimiWebNormalizeOp[],
) => void;

function handleTurnStarted(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? 0;
  const promptId = asString(payload.promptId);
  if (promptId) core.promptIds.set(`${sessionId}|${agentId}`, promptId);
  ensureGroup(core, sessionId, agentId, turnId, payload, ops);
  ops.push({
    kind: 'turn', phase: 'started', sessionId, agentId, turnId,
    promptId: promptId || undefined, time: asNumber(payload.time) ?? core.now(),
  });
}

function handleTurnEnded(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? core.agentTurns.get(`${sessionId}|${agentId}`) ?? 0;
  const group = ensureGroup(core, sessionId, agentId, turnId, payload, ops);
  const time = asNumber(payload.time) ?? core.now();
  const reason = turnReason(payload.reason);
  const interruptReason = asString(payload.interruptReason) || undefined;
  const errorPayload = isRecord(payload.error) ? payload.error : {};
  group.endedAt = time;
  if (reason === 'failed' || reason === 'blocked') {
    group.error = {
      name: 'KimiWebTurnError',
      data: {
        code: asString(errorPayload.code) || undefined,
        message: asString(errorPayload.message) || asString(errorPayload.msg) || 'Kimi turn failed',
        retryable: asBoolean(errorPayload.retryable),
        interruptReason,
      },
    };
  }
  ops.push({ kind: 'message', message: buildMessage(core, group) });
  terminalParts(group, false, ops);
  ops.push({
    kind: 'turn', phase: 'ended', sessionId, agentId, turnId, reason, time,
    error: reason === 'failed' ? {
      code: asString(errorPayload.code) || undefined,
      message: asString(errorPayload.message) || 'Kimi turn failed',
      retryable: asBoolean(errorPayload.retryable),
      interruptReason,
    } : undefined,
    durationMs: asNumber(payload.durationMs), interruptReason,
  });
}

function handleTurnStep(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const phase = frame.type.slice('turn.step.'.length) as 'started' | 'completed' | 'retrying' | 'interrupted';
  if (phase === 'completed' && isRecord(payload.usage)) {
    const sessionId = sessionOf(frame, payload);
    const agentId = asString(payload.agentId) || 'main';
    const turnId = asNumber(payload.turnId) ?? 0;
    const group = ensureGroup(core, sessionId, agentId, turnId, payload, ops);
    const stepId = asString(payload.stepId) || String(asNumber(payload.step) ?? 0);
    if (!group.usageStepIds.has(stepId)) {
      group.usageStepIds.add(stepId);
      const usage = payload.usage;
      const previous = group.usage;
      group.usage = {
        inputOther: (previous?.inputOther ?? 0) + (asNumber(usage.inputOther) ?? 0),
        output: (previous?.output ?? 0) + (asNumber(usage.output) ?? 0),
        inputCacheRead: (previous?.inputCacheRead ?? 0) + (asNumber(usage.inputCacheRead) ?? 0),
        inputCacheCreation: (previous?.inputCacheCreation ?? 0) + (asNumber(usage.inputCacheCreation) ?? 0),
      };
      ops.push({ kind: 'message', message: buildMessage(core, group) });
    }
  }
  ops.push({
    kind: 'step',
    phase,
    sessionId: sessionOf(frame, payload),
    agentId: asString(payload.agentId) || 'main',
    turnId: asNumber(payload.turnId) ?? 0,
    step: asNumber(payload.step) ?? 0,
    stepId: asString(payload.stepId) || undefined,
    usage: isRecord(payload.usage) ? (payload.usage as KimiWebUsage) : undefined,
    reason: asString(payload.reason) || undefined,
    message: asString(payload.message) || undefined,
    failedAttempt: asNumber(payload.failedAttempt),
    nextAttempt: asNumber(payload.nextAttempt),
    maxAttempts: asNumber(payload.maxAttempts),
    delayMs: asNumber(payload.delayMs),
    errorName: asString(payload.errorName) || undefined,
    errorMessage: asString(payload.errorMessage) || undefined,
    statusCode: asNumber(payload.statusCode),
  });
}

function handleDelta(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? 0;
  const group = ensureGroup(core, sessionId, agentId, turnId, payload, ops);
  const bucket = frame.type === 'assistant.delta' ? group.text : group.reasoning;
  const applied = applyDelta(core, bucket, asNumber(frame.seq), asNumber(frame.offset), asString(payload.delta));
  if (!applied) return;
  ops.push({
    kind: 'part',
    part: frame.type === 'assistant.delta' ? textPartOf(group) : reasoningPartOf(group),
    delta: applied.delta,
  });
}

function handleToolStarted(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const group = ensureGroup(
    core,
    sessionOf(frame, payload),
    asString(payload.agentId) || 'main',
    asNumber(payload.turnId) ?? 0,
    payload,
    ops,
  );
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  const input = isRecord(payload.args) ? payload.args : {};
  const description = asString(payload.description);
  const part: ToolPart = {
    id: `${group.messageID}:tool:${callId}`,
    sessionID: group.sessionID,
    messageID: group.messageID,
    type: 'tool',
    callID: callId,
    tool: resolveKimiWebToolName(asString(payload.name)),
    state: { status: 'pending', input, raw: textOf(input) },
    metadata: { source: 'kimi-web', ...(description ? { title: description } : {}) },
  };
  core.toolParts.set(part.id, part);
  ops.push({ kind: 'part', part });
}

function handleToolProgress(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  const existing = core.toolParts.get(
    toolPartKey(core, sessionOf(frame, payload), asString(payload.agentId) || 'main', asNumber(payload.turnId) ?? 0, callId),
  );
  if (!existing) return;
  const update = isRecord(payload.update) ? payload.update : {};
  const text = asString(update.text);
  const previous = existing.state.status === 'running'
    ? asString(isRecord(existing.state.metadata) ? existing.state.metadata.output : '')
    : '';
  const running: ToolPart = {
    ...existing,
    state: {
      status: 'running',
      input: existing.state.input,
      title: typeof existing.metadata?.title === 'string' ? existing.metadata.title : undefined,
      metadata: { source: 'kimi-web', output: text ? (update.replace === true ? text : previous + text) : previous, kimiProgress: update },
      time: { start: asNumber(payload.time) ?? core.now() },
    },
  };
  core.toolParts.set(running.id, running);
  ops.push({ kind: 'part', part: running });
}

function handleToolResult(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  const group = ensureGroup(
    core,
    sessionOf(frame, payload),
    asString(payload.agentId) || 'main',
    asNumber(payload.turnId) ?? 0,
    payload,
    ops,
  );
  const key = `${group.messageID}:tool:${callId}`;
  const existing = core.toolParts.get(key);
  const time = asNumber(payload.time) ?? core.now();
  const start = existing?.state.status === 'running' ? existing.state.time.start : time;
  const input = existing?.state.input ?? {};
  const output = textOf(payload.output);
  const base: ToolPart = existing ?? {
    id: key, sessionID: group.sessionID, messageID: group.messageID, type: 'tool', callID: callId,
    tool: 'other', state: { status: 'pending', input, raw: '' }, metadata: { source: 'kimi-web' },
  };
  const finalPart: ToolPart = payload.isError === true
    ? {
      ...base,
      state: {
        status: 'error', input, error: output || 'Kimi tool failed',
        metadata: { source: 'kimi-web' }, time: { start, end: time },
      },
    }
    : {
      ...base,
      state: {
        status: 'completed', input, output,
        title: typeof base.metadata?.title === 'string' ? base.metadata.title : base.tool,
        metadata: { source: 'kimi-web' }, time: { start, end: time },
      },
    };
  core.toolParts.set(key, finalPart);
  ops.push({ kind: 'part', part: finalPart });
}

export const CORE_HANDLERS: Record<string, KimiWebHandler> = {
  'turn.started': handleTurnStarted,
  'turn.ended': handleTurnEnded,
  'turn.step.started': handleTurnStep,
  'turn.step.completed': handleTurnStep,
  'turn.step.retrying': handleTurnStep,
  'turn.step.interrupted': handleTurnStep,
  'assistant.delta': handleDelta,
  'thinking.delta': handleDelta,
  'tool.call.started': handleToolStarted,
  'tool.progress': handleToolProgress,
  'tool.result': handleToolResult,
};
