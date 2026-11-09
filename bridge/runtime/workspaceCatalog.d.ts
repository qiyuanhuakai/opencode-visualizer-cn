import type { WorkspaceRef, WorkspaceKey } from '../../shared/runtime/identity.js';
import type { RuntimeStore, Page } from './storage/runtimeStore.js';
import type { GitService, GitProbe } from './gitService.js';
export type WorkspaceRegistration = {
  readonly workspace: WorkspaceRef;
  readonly harnessInstanceId: string;
  readonly harness: 'opencode' | 'codex' | 'kimi' | 'dsh' | 'acp';
  readonly orphan?: boolean;
};
export interface WorkspaceCatalog {
  register(input: WorkspaceRegistration): Promise<WorkspaceKey>;
  registerMany(inputs: readonly WorkspaceRegistration[]): Promise<readonly WorkspaceKey[]>;
  page(options?: { readonly cursor?: string | null; readonly limit?: number }): Promise<Page>;
  probe(
    key: WorkspaceKey,
    visibility?: { readonly selected?: boolean; readonly visible?: boolean },
  ): Promise<GitProbe>;
}
export function createWorkspaceCatalog(options: {
  readonly store: RuntimeStore;
  readonly git: Pick<GitService, 'probe'>;
}): WorkspaceCatalog;
