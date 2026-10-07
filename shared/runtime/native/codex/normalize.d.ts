export interface CanonicalEntry {
  readonly info: {
    readonly id: string;
    readonly sessionID: string;
    readonly role: 'user' | 'assistant';
    readonly parentID?: string;
    readonly [key: string]: unknown;
  };
  readonly parts: readonly {
    readonly id: string;
    readonly messageID: string;
    readonly type: string;
    readonly [key: string]: unknown;
  }[];
}
export interface HistoryInput {
  readonly sessionId: string;
  readonly turns: readonly {
    readonly id?: unknown;
    readonly items?: unknown;
    readonly createdAt?: unknown;
    readonly startedAt?: unknown;
    readonly completedAt?: unknown;
    readonly status?: unknown;
  }[];
  readonly createdAt?: number;
  readonly model?: { readonly providerID?: string; readonly modelID?: string };
  readonly parentMessageId?: string;
}
export interface TokenBreakdown {
  readonly totalTokens: number;
  readonly inputTokens: number;
  readonly cachedInputTokens: number;
  readonly cacheWriteInputTokens: number;
  readonly outputTokens: number;
  readonly reasoningOutputTokens: number;
}
export function normalizeCodexTurnsToHistory(params: HistoryInput): readonly CanonicalEntry[];
export function parseCodexThreadTokenUsage(
  value: unknown,
  threadId: string,
): null | {
  readonly threadId: string;
  readonly turnId: string;
  readonly total: TokenBreakdown;
  readonly last: TokenBreakdown;
  readonly modelContextWindow: number | null;
};
