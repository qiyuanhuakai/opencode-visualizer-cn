export type CodexTokenBreakdown = {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
};

export type CodexThreadTokenUsage = {
  readonly threadId: string;
  readonly turnId: string;
  readonly total: CodexTokenBreakdown;
  readonly last: CodexTokenBreakdown;
  readonly modelContextWindow: number | null;
};

function record(value: unknown): Record<string, unknown> | null {
  return value !== null && typeof value === 'object' && !Array.isArray(value)
    ? Object.fromEntries(Object.entries(value)) : null;
}

function nonnegative(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0;
}

function breakdown(value: unknown): CodexTokenBreakdown | null {
  const data = record(value);
  if (!data || !nonnegative(data.totalTokens) || !nonnegative(data.inputTokens)
    || !nonnegative(data.cachedInputTokens) || !nonnegative(data.cacheWriteInputTokens)
    || !nonnegative(data.outputTokens) || !nonnegative(data.reasoningOutputTokens)) return null;
  return {
    totalTokens: data.totalTokens,
    inputTokens: data.inputTokens,
    cachedInputTokens: data.cachedInputTokens,
    cacheWriteInputTokens: data.cacheWriteInputTokens,
    outputTokens: data.outputTokens,
    reasoningOutputTokens: data.reasoningOutputTokens,
  };
}

export function parseCodexThreadTokenUsage(value: unknown, threadId: string): CodexThreadTokenUsage | null {
  const notification = record(value);
  if (!notification || notification.threadId !== threadId || typeof notification.turnId !== 'string') return null;
  const usage = record(notification.tokenUsage);
  if (!usage) return null;
  const total = breakdown(usage.total);
  const last = breakdown(usage.last);
  if (!total || !last) return null;
  const modelContextWindow = usage.modelContextWindow;
  if (modelContextWindow !== null && !nonnegative(modelContextWindow)) return null;
  return { threadId, turnId: notification.turnId, total, last, modelContextWindow };
}
