import type {
  MessageInfo,
  MessagePart,
  QuestionInfo,
  ReasoningPart,
  SubtaskPart,
  ToolPart,
} from '../types/sse';
import type { HistoryEntry, HistoryWindowEntry } from '../types/message';
import { isHistoryToolName } from './toolNames';

/**
 * Pure helpers shared by the thread-history and subagent-history builders.
 * Both SubagentHistoryContent.vue and ThreadBlock.vue previously duplicated
 * these verbatim; the entry-building loop and the window-entry mapping are
 * consolidated here so ordering, keys, timestamps, question status/answers,
 * and agent/isSubagent semantics live in one place.
 */

export function getToolPartTime(part: ToolPart): number {
  const state = part.state;
  if (state.status === 'running' || state.status === 'completed' || state.status === 'error') {
    return state.time.start;
  }
  return 0;
}

export function getSubtaskPartTime(_part: SubtaskPart, fallbackTime: number): number {
  return fallbackTime;
}

export function extractQuestionInfos(part: ToolPart): QuestionInfo[] {
  const raw = part.state.input?.questions;
  if (!Array.isArray(raw)) return [];
  return raw.filter(
    (q): q is QuestionInfo =>
      q &&
      typeof q === 'object' &&
      typeof q.question === 'string' &&
      typeof q.header === 'string' &&
      Array.isArray(q.options),
  );
}

export function resolveQuestionStatus(part: ToolPart): 'pending' | 'replied' | 'rejected' {
  if (part.state.status === 'completed') return 'replied';
  if (part.state.status === 'error') return 'rejected';
  return 'pending';
}

export function extractQuestionAnswers(part: ToolPart): string[][] | undefined {
  if (part.state.status !== 'completed') return undefined;
  const answers = part.state.metadata?.answers;
  if (!Array.isArray(answers)) return undefined;
  return answers as string[][];
}

export function getHistoryEntryKey(entry: HistoryEntry): string {
  if (entry.kind === 'message') return `msg:${entry.message.id}`;
  if (entry.kind === 'reasoning') return `reasoning:${entry.part.id}`;
  if (entry.kind === 'question') return `question:${entry.part.callID}`;
  if (entry.kind === 'subtask') return `subtask:${entry.part.id}`;
  return `tool:${entry.part.callID}`;
}

/** Accessors the caller wires to its message store so this stays pure. */
export type HistoryEntrySource = {
  messages: MessageInfo[];
  hasTextContent: (message: MessageInfo) => boolean;
  getParts: (messageId: string) => MessagePart[];
};

function messageEntry(
  msgInfo: MessageInfo,
  hasTextContent: (message: MessageInfo) => boolean,
): HistoryEntry | null {
  if (msgInfo.role !== 'assistant' || !hasTextContent(msgInfo)) return null;
  return { kind: 'message', message: msgInfo, time: msgInfo.time.created };
}

function reasoningEntry(part: ReasoningPart): HistoryEntry | null {
  if (!part.text) return null;
  return { kind: 'reasoning', part, time: part.time.start };
}

function subtaskEntry(part: SubtaskPart, fallbackTime: number): HistoryEntry {
  return { kind: 'subtask', part, time: getSubtaskPartTime(part, fallbackTime) };
}

/** Tool dispatch: pending skipped, question tools mapped, only history tools kept. */
function toolEntry(part: ToolPart): HistoryEntry | null {
  if (part.state.status === 'pending') return null;
  if (part.tool === 'question') {
    return { kind: 'question', part, time: getToolPartTime(part) };
  }
  if (!isHistoryToolName(part.tool)) return null;
  return { kind: 'tool', part, time: getToolPartTime(part) };
}

/** Exhaustive dispatch over every part variant; unknown part types are skipped. */
function partEntry(part: MessagePart, fallbackTime: number): HistoryEntry | null {
  switch (part.type) {
    case 'reasoning':
      return reasoningEntry(part);
    case 'subtask':
      return subtaskEntry(part, fallbackTime);
    case 'tool':
      return toolEntry(part);
    default:
      return null;
  }
}

/**
 * Builds the sorted history entries for a list of messages: assistant text
 * messages, reasoning parts with text, subtask parts, question tools, and
 * history tools. Pending tools and non-history tools are skipped. Entries are
 * ordered ascending by their resolved timestamp.
 */
export function buildHistoryEntries(source: HistoryEntrySource): HistoryEntry[] {
  const entries: HistoryEntry[] = [];
  for (const msgInfo of source.messages) {
    const message = messageEntry(msgInfo, source.hasTextContent);
    if (message) entries.push(message);
    for (const part of source.getParts(msgInfo.id)) {
      const entry = partEntry(part, msgInfo.time.created);
      if (entry) entries.push(entry);
    }
  }
  return entries.sort((a, b) => a.time - b.time);
}

/**
 * Selects the user roots belonging to `parentThreadId` and flattens their
 * threads into a single message list (subagent history source).
 */
export function selectSubagentMessages(
  roots: MessageInfo[],
  getThread: (rootId: string) => MessageInfo[],
  parentThreadId: string,
): MessageInfo[] {
  const target = parentThreadId.trim();
  if (!target) return [];
  return roots
    .filter((root) => root.role === 'user')
    .filter((root) => root.sessionID === target)
    .flatMap((root) => getThread(root.id));
}

/** A message belongs to a subagent when it lives in a different session. */
export function resolveMessageIsSubagent(message: MessageInfo, currentSessionId?: string): boolean {
  return Boolean(currentSessionId && message.sessionID !== currentSessionId);
}

/** Assistant messages carry the agent name; user messages do not. */
export function getMessageHistoryAgent(message: MessageInfo): string | undefined {
  return message.role === 'assistant' && 'agent' in message && message.agent
    ? message.agent
    : undefined;
}

/** Message-specific fields for the window representation. */
export type HistoryMessageView = {
  content: string;
  isSubagent: boolean;
  agent?: string;
};

/**
 * Maps a history entry to its window representation. The optional `message`
 * view only affects message-kind entries (content, isSubagent, agent).
 */
export function toHistoryWindowEntry(
  entry: HistoryEntry,
  message?: HistoryMessageView,
): HistoryWindowEntry {
  if (entry.kind === 'message') {
    return {
      key: getHistoryEntryKey(entry),
      kind: 'message',
      content: message?.content ?? '',
      time: entry.time,
      sessionId: entry.message.sessionID,
      isSubagent: message?.isSubagent,
      agent: message?.agent,
    };
  }
  if (entry.kind === 'reasoning') {
    return {
      key: getHistoryEntryKey(entry),
      kind: 'reasoning',
      part: entry.part,
      time: entry.time,
    };
  }
  if (entry.kind === 'question') {
    return {
      key: getHistoryEntryKey(entry),
      kind: 'question',
      questions: extractQuestionInfos(entry.part),
      status: resolveQuestionStatus(entry.part),
      answers: extractQuestionAnswers(entry.part),
      time: entry.time,
    };
  }
  if (entry.kind === 'subtask') {
    return {
      key: getHistoryEntryKey(entry),
      kind: 'subtask',
      part: entry.part,
      time: entry.time,
    };
  }
  return {
    key: getHistoryEntryKey(entry),
    kind: 'tool',
    part: entry.part,
    time: entry.time,
  };
}
