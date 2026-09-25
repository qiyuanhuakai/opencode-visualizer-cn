export type SessionHistoryPage = {
  readonly entries: readonly unknown[];
  readonly nextCursor: string | null;
};

export type SessionDatabaseApi = {
  readonly readHistory: (request: { readonly threadId: string; readonly cursor?: string; readonly limit?: number }) => Promise<SessionHistoryPage>;
  readonly upsertHistory: (request: { readonly threadId: string; readonly entries: readonly unknown[] }) => Promise<void>;
  readonly clearHistory: (request: { readonly threadId: string }) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly onHistoryChanged: (listener: (threadId: string) => void) => () => void;
};
