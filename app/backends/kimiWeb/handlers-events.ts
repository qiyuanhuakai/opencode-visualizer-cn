/**
 * Session / prompt / interaction / subagent / compaction / error handlers.
 */
import type { KimiWebNormalizeOp } from './ops';
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  type KimiWebPayload,
  type KimiWebWireFrame,
} from './wire';
import {
  ensureGroup,
  sessionOf,
  terminalParts,
  type KimiWebCore,
} from './parts';
import type { KimiWebHandler } from './handlers-core';

function handleSessionMeta(_core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  ops.push({
    kind: 'session', phase: 'meta', sessionId: sessionOf(frame, payload),
    title: asString(payload.title) || undefined,
    patch: isRecord(payload.patch) ? payload.patch : undefined,
  });
}

function handleSessionLifecycle(_core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const phase = frame.type.slice('event.session.'.length) as
    'created' | 'archived' | 'deleted' | 'work_changed' | 'status_changed';
  const sessionId = sessionOf(frame, payload);
  if (phase === 'created') {
    const session = payload.session;
    const sessionRecord = isRecord(session) ? session : undefined;
    ops.push({
      kind: 'session', phase: 'created',
      sessionId: asString(sessionRecord?.id) || sessionId,
      session,
      workspaceId: asString(sessionRecord?.workspace_id) || undefined,
    });
    return;
  }
  if (phase === 'work_changed') {
    ops.push({
      kind: 'session', phase: 'work-changed', sessionId,
      busy: asBoolean(payload.busy),
      mainTurnActive: asBoolean(payload.main_turn_active),
      pendingInteraction: asString(payload.pending_interaction) || undefined,
      lastTurnReason: asString(payload.last_turn_reason) || undefined,
    });
    return;
  }
  if (phase === 'status_changed') {
    ops.push({
      kind: 'session', phase: 'status-changed', sessionId,
      status: asString(payload.status) || undefined,
      previousStatus: asString(payload.previous_status) || undefined,
      currentPromptId: asString(payload.current_prompt_id) || undefined,
    });
    return;
  }
  ops.push({ kind: 'session', phase, sessionId, workspaceId: asString(payload.workspace_id) || undefined });
}

function handleInteraction(_core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const base = {
    sessionId: sessionOf(frame, payload),
    agentId: asString(payload.agentId) || 'main',
    turnId: asNumber(payload.turn_id) ?? asNumber(payload.turnId),
    toolCallId: asString(payload.tool_call_id) || undefined,
  };
  if (frame.type === 'event.approval.requested') {
    ops.push({
      kind: 'interaction', interaction: 'approval', phase: 'requested', id: asString(payload.approval_id), ...base,
      toolName: asString(payload.tool_name) || undefined,
      action: asString(payload.action) || undefined,
      createdAt: asString(payload.created_at) || undefined,
      expiresAt: asString(payload.expires_at) || undefined,
    });
    return;
  }
  if (frame.type === 'event.approval.resolved') {
    ops.push({
      kind: 'interaction', interaction: 'approval', phase: 'resolved', id: asString(payload.approval_id), ...base,
      decision: asString(payload.decision) || undefined,
      scope: asString(payload.scope) || undefined,
      feedback: asString(payload.feedback) || undefined,
      selectedLabel: asString(payload.selected_label) || undefined,
      resolvedAt: asString(payload.resolved_at) || undefined,
    });
    return;
  }
  if (frame.type === 'event.question.requested') {
    ops.push({
      kind: 'interaction', interaction: 'question', phase: 'requested', id: asString(payload.question_id), ...base,
      questions: Array.isArray(payload.questions) ? payload.questions : undefined,
      createdAt: asString(payload.created_at) || undefined,
    });
    return;
  }
  if (frame.type === 'event.question.answered') {
    ops.push({
      kind: 'interaction', interaction: 'question', phase: 'answered', id: asString(payload.question_id), ...base,
      answers: payload.answers,
      resolvedAt: asString(payload.resolved_at) || undefined,
    });
    return;
  }
  ops.push({
    kind: 'interaction', interaction: 'question', phase: 'dismissed', id: asString(payload.question_id), ...base,
    resolvedAt: asString(payload.dismissed_at) || undefined,
  });
}

function handlePrompt(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const promptId = asString(payload.promptId);
  if (promptId && (frame.type === 'prompt.submitted' || frame.type === 'prompt.started')) {
    core.promptIds.set(`${sessionId}|${agentId}`, promptId);
  }
  ops.push({
    kind: 'prompt',
    phase: frame.type.slice('prompt.'.length) as 'submitted' | 'started' | 'completed' | 'aborted' | 'steered',
    sessionId,
    agentId,
    promptId: promptId || undefined,
    userMessageId: asString(payload.userMessageId) || undefined,
    status: asString(payload.status) || undefined,
    reason: asString(payload.reason) || undefined,
    abortedAt: asString(payload.abortedAt) || undefined,
    steeredAt: asString(payload.steeredAt) || undefined,
    activePromptId: asString(payload.activePromptId) || undefined,
    promptIds: Array.isArray(payload.promptIds)
      ? payload.promptIds.filter((entry): entry is string => typeof entry === 'string')
      : undefined,
  });
}

function handleSubagentSpawned(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const subagentId = asString(payload.subagentId);
  if (!subagentId) return;
  const turnId = core.agentTurns.get(`${sessionId}|${subagentId}`) ?? 0;
  const group = ensureGroup(core, sessionId, subagentId, turnId, payload, ops);
  ops.push({
    kind: 'subagent', phase: 'spawned', sessionId, agentId: asString(payload.agentId) || 'main', subagentId,
    subagentSessionId: group.sessionID,
    name: asString(payload.subagentName) || undefined,
    description: asString(payload.description) || undefined,
    parentToolCallId: asString(payload.parentToolCallId) || undefined,
    runInBackground: asBoolean(payload.runInBackground),
    model: asString(payload.model) || undefined,
    time: asNumber(payload.time) ?? core.now(),
  });
}

function handleSubagentStarted(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const subagentId = asString(payload.subagentId);
  if (!subagentId) return;
  ops.push({
    kind: 'subagent', phase: 'started', sessionId, agentId: asString(payload.agentId) || 'main',
    subagentId, subagentSessionId: core.subagentIdentity(sessionId, subagentId),
    time: asNumber(payload.time) ?? core.now(),
  });
}

function handleSubagentTerminal(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const phase = frame.type.slice('subagent.'.length) as 'suspended' | 'completed' | 'failed';
  const sessionId = sessionOf(frame, payload);
  const subagentId = asString(payload.subagentId);
  if (!subagentId) return;
  const turnId = core.agentTurns.get(`${sessionId}|${subagentId}`) ?? 0;
  const group = ensureGroup(core, sessionId, subagentId, turnId, payload, ops);
  const time = asNumber(payload.time) ?? core.now();
  if (phase !== 'suspended') {
    group.endedAt = time;
    terminalParts(group, true, ops);
  }
  ops.push({
    kind: 'subagent', phase, sessionId, agentId: asString(payload.agentId) || 'main', subagentId,
    subagentSessionId: group.sessionID,
    resultSummary: asString(payload.resultSummary) || undefined,
    error: asString(payload.error) || undefined,
    usage: isRecord(payload.usage) ? payload.usage : undefined,
    contextTokens: asNumber(payload.contextTokens),
    time,
  });
}

function handleCompaction(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  ops.push({
    kind: 'compaction',
    phase: frame.type.slice('compaction.'.length) as 'started' | 'blocked' | 'cancelled' | 'completed',
    sessionId: sessionOf(frame, payload),
    agentId: asString(payload.agentId) || 'main',
    trigger: asString(payload.trigger) || undefined,
    instruction: asString(payload.instruction) || undefined,
    turnId: asNumber(payload.turnId),
    result: isRecord(payload.result) ? payload.result : undefined,
    time: asNumber(payload.time) ?? core.now(),
  });
}

function handleErrorOrWarning(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const system = typeof payload.code === 'number' || typeof payload.fatal === 'boolean';
  ops.push({
    kind: frame.type === 'error' ? 'error' : 'warning',
    sessionId: sessionId || undefined,
    agentId: asString(payload.agentId) || undefined,
    system: system || undefined,
    code: system
      ? (typeof payload.code === 'number' ? String(payload.code) : undefined)
      : (asString(payload.code) || undefined),
    message: system
      ? (asString(payload.msg) || 'Kimi web error')
      : (asString(payload.message) || asString(payload.msg) || 'Kimi web error'),
    retryable: asBoolean(payload.retryable),
    details: isRecord(payload.details) ? payload.details : undefined,
    time: asNumber(payload.time) ?? core.now(),
  });
}

function handleIgnoredNoop(core: KimiWebCore) {
  core.stats.ignoredEventCount += 1;
}

export const EVENT_HANDLERS: Record<string, KimiWebHandler> = {
  'session.meta.updated': handleSessionMeta,
  'event.session.created': handleSessionLifecycle,
  'event.session.archived': handleSessionLifecycle,
  'event.session.deleted': handleSessionLifecycle,
  'event.session.work_changed': handleSessionLifecycle,
  'event.session.status_changed': handleSessionLifecycle,
  'event.approval.requested': handleInteraction,
  'event.approval.resolved': handleInteraction,
  'event.question.requested': handleInteraction,
  'event.question.answered': handleInteraction,
  'event.question.dismissed': handleInteraction,
  'prompt.submitted': handlePrompt,
  'prompt.started': handlePrompt,
  'prompt.completed': handlePrompt,
  'prompt.aborted': handlePrompt,
  'prompt.steered': handlePrompt,
  'subagent.spawned': handleSubagentSpawned,
  'subagent.started': handleSubagentStarted,
  'subagent.suspended': handleSubagentTerminal,
  'subagent.completed': handleSubagentTerminal,
  'subagent.failed': handleSubagentTerminal,
  'compaction.started': handleCompaction,
  'compaction.blocked': handleCompaction,
  'compaction.cancelled': handleCompaction,
  'compaction.completed': handleCompaction,
  error: handleErrorOrWarning,
  warning: handleErrorOrWarning,
  'context.spliced': handleIgnoredNoop,
};
