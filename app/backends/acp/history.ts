import type { BackendSessionInfo } from '../../types/backend-domain';
import type {
  AssistantMessageInfo,
  MessageInfo,
  MessagePart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';
import { toRecord } from './wire';
import { parseAcpSelectOptions, toAcpAgentModeId } from './configOptions';
import { createAcpToolPart } from './toolPart';

export type AcpHistoryEntry = {
  info: MessageInfo;
  parts: MessagePart[];
};

export type AcpSessionState = {
  info: BackendSessionInfo;
  entries: AcpHistoryEntry[];
  turn: number;
  activeUserId?: string;
  activeAssistantId?: string;
  configOptions: unknown[];
  availableCommands: unknown[];
  status: 'busy' | 'idle';
  clock: number;
};

export function createAcpSessionState(
  info: BackendSessionInfo,
  configOptions: unknown[] = [],
): AcpSessionState {
  return {
    info,
    entries: [],
    turn: 0,
    configOptions,
    availableCommands: [],
    status: 'idle',
    clock: 0,
  };
}

function tickTime(state: AcpSessionState, now: number) {
  const time = Math.max(now, state.clock + 1);
  state.clock = time;
  return time;
}

function currentConfigValue(state: AcpSessionState, categories: string[]) {
  const option = parseAcpSelectOptions(state.configOptions).find(
    (candidate) => categories.includes(candidate.category ?? '') || categories.includes(candidate.id),
  );
  return option?.currentValue;
}

function currentAgentMode(state: AcpSessionState) {
  const value = currentConfigValue(state, ['mode']);
  return value ? toAcpAgentModeId(value) : 'default';
}

function currentModelId(state: AcpSessionState) {
  return currentConfigValue(state, ['model']) ?? 'default';
}

function stringify(value: unknown) {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value, null, 2);
  } catch {
    return String(value);
  }
}

function findEntry(state: AcpSessionState, id: string) {
  return state.entries.find((entry) => entry.info.id === id);
}

function createUserInfo(id: string, state: AcpSessionState, now: number): UserMessageInfo {
  return {
    id,
    sessionID: state.info.id,
    role: 'user',
    time: { created: now },
    agent: currentAgentMode(state),
    model: { providerID: 'acp', modelID: currentModelId(state) },
  };
}

function createAssistantInfo(
  id: string,
  parentId: string,
  state: AcpSessionState,
  now: number,
  agentId: string,
): AssistantMessageInfo {
  const directory = state.info.directory ?? '';
  return {
    id,
    sessionID: state.info.id,
    role: 'assistant',
    time: { created: now },
    parentID: parentId,
    modelID: currentModelId(state),
    providerID: 'acp',
    mode: currentAgentMode(state),
    agent: currentConfigValue(state, ['mode']) ? currentAgentMode(state) : agentId,
    path: { cwd: directory, root: directory },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function upsertPart(entry: AcpHistoryEntry, part: MessagePart) {
  const index = entry.parts.findIndex((candidate) => candidate.id === part.id);
  if (index >= 0) entry.parts[index] = part;
  else entry.parts.push(part);
}

function appendText(
  entry: AcpHistoryEntry,
  type: 'text' | 'reasoning',
  text: string,
  now: number,
) {
  const id = `${entry.info.id}:${type}`;
  const existing = entry.parts.find((part) => part.id === id && part.type === type);
  if (existing?.type === 'text') existing.text += text;
  else if (existing?.type === 'reasoning') existing.text += text;
  else if (type === 'text') {
    entry.parts.push({ id, sessionID: entry.info.sessionID, messageID: entry.info.id, type, text });
  } else {
    entry.parts.push({ id, sessionID: entry.info.sessionID, messageID: entry.info.id, type, text, time: { start: now } });
  }
}

function appendContent(entry: AcpHistoryEntry, content: unknown, now: number) {
  const record = toRecord(content);
  if (!record || typeof record.type !== 'string') return;
  if (record.type === 'text' && typeof record.text === 'string') {
    appendText(entry, entry.info.role === 'assistant' ? 'text' : 'text', record.text, now);
    return;
  }
  if (record.type === 'image' && typeof record.data === 'string' && typeof record.mimeType === 'string') {
    const id = `${entry.info.id}:file:${entry.parts.length}`;
    entry.parts.push({
      id,
      sessionID: entry.info.sessionID,
      messageID: entry.info.id,
      type: 'file',
      mime: record.mimeType,
      url: `data:${record.mimeType};base64,${record.data}`,
    });
    return;
  }
  if (record.type === 'resource_link' && typeof record.uri === 'string') {
    appendText(entry, 'text', `[${typeof record.name === 'string' ? record.name : record.uri}](${record.uri})`, now);
  }
}

export function beginAcpPrompt(
  state: AcpSessionState,
  parts: Array<Record<string, unknown>>,
  now: number,
  agentId: string,
  attribution?: { agent?: string; modelID?: string },
) {
  state.turn += 1;
  state.status = 'busy';
  const userId = `acp:${state.info.id}:user:${state.turn}`;
  const assistantId = `acp:${state.info.id}:assistant:${state.turn}`;
  const user: AcpHistoryEntry = { info: createUserInfo(userId, state, tickTime(state, now)), parts: [] };
  if (user.info.role === 'user') {
    if (attribution?.agent) user.info.agent = attribution.agent;
    if (attribution?.modelID) user.info.model = { providerID: 'acp', modelID: attribution.modelID };
  }
  for (const part of parts) appendContent(user, part, now);
  const assistant: AcpHistoryEntry = {
    info: createAssistantInfo(assistantId, userId, state, tickTime(state, now), agentId),
    parts: [],
  };
  if (assistant.info.role === 'assistant') {
    if (attribution?.agent) {
      assistant.info.mode = attribution.agent;
      assistant.info.agent = attribution.agent;
    }
    if (attribution?.modelID) assistant.info.modelID = attribution.modelID;
  }
  state.entries.push(user, assistant);
  state.activeUserId = userId;
  state.activeAssistantId = assistantId;
  return [user, assistant];
}

function ensureReplayEntry(
  state: AcpSessionState,
  role: 'user' | 'assistant',
  now: number,
  agentId: string,
) {
  const activeId = role === 'user' ? state.activeUserId : state.activeAssistantId;
  const lastEntry = state.entries.at(-1);
  if (!activeId && lastEntry?.info.role === role) return lastEntry;
  if (role === 'user' && !activeId) state.turn += 1;
  const turn = Math.max(state.turn, 1);
  const id = activeId ?? `acp:${state.info.id}:${role}:${turn}`;
  const existing = findEntry(state, id);
  if (existing) return existing;
  const parent = state.entries.findLast((entry) => entry.info.role === 'user')?.info.id
    ?? `acp:${state.info.id}:user`;
  const created = tickTime(state, now);
  const entry: AcpHistoryEntry = {
    info: role === 'user'
      ? createUserInfo(id, state, created)
      : createAssistantInfo(id, parent, state, created, agentId),
    parts: [],
  };
  state.entries.push(entry);
  return entry;
}

export type AcpEntryAttributionInput = {
  agent?: string;
  modelID?: string;
  created?: number;
  completed?: number;
};

export function applyAcpAttribution(
  state: AcpSessionState,
  attributions: Record<string, AcpEntryAttributionInput>,
) {
  const restored = new Set<string>();
  // Restore functions must assign fresh info objects: the message store holds
  // plain non-reactive infos, so in-place mutation is invisible to Vue.
  for (const entry of state.entries) {
    const recorded = attributions[entry.info.id];
    if (!recorded) continue;
    restored.add(entry.info.id);
    const next = { ...entry.info };
    if (typeof recorded.created === 'number') next.time.created = recorded.created;
    if (next.role === 'user') {
      if (recorded.agent) next.agent = recorded.agent;
      if (recorded.modelID) next.model = { providerID: 'acp', modelID: recorded.modelID };
    } else {
      if (recorded.agent) {
        next.agent = recorded.agent;
        next.mode = recorded.agent;
      }
      if (recorded.modelID) next.modelID = recorded.modelID;
      if (typeof recorded.completed === 'number') next.time.completed = recorded.completed;
    }
    entry.info = next;
  }
  return restored;
}

export type AcpSessionTurnMeta = {
  userText: string;
  userTime?: number;
  assistantTime?: number;
  assistantCompletedTime?: number;
  model?: string;
  agent?: string;
};

function entryText(entry: AcpHistoryEntry) {
  const part = entry.parts.find((candidate) => candidate.type === 'text');
  return part && 'text' in part && typeof part.text === 'string' ? part.text : '';
}

function anchorsTurn(turnText: string, text: string) {
  const turn = turnText.trim();
  const entry = text.trim();
  if (!turn || !entry) return false;
  const anchor = turn.slice(0, 48);
  return entry.startsWith(anchor) || turn.startsWith(entry.slice(0, 48));
}

export function applyAcpSessionMeta(
  state: AcpSessionState,
  turns: AcpSessionTurnMeta[],
  skipIds: Set<string> = new Set(),
) {
  const userEntries = state.entries.filter((entry) => entry.info.role === 'user');
  let turnIndex = 0;
  for (const userEntry of userEntries) {
    const text = entryText(userEntry);
    while (turnIndex < turns.length && !anchorsTurn(turns[turnIndex]?.userText ?? '', text)) {
      turnIndex += 1;
    }
    const turn = turns[turnIndex];
    if (!turn) break;
    turnIndex += 1;
    const turnMatch = /:user:(\d+)$/u.exec(userEntry.info.id);
    const assistantEntry = turnMatch
      ? state.entries.find((entry) => entry.info.id === `acp:${state.info.id}:assistant:${turnMatch[1]}`)
      : undefined;
    if (!skipIds.has(userEntry.info.id) && userEntry.info.role === 'user') {
      const next = { ...userEntry.info };
      if (typeof turn.userTime === 'number') next.time.created = turn.userTime;
      if (turn.agent) next.agent = turn.agent;
      if (turn.model) next.model = { providerID: 'acp', modelID: turn.model };
      userEntry.info = next;
    }
    if (assistantEntry && !skipIds.has(assistantEntry.info.id) && assistantEntry.info.role === 'assistant') {
      const next = { ...assistantEntry.info };
      if (typeof turn.assistantTime === 'number') {
        next.time.created = turn.assistantTime;
      }
      const completedTime = turn.assistantCompletedTime ?? turn.assistantTime;
      if (typeof completedTime === 'number') {
        next.time.completed = completedTime;
      }
      if (turn.agent) {
        next.agent = turn.agent;
        next.mode = turn.agent;
      }
      if (turn.model) next.modelID = turn.model;
      assistantEntry.info = next;
    }
  }
}

export function reattributeAcpEntries(state: AcpSessionState, agentId: string) {
  const modeValue = currentConfigValue(state, ['mode']);
  const modelValue = currentConfigValue(state, ['model']);
  const agent = modeValue ? toAcpAgentModeId(modeValue) : undefined;
  for (const entry of state.entries) {
    if (entry.info.role === 'user') {
      const next = { ...entry.info };
      if (agent) next.agent = agent;
      if (modelValue) next.model = { providerID: 'acp', modelID: modelValue };
      entry.info = next;
    } else {
      const next = { ...entry.info };
      if (modelValue) next.modelID = modelValue;
      if (agent) {
        next.mode = agent;
        next.agent = agent;
      } else {
        next.agent = agentId;
      }
      entry.info = next;
    }
  }
}

export function applyAcpUpdate(
  state: AcpSessionState,
  update: Record<string, unknown> & { sessionUpdate: string },
  now: number,
  agentId: string,
): AcpHistoryEntry | null {
  if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') {
    const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    const entry = ensureReplayEntry(state, role, now, agentId);
    appendContent(entry, update.content, now);
    return entry;
  }
  if (update.sessionUpdate === 'agent_thought_chunk') {
    const entry = ensureReplayEntry(state, 'assistant', now, agentId);
    const content = toRecord(update.content);
    if (content?.type === 'text' && typeof content.text === 'string') appendText(entry, 'reasoning', content.text, now);
    return entry;
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    if (typeof update.toolCallId !== 'string') return null;
    const entry = ensureReplayEntry(state, 'assistant', now, agentId);
    const existing = entry.parts.find((part): part is ToolPart => (
      part.id === `${entry.info.id}:tool:${update.toolCallId}` && part.type === 'tool'
    ));
    const part = createAcpToolPart(
      state.info.id,
      entry.info.id,
      { ...update, toolCallId: update.toolCallId },
      existing,
      now,
    );
    upsertPart(entry, part);
    return entry;
  }
  if (update.sessionUpdate === 'session_info_update') {
    if (typeof update.title === 'string') state.info.title = update.title;
    if (typeof update.updatedAt === 'string') {
      const updatedAt = Date.parse(update.updatedAt);
      if (Number.isFinite(updatedAt)) state.info.time = { ...state.info.time, updated: updatedAt };
    }
  } else if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    state.configOptions = update.configOptions;
  } else if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
    state.availableCommands = update.availableCommands;
  } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
    const entry = ensureReplayEntry(state, 'assistant', now, agentId);
    appendText(entry, 'text', stringify(update.entries), now);
    return entry;
  }
  return null;
}

export function completeAcpPrompt(
  state: AcpSessionState,
  stopReason: string,
  now: number,
  usage?: { inputTokens: number; outputTokens: number; totalTokens: number },
) {
  state.status = 'idle';
  const entry = state.activeAssistantId ? findEntry(state, state.activeAssistantId) : undefined;
  if (entry?.info.role === 'assistant') {
    entry.info.time.completed = tickTime(state, now);
    entry.info.finish = stopReason;
    if (usage) {
      entry.info.tokens.input = usage.inputTokens;
      entry.info.tokens.output = usage.outputTokens;
      entry.info.tokens.total = usage.totalTokens;
    }
  }
  state.activeUserId = undefined;
  state.activeAssistantId = undefined;
  return entry ?? null;
}
