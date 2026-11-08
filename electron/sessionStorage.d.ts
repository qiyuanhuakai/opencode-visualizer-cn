import type { PersistentStorageChange } from './persistentStorage.js';
export type HistoryPageRequest = Readonly<{ threadId: string; namespace?: string; cursor?: string | null; limit?: number }>;
export type HistoryPage = Readonly<{ entries: unknown[]; nextCursor: string | null }>;
export interface SessionStorage {
  prepare(): Promise<void>;
  getItem(key: string): string | null | Promise<string | null>;
  setItem(key: string, value: string): Promise<string | null>;
  setItemAsync(key: string, value: string | null): Promise<string | null>;
  removeItem(key: string): Promise<string | null>;
  migrate(entries: Readonly<Record<string, string>>): Promise<readonly PersistentStorageChange[]>;
  drainPendingChanges(): readonly PersistentStorageChange[];
  readHistory(payload: HistoryPageRequest): Promise<HistoryPage>;
  upsertHistory(payload: Readonly<{ threadId: string; namespace?: string; entries: readonly unknown[] }>): Promise<void>;
  clearHistory(payload: Readonly<{ threadId: string; namespace?: string }>): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
}
export function createSessionStorage(filePath: string): SessionStorage;

export interface LegacyExportStorage {
  exportBinding(request: Readonly<{ sourceKey: string }>): Promise<import('../app/runtime/migration/legacyBinding').LocalBindingHint>;
  exportOpen(): Promise<import('../shared/runtime/migration/legacyExport.js').LegacyExportToken>;
  exportPage(request: import('../shared/runtime/migration/legacyExport.js').LegacyPageRequest): Promise<import('../shared/runtime/migration/legacyExport.js').LegacyExportPage>;
  close(): Promise<void>;
}
export function createLegacyExportStorage(filePath: string): LegacyExportStorage;
