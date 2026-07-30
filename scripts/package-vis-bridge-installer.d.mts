export type VisBridgeInstallerTarget = {
  readonly version: string;
  readonly platform: NodeJS.Platform;
  readonly arch: NodeJS.Architecture;
};

export type VisBridgeInstallerPaths = {
  readonly binaryPath: string;
  readonly installerDirectory: string;
  readonly installerPath: string;
  readonly workspacePath: string;
};

export class VisBridgeInstallerTargetError extends Error {}

export function createVisBridgeInstallerAssetName(target: VisBridgeInstallerTarget): string;
export function createVisBridgeInstallerPaths(
  rootDirectory: string,
  target: VisBridgeInstallerTarget,
): VisBridgeInstallerPaths;
export function packageVisBridgeInstaller(
  rootDirectory: string,
  target: VisBridgeInstallerTarget,
): Promise<string>;
