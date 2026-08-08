import type { ChildProcessWithoutNullStreams } from 'node:child_process';

export type WorkspaceCommandResult = {
  stdout: string;
  stderr: string;
  exitCode: number;
};

export type WorkspaceCommandRunner = {
  run(payload: unknown): Promise<WorkspaceCommandResult>;
  close(): Promise<void>;
};

export function createWorkspaceCommandRunner(options?: {
  spawnProcess?: (command: string, args: string[], options: object) => ChildProcessWithoutNullStreams;
  outputLimit?: number;
}): WorkspaceCommandRunner;

export function runWorkspaceCommand(
  payload: unknown,
  options?: Parameters<typeof createWorkspaceCommandRunner>[0],
): Promise<WorkspaceCommandResult>;
