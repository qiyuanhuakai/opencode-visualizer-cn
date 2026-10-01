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
  TextPart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';
import type { KimiWebAgentTranscript, KimiWebContentPart, KimiWebMessage } from '../../utils/kimiWeb';
import { kimiWebSubagentSessionId, resolveKimiWebToolName } from './wire';

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

type KimiWebChildResult = { agentId: string; label: string; summary: string };

function taskChildResults(toolPart: ToolPart, output: string): KimiWebChildResult[] {
  const items = Array.isArray(toolPart.state.input.items) ? toolPart.state.input.items : [];
  if (output.includes('<agent_swarm_result>')) {
    return [...output.matchAll(/<subagent\s+[^>]*\bagent_id="([A-Za-z0-9_-]+)"[^>]*>([\s\S]*?)<\/subagent>/gu)]
      .map((match, index) => ({
        agentId: match[1]!,
        label: (match[0]!.match(/\bitem="([^"]*)"/u)?.[1] ||
          (typeof items[index] === 'string' ? items[index] : '') || match[1]!)
          .replace(/&(amp|lt|gt|quot|apos);/gu, (_, entity: string) =>
            ({ amp: '&', lt: '<', gt: '>', quot: '"', apos: "'" })[entity] ?? '').trim(),
        summary: match[2]!.trim(),
      }));
  }
  const agentIds = [...output.matchAll(/^agent_id:\s*([A-Za-z0-9_-]+)\s*$/gmu)]
    .map((match) => match[1])
    .filter((id): id is string => Boolean(id));
  const description = toolPart.state.input.description;
  const label = typeof description === 'string' && description.trim() ? description.trim() : 'Agent';
  const summary = output.split('[summary]\n')[1]?.split('\n\nresume_hint:')[0]?.trim() || output.trim();
  return agentIds.map((agentId) => ({ agentId, label, summary }));
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
    mode: '',
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
    tool: resolveKimiWebToolName(part.tool_name),
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
  let thinkingChunks: string[] = [];
  let thinkingStart = -1;
  const flushThinking = () => {
    // Some Kimi history responses repeat every thinking part in consecutive pairs.
    // Require the whole run to match before removing copies, so ordinary repetition survives.
    const pairedDuplicates = thinkingChunks.length >= 4 && thinkingChunks.length % 2 === 0 &&
      thinkingChunks.every((chunk, index) => index % 2 === 0 || chunk === thinkingChunks[index - 1]);
    const thinking = (pairedDuplicates
      ? thinkingChunks.filter((_, index) => index % 2 === 0)
      : thinkingChunks).join('');
    if (!thinking.trim()) {
      thinkingChunks = [];
      thinkingStart = -1;
      return;
    }
    parts.push({
      ...partBase(message, `${message.id}:reasoning:${thinkingStart}`),
      type: 'reasoning',
      text: thinking,
      metadata: { source: 'kimi-web' },
      time: { start: createdAt, end: createdAt },
    });
    thinkingChunks = [];
    thinkingStart = -1;
  };
  message.content.forEach((part, index) => {
    if (part.type === 'thinking') {
      if (thinkingStart < 0) thinkingStart = index;
      thinkingChunks.push(part.thinking);
      return;
    }
    flushThinking();
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
  flushThinking();
  return parts;
}

function foldToolResults(
  message: KimiWebMessage,
  createdAt: number,
  toolParts: Map<string, ToolPart>,
  profile: KimiWebHistoryProfile,
): KimiWebHistoryEntry[] {
  const childHistory: KimiWebHistoryEntry[] = [];
  for (const part of message.content) {
    if (part.type !== 'tool_result') continue;
    const toolPart = toolParts.get(part.tool_call_id);
    if (!toolPart) continue;
    const output = stringifyToolOutput(part.output);
    const time = { start: createdAt, end: createdAt };
    if (toolPart.tool === 'task') {
      const children = taskChildResults(toolPart, output);
      const sessionIds = [...new Set(children.map(({ agentId }) => kimiWebSubagentSessionId(message.session_id, agentId)))];
      if (sessionIds.length > 0) {
        toolPart.metadata = {
          ...toolPart.metadata,
          sessionIds,
          subagentLabels: Object.fromEntries(children.map(({ agentId, label }) =>
            [kimiWebSubagentSessionId(message.session_id, agentId), label])),
        };
        for (const { agentId, label, summary } of children) {
          const childId = kimiWebSubagentSessionId(message.session_id, agentId);
          const userId = `${message.id}:${childId}:user`;
          const assistantId = `${message.id}:${childId}:assistant`;
          childHistory.push({
            info: createUserInfo({ ...message, id: userId, session_id: childId }, createdAt, profile),
            parts: [{ id: `${userId}:text`, sessionID: childId, messageID: userId, type: 'text', text: label }],
          });
          childHistory.push({
            info: {
              ...createAssistantInfo({ ...message, id: assistantId, session_id: childId }, createdAt, userId, profile),
              time: { created: createdAt, completed: createdAt },
              agent: 'subagent',
            },
            parts: [{ id: `${assistantId}:text`, sessionID: childId, messageID: assistantId, type: 'text', text: summary }],
          });
        }
      }
    }
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
  return childHistory;
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
    if (message.role === 'tool') entries.push(...foldToolResults(message, createdAt, toolParts, profile));
  });
  return entries;
}

export function kimiWebTranscriptToHistoryEntries(
  childSessionId: string,
  transcript: KimiWebAgentTranscript,
): KimiWebHistoryEntry[] {
  return transcript.items.flatMap((item, index): KimiWebHistoryEntry[] => {
    if (item.kind !== 'turn') return [];
    const createdAt = parseCreatedAt(item.startedAt, index);
    const completedAt = item.endedAt ? parseCreatedAt(item.endedAt, createdAt) : undefined;
    // Each step is one utterance: emit a separate message per step so the
    // subagent history window renders one cell per utterance instead of
    // joining a whole turn's text with newlines.
    return item.steps.map((step): KimiWebHistoryEntry => {
      const messageId = `${childSessionId}:transcript:${item.turnId}:${step.stepId}`;
      const message: KimiWebMessage = { id: messageId, session_id: childSessionId, role: 'assistant', content: [] };
      const info = createAssistantInfo(message, createdAt, messageId, {});
      info.agent = 'subagent';
      if (completedAt !== undefined) info.time.completed = completedAt;
      const parts: MessagePart[] = [];
      for (const frame of step.frames) {
        const base = partBase(message, `${messageId}:${frame.frameId}`);
        if (frame.kind === 'thinking') {
          parts.push({ ...base, type: 'reasoning', text: frame.text, time: { start: createdAt, end: completedAt } });
        } else if (frame.kind === 'text' && frame.role === 'assistant') {
          parts.push({ ...base, type: 'text', text: frame.text, time: { start: createdAt, end: completedAt } });
        } else if (frame.kind === 'tool') {
          const input = isRecord(frame.input) ? frame.input : {};
          const output = stringifyToolOutput(frame.output);
          const time = { start: createdAt, end: completedAt ?? createdAt };
          const state: ToolPart['state'] = frame.error
            ? { status: 'error', input, error: frame.error, time }
            : frame.state === 'done' || frame.state === 'completed'
              ? { status: 'completed', input, output, title: frame.name, metadata: { source: 'kimi-web' }, time }
              : { status: 'running', input, title: frame.name, metadata: { output }, time };
          parts.push({ ...base, type: 'tool', callID: frame.toolCallId || frame.frameId,
            tool: resolveKimiWebToolName(frame.name), state, metadata: { source: 'kimi-web' } });
        }
      }
      return { info, parts };
    });
  });
}
