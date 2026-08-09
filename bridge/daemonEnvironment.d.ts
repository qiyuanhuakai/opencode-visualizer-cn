export function createDaemonEnvironment(
  environment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
): NodeJS.ProcessEnv;

export function createDaemonSpawnOptions(
  environment: NodeJS.ProcessEnv,
  overrides: NodeJS.ProcessEnv,
  logFileDescriptor: number,
): object;
