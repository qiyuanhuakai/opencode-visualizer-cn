import type { SessionRef, WorkspaceRef } from '../../shared/runtime/identity.js';
import type { RuntimeStore } from './storage/runtimeStore.js';
import type { WorkspaceCatalog } from './workspaceCatalog.js';
import type { SourceIdentity, SourceAuthority, SessionSummary, DiscoveryScope } from './sessionSummaries.js';
export interface DiscoveryScan {
  readonly id: string;
  readonly source: SourceIdentity;
  readonly scope: DiscoveryScope;
  readonly authority: SourceAuthority;
  readonly startRevision: number;
  assertCurrent(): void;
}
export interface IndexMutations {
  apply(scan: DiscoveryScan, items: readonly SessionSummary[]): Promise<number>;
  complete(scan: DiscoveryScan, proof: { readonly completeness: 'complete'; readonly cursor: null; readonly stable: true }): Promise<{ readonly count: number; readonly deleted: number }>;
  event(input: { readonly source: SourceIdentity; readonly authority: SourceAuthority; assertCurrent(): void } & ({ readonly deleted: true; readonly session: SessionRef } | { readonly deleted: false; readonly summary: SessionSummary })): Promise<boolean>;
  progress(source: SourceIdentity, scope: DiscoveryScope, progress: { readonly status: string; readonly count: number; readonly reason: string; readonly authority: SourceAuthority }, assertCurrent: () => void): Promise<void>;
}
export function createIndexMutations(options: {
  readonly store: RuntimeStore;
  readonly catalog: WorkspaceCatalog;
  readonly resolveWorkspace: (input: { readonly source: SourceIdentity; readonly directory: string }) => Promise<WorkspaceRef>;
  readonly onCommit?: () => void;
}): IndexMutations;
