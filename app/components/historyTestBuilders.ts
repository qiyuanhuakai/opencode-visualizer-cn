import type { HistoryWindowEntry } from '../types/message';
import type { MessageInfo, MessagePart, TextPart, ToolPart } from '../types/sse';

export function makeUserMessage(
  sessionId: string,
  id: string,
  time: number,
  providerID = 'test',
  modelID = 'test-model',
): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'user',
    time: { created: time },
    agent: 'build',
    model: { providerID, modelID },
  };
}

export function makeAssistantMessage(
  sessionId: string,
  id: string,
  parentId: string,
  time: number,
  agent = 'subagent',
): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'assistant',
    parentID: parentId,
    time: { created: time, completed: time + 10 },
    agent,
    modelID: 'codex',
    providerID: 'codex',
    mode: 'codex',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

export function makeTextPart(messageId: string, sessionId: string, text: string): TextPart {
  return {
    id: `text-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

export function makeToolPart(messageId: string, sessionId: string, tool: string): ToolPart {
  return {
    id: `tool-${messageId}`,
    callID: `call-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool',
    tool,
    state: {
      status: 'completed',
      input: { command: 'ls' },
      output: 'done',
      title: tool,
      metadata: {},
      time: { start: 1, end: 1 },
    },
  };
}

export function makeMessageEntry(
  info: MessageInfo,
  parts: readonly MessagePart[],
): { readonly info: MessageInfo; readonly parts: MessagePart[] } {
  return { info, parts: [...parts] };
}

export function makeUserHistoryEntry(index: number, sessionId = 'root-session') {
  const messageId = `message-${index}`;
  return makeMessageEntry(makeUserMessage(sessionId, messageId, index + 1, 'openai', 'gpt'), [
    makeTextPart(messageId, sessionId, `Prompt ${index}`),
  ]);
}

export function makeThreadHistoryToolEntries(
  count: number,
  prefix: string,
  commandPrefix = prefix,
): HistoryWindowEntry[] {
  return Array.from({ length: count }, (_, index) => ({
    key: `${prefix}-${index}`,
    kind: 'tool' as const,
    time: index,
    part: {
      id: `${prefix}-${index}`,
      callID: `${prefix}-${index}`,
      sessionID: 's1',
      messageID: `m-${index}`,
      type: 'tool' as const,
      tool: 'bash',
      state: {
        status: 'completed' as const,
        input: { command: `printf ${commandPrefix}-${index}` },
        output: '',
        title: 'shell',
        metadata: {},
        time: { start: index, end: index },
      },
    },
  }));
}
