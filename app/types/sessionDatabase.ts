export type SessionHistoryPage = {
  readonly entries: readonly unknown[];
  readonly nextCursor: string | null;
};

export type SessionDatabaseApi = {
  readonly exportBinding?: (request: Readonly<{ sourceKey: string }>) => Promise<import('../runtime/migration/legacyBinding').LocalBindingHint>;
  readonly exportOpen?: () => Promise<import('../../shared/runtime/migration/legacyExport.js').LegacyExportToken>;
  readonly exportPage?: (request: import('../../shared/runtime/migration/legacyExport.js').LegacyPageRequest) => Promise<import('../../shared/runtime/migration/legacyExport.js').LegacyExportPage>;
  readonly readHistory: (request: { readonly threadId: string; readonly namespace?: string; readonly cursor?: string; readonly limit?: number }) => Promise<SessionHistoryPage>;
  readonly upsertHistory: (request: { readonly threadId: string; readonly namespace?: string; readonly entries: readonly unknown[] }) => Promise<void>;
  readonly clearHistory: (request: { readonly threadId: string; readonly namespace?: string }) => Promise<void>;
  readonly flush: () => Promise<void>;
  readonly onHistoryChanged: (listener: (threadId: string) => void) => () => void;
};
