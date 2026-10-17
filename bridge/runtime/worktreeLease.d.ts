import type { RepoKey, WorkspaceKey } from '../../shared/runtime/identity.js';
import type { RuntimeStore, Change, Item } from './storage/runtimeStore.js';
export type GitResource = RepoKey | WorkspaceKey;
export function leaseKey(resource: GitResource): string;
export interface WorktreeLease {
  read(resource: GitResource): Promise<Item | null>;
  claimChanges(
    resources: readonly GitResource[],
    owner: string,
    baseCommit?: string | null,
  ): Promise<readonly Change[]>;
  acquire(resource: GitResource, owner: string, baseCommit: string): Promise<void>;
  release(resource: GitResource, owner: string): Promise<void>;
}
export function createWorktreeLease(options: { readonly store: RuntimeStore }): WorktreeLease;
