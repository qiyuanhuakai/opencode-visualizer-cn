import type { WorkspaceRef } from '../../shared/runtime/identity.js';
import type { RuntimeStore } from './storage/runtimeStore.js';
import type { TargetGitCommand } from './targetGitCommand.js';
import type { GitService } from './gitService.js';
import type {
  RepositoryJournal,
  RepositoryAcceptance,
  RepositoryOperation,
} from './repositoryOperation.js';
import type { WorktreeLease } from './worktreeLease.js';
export interface WorktreeService {
  readonly journal: RepositoryJournal;
  readonly leases: WorktreeLease;
  create(input: {
    readonly workspace: WorkspaceRef;
    readonly parent: WorkspaceRef;
    readonly name: string;
    readonly idempotencyKey: string;
  }): Promise<RepositoryAcceptance>;
  remove(input: {
    readonly workspace: WorkspaceRef;
    readonly worktree: WorkspaceRef;
    readonly idempotencyKey: string;
  }): Promise<RepositoryAcceptance>;
  wait(id: string): Promise<RepositoryOperation>;
  cancel(id: string): Promise<RepositoryOperation>;
  releaseWriter(workspace: WorkspaceRef, owner: string): Promise<void>;
  close(): Promise<void>;
}
export function createWorktreeService(options: {
  readonly command: TargetGitCommand;
  readonly git: GitService;
  readonly store: RuntimeStore;
  readonly assertCurrent: () => void;
}): WorktreeService;
