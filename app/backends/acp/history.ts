import type { BackendSessionInfo } from '../../types/backend-domain';
import type {
  AssistantMessageInfo,
  MessageInfo,
  MessagePart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';
import { toRecord } from './wire';
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
  };
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
    agent: 'default',
    model: { providerID: 'acp', modelID: 'default' },
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
    modelID: 'default',
    providerID: 'acp',
    mode: 'default',
    agent: agentId,
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
) {
  state.turn += 1;
  state.status = 'busy';
  const userId = `acp:${state.info.id}:user:${state.turn}`;
  const assistantId = `acp:${state.info.id}:assistant:${state.turn}`;
  const user: AcpHistoryEntry = { info: createUserInfo(userId, state, now), parts: [] };
  for (const part of parts) appendContent(user, part, now);
  const assistant: AcpHistoryEntry = {
    info: createAssistantInfo(assistantId, userId, state, now, agentId),
    parts: [],
  };
  state.entries.push(user, assistant);
  state.activeUserId = userId;
  state.activeAssistantId = assistantId;
  return [user, assistant];
}

function ensureReplayEntry(
  state: AcpSessionState,
  role: 'user' | 'assistant',
  messageId: string | undefined,
  now: number,
  agentId: string,
) {
  const activeId = role === 'user' ? state.activeUserId : state.activeAssistantId;
  const lastEntry = state.entries.at(-1);
  if (!activeId && lastEntry?.info.role === role) return lastEntry;
  const id = activeId ?? `acp:${state.info.id}:${role}:${messageId ?? state.entries.length + 1}`;
  const existing = findEntry(state, id);
  if (existing) return existing;
  const parent = state.entries.findLast((entry) => entry.info.role === 'user')?.info.id
    ?? `acp:${state.info.id}:user`;
  const entry: AcpHistoryEntry = {
    info: role === 'user'
      ? createUserInfo(id, state, now)
      : createAssistantInfo(id, parent, state, now, agentId),
    parts: [],
  };
  state.entries.push(entry);
  return entry;
}

export function applyAcpUpdate(
  state: AcpSessionState,
  update: Record<string, unknown> & { sessionUpdate: string },
  now: number,
  agentId: string,
): AcpHistoryEntry | null {
  const messageId = typeof update.messageId === 'string' ? update.messageId : undefined;
  if (update.sessionUpdate === 'user_message_chunk' || update.sessionUpdate === 'agent_message_chunk') {
    const role = update.sessionUpdate === 'user_message_chunk' ? 'user' : 'assistant';
    const entry = ensureReplayEntry(state, role, messageId, now, agentId);
    appendContent(entry, update.content, now);
    return entry;
  }
  if (update.sessionUpdate === 'agent_thought_chunk') {
    const entry = ensureReplayEntry(state, 'assistant', messageId, now, agentId);
    const content = toRecord(update.content);
    if (content?.type === 'text' && typeof content.text === 'string') appendText(entry, 'reasoning', content.text, now);
    return entry;
  }
  if (update.sessionUpdate === 'tool_call' || update.sessionUpdate === 'tool_call_update') {
    if (typeof update.toolCallId !== 'string') return null;
    const entry = ensureReplayEntry(state, 'assistant', messageId, now, agentId);
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
  if (update.sessionUpdate === 'session_info_update' && typeof update.title === 'string') {
    state.info.title = update.title;
  } else if (update.sessionUpdate === 'config_option_update' && Array.isArray(update.configOptions)) {
    state.configOptions = update.configOptions;
  } else if (update.sessionUpdate === 'available_commands_update' && Array.isArray(update.availableCommands)) {
    state.availableCommands = update.availableCommands;
  } else if (update.sessionUpdate === 'plan' && Array.isArray(update.entries)) {
    const entry = ensureReplayEntry(state, 'assistant', messageId, now, agentId);
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
    entry.info.time.completed = now;
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
