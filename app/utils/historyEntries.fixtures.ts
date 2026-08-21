import type {
  MessageInfo,
  MessagePart,
  QuestionInfo,
  ReasoningPart,
  SubtaskPart,
  ToolPart,
} from '../types/sse';

/** Shared fixtures for the historyEntries test modules. */

export function makeUserMessage(sessionId: string, id: string, time: number): MessageInfo {
  return {
    id,
    sessionID: sessionId,
    role: 'user',
    time: { created: time },
    agent: 'build',
    model: { providerID: 'test', modelID: 'test-model' },
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

export function makeTextPart(messageId: string, sessionId: string, text: string): MessagePart {
  return {
    id: `text-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'text',
    text,
  };
}

export function makeToolPart(
  messageId: string,
  sessionId: string,
  tool: string,
  status: ToolPart['state']['status'] = 'completed',
  start = 1,
): ToolPart {
  const base = {
    id: `tool-${messageId}-${tool}`,
    callID: `call-${messageId}-${tool}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool' as const,
    tool,
  };
  if (status === 'pending') {
    return { ...base, state: { status, input: {}, raw: '' } };
  }
  if (status === 'running') {
    return { ...base, state: { status, input: {}, time: { start } } };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status, input: {}, error: 'boom', time: { start, end: start + 1 } },
    };
  }
  return {
    ...base,
    state: {
      status,
      input: {},
      output: 'done',
      title: tool,
      metadata: {},
      time: { start, end: start + 1 },
    },
  };
}

export function makeReasoningPart(
  messageId: string,
  sessionId: string,
  text: string,
  start: number,
): ReasoningPart {
  return {
    id: `reasoning-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'reasoning',
    text,
    time: { start },
  };
}

export function makeSubtaskPart(messageId: string, sessionId: string): SubtaskPart {
  return {
    id: `subtask-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'subtask',
    prompt: 'do it',
    description: 'subtask',
    agent: 'subagent',
  };
}

export function makeQuestionTool(
  messageId: string,
  sessionId: string,
  status: ToolPart['state']['status'],
  answers?: string[][],
): ToolPart {
  const questions: QuestionInfo[] = [
    { question: 'Proceed?', header: 'Confirm', options: [{ label: 'yes', description: '' }] },
  ];
  const base = {
    id: `question-${messageId}`,
    callID: `call-question-${messageId}`,
    sessionID: sessionId,
    messageID: messageId,
    type: 'tool' as const,
    tool: 'question',
  };
  if (status === 'completed') {
    return {
      ...base,
      state: {
        status,
        input: { questions },
        output: '',
        title: 'question',
        metadata: answers ? { answers } : {},
        time: { start: 5, end: 6 },
      },
    };
  }
  if (status === 'error') {
    return {
      ...base,
      state: { status, input: { questions }, error: 'no', time: { start: 5, end: 6 } },
    };
  }
  if (status === 'running') {
    return { ...base, state: { status, input: { questions }, time: { start: 5 } } };
  }
  return { ...base, state: { status: 'pending', input: { questions }, raw: '' } };
}

export function makeSource(messages: MessageInfo[], partsByMessage: Record<string, MessagePart[]>) {
  return {
    messages,
    hasTextContent: (message: MessageInfo) =>
      (partsByMessage[message.id] ?? []).some((part) => part.type === 'text' && part.text),
    getParts: (messageId: string) => partsByMessage[messageId] ?? [],
  };
}
