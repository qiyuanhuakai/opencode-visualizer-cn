import type { PluginInfo, PluginContribution, SessionInfo } from '../contracts/models';

export type PluginProbeContext = {
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  providerID?: string;
  signal?: AbortSignal;
};

export type PluginActivationContext = {
  session?: SessionInfo;
  providerID?: string;
  directory?: string;
  signal?: AbortSignal;
};

export type PluginHandle = {
  id: string;
  contributes: PluginContribution[];
  dispose(): Promise<void>;
};

export type PluginModule = {
  readonly id: string;
  readonly label: string;
  probe(context?: PluginProbeContext): Promise<PluginInfo>;
  supports(context: PluginActivationContext): boolean | Promise<boolean>;
  activate(context: PluginActivationContext): Promise<PluginHandle>;
};
