import {
  codexUserMessageId,
  codexAssistantMessageId,
  codexAssistantTextPartId,
  isRecord,
  stringValue,
  numberValue,
  codexItemId,
  extractUserText,
  extractUserFiles,
  createUserMessage,
  extractTurnCompletedTime,
  createAssistantMessage,
  createTextPart,
  createFilePart,
} from './normalizeParts.js';
import { normalizeToolItem } from './normalizeTools.js';
export function normalizeCodexTurnItems(params) {
  const createdAt = params.createdAt ?? Date.now();
  const hasExplicitStatus = params.turnStatus != null && params.turnStatus !== '';
  const isCompleted = params.turnStatus === 'completed';
  const turnForExtraction = { ...params.turn, items: params.turn?.items ?? params.items };
  const turnCompletedTime = isCompleted ? extractTurnCompletedTime(turnForExtraction) : undefined;
  const messages = [];
  const parts = [];
  let parentMessageId = params.parentMessageId ?? '';
  let userMessageIndex = 0;
  function addAssistantMessage(messageId, itemTime) {
    let completedAt;
    if (isCompleted) {
      completedAt = turnCompletedTime ?? itemTime;
    } else if (!hasExplicitStatus) {
      completedAt = itemTime;
    }
    messages.push(
      createAssistantMessage({
        id: messageId,
        sessionId: params.sessionId,
        parentId: parentMessageId,
        createdAt: itemTime,
        completedAt,
        model: params.model,
      }),
    );
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
        id: codexUserMessageId(
          params.turnId,
          stringValue(item.clientId).trim() || stringValue(item.id).trim() || userMessageIndex,
        ),
        sessionId: params.sessionId,
        createdAt: itemTime,
        model: params.model,
      });
      messages.push(message);
      if (text) {
        parts.push(
          createTextPart({
            id: `${message.id}:text`,
            sessionId: params.sessionId,
            messageId: message.id,
            text,
            createdAt: message.time.created,
          }),
        );
      }
      files.forEach((file, fileIndex) => {
        parts.push(
          createFilePart({
            id: `${message.id}:file:${fileIndex}`,
            sessionId: params.sessionId,
            messageId: message.id,
            mime: file.mime,
            filename: file.filename,
            url: file.url,
          }),
        );
      });
      parentMessageId = message.id;
      userMessageIndex += 1;
      return;
    }
    if (type === 'agentMessage') {
      const text = stringValue(item.text);
      if (!text) return;
      const messageId = codexAssistantMessageId(params.turnId, itemId);
      messages.push(
        createAssistantMessage({
          id: messageId,
          sessionId: params.sessionId,
          parentId: parentMessageId,
          createdAt: itemTime,
          completedAt: isCompleted
            ? (turnCompletedTime ?? itemTime)
            : !hasExplicitStatus
              ? itemTime
              : undefined,
          model: params.model,
        }),
      );
      parts.push(
        createTextPart({
          id: codexAssistantTextPartId(params.turnId, itemId),
          sessionId: params.sessionId,
          messageId,
          text,
          createdAt: itemTime,
        }),
      );
      return;
    }
    if (type === 'enteredReviewMode' || type === 'exitedReviewMode') return;
    const assistantMessageId = codexAssistantMessageId(params.turnId, itemId);
    addAssistantMessage(assistantMessageId, itemTime);
    parts.push(
      ...normalizeToolItem({
        type,
        item,
        itemId,
        itemTime,
        assistantMessageId,
        sessionId: params.sessionId,
      }),
    );
  });
  return { messages, parts };
}
