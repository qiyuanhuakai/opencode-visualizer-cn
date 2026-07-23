export type AcpAgentConfig = {
  id: string;
  name: string;
  command: string;
  args: string[];
  enabled: boolean;
  env?: Record<string, string>;
};

export type BridgeConfig = {
  version: 1;
  acpAgents: AcpAgentConfig[];
};

export type BridgeConfigStore = {
  configPath: string;
  load(): Promise<BridgeConfig>;
  save(config: BridgeConfig): Promise<BridgeConfig>;
  getConfig(): Promise<BridgeConfig>;
  upsertAgent(agent: AcpAgentConfig): Promise<BridgeConfig>;
  removeAgent(id: string): Promise<BridgeConfig>;
};

export function createDefaultBridgeConfig(): BridgeConfig;
export function parseBridgeConfig(input: unknown): BridgeConfig;
export function defaultBridgeConfigPath(env?: NodeJS.ProcessEnv): string;
export function createBridgeConfigStore(options?: { configPath?: string }): BridgeConfigStore;
