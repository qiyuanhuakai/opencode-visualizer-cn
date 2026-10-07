import type { WorkspaceRef, WorkspaceKey, PathPolicy } from '../../shared/runtime/identity.js';
export interface GitResult {
  readonly stdout: string;
  readonly stderr: string;
  readonly exitCode: number | null;
  readonly signal: string | null;
}
export interface GitJob {
  readonly pid: number | undefined;
  readonly workspaceKey: WorkspaceKey;
  wait(): Promise<GitResult>;
  cancel(): Promise<void>;
}
export interface GitRequest {
  readonly workspace: WorkspaceRef;
  readonly args: readonly string[];
  readonly mutation?: boolean;
}
export interface TargetGitCommand {
  policyFor(canonicalPath: string): Promise<PathPolicy>;
  authorize(workspace: WorkspaceRef, permission?: 'command' | 'write'): Promise<WorkspaceRef>;
  destination(parent: WorkspaceRef, name: string): Promise<WorkspaceRef>;
  start(request: GitRequest): Promise<GitJob>;
  run(request: GitRequest): Promise<GitResult>;
  close(): Promise<void>;
}
export class GitCommandError extends Error {
  readonly code: 'source_unavailable';
  readonly reason: string;
  readonly result: Partial<GitResult>;
  constructor(reason: string, result?: Partial<GitResult>);
}
export function createTargetGitCommand(options: {
  readonly target: string;
  readonly roots: readonly {
    readonly root: string;
    readonly pathPolicy: PathPolicy;
    readonly permissions: readonly ('read' | 'write' | 'command')[];
  }[];
  readonly assertCurrent: () => void;
  readonly gitBinary?: string;
  readonly maxBytes?: number;
  readonly resolvePathPolicy?: (canonicalPath: string) => PathPolicy | Promise<PathPolicy>;
}): Promise<TargetGitCommand>;
