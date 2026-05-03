import type {
  AssistantMessageInfo,
  CompactionPart,
  MessageInfo,
  MessagePart,
  ReasoningPart,
  TextPart,
  ToolPart,
  UserMessageInfo,
} from '../../types/sse';

type CodexRecord = Record<string, unknown>;

export type CodexCanonicalMessageBundle = {
  messages: MessageInfo[];
  parts: MessagePart[];
};

export type CodexCanonicalHistoryEntry = {
  info: MessageInfo;
  parts: MessagePart[];
};

export function codexUserMessageId(turnId: string, index = 0) {
  return `${turnId}:user:${index}`;
}

export function codexAssistantMessageId(turnId: string) {
  return `${turnId}:assistant`;
}

export function codexAssistantTextPartId(turnId: string) {
  return `${codexAssistantMessageId(turnId)}:text`;
}

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

function createReasoningPart(params: {
  id: string;
  sessionId: string;
  messageId: string;
  text: string;
  createdAt: number;
}): ReasoningPart {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'reasoning',
    text: params.text,
    metadata: { source: 'codex' },
    time: { start: params.createdAt, end: params.createdAt },
  };
}

function createCompactionPart(params: {
  id: string;
  sessionId: string;
  messageId: string;
  createdAt: number;
}): CompactionPart {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'compaction',
    auto: false,
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
  let assistantMessageId = codexAssistantMessageId(params.turnId);
  let userMessageIndex = 0;
  let assistantMessage: AssistantMessageInfo | undefined;

  function ensureAssistantMessage(itemTime: number) {
    if (!assistantMessage) {
      assistantMessage = createAssistantMessage({
        id: assistantMessageId,
        sessionId: params.sessionId,
        parentId: parentMessageId,
        createdAt: itemTime,
        completedAt: itemTime,
      });
      messages.push(assistantMessage);
      return assistantMessage;
    }

    if (!assistantMessage.parentID && parentMessageId) {
      assistantMessage.parentID = parentMessageId;
    }
    if (itemTime < assistantMessage.time.created) {
      assistantMessage.time.created = itemTime;
    }
    const currentCompleted = numberValue(assistantMessage.time.completed, assistantMessage.time.created);
    if (itemTime > currentCompleted) {
      assistantMessage.time.completed = itemTime;
    }
    return assistantMessage;
  }

  params.items.forEach((item, index) => {
    if (!isRecord(item)) return;
    const type = stringValue(item.type);
    const itemId = codexItemId(item, `${params.turnId}:item:${index}`);
    const itemTime = numberValue(item.createdAt, createdAt + index);

    if (type === 'userMessage') {
      const text = extractUserText(item);
      if (!text) return;
      const message = createUserMessage({
        id: codexUserMessageId(params.turnId, userMessageIndex),
        sessionId: params.sessionId,
        createdAt: itemTime,
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
      userMessageIndex += 1;
      return;
    }

    ensureAssistantMessage(itemTime);

    if (type === 'agentMessage') {
      const text = stringValue(item.text);
      if (!text) return;
      parts.push(createTextPart({
        id: codexAssistantTextPartId(params.turnId),
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: itemTime,
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
        createdAt: itemTime,
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
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'reasoning') {
      const summary = stringValue(item.summary);
      const content = stringValue(item.text) || stringValue(item.content);
      const text = summary || content;
      if (!text) return;
      parts.push(createReasoningPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'plan') {
      const text = stringValue(item.text);
      if (!text) return;
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'mcpToolCall') {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      const args = isRecord(item.arguments) ? item.arguments : {};
      const result = stringValue(item.result);
      const error = stringValue(item.error);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: tool || 'mcp',
        title: server && tool ? `${server}.${tool}` : tool || 'MCP tool call',
        input: { server, tool, ...args },
        output: error || result,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'dynamicToolCall' || type === 'collabToolCall') {
      const tool = stringValue(item.tool);
      const args = isRecord(item.arguments) ? item.arguments : {};
      const status = stringValue(item.status);
      const contentItems = Array.isArray(item.contentItems) ? item.contentItems : [];
      const outputText = contentItems
        .filter(isRecord)
        .map((ci) => stringValue(ci.text))
        .filter(Boolean)
        .join('\n');
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: tool || 'dynamic',
        title: tool || 'Dynamic tool call',
        input: args,
        output: outputText || status,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'webSearch') {
      const query = stringValue(item.query);
      const action = isRecord(item.action) ? item.action : null;
      const actionType = action ? stringValue(action.type) : '';
      const actionUrl = action ? stringValue(action.url) : '';
      const text = [
        query ? `Web search: ${query}` : '',
        actionType ? `action: ${actionType}` : '',
        actionUrl ? `url: ${actionUrl}` : '',
      ].filter(Boolean).join('\n');
      if (!text) return;
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'imageView') {
      const path = stringValue(item.path);
      if (!path) return;
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text: `Image: ${path}`,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
      const review = stringValue(item.review);
      const text = type === 'enteredReviewMode'
        ? `Entered review mode: ${review || 'current changes'}`
        : (review ? `Review: ${review}` : 'Exited review mode');
      parts.push(createTextPart({
        id: `${itemId}:text`,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        text,
        createdAt: itemTime,
      }));
      return;
    }

    if (type === 'contextCompaction') {
      parts.push(createCompactionPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        createdAt: itemTime,
      }));
      return;
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
