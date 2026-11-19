export type RuntimeSidecarLayout = {
  readonly installRoot: string;
  readonly runtimeDirectory: string;
  readonly workerPath: string;
  readonly sidecarPath: string;
};

export type RuntimeSidecarStagingOptions = {
  readonly platform?: NodeJS.Platform;
  readonly sidecarSource?: string;
};

export type RuntimeSidecarStagingResult = RuntimeSidecarLayout & {
  readonly platform: NodeJS.Platform;
  readonly sidecarSource: string;
  readonly stagedFiles: readonly string[];
};

export function createRuntimeSidecarLayout(
  stageRoot: string,
  platform?: NodeJS.Platform,
): RuntimeSidecarLayout;
export function computeRuntimeWorkerClosure(rootDirectory: string): Promise<string[]>;
export function stageRuntimeWorkerSidecar(
  rootDirectory: string,
  stageRoot: string,
  options?: RuntimeSidecarStagingOptions,
): Promise<RuntimeSidecarStagingResult>;
