import type { OpenCodeSummary, DiscoveryScope } from '../../../shared/runtime/native/opencode/protocol.js';
export interface StoreProvenance { readonly nativeVersion: string; readonly readOnly: true; readonly summaryOnly: true; readonly schemaVersion: number }
export interface NativeSummaryPage { readonly items: readonly OpenCodeSummary[]; readonly cursor: string | null; readonly completeness: 'complete' | 'partial'; readonly reason: string; readonly provenance: StoreProvenance }
export interface OpenCodeStoreReader {
  readonly ready: Promise<StoreProvenance>;
  page(params?: { readonly cursor?: string | null; readonly limit?: number; readonly scope?: DiscoveryScope }): Promise<NativeSummaryPage>;
  close(): Promise<void>;
}
export function createOpenCodeStoreReader(options: { readonly databasePath: string; readonly nativeVersion: string; readonly timeoutMs?: number }): OpenCodeStoreReader;
