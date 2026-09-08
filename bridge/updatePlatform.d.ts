export interface ProcessAncestor {
  readonly pid: number;
  readonly executable: string;
}

export interface LinuxPackageProbeResult {
  readonly code: number;
  readonly stdout: string;
}

export declare function managedBridgePath(platform: string, env?: NodeJS.ProcessEnv): string;
export declare function assertManagedInstallation(
  execPath: string,
  platform: string,
  env?: NodeJS.ProcessEnv,
): string;
export declare function hasBridgeHostedAncestor(
  ancestors: readonly ProcessAncestor[],
  installedPath: string,
  platform: string,
): boolean;
export declare function assertBridgeInstallAllowed(options?: {
  readonly platform?: string;
  readonly execPath?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly pid?: number;
  readonly allowPrivilegedInspection?: boolean;
  readonly nonInteractiveYes?: boolean;
  readonly collectAncestors?: (
    pid: number,
    platform: string,
    env: NodeJS.ProcessEnv,
  ) => Promise<readonly ProcessAncestor[]>;
}): Promise<void>;
export declare function detectLinuxPackageFormat(options?: {
  readonly requireOwnership?: boolean;
}): Promise<'deb' | 'rpm'>;
export declare function selectLinuxPackageFormat(options: {
  readonly osRelease: string;
  readonly installedPath: string;
  readonly requireOwnership: boolean;
  readonly toolExists: (tool: string) => boolean;
  readonly probe: (command: string, args: readonly string[]) => Promise<LinuxPackageProbeResult>;
}): Promise<'deb' | 'rpm'>;
export declare function collectProcessAncestors(
  pid: number,
  platform: string,
  env?: NodeJS.ProcessEnv,
): Promise<readonly ProcessAncestor[]>;
export declare function collectLinuxAncestors(
  pid: number,
  options?: {
    readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
    readonly readlink?: (path: string) => Promise<string>;
    readonly privilegedReadlink?: (pid: number) => Promise<string>;
  },
): Promise<readonly ProcessAncestor[]>;
export declare function privilegedLinuxReadlinkCommand(
  pid: number,
  nonInteractiveYes: boolean,
): { readonly command: '/usr/bin/sudo'; readonly args: readonly string[] };
export declare function readLinuxExecutableWithSudo(
  pid: number,
  options?: {
    readonly nonInteractiveYes?: boolean;
    readonly probe?: (
      command: string,
      args: readonly string[],
    ) => Promise<LinuxPackageProbeResult>;
  },
): Promise<string>;
export declare function collectDarwinAncestors(
  pid: number,
  runtime?: {
    readonly probe: (command: string, args: readonly string[]) => Promise<LinuxPackageProbeResult>;
    readonly isAlive: (pid: number) => boolean;
  },
): Promise<readonly ProcessAncestor[]>;
export declare function collectWindowsAncestors(
  pid: number,
  env: NodeJS.ProcessEnv,
  runtime?: {
    readonly probe: (command: string, args: readonly string[]) => Promise<LinuxPackageProbeResult>;
    readonly isAlive: (pid: number) => boolean;
  },
): Promise<readonly ProcessAncestor[]>;
