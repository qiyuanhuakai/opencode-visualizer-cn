export type WorkspaceCommandChild = {
  readonly pid?: number;
  readonly exitCode?: number | null;
  readonly stdout: { on(event: 'data', listener: (chunk: unknown) => void): unknown };
  readonly stderr: { on(event: 'data', listener: (chunk: unknown) => void): unknown };
  kill(signal: NodeJS.Signals): boolean;
  once(event: 'error', listener: (error: Error) => void): unknown;
  once(event: 'close', listener: (exitCode: number | null) => void): unknown;
  off(event: 'exit' | 'close', listener: () => void): unknown;
};

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
  spawnProcess?: (command: string, args: string[], options: object) => WorkspaceCommandChild;
  stopProcessTree?: (child: WorkspaceCommandChild) => Promise<void>;
  outputLimit?: number;
}): WorkspaceCommandRunner;

export function runWorkspaceCommand(
  payload: unknown,
  options?: Parameters<typeof createWorkspaceCommandRunner>[0],
): Promise<WorkspaceCommandResult>;
