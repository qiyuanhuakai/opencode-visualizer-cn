export type DaemonStartupEntry = {
  readonly kind: string;
  readonly name: string;
  readonly state: string;
  readonly error?: string;
};

export type DaemonStartupFailure = {
  readonly kind: string;
  readonly name: string;
  readonly error: string;
};

export type DaemonRuntimeStatus = {
  readonly services: readonly DaemonStartupEntry[];
  readonly acpAgents: readonly DaemonStartupEntry[];
};

export type DaemonController = {
  start(serverArgs: readonly string[], credentials?: DaemonCredentials): Promise<unknown>;
  stop(): Promise<void>;
  restart(serverArgs: readonly string[], credentials?: DaemonCredentials): Promise<unknown>;
};

export type DaemonCredentials = {
  readonly bridgeToken?: string;
  readonly upstreamAuthorization?: string;
};

export function collectStartupFailures(status: DaemonRuntimeStatus): DaemonStartupFailure[];
export function createDaemonInvocation(options: {
  readonly entryPath: string | undefined;
  readonly execPath: string;
  readonly serverArgs: readonly string[];
  readonly isSea?: boolean;
}): { readonly command: string; readonly args: readonly string[] };
export function createDaemonController(options?: object): DaemonController;
