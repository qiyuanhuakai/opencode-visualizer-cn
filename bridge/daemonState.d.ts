export type DaemonPaths = {
  readonly stateDirectory: string;
  readonly statePath: string;
  readonly lockPath: string;
  readonly logPath: string;
};

export type DaemonStateInput = {
  readonly instanceId: string;
  readonly pid: number;
  readonly state: 'starting' | 'running' | 'error';
  readonly logPath: string;
  readonly launchArgs: readonly string[];
  readonly requiredSecrets?: readonly string[];
  readonly credentialFingerprint?: string;
  readonly startedAt?: string;
  readonly host?: string;
  readonly port?: number;
  readonly path?: string;
  readonly controlPort?: number;
  readonly controlToken?: string;
  readonly failures?: readonly {
    readonly name: string;
    readonly error: string;
    readonly kind?: string;
  }[];
  readonly error?: string;
};

export function createDaemonPaths(env?: NodeJS.ProcessEnv): DaemonPaths;
export function isProcessAlive(pid: number): boolean;
export function writeDaemonState(paths: DaemonPaths, state: DaemonStateInput): Promise<void>;
