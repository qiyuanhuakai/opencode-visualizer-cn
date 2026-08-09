export function assertRequiredDaemonCredentials(
  requiredSecrets: readonly string[] | undefined,
  credentials?: {
    readonly bridgeToken?: string;
    readonly upstreamAuthorization?: string;
  },
  requestedArgs?: readonly string[],
): void;

export function assertSafeDaemonTarget(target: string): void;
export function assertSafeDaemonLaunchArgs(serverArgs: readonly string[]): void;
export function mergeDaemonRestartArgs(
  previousArgs: readonly string[],
  requestedArgs: readonly string[],
  requiredSecrets?: readonly string[],
): string[];

export function prepareDaemonLaunch(
  serverArgs: readonly string[],
  credentials?: {
    readonly bridgeToken?: string;
    readonly upstreamAuthorization?: string;
  },
): {
  readonly launchArgs: string[];
  readonly requiredSecrets: string[];
  readonly secrets: Record<string, string>;
};

export function fingerprintDaemonCredentials(
  controlToken: string,
  credentials?: {
    readonly bridgeToken?: string;
    readonly upstreamAuthorization?: string;
  },
): string;
