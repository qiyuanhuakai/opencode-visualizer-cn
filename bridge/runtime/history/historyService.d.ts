import type { AuxiliaryEntry } from './auxiliaryMerge.js';

export type AuxiliaryHistoryLimits = Readonly<{
  pages: number;
  residentBytes: number;
  entryInlineBytes: number;
  chunkBytes: number;
  recordsPerPage: number;
  dirtyMaxCount: number;
  dirtyMaxBytes: number;
}>;
export type AuxiliaryOversizedRef = Readonly<{ entryId: string; descriptorId: string; totalBytes: number }>;
export type AuxiliaryHistoryPage = Readonly<{
  pageId: string;
  cursor: string | null;
  nextCursor: string | null;
  entries: readonly AuxiliaryEntry[];
  bytes: number;
  oversized: readonly AuxiliaryOversizedRef[];
}>;
export type AuxiliaryHistoryUsage = Readonly<{
  residentBytes: number;
  pageCount: number;
  evicted: number;
  rereads: number;
  dirtyCount: number;
  dirtyBytes: number;
  retainedBytes: number;
  bufferedHistory: boolean;
}>;
export type AuxiliaryHistoryService = Readonly<{
  page(cursor: string | null): Promise<AuxiliaryHistoryPage>;
  get(pageId: string): AuxiliaryHistoryPage | null;
  evict(pageId: string): { pageId: string; freedBytes: number; evicted: boolean };
  reread(cursor: string | null): Promise<AuxiliaryHistoryPage>;
  chunk(pageId: string, descriptorId: string, offset: number): Promise<{ bytes: number; nextOffset: number | null }>;
  legacyExport(): Promise<readonly AuxiliaryEntry[]>;
  mergeWithCanonical(canonical: readonly AuxiliaryEntry[], page: AuxiliaryHistoryPage | null): readonly AuxiliaryEntry[];
  stage(entries: readonly AuxiliaryEntry[], generation?: number): void;
  commit(): Promise<{ committed: number; bytes: number }>;
  usage(): AuxiliaryHistoryUsage;
  dispose(): void;
}>;
export declare const AUXILIARY_HISTORY_LIMITS: AuxiliaryHistoryLimits;
export declare function createAuxiliaryHistoryService(options: Readonly<{
  reader: (cursor: string | null) => Promise<{ entries: readonly unknown[]; nextCursor: string | null }>;
  persister?: (entries: readonly AuxiliaryEntry[]) => Promise<void>;
  limits?: Partial<AuxiliaryHistoryLimits>;
}>): AuxiliaryHistoryService;
