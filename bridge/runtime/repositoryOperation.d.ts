import type { WorkspaceRef, WorkspaceKey, RepoKey } from '../../shared/runtime/identity.js';
import type { RuntimeStore, Json } from './storage/runtimeStore.js';
import type { WorktreeLease } from './worktreeLease.js';
export interface RepositoryOperation {
  readonly kind: 'repository-operation';
  readonly operationId: string;
  readonly repoKey: RepoKey;
  readonly workspace: WorkspaceRef;
  readonly workspaceKey: WorkspaceKey;
  readonly epoch: string;
  readonly method: string;
  readonly payload: Json;
  readonly baseCommit: string;
  readonly digest: string;
  readonly phase: 'accepted' | 'sent' | 'observed' | 'reconciling' | 'terminal';
  readonly outcome?: 'completed' | 'failed' | 'cancelled';
}
export interface RepositoryAcceptance {
  readonly phase: 'durable-accepted';
  readonly operationId: string;
}
export interface RepositoryJournal {
  readonly leases: WorktreeLease;
  accept(input: {
    readonly repoKey: RepoKey;
    readonly workspace: WorkspaceRef;
    readonly idempotencyKey: string;
    readonly method: string;
    readonly payload: Json;
    readonly baseCommit: string;
  }): Promise<RepositoryAcceptance>;
  launch<T>(id: string, send: (operation: RepositoryOperation) => Promise<T>): Promise<T>;
  observed(id: string): Promise<RepositoryOperation>;
  terminal(
    id: string,
    outcome: 'completed' | 'failed' | 'cancelled',
    retainWorkspace?: boolean,
  ): Promise<RepositoryOperation>;
  reconcile(id: string): Promise<RepositoryOperation>;
  get(id: string): Promise<RepositoryOperation>;
}
export function createRepositoryOperation(options: {
  readonly store: RuntimeStore;
  readonly assertCurrent: () => void;
}): RepositoryJournal;
