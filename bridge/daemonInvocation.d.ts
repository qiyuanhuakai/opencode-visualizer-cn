export function createDaemonInvocation(options: {
  readonly entryPath: string | undefined;
  readonly execPath: string;
  readonly serverArgs: readonly string[];
  readonly isSea?: boolean;
  readonly hostInstallPath?: string | null;
}): { readonly command: string; readonly args: readonly string[] };
