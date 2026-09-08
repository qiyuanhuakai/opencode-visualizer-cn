export interface LinuxAncestryProbeResult {
  readonly code: number;
  readonly stdout: string;
}

export interface LinuxAncestor {
  readonly pid: number;
  readonly executable: string;
}

export declare function collectLinuxAncestors(
  pid: number,
  options?: {
    readonly readFile?: (path: string, encoding: BufferEncoding) => Promise<string>;
    readonly readlink?: (path: string) => Promise<string>;
    readonly privilegedReadlink?: (pid: number) => Promise<string>;
  },
): Promise<readonly LinuxAncestor[]>;
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
    ) => Promise<LinuxAncestryProbeResult>;
  },
): Promise<string>;
