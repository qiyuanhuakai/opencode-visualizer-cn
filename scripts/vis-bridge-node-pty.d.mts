export function stageNodePtyRuntime(
  rootDirectory: string,
  destination: string,
  platform: NodeJS.Platform,
  arch: 'x64' | 'arm64',
): Promise<void>;
