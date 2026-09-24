import { describe, expect, it } from 'vitest';
import { parseCodexThreadTokenUsage } from './tokenUsage';

describe('Codex thread token usage', () => {
  it('reads the App Server notification for the selected thread', () => {
    const result = parseCodexThreadTokenUsage({
      threadId: 'thread-1', turnId: 'turn-2', tokenUsage: {
        total: { totalTokens: 1800, inputTokens: 1200, cachedInputTokens: 400, cacheWriteInputTokens: 50, outputTokens: 600, reasoningOutputTokens: 100 },
        last: { totalTokens: 300, inputTokens: 240, cachedInputTokens: 80, cacheWriteInputTokens: 10, outputTokens: 60, reasoningOutputTokens: 20 },
        modelContextWindow: 128000,
      },
    }, 'thread-1');
    expect(result?.total.totalTokens).toBe(1800);
    expect(result?.last.inputTokens).toBe(240);
    expect(result?.modelContextWindow).toBe(128000);
  });

  it('ignores another thread and malformed usage', () => {
    const notification = { threadId: 'other', tokenUsage: { total: {}, last: {}, modelContextWindow: 128000 } };
    expect(parseCodexThreadTokenUsage(notification, 'thread-1')).toBeNull();
    expect(parseCodexThreadTokenUsage({ ...notification, threadId: 'thread-1' }, 'thread-1')).toBeNull();
  });
});
