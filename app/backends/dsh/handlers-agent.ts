/**
 * Session-policy, inbox-splice, title and request-envelope handlers.
 *
 * dsh expresses subagents as *child sessions* addressed by
 * `session/page` `{kind:'subagent',parentSessionId,childSessionId,mode}`
 * (Metis #10) rather than as in-session agents, so a subagent's records arrive
 * through a normalizer bound to a subagent address; `handlers-core` maps the
 * terminal `turn/end.reason` into the terminal part and this file carries the
 * identity that makes those parts recognisable as subagent parts.
 */
import {
  asArray,
  asNumber,
  asString,
  buildMessage,
  isRecord,
  moduleLevelMeta,
  textOfContent,
  userMessageOf,
  type DshCore,
} from './parts';
import type { DshNormalizeOp } from './ops';
import type { DshHandler } from './handlers-core';
import type { DshSessionWireEvent } from './types';
import { readDshModelRef } from './modelSelection';

const dataOf = (event: DshSessionWireEvent): Record<string, unknown> =>
  isRecord(event.data) ? event.data : {};

function handlePermissionPreset(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const preset = asString(dataOf(event).preset);
  if (!preset) return;
  core.permissionPreset = preset;
  ops.push({ kind: 'policy', policy: 'permission-preset', value: preset, time: event.time });
}

function handleSandbox(_core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const mode = asString(dataOf(event).mode);
  if (!mode) return;
  ops.push({ kind: 'policy', policy: 'sandbox-mode', value: mode, time: event.time });
}

function handleApproval(_core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const policy = asString(dataOf(event).policy);
  if (!policy) return;
  ops.push({ kind: 'policy', policy: 'approval-policy', value: policy, time: event.time });
}

/**
 * `agent/inbox/spliced` pushes the user message into the session before the
 * turn consumes it. The message identity (`source.rpcId`) is the only reliable
 * answer-binding key (docs/dsh.md §9.3), so it rides on the part metadata and
 * on a dedicated binding op. A record carrying only `removedCount` is the turn
 * consuming the inbox and renders nothing.
 */
function handleInboxSpliced(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const removed = asNumber(data.removedCount);
  if (removed && removed > 0) return;
  const now = event.time;
  for (const raw of asArray(data.inserted)) {
    if (!isRecord(raw)) continue;
    const role = asString(raw.role) || 'user';
    if (role !== 'user') continue;
    const id = asString(raw.id);
    if (!id || core.appliedMessages.has(id)) continue;
    core.appliedMessages.add(id);
    const source = isRecord(raw.source) ? raw.source : {};
    const sourceKind = asString(source.kind) || 'user';
    if (sourceKind !== 'user') continue;
    core.pendingUserMessageIds.push(id);
    const rpcId = asString(source.rpcId);
    const text = textOfContent(raw.content, 'text');
    ops.push({ kind: 'message', message: userMessageOf(core, core.sessionId, id, now) });
    ops.push({
      kind: 'part',
      part: {
        id: `${id}:text`,
        sessionID: core.sessionId,
        messageID: id,
        type: 'text',
        text,
        time: { start: now },
        metadata: moduleLevelMeta({
          sourceKind,
          ...(rpcId ? { rpcId } : {}),
        }),
      },
    });
    ops.push({
      kind: 'user-message',
      sessionId: core.sessionId,
      messageId: id,
      sourceKind,
      rpcId: rpcId || undefined,
      role,
      time: now,
    });
  }
}

/**
 * `session/title` is the event producer for renames: it appends the resolved
 * title, so it must overwrite rather than merge. `session/title-llm-request` is
 * dsh's internal title-generation prompt and carries no title — it is recorded
 * as ignorable instead of emitting a bogus empty title.
 */
function handleSessionTitle(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const title = asString(data.title);
  if (!title) return;
  core.sessionTitle = title;
  const source = isRecord(data.source) ? data.source : {};
  ops.push({
    kind: 'session-title',
    sessionId: core.sessionId,
    title,
    messageSeqs: asArray(data.messageSeqs).filter((seq): seq is number => typeof seq === 'number'),
    sourceKind: asString(source.kind) || 'fallback',
    time: event.time,
  });
}

function handleSessionTitleLlmRequest(core: DshCore, _event: DshSessionWireEvent, _ops: DshNormalizeOp[]) {
  core.stats.ignoredEventCount += 1;
}

function handleRequestHeader(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const header = isRecord(data.header) ? data.header : {};
  const config = isRecord(header.config) ? header.config : {};
  const tools = asArray(header.tools)
    .filter((tool): tool is Record<string, unknown> => isRecord(tool))
    .map((tool) => asString(tool.name))
    .filter((name) => name.length > 0);
  if (asString(config.provider)) core.model.providerID = asString(config.provider);
  if (asString(config.model)) core.model.modelID = asString(config.model);
  core.model.variant = asString(config.reasoningEffort) || undefined;
  const currentGroup = [...core.groups.values()].filter(group => group.turn === core.activeTurn).at(-1);
  if (currentGroup) {
    currentGroup.model = { ...core.model };
    ops.push({ kind: 'message', message: buildMessage(core, currentGroup) });
  }
  const parentId = core.turnParents.get(core.activeTurn);
  const parent = parentId ? core.userMessages.get(parentId) : undefined;
  if (parent) {
    const updated = { ...parent, model: { providerID: core.model.providerID, modelID: core.model.modelID }, variant: core.model.variant };
    core.userMessages.set(updated.id, updated);
    ops.push({ kind: 'message', message: updated });
  }
  ops.push({
    kind: 'request',
    phase: 'header',
    sessionId: core.sessionId,
    provider: asString(config.provider) || undefined,
    model: asString(config.model) || undefined,
    reasoningEffort: asString(config.reasoningEffort) || undefined,
    ...(tools.length > 0 ? { tools } : {}),
    time: event.time,
  });
}

function handleRequestContext(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const provider = asString(data.provider);
  const model = asString(data.model);
  if (provider) core.model.providerID = provider;
  if (model) core.model.modelID = model;
  ops.push({
    kind: 'request',
    phase: 'context',
    sessionId: core.sessionId,
    provider: provider || undefined,
    model: model || undefined,
    contextWindow: asNumber(data.contextWindow),
    time: event.time,
  });
}

/**
 * A subagent child session's terminal record. dsh has no dedicated subagent
 * event: the child's own `turn/end.reason` is authoritative, so a terminal
 * child turn is surfaced here for the history card that keeps the subagent's
 * thinking / tools / results.
 */
export function discoverDshSubagent(core: DshCore, data: Record<string, unknown>, ops: DshNormalizeOp[]) {
  const childSessionId = asString(data.childId) || asString(data.id);
  if (!childSessionId || !core.sessionId || childSessionId === core.sessionId) return;
  if (asString(data.childId)) {
    const groupIds = new Set([...core.groups.values()].filter(group => group.turn === core.activeTurn).map(group => group.messageID));
    const tool = [...core.toolParts.values()].findLast(part => part.tool === 'subagent' && part.state.status === 'pending' && groupIds.has(part.messageID));
    if (tool) {
      const ids = asArray(tool.metadata?.sessionIds).filter((id): id is string => typeof id === 'string');
      tool.metadata = { ...tool.metadata, sessionIds: [...new Set([...ids, childSessionId])] };
      ops.push({ kind: 'part', part: tool });
    }
  }
  ops.push({ kind: 'subagent-discovered', parentSessionId: core.sessionId, childSessionId,
    mode: asString(data.mode) || 'unknown', title: asString(data.label) || childSessionId,
    createdAt: asNumber(data.childCreatedAt) ?? asNumber(data.createdAt) });
}

function handleSubagentDescriptor(core: DshCore, event: DshSessionWireEvent, ops: DshNormalizeOp[]) {
  const data = dataOf(event);
  const address = core.address;
  if (address?.kind !== 'subagent') return;
  const childSessionId = asString(data.childSessionId) || address.childSessionId;
  const parentSessionId = asString(data.parentSessionId) || address.parentSessionId;
  const mode = asString(data.mode) || address.mode;
  const model = asString(data.model);
  const title = asString(data.label) || asString(data.description) || asString(data.prompt) || 'subagent';
  ops.push({
    kind: 'part',
    part: {
      id: `${childSessionId}:subagent`,
      sessionID: childSessionId,
      messageID: `${childSessionId}:subagent`,
      type: 'subtask',
      prompt: asString(data.prompt) || title,
      description: title,
      agent: asString(data.agent) || 'subagent',
      ...(model ? { model: { providerID: core.model.providerID, modelID: model } } : {}),
    },
  });
  ops.push({
    kind: 'subagent',
    phase: 'started',
    parentSessionId,
    childSessionId,
    mode,
    turn: asNumber(data.turn) ?? 0,
    time: event.time,
  });
}

export const AGENT_HANDLERS: Record<string, DshHandler> = {
  'model/selection': (core, event, ops) => ops.push({ kind: 'model-selection', sessionId: core.sessionId, selection: readDshModelRef(event.data) }),
  'permission/preset': handlePermissionPreset,
  'sandbox/mode': handleSandbox,
  'approval/policy': handleApproval,
  'agent/inbox/spliced': handleInboxSpliced,
  'session/title': handleSessionTitle,
  'session/title-llm-request': handleSessionTitleLlmRequest,
  'request/header': handleRequestHeader,
  'request/context': handleRequestContext,
  'subagent/descriptor': handleSubagentDescriptor,
  'subagent/catalog': (core, event, ops) => discoverDshSubagent(core, dataOf(event), ops),
};
