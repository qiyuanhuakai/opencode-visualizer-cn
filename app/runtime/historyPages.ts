import {
  AUXILIARY_HISTORY_LIMITS,
  createAuxiliaryHistoryService,
} from '../../bridge/runtime/history/historyService.js';
import type {
  AuxiliaryHistoryLimits,
  AuxiliaryHistoryPage,
  AuxiliaryHistoryService,
  AuxiliaryHistoryUsage,
} from '../../bridge/runtime/history/historyService.js';
import type { AuxiliaryEntry } from '../../bridge/runtime/history/auxiliaryMerge.js';

export type { AuxiliaryEntry, AuxiliaryHistoryPage, AuxiliaryHistoryUsage };

/**
 * Task 36 — the app-side bounded auxiliary-history page cache.
 *
 * The new paged namespace for auxiliary history reads. Reads go through the bridge bounded paging
 * service (≤ 3 pages / ≤ 16 MiB resident, LRU evict + re-read, oversized-entry chunking, terminal
 * -guarded canonical merge) and writes go through a bounded dirty set that retains recovery state on
 * a failed durable ack without ever buffering the whole transcript. The read-only legacy export
 * remains the single explicit path that materialises the full history.
 *
 * This module is the client/renderer seam: it holds no node builtins, so it bundles for the browser
 * exactly as the bridge paging engine does.
 */
export const BACKEND_AUXILIARY_PAGED_NAMESPACE = 'auxiliary-history-paged-v1';

export type HistoryPageCacheOptions = Readonly<{
  read: (cursor: string | null) => Promise<{ entries: readonly unknown[]; nextCursor: string | null }>;
  persist?: (entries: readonly AuxiliaryEntry[]) => Promise<void>;
  namespace?: string;
  limits?: Partial<AuxiliaryHistoryLimits>;
}>;

export type HistoryPageCache = Readonly<{
  namespace: string;
  limits: AuxiliaryHistoryLimits;
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

export function createHistoryPageCache(options: HistoryPageCacheOptions): HistoryPageCache {
  const namespace = options.namespace ?? BACKEND_AUXILIARY_PAGED_NAMESPACE;
  const limits: AuxiliaryHistoryLimits = { ...AUXILIARY_HISTORY_LIMITS, ...options.limits };
  const service: AuxiliaryHistoryService = createAuxiliaryHistoryService({
    reader: options.read,
    ...(options.persist ? { persister: options.persist } : {}),
    limits,
  });
  return {
    namespace,
    limits,
    page: (cursor) => service.page(cursor),
    get: (pageId) => service.get(pageId),
    evict: (pageId) => service.evict(pageId),
    reread: (cursor) => service.reread(cursor),
    chunk: (pageId, descriptorId, offset) => service.chunk(pageId, descriptorId, offset),
    legacyExport: () => service.legacyExport(),
    mergeWithCanonical: (canonical, page) => service.mergeWithCanonical(canonical, page),
    stage: (entries, generation) => service.stage(entries, generation),
    commit: () => service.commit(),
    usage: () => service.usage(),
    dispose: () => service.dispose(),
  };
}
