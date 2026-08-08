export function assertRequiredDaemonCredentials(
  requiredSecrets: readonly string[] | undefined,
  credentials?: {
    readonly bridgeToken?: string;
    readonly upstreamAuthorization?: string;
  },
): void;

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
