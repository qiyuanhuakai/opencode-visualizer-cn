export type SeaBuildPaths = {
  outputDirectory: string;
  bundlePath: string;
  blobPath: string;
  configPath: string;
  binaryPath: string;
};

export function createSeaBuildPaths(rootDirectory: string, platform?: NodeJS.Platform): SeaBuildPaths;
export function createSeaConfig(paths: SeaBuildPaths): {
  main: string;
  output: string;
  disableExperimentalSEAWarning: true;
  useSnapshot: false;
  useCodeCache: false;
};
export function buildVisBridgeBinary(rootDirectory: string): Promise<string>;
export function getBinaryPreparationCommands(platform: NodeJS.Platform, binaryPath: string): Array<{
  command: string;
  args: string[];
}>;
