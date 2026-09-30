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
  findCurrentGroup,
  openUtteranceGroup,
  reasoningPartOf,
  resolveToolMessageId,
  sessionOf,
  terminalParts,
  textPartOf,
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
  // No eager group: the first utterance opens on turn.step.started (or on the
  // first content event when the opener was missed). A new turn restarts the
  // utterance counter and drops any stale open step for that (session, agent).
  core.stepCounters.set(`${sessionId}|${agentId}|${turnId}`, 0);
  core.currentStep.delete(`${sessionId}|${agentId}|${turnId}`);
  core.lastStepKey.delete(`${sessionId}|${agentId}|${turnId}`);
  core.agentTurns.set(`${sessionId}|${agentId}`, turnId);
  ops.push({
    kind: 'turn', phase: 'started', sessionId, agentId, turnId,
    promptId: promptId || undefined, time: asNumber(payload.time) ?? core.now(),
  });
}

function handleTurnEnded(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? core.agentTurns.get(`${sessionId}|${agentId}`) ?? 0;
  const time = asNumber(payload.time) ?? core.now();
  const reason = turnReason(payload.reason);
  const interruptReason = asString(payload.interruptReason) || undefined;
  const errorPayload = isRecord(payload.error) ? payload.error : {};
  const failed = reason === 'failed' || reason === 'blocked';
  const lastKey = core.lastStepKey.get(`${sessionId}|${agentId}|${turnId}`);
  let group = lastKey ? core.groups.get(lastKey) : undefined;
  if (!group && failed) {
    // No utterance opened (e.g. the model failed before the first step): keep a
    // turn-level fallback so the error stays visible instead of being dropped.
    group = openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops);
  }
  if (group) {
    group.endedAt = time;
    if (failed) {
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
  }
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
  core.currentStep.delete(`${sessionId}|${agentId}|${turnId}`);
  core.lastStepKey.delete(`${sessionId}|${agentId}|${turnId}`);
}

function handleTurnStep(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const phase = frame.type.slice('turn.step.'.length) as 'started' | 'completed' | 'retrying' | 'interrupted';
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? 0;
  if (phase === 'started') {
    openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops, asNumber(frame.seq));
  } else if (phase === 'completed') {
    let group = findCurrentGroup(core, sessionId, agentId, turnId);
    if (!group && isRecord(payload.usage)) {
      group = openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops);
    }
    if (group) {
      group.endedAt = asNumber(payload.time) ?? core.now();
      if (isRecord(payload.usage)) {
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
        }
      }
      ops.push({ kind: 'message', message: buildMessage(core, group) });
      terminalParts(group, false, ops);
    }
  }
  ops.push({
    kind: 'step',
    phase,
    sessionId,
    agentId,
    turnId,
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
  const seq = asNumber(frame.seq);
  let group = findCurrentGroup(core, sessionId, agentId, turnId);
  if (!group) {
    // Opener missed (mid-step connect) or a content-first step: open the utterance.
    group = openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops, seq);
  } else if (seq !== undefined && group.openSeq !== undefined && seq !== group.openSeq) {
    // A content event whose seq differs from the current step's opener belongs to
    // a different utterance. A newer seq starts the next one; an older seq is a
    // stale replay of an utterance we already left behind.
    if (seq > group.openSeq) {
      group = openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops, seq);
    } else {
      core.stats.staleDeltaCount += 1;
      return;
    }
  }
  const bucket = frame.type === 'assistant.delta' ? group.text : group.reasoning;
  const applied = applyDelta(core, bucket, seq, asNumber(frame.offset), asString(payload.delta));
  if (!applied) return;
  ops.push({
    kind: 'part',
    part: frame.type === 'assistant.delta' ? textPartOf(group) : reasoningPartOf(group),
    delta: applied.delta,
  });
}

function handleToolStarted(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? 0;
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  const group = findCurrentGroup(core, sessionId, agentId, turnId)
    ?? openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops, asNumber(frame.seq));
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
  core.toolMessages.set(`${sessionId}|${agentId}|${callId}`, group.messageID);
  core.toolParts.set(part.id, part);
  ops.push({ kind: 'part', part });
}

function handleToolProgress(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  const messageId = resolveToolMessageId(
    core,
    sessionOf(frame, payload),
    asString(payload.agentId) || 'main',
    callId,
  );
  const existing = messageId ? core.toolParts.get(`${messageId}:tool:${callId}`) : undefined;
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
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const turnId = asNumber(payload.turnId) ?? 0;
  const callId = asString(payload.toolCallId);
  if (!callId) return;
  // tool.result carries a different seq than tool.call.started, so resolve the
  // owning message through the callID map (not the current step / seq).
  let messageId = resolveToolMessageId(core, sessionId, agentId, callId);
  if (!messageId) {
    messageId = (findCurrentGroup(core, sessionId, agentId, turnId)
      ?? openUtteranceGroup(core, sessionId, agentId, turnId, payload, ops, asNumber(frame.seq))).messageID;
  }
  const key = `${messageId}:tool:${callId}`;
  const existing = core.toolParts.get(key);
  const sessionID = existing?.sessionID ?? core.subagentIdentity(sessionId, agentId, turnId);
  const time = asNumber(payload.time) ?? core.now();
  const start = existing?.state.status === 'running' ? existing.state.time.start : time;
  const input = existing?.state.input ?? {};
  const output = textOf(payload.output);
  const base: ToolPart = existing ?? {
    id: key, sessionID, messageID: messageId, type: 'tool', callID: callId,
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
