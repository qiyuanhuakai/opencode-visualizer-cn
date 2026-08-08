export type DaemonPaths = {
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly logPath: string;
};

export function createDaemonPaths(env?: NodeJS.ProcessEnv): DaemonPaths;
export function isProcessAlive(pid: number): boolean;
