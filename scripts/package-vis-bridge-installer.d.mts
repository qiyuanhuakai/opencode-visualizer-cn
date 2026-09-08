export type VisBridgeInstallerTarget = {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
  readonly format?: 'deb' | 'rpm';
};

export type LinuxRpmSpecOptions = {
  readonly version: string;
  readonly architecture: 'x86_64' | 'aarch64';
  readonly payloadPath: string;
};

export type VisBridgeInstallerPaths = {
  readonly binaryPath: string;
  readonly installerDirectory: string;
  readonly installerPath: string;
  readonly workspacePath: string;
};

export class VisBridgeInstallerTargetError extends Error {}

export function createNsiPath(filePath: string): string;
export function createLinuxMaintainerScript(): string;
export function createLinuxRpmSpec(options: LinuxRpmSpecOptions): string;
export function createMacPreinstallScript(): string;
export function createWindowsStopScript(): string;
export function createWindowsInstallerScript(paths: VisBridgeInstallerPaths): string;
export function createVisBridgeInstallerAssetName(target: VisBridgeInstallerTarget): string;
export function createVisBridgeInstallerPaths(
  rootDirectory: string,
  target: VisBridgeInstallerTarget,
): VisBridgeInstallerPaths;
export function packageVisBridgeInstaller(
  rootDirectory: string,
  target: VisBridgeInstallerTarget,
): Promise<string>;
