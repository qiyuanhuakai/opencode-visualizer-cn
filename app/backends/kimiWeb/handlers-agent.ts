/**
 * Agent lifecycle and status event handlers.
 */
import type { KimiWebNormalizeOp } from './ops';
import {
  asBoolean,
  asNumber,
  asString,
  isRecord,
  splitModel,
  type KimiWebPayload,
  type KimiWebWireFrame,
} from './wire';
import { sessionOf, buildMessage, type KimiWebCore } from './parts';
import type { KimiWebHandler } from './handlers-core';

function handleAgentLifecycle(_core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  ops.push({
    kind: 'agent',
    phase: frame.type === 'agent.created' ? 'created' : 'disposed',
    sessionId: sessionOf(frame, payload),
    agentId: asString(payload.agentId) || 'main',
  });
}

function handleAgentStatus(core: KimiWebCore, frame: KimiWebWireFrame, payload: KimiWebPayload, ops: KimiWebNormalizeOp[]) {
  const sessionId = sessionOf(frame, payload);
  const agentId = asString(payload.agentId) || 'main';
  const model = asString(payload.model);
  if (model) core.agentModels.set(`${sessionId}|${agentId}`, splitModel(model));
  const profileKey = `${sessionId}|${agentId}`;
  const previousProfile = core.agentProfiles.get(profileKey);
  core.agentProfiles.set(profileKey, {
    effort: asString(payload.thinkingEffort) || previousProfile?.effort,
    permission: asString(payload.permission) || previousProfile?.permission,
  });
  const usage = isRecord(payload.usage) ? payload.usage : undefined;
  if (usage) core.agentUsage.set(`${sessionId}|${agentId}`, usage);
  const contextKey = `${sessionId}|${agentId}`;
  const previousContext = core.agentContexts.get(contextKey);
  const contextTokens = asNumber(payload.contextTokens);
  const maxContextTokens = asNumber(payload.maxContextTokens);
  core.agentContexts.set(contextKey, {
    ...previousContext,
    ...(contextTokens === undefined ? {} : { contextTokens }),
    ...(maxContextTokens === undefined ? {} : { maxContextTokens }),
  });
  const contextChanged =
    (contextTokens !== undefined && contextTokens !== previousContext?.contextTokens) ||
    (maxContextTokens !== undefined && maxContextTokens !== previousContext?.maxContextTokens);
  ops.push({
    kind: 'agent', phase: 'status', sessionId, agentId,
    status: {
      model: model || undefined,
      thinkingEffort: asString(payload.thinkingEffort) || undefined,
      contextTokens,
      maxContextTokens,
      contextUsage: asNumber(payload.contextUsage),
      planMode: asBoolean(payload.planMode),
      swarmMode: asBoolean(payload.swarmMode),
      towerMode: asBoolean(payload.towerMode),
      permission: asString(payload.permission) || undefined,
      usage,
      phase: isRecord(payload.phase) ? payload.phase : undefined,
    },
  });
  if (contextChanged) {
    const turnId = core.agentTurns.get(contextKey);
    if (turnId !== undefined) {
      const group = core.groups.get(`${core.subagentIdentity(sessionId, agentId, turnId)}|${turnId}`);
      if (group) ops.push({ kind: 'message', message: buildMessage(core, group) });
    }
  }
}

export const AGENT_HANDLERS: Record<string, KimiWebHandler> = {
  'agent.created': handleAgentLifecycle,
  'agent.disposed': handleAgentLifecycle,
  'agent.status.updated': handleAgentStatus,
};
