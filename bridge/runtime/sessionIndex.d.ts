import type { HarnessRegistry, HarnessRegistration } from '../../shared/runtime/harnessContract.js';
import type { WorkspaceRef } from '../../shared/runtime/identity.js';
import type { RuntimeStore, Page, PageOptions } from './storage/runtimeStore.js';
import type { WorkspaceCatalog } from './workspaceCatalog.js';
import type { SourceIdentity, SourceAuthority } from './sessionSummaries.js';
import type { DiscoveryRequest, DiscoveryResult } from './indexDiscovery.js';
import type { DiscoveryScheduler } from './discoveryScheduler.js';
import type { NativeEventIntake } from './nativeEventIntake.js';
import type { RuntimeEventBus } from './eventBus.js';
import type { RuntimeSnapshots } from './snapshots.js';
export interface IndexedSource {
  readonly identity: SourceIdentity;
  publish: NativeEventIntake['publish'];
  flush: NativeEventIntake['flush'];
  discover(request?: DiscoveryRequest): Promise<DiscoveryResult>;
  close(): Promise<void>;
  readonly state: { readonly serial: number; readonly intake: NativeEventIntake['state'] };
}
export interface SessionIndex {
  attach(input: { readonly harnessInstanceId: string; readonly authority: () => SourceAuthority; readonly subscribe?: boolean }): Promise<IndexedSource>;
  createDshSource<T extends HarnessRegistration & { close(): Promise<unknown> }>(input: { readonly create: (options: { readonly onEvent: (event: unknown) => void }) => T | Promise<T>; readonly authority: () => SourceAuthority }): Promise<{ readonly source: IndexedSource; readonly native: T }>;
  topology(input?: { readonly collection?: 'harnesses' | 'workspaces'; readonly cursor?: string | null; readonly limit?: number }): Promise<Page>;
  page(input?: Omit<PageOptions, 'collection'>): Promise<Page>;
  probeWorkspace: WorkspaceCatalog['probe'];
  readonly snapshots: RuntimeSnapshots;
  readonly events: RuntimeEventBus;
  close(): Promise<void>;
  readonly state: { readonly sources: number; readonly discovery: number; readonly scheduler: DiscoveryScheduler['state']; readonly events: RuntimeEventBus['state']; readonly closed: boolean };
}
export function createSessionIndex(options: { readonly store: RuntimeStore; readonly registry: HarnessRegistry; readonly catalog: WorkspaceCatalog; readonly resolveWorkspace: (input: { readonly source: SourceIdentity; readonly directory: string }) => Promise<WorkspaceRef> }): SessionIndex;
