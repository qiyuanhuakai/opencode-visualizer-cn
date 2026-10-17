import type { WorkspaceRef, RepoRef, RepoKey } from '../../shared/runtime/identity.js';
import type { TargetGitCommand } from './targetGitCommand.js';
import type { GitWorktree } from './gitOutputParser.js';
export type Repository = {
  readonly kind: 'git';
  readonly workspace: WorkspaceRef;
  readonly repo: RepoRef;
  readonly repoKey: RepoKey;
};
export type NonGit = { readonly kind: 'non-git'; readonly workspace: WorkspaceRef };
export type GitProbe =
  | NonGit
  | (Repository & {
      readonly worktrees: readonly GitWorktree[];
      readonly branch: string | null;
      readonly dirty: boolean;
      readonly bare: boolean;
    });
export interface GitService {
  repository(workspace: WorkspaceRef): Promise<Repository | NonGit>;
  probe(workspace: WorkspaceRef): Promise<GitProbe>;
  checked(workspace: WorkspaceRef, args: readonly string[]): Promise<string>;
  invalidate(repoKey: RepoKey): void;
  diff(workspace: WorkspaceRef): Promise<string>;
}
export function createGitService(options: {
  readonly command: TargetGitCommand;
  readonly now?: () => number;
}): GitService;
