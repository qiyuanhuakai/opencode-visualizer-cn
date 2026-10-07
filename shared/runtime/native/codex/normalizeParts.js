export function codexUserMessageId(turnId, index = 0) {
  return `${turnId}:user:${index}`;
}
export function codexAssistantMessageId(turnId, itemId) {
  return itemId ? `${turnId}:assistant:${itemId}` : `${turnId}:assistant`;
}
export function codexAssistantTextPartId(turnId, itemId) {
  return `${codexAssistantMessageId(turnId, itemId)}:text`;
}
export function isRecord(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}
export function stringValue(value, fallback = '') {
  return typeof value === 'string' ? value : fallback;
}
export function toolResultText(value) {
  if (typeof value === 'string') return value;
  if (!isRecord(value)) return '';
  const message = stringValue(value.message);
  if (message) return message;
  const content = Array.isArray(value.content) ? value.content : [];
  const contentText = content
    .filter(isRecord)
    .map((entry) => stringValue(entry.text))
    .filter(Boolean)
    .join('\n');
  if (contentText) return contentText;
  if (value.structuredContent !== null && value.structuredContent !== undefined) {
    try {
      return JSON.stringify(value.structuredContent);
    } catch {
      return '';
    }
  }
  return '';
}
export function numberValue(value, fallback) {
  return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}
export function asNumber(value) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}
export function wireTimestampMs(value) {
  const num = asNumber(value);
  if (num === undefined || num <= 0) return undefined;
  return num < 1_000_000_000_000 ? num * 1000 : num;
}
export function codexItemId(item, fallback) {
  return stringValue(item.id, fallback);
}
export function extractUserText(item) {
  const content = Array.isArray(item.content) ? item.content : [];
  const parts = content
    .filter(isRecord)
    .filter((entry) => stringValue(entry.type) === 'text')
    .map((entry) => stringValue(entry.text).trim())
    .filter((text) => text.length > 0);
  return parts.join('\n');
}
export function extractUserFiles(item) {
  const content = Array.isArray(item.content) ? item.content : [];
  const files = [];
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
export function commandText(item) {
  if (Array.isArray(item.command)) {
    return item.command.filter((entry) => typeof entry === 'string').join(' ');
  }
  return stringValue(item.command);
}
export function createUserMessage(params) {
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
export function extractTurnCompletedTime(turn) {
  const direct = asNumber(turn.completedAt) ?? asNumber(turn.finishedAt);
  if (direct !== undefined) return direct;
  let max;
  const items = Array.isArray(turn.items) ? turn.items : [];
  for (const item of items) {
    if (!isRecord(item)) continue;
    const time = item.time;
    if (!isRecord(time)) continue;
    const end = asNumber(time.end);
    if (end !== undefined && (max === undefined || end > max)) max = end;
  }
  return max;
}
export function createAssistantMessage(params) {
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
export function createTextPart(params) {
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
export function createToolPart(params) {
  const isError =
    params.status === 'failed' || params.status === 'declined' || params.status === 'error';
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
          metadata: { source: 'codex', codexStatus: params.status, ...params.metadata },
          time: { start: params.createdAt, end: params.createdAt },
        }
      : {
          status: 'completed',
          input: params.input,
          output: params.output,
          title: params.title,
          metadata: { source: 'codex', codexStatus: params.status, ...params.metadata },
          time: { start: params.createdAt, end: params.createdAt },
        },
    metadata: { source: 'codex' },
  };
}
export function createFilePart(params) {
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
export function createReasoningPart(params) {
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
export function createCompactionPart(params) {
  return {
    id: params.id,
    sessionID: params.sessionId,
    messageID: params.messageId,
    type: 'compaction',
    auto: false,
  };
}
