import type { AssistantMessageInfo, MessageInfo, MessagePart, TextPart, ToolPart, UserMessageInfo } from '../../types/sse';

type CodexRecord = Record<string, unknown>;

export type CodexCanonicalMessageBundle = {
  messages: MessageInfo[];
  parts: MessagePart[];
};

export type CodexCanonicalHistoryEntry = {
  info: MessageInfo;
  parts: MessagePart[];
};

function isRecord(value: unknown): value is CodexRecord {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function stringValue(value: unknown, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}

function numberValue(value: unknown, fallback: number) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function codexItemId(item: CodexRecord, fallback: string) {
  return stringValue(item.id, fallback);
}

function extractUserText(item: CodexRecord) {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .filter(isRecord)
    .map((entry) => stringValue(entry.text).trim())
    .filter((text) => text.length > 0);
  return parts.join('\n');
}

function commandText(item: CodexRecord) {
  if (Array.isArray(item.command)) {
    return item.command.filter((entry): entry is string => typeof entry === 'string').join(' ');
  }
  return stringValue(item.command);
}

function createUserMessage(params: {
  id: string;
  sessionId: string;
  createdAt: number;
}): UserMessageInfo {
  return {
    id: params.id,
    sessionID: params.sessionId,
    role: 'user',
    time: { created: params.createdAt },
    agent: 'codex',
    model: { providerID: 'codex', modelID: 'codex' },
  };
}

function createAssistantMessage(params: {
  id: string;
  sessionId: string;
  parentId: string;
  createdAt: number;
  completedAt?: number;
}): AssistantMessageInfo {
  return {
    id: params.id,
    sessionID: params.sessionId,
    role: 'assistant',
    time: { created: params.createdAt, completed: params.completedAt },
    parentID: params.parentId,
    modelID: 'codex',
    providerID: 'codex',
    mode: 'codex',
    agent: 'codex',
    path: { cwd: '', root: '' },
    cost: 0,
    tokens: {
      input: 0,
      output: 0,
      reasoning: 0,
      cache: { read: 0, write: 0 },
    },
  };
}

function createTextPart(params: {
  id: string;
  sessionId: string;
  messageId: string;
  text: string;
  createdAt: number;
}): TextPart {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'text',
    text: params.text,
    time: { start: params.createdAt, end: params.createdAt },
    metadata: { source: 'codex' },
  };
}

function createToolPart(params: {
  id: string;
  sessionId: string;
  messageId: string;
  tool: string;
  input: Record<string, unknown>;
  output: string;
  title: string;
  createdAt: number;
}): ToolPart {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'tool',
    callID: params.id,
    tool: params.tool,
    state: {
      status: 'completed',
      input: params.input,
      output: params.output,
      title: params.title,
      metadata: { source: 'codex' },
      time: { start: params.createdAt, end: params.createdAt },
    },
    metadata: { source: 'codex' },
  };
}

export function normalizeCodexTurnItems(params: {
  sessionId: string;
  turnId: string;
  items: unknown[];
  createdAt?: number;
}): CodexCanonicalMessageBundle {
  const createdAt = params.createdAt ?? Date.now();
  const messages: MessageInfo[] = [];
  const parts: MessagePart[] = [];
  let parentMessageId = '';
  let assistantMessageId = `${params.turnId}:assistant`;

  params.items.forEach((item, index) => {
    if (!isRecord(item)) return;
    const type = stringValue(item.type);
    const itemId = codexItemId(item, `${params.turnId}:item:${index}`);

    if (type === 'userMessage') {
      const text = extractUserText(item);
      if (!text) return;
      const message = createUserMessage({
        id: itemId,
        sessionId: params.sessionId,
        createdAt: numberValue(item.createdAt, createdAt + index),
      });
      messages.push(message);
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: message.id,
        text,
        createdAt: message.time.created,
      }));
      parentMessageId = message.id;
      assistantMessageId = `${params.turnId}:assistant:${index}`;
      return;
    }

    if (!messages.some((message) => message.id === assistantMessageId)) {
      messages.push(createAssistantMessage({
        id: assistantMessageId,
        sessionId: params.sessionId,
        parentId: parentMessageId,
        createdAt: numberValue(item.createdAt, createdAt + index),
      }));
    }

    if (type === 'agentMessage') {
      const text = stringValue(item.text);
      if (!text) return;
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: numberValue(item.createdAt, createdAt + index),
      }));
      return;
    }

    if (type === 'commandExecution') {
      const command = commandText(item);
      const output = stringValue(item.aggregatedOutput) || stringValue(item.output);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: 'bash',
        title: command || 'Codex command',
        input: { command, cwd: stringValue(item.cwd) },
        output,
        createdAt: numberValue(item.createdAt, createdAt + index),
      }));
      return;
    }

    if (type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const files = changes.map((change) => stringValue(change.path)).filter(Boolean);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: 'edit',
        title: files.length > 0 ? `Codex file changes (${files.length})` : 'Codex file changes',
        input: { files },
        output: changes.map((change) => stringValue(change.diff)).filter(Boolean).join('\n'),
        createdAt: numberValue(item.createdAt, createdAt + index),
      }));
    }
  });

  return { messages, parts };
}

export function normalizeCodexTurnsToHistory(params: {
  sessionId: string;
  turns: Array<{ id?: unknown; items?: unknown; createdAt?: unknown }>;
  createdAt?: number;
}): CodexCanonicalHistoryEntry[] {
  const entries: CodexCanonicalHistoryEntry[] = [];
  for (const [index, turn] of params.turns.entries()) {
    const turnId = stringValue(turn.id, `${params.sessionId}:turn:${index}`);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const bundle = normalizeCodexTurnItems({
      sessionId: params.sessionId,
      turnId,
      items,
      createdAt: numberValue(turn.createdAt, params.createdAt ?? Date.now() + index),
    });
    for (const info of bundle.messages) {
      entries.push({
        info,
        parts: bundle.parts.filter((part) => part.messageID === info.id),
      });
    }
  }
  return entries;
}
