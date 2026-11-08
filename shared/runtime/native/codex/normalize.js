import { stringValue, wireTimestampMs, numberValue } from './normalizeParts.js';
import { normalizeCodexTurnItems } from './normalizeItems.js';
export function normalizeCodexTurnsToHistory(params) {
  const entries = [];
  let parentMessageId = params.parentMessageId;
  for (const [index, turn] of params.turns.entries()) {
    const turnId = stringValue(turn.id, `${params.sessionId}:turn:${index}`);
    const items = Array.isArray(turn.items) ? turn.items : [];
    const turnStatus = stringValue(turn.status);
    const startedMs = wireTimestampMs(turn.startedAt);
    const completedMs = wireTimestampMs(turn.completedAt);
    const bundle = normalizeCodexTurnItems({
      sessionId: params.sessionId,
      turnId,
      items,
      parentMessageId,
      createdAt: startedMs ?? numberValue(turn.createdAt, params.createdAt ?? Date.now() + index),
      model: params.model,
      turnStatus,
      turn: completedMs !== undefined ? { ...turn, completedAt: completedMs } : turn,
    });
    const partsByMessage = new Map();
    for (const part of bundle.parts) {
      const messageParts = partsByMessage.get(part.messageID);
      if (messageParts) messageParts.push(part);
      else partsByMessage.set(part.messageID, [part]);
    }
    for (const info of bundle.messages) {
      if (info.role === 'user') parentMessageId = info.id;
      entries.push({
        info,
        parts: partsByMessage.get(info.id) ?? [],
      });
    }
  }
  return entries;
}
function record(value) {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value))
    : null;
}
function nonnegative(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}
function breakdown(value) {
  const data = record(value);
  const cacheWriteInputTokens =
    data?.cacheWriteInputTokens === undefined ? 0 : data.cacheWriteInputTokens;
  if (
    !data ||
    !nonnegative(data.totalTokens) ||
    !nonnegative(data.inputTokens) ||
    !nonnegative(data.cachedInputTokens) ||
    !nonnegative(cacheWriteInputTokens) ||
    !nonnegative(data.outputTokens) ||
    !nonnegative(data.reasoningOutputTokens)
  )
    return null;
  return {
    totalTokens: data.totalTokens,
    inputTokens: data.inputTokens,
    cachedInputTokens: data.cachedInputTokens,
    cacheWriteInputTokens,
    outputTokens: data.outputTokens,
    reasoningOutputTokens: data.reasoningOutputTokens,
  };
}
export function parseCodexThreadTokenUsage(value, threadId) {
  const notification = record(value);
  if (
    !notification ||
    notification.threadId !== threadId ||
    typeof notification.turnId !== 'string'
  )
    return null;
  const usage = record(notification.tokenUsage);
  if (!usage) return null;
  const total = breakdown(usage.total);
  const last = breakdown(usage.last);
  if (!total || !last) return null;
  const modelContextWindow =
    usage.modelContextWindow === undefined ? null : usage.modelContextWindow;
  if (modelContextWindow !== null && !nonnegative(modelContextWindow)) return null;
  return { threadId, turnId: notification.turnId, total, last, modelContextWindow };
}
