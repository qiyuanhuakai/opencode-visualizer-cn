/**
 * Converts kimi web REST message rows into the shared `MessageInfo`/
 * `MessagePart` shapes consumed by `useMessages.loadHistory`. Kimi splits
 * assistant content and tool results across rows, so `role:'tool'` rows carry
 * no `MessageInfo` and instead fold into the matching assistant `tool_use`
 * part (matched by `tool_call_id`). Messages are expected in chronological
 * order; the pager (`history.ts`) is responsible for reversing and filtering.
 */
import type {
  AssistantMessageInfo,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';
import type { KimiWebContentPart, KimiWebMessage } from '../../utils/kimiWeb';

export type KimiWebHistoryEntry = {
  info: UserMessageInfo | AssistantMessageInfo;
  parts: MessagePart[];
};

export type KimiWebHistoryProfile = {
  model?: string;
  provider?: string;
  effort?: string;
  permission?: string;
};

export function isInjectionMessage(message: KimiWebMessage): boolean {
  const origin = message.metadata?.origin;
  return origin?.kind === 'injection' ||
    ((origin?.kind === 'skill_activation' || origin?.kind === 'plugin_command') && origin.trigger !== 'user-slash');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function parseCreatedAt(value: unknown, fallback: number): number {
  if (typeof value === 'string') {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  if (typeof value === 'number' && Number.isFinite(value)) return value;
  return fallback;
}

function stringifyToolOutput(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value === undefined || value === null) return '';
  try {
    return JSON.stringify(value) ?? '';
  } catch {
    return '';
  }
}

function partBase(message: KimiWebMessage, id: string) {
  return { id, sessionID: message.session_id, messageID: message.id };
}

function createUserInfo(message: KimiWebMessage, createdAt: number, profile: KimiWebHistoryProfile): UserMessageInfo {
  return {
    id: message.id,
    sessionID: message.session_id,
    role: 'user',
    time: { created: createdAt },
    agent: 'main',
    model: { providerID: profile.provider ?? '', modelID: profile.model ?? '' },
    ...(profile.effort ? { variant: profile.effort } : {}),
  };
}

function createAssistantInfo(
  message: KimiWebMessage,
  createdAt: number,
  parentId: string,
  profile: KimiWebHistoryProfile,
): AssistantMessageInfo {
  return {
    id: message.id,
    sessionID: message.session_id,
    role: 'assistant',
    time: { created: createdAt },
    parentID: parentId,
    modelID: profile.model ?? '',
    providerID: profile.provider ?? '',
    mode: profile.permission ?? 'manual',
    agent: 'main',
    ...(profile.effort ? { variant: profile.effort } : {}),
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  };
}

function createToolPart(
  message: KimiWebMessage,
  part: Extract<KimiWebContentPart, { type: 'tool_use' }>,
): ToolPart {
  return {
    ...partBase(message, `${message.id}:tool:${part.tool_call_id}`),
    type: 'tool',
    callID: part.tool_call_id,
    tool: part.tool_name,
    state: { status: 'pending', input: isRecord(part.input) ? part.input : {}, raw: '' },
    metadata: { source: 'kimi-web' },
  };
}

function assistantParts(
  message: KimiWebMessage,
  createdAt: number,
  toolParts: Map<string, ToolPart>,
): MessagePart[] {
  const parts: MessagePart[] = [];
  message.content.forEach((part, index) => {
    if (part.type === 'thinking' && part.thinking.trim()) {
      const reasoning: ReasoningPart = {
        ...partBase(message, `${message.id}:reasoning:${index}`),
        type: 'reasoning',
        text: part.thinking,
        metadata: { source: 'kimi-web' },
        time: { start: createdAt, end: createdAt },
      };
      parts.push(reasoning);
      return;
    }
    if (part.type === 'text' && part.text.trim()) {
      const text: TextPart = {
        ...partBase(message, `${message.id}:text:${index}`),
        type: 'text',
        text: part.text,
        metadata: { source: 'kimi-web' },
        time: { start: createdAt, end: createdAt },
      };
      parts.push(text);
      return;
    }
    if (part.type === 'tool_use') {
      const toolPart = createToolPart(message, part);
      toolParts.set(part.tool_call_id, toolPart);
      parts.push(toolPart);
    }
  });
  return parts;
}

function foldToolResults(
  message: KimiWebMessage,
  createdAt: number,
  toolParts: Map<string, ToolPart>,
): void {
  for (const part of message.content) {
    if (part.type !== 'tool_result') continue;
    const toolPart = toolParts.get(part.tool_call_id);
    if (!toolPart) continue;
    const output = stringifyToolOutput(part.output);
    const time = { start: createdAt, end: createdAt };
    if (part.is_error === true) {
      toolPart.state = {
        status: 'error',
        input: toolPart.state.input,
        error: output || 'Kimi Web tool failed',
        metadata: { source: 'kimi-web' },
        time,
      };
    } else {
      toolPart.state = {
        status: 'completed',
        input: toolPart.state.input,
        output,
        title: toolPart.tool,
        metadata: { source: 'kimi-web' },
        time,
      };
    }
  }
}

function userParts(message: KimiWebMessage, createdAt: number): MessagePart[] {
  return message.content.flatMap<MessagePart>((part, index) =>
    part.type === 'text' && part.text.trim()
      ? [
          {
            ...partBase(message, `${message.id}:text:${index}`),
            type: 'text',
            text: part.text,
            metadata: { source: 'kimi-web' },
            time: { start: createdAt, end: createdAt },
          },
        ]
      : [],
  );
}

export function kimiWebMessagesToHistoryEntries(messages: KimiWebMessage[], profile: KimiWebHistoryProfile = {}): KimiWebHistoryEntry[] {
  const entries: KimiWebHistoryEntry[] = [];
  const toolParts = new Map<string, ToolPart>();
  let lastUserId = '';
  messages.forEach((message, index) => {
    if (isInjectionMessage(message)) return;
    const createdAt = parseCreatedAt(message.created_at, index);
    if (message.role === 'user') {
      lastUserId = message.id;
      entries.push({
        info: createUserInfo(message, createdAt, profile),
        parts: userParts(message, createdAt),
      });
      return;
    }
    if (message.role === 'assistant') {
      entries.push({
        info: createAssistantInfo(message, createdAt, lastUserId || message.id, profile),
        parts: assistantParts(message, createdAt, toolParts),
      });
      return;
    }
    if (message.role === 'tool') foldToolResults(message, createdAt, toolParts);
  });
  return entries;
}
