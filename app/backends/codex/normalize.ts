import type {
  AssistantMessageInfo,
  CompactionPart,
  FilePart,
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

export type CodexNormalizeModel = {
  providerID?: string;
  modelID?: string;
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
    .filter((entry) => stringValue(entry.type) === 'text')
    .map((entry) => stringValue(entry.text).trim())
    .filter((text) => text.length > 0);
  return parts.join('\n');
}

function extractUserFiles(item: CodexRecord) {
  const content = Array.isArray(item.content) ? item.content : [];
  const files: Array<{ id: string; url: string; filename: string; mime: string }> = [];
  content.filter(isRecord).forEach((entry, index) => {
    const type = stringValue(entry.type);
    if (type === 'image') {
      const url = stringValue(entry.url);
      if (!url) return;
      const mimeMatch = url.match(/^data:([^;,]+)/u);
      const mime = mimeMatch?.[1] || 'image/*';
      const extension = mime.split('/')[1]?.split('+')[0] || 'img';
      files.push({
        id: stringValue(entry.id, `image:${index}`),
        url,
        filename: `image-${index + 1}.${extension}`,
        mime,
      });
      return;
    }
    if (type === 'localImage') {
      const path = stringValue(entry.path);
      if (!path) return;
      const filename = path.split(/[\\/]/u).filter(Boolean).pop() || `image-${index + 1}`;
      const extension = filename.split('.').pop()?.toLowerCase() || '';
      files.push({
        id: stringValue(entry.id, `local-image:${index}`),
        url: path,
        filename,
        mime: extension ? `image/${extension === 'jpg' ? 'jpeg' : extension}` : 'image/*',
      });
    }
  });
  return files;
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
  model?: CodexNormalizeModel;
}): UserMessageInfo {
  return {
    id: params.id,
    sessionID: params.sessionId,
    role: 'user',
    time: { created: params.createdAt },
    agent: 'codex',
    model: {
      providerID: params.model?.providerID || 'codex',
      modelID: params.model?.modelID || 'codex',
    },
  };
}

function createAssistantMessage(params: {
  id: string;
  sessionId: string;
  parentId: string;
  createdAt: number;
  completedAt?: number;
  model?: CodexNormalizeModel;
}): AssistantMessageInfo {
  return {
    id: params.id,
    sessionID: params.sessionId,
    role: 'assistant',
    time: { created: params.createdAt, completed: params.completedAt },
    parentID: params.parentId,
    modelID: params.model?.modelID || 'codex',
    providerID: params.model?.providerID || 'codex',
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
  status?: string;
  metadata?: Record<string, unknown>;
}): ToolPart {
  const isError = params.status === 'failed' || params.status === 'declined' || params.status === 'error';
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'tool',
    callID: params.id,
    tool: params.tool,
    state: isError
      ? {
        status: 'error',
        input: params.input,
        error: params.output || params.status || 'Codex tool failed',
        metadata: { source: 'codex', codexStatus: params.status, ...(params.metadata ?? {}) },
        time: { start: params.createdAt, end: params.createdAt },
      }
      : {
        status: 'completed',
        input: params.input,
        output: params.output,
        title: params.title,
        metadata: { source: 'codex', codexStatus: params.status, ...(params.metadata ?? {}) },
        time: { start: params.createdAt, end: params.createdAt },
      },
    metadata: { source: 'codex' },
  };
}

function createFilePart(params: {
  id: string;
  sessionId: string;
  messageId: string;
  mime: string;
  filename: string;
  url: string;
}): FilePart {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'file',
    mime: params.mime,
    filename: params.filename,
    url: params.url,
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
  model?: CodexNormalizeModel;
  parentMessageId?: string;
}): CodexCanonicalMessageBundle {
  const createdAt = params.createdAt ?? Date.now();
  const messages: MessageInfo[] = [];
  const parts: MessagePart[] = [];
  let parentMessageId = params.parentMessageId ?? '';
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
        model: params.model,
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
      const files = extractUserFiles(item);
      if (!text && files.length === 0) return;
      const message = createUserMessage({
        id: codexUserMessageId(params.turnId, userMessageIndex),
        sessionId: params.sessionId,
        createdAt: itemTime,
        model: params.model,
      });
      messages.push(message);
      if (text) {
        parts.push(createTextPart({
          id: `${message.id}:text`,
          sessionId: params.sessionId,
          messageId: message.id,
          text,
          createdAt: message.time.created,
        }));
      }
      files.forEach((file, fileIndex) => {
        parts.push(createFilePart({
          id: `${message.id}:file:${file.id || fileIndex}`,
          sessionId: params.sessionId,
          messageId: message.id,
          mime: file.mime,
          filename: file.filename,
          url: file.url,
        }));
      });
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
      const status = stringValue(item.status);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: 'bash',
        title: command || 'Codex command',
        input: { command, cwd: stringValue(item.cwd) },
        output,
        createdAt: itemTime,
        status,
      }));
      return;
    }

    if (type === 'fileChange') {
      const changes = Array.isArray(item.changes) ? item.changes.filter(isRecord) : [];
      const files = changes.map((change) => stringValue(change.path)).filter(Boolean);
      const status = stringValue(item.status);
      const firstPath = files[0] || '';
      const changeResults = changes.map((change) => {
        const path = stringValue(change.path);
        const rawDiff = stringValue(change.diff);
        const diff = rawDiff || (path ? `File changed: ${path}` : 'File changed');
        return {
          path,
          diff,
          filediff: {
            patch: diff,
          },
        };
      }).filter((entry) => entry.path || entry.diff);
      const isMultiFile = changeResults.length > 1;
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: isMultiFile ? 'multiedit' : 'edit',
        title: files.length > 0 ? `Codex file changes (${files.length})` : 'Codex file changes',
        input: { files, filePath: firstPath },
        output: changeResults.map((change) => change.diff).filter(Boolean).join('\n'),
        createdAt: itemTime,
        status,
        metadata: isMultiFile
          ? { results: changeResults }
          : { filediff: { patch: changeResults[0]?.diff || '' } },
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
      return;
    }

    if (type === 'mcpToolCall') {
      const server = stringValue(item.server);
      const tool = stringValue(item.tool);
      const args = isRecord(item.arguments) ? item.arguments : {};
      const result = stringValue(item.result);
      const error = stringValue(item.error);
      const status = stringValue(item.status);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: tool || 'mcp',
        title: server && tool ? `${server}.${tool}` : tool || 'MCP tool call',
        input: { server, tool, ...args },
        output: error || result,
        createdAt: itemTime,
        status,
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
        status,
      }));
      return;
    }

    if (type === 'webSearch') {
      const query = stringValue(item.query);
      const action = isRecord(item.action) ? item.action : null;
      const actionType = action ? stringValue(action.type) : '';
      const actionUrl = action ? stringValue(action.url) : '';
      const status = stringValue(item.status);
      parts.push(createToolPart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        tool: 'websearch',
        title: query || actionUrl || 'Codex web search',
        input: {
          query,
          ...(actionType ? { action: actionType } : {}),
          ...(actionUrl ? { url: actionUrl } : {}),
        },
        output: [
          query ? `Query: ${query}` : '',
          actionType ? `Action: ${actionType}` : '',
          actionUrl ? `URL: ${actionUrl}` : '',
        ].filter(Boolean).join('\n'),
        createdAt: itemTime,
        status,
      }));
      return;
    }

    if (type === 'imageView') {
      const path = stringValue(item.path);
      if (!path) return;
      parts.push(createFilePart({
        id: itemId,
        sessionId: params.sessionId,
        messageId: assistantMessageId,
        mime: 'image/*',
        filename: path.split(/[\\/]/u).filter(Boolean).pop() || 'image',
        url: path,
      }));
      return;
    }

    if (type === 'enteredReviewMode' || type === 'exitedReviewMode') {
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
  model?: CodexNormalizeModel;
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
      model: params.model,
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
