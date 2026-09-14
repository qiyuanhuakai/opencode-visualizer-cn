import type {
  AssistantMessageInfo,
  TextPart,
  ToolPart,
  ToolState,
  UserMessageInfo,
} from '../types/sse';

type UserMessageOverrides = Partial<Omit<UserMessageInfo, 'id' | 'role'>>;
type AssistantMessageOverrides = Partial<Omit<AssistantMessageInfo, 'id' | 'role'>>;
type TextPartOverrides = Partial<Omit<TextPart, 'messageID' | 'type'>>;
type ToolPartOverrides = Partial<Omit<ToolPart, 'messageID' | 'state' | 'type'>>;

export function userMessage(id: string, overrides: UserMessageOverrides = {}): UserMessageInfo {
  return {
    sessionID: 'thread-1',
    time: { created: 1 },
    agent: 'codex',
    model: { providerID: 'codex', modelID: 'codex' },
    ...overrides,
    id,
    role: 'user',
  };
}

export function assistantMessage(
  id: string,
  overrides: AssistantMessageOverrides = {},
): AssistantMessageInfo {
  return {
    sessionID: 'thread-1',
    time: { created: 2 },
    parentID: 'turn_1:user:0',
    modelID: 'codex',
    providerID: 'codex',
    mode: 'codex',
    agent: 'codex',
    path: { cwd: '/repo', root: '/repo' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
    id,
    role: 'assistant',
  };
}

export function textPart(messageID: string, overrides: TextPartOverrides = {}): TextPart {
  return {
    id: `${messageID}:text`,
    sessionID: 'thread-1',
    text: '',
    ...overrides,
    messageID,
    type: 'text',
  };
}

export function toolPart(
  messageID: string,
  state: ToolState,
  overrides: ToolPartOverrides = {},
): ToolPart {
  return {
    id: 'tool-1',
    sessionID: 'session-1',
    callID: 'tool-1',
    tool: 'bash',
    metadata: { source: 'codex' },
    ...overrides,
    messageID,
    state,
    type: 'tool',
  };
}
