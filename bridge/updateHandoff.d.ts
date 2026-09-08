import type { ChildProcess } from 'node:child_process';

export type UpdateHelperProcess = Pick<ChildProcess, 'kill' | 'off' | 'once' | 'pid' | 'unref'>;

export interface InstallerHandoffRequest {
  readonly assetPath: string;
  readonly linuxFormat: 'deb' | 'rpm' | null;
  readonly nonInteractiveYes: boolean;
  readonly onAccepted?: (resultLogPath?: string) => void;
}

export declare function createPosixUpdateHelper(platform: string, linuxFormat: 'deb' | 'rpm' | null): string;
export declare function createWindowsUpdateHelper(): string;
export declare function createWindowsUpdateBootstrap(options: {
  readonly powershellPath: string;
  readonly helperPath: string;
  readonly parentPid: number;
  readonly ackPath: string;
  readonly installerPath: string;
  readonly stagingDirectory: string;
}): string;
export declare function waitForAck(
  ackPath: string,
  child: UpdateHelperProcess,
  options?: {
    readonly timeoutMs?: number;
    readonly pollIntervalMs?: number;
    readonly readAck?: (path: string, encoding: BufferEncoding) => Promise<string>;
    readonly schedule?: (callback: () => void, delay: number) => NodeJS.Timeout;
    readonly clearSchedule?: (handle: NodeJS.Timeout) => void;
  },
): Promise<string>;
export declare function handoffPosixInstaller(options: InstallerHandoffRequest & {
  readonly platform: string;
  readonly uid: number | null;
  readonly execve: ((file: string, args: string[], env: NodeJS.ProcessEnv) => void) | null;
  readonly writeHelper: (assetPath: string, contents: string) => Promise<string>;
}): Promise<void>;
export declare function handoffWindowsInstaller(options: {
  readonly assetPath: string;
  readonly parentPid: number;
  readonly powershellPath: string;
  readonly spawnProcess: (
    command: string,
    args: readonly string[],
    options: import('node:child_process').SpawnOptions,
  ) => UpdateHelperProcess;
  readonly waitForAck: (ackPath: string, child: UpdateHelperProcess) => Promise<string>;
  readonly writeHelper: (
    assetPath: string,
    contents: string,
  ) => Promise<{ readonly helperPath: string; readonly ackPath: string }>;
  readonly onAccepted?: (resultLogPath: string) => void;
}): Promise<void>;
export declare function handoffBridgeInstaller(options: InstallerHandoffRequest & Record<string, unknown>): Promise<void>;
export declare function createInstallerHandoff(options?: {
  readonly platform?: string;
}): (request: InstallerHandoffRequest) => Promise<void>;
