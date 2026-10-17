import type { OpenCodeStoreReader, StoreProvenance } from './openCodeStoreReader.mjs';
import type { OpenCodeSummary, DiscoveryScope } from '../../../shared/runtime/native/opencode/protocol.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
export interface DiscoveryGeneration { readonly epoch: string; readonly processGeneration: number; readonly seq: number }
export interface DiscoveryEvent extends DiscoveryGeneration { readonly type: string; readonly session?: SessionRef; readonly summary?: OpenCodeSummary }
export interface OpenCodePage extends DiscoveryGeneration {
  readonly items: readonly { readonly summary: OpenCodeSummary; readonly revision: number }[];
  readonly cursor: string | null; readonly completeness: 'complete' | 'partial' | 'unsupported'; readonly reason: string;
  readonly retryable: boolean; readonly provenance?: StoreProvenance;
}
export interface OpenCodeDiscovery {
  listSessionPage(params?: { readonly cursor?: string | null; readonly limit?: number; readonly scope?: DiscoveryScope }): Promise<OpenCodePage>;
  event(event: DiscoveryEvent): void; invalidate(reason: string): void; retry(): void; close(): void;
}
export function createOpenCodeDiscovery(options: {
  readonly reader?: OpenCodeStoreReader;
  readonly request: (route: string, options: { readonly query: Readonly<Record<string, string | number>> }) => Promise<unknown>;
  readonly current: () => DiscoveryGeneration; readonly assertCurrent: () => void | Promise<void>;
}): OpenCodeDiscovery;
