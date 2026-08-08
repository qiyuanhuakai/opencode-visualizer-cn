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
