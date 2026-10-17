import type { RuntimeStore } from './storage/runtimeStore.js';
import type { DiscoveryPriority, DiscoveryScheduler } from './discoveryScheduler.js';
import type { SourceIdentity, SourceAuthority, DiscoveryScope } from './sessionSummaries.js';
import type { IndexMutations } from './indexMutations.js';
export interface DiscoverySource {
  readonly identity: SourceIdentity;
  authority(): SourceAuthority;
  serial(): number;
  assertCurrent(): void;
  list(params: Readonly<Record<string, unknown>>): Promise<unknown>;
}
export interface DiscoveryRequest { readonly scope?: DiscoveryScope; readonly priority?: DiscoveryPriority; readonly interactive?: boolean }
export interface DiscoveryResult { readonly status: 'complete' | 'partial' | 'unsupported'; readonly count: number; readonly reason: string; readonly authority: SourceAuthority }
export interface IndexDiscovery {
  discover(source: DiscoverySource, request?: DiscoveryRequest): Promise<DiscoveryResult>;
  readonly active: number;
}
export function createIndexDiscovery(options: { readonly store: RuntimeStore; readonly scheduler: DiscoveryScheduler; readonly mutations: IndexMutations }): IndexDiscovery;
