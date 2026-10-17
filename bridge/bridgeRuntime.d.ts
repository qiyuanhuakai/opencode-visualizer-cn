import type { RuntimeHost } from './runtime/runtimeHost.js';
import type { RuntimeServices, RuntimeRoot } from './runtime/runtimeServices.js';
import type { RuntimeDriverFactory } from './runtime/runtimeDriverFactories.js';
import type { TargetGrant } from '../shared/runtime/runtimeWire.js';
import type { AcpClient, AcpProcessStatus, AcpProcessManager } from './acpProcessManager.js';
import type { AcpAgentConfig, BridgeConfig, BridgeConfigStore } from './bridgeConfig.js';
import type { ProcessStatus, ProcessSupervisor } from './processSupervisor.js';
import type { AcpClientMethodHandler } from './acpClientMethodHandler.js';

export type BridgeRuntimeStatus = {
  services: ProcessStatus[];
  acpAgents: AcpProcessStatus[];
};

export type DshAuthProvider = {
  getCookie(authority: string): Promise<string>;
  invalidate(authority: string): boolean;
};

export type BridgeRuntime = {
  getRuntimeHost?(): Promise<RuntimeHost>;
  start(): Promise<BridgeRuntimeStatus>;
  stop(): Promise<void>;
  getStatus(): BridgeRuntimeStatus;
  getConfig(): Promise<BridgeConfig>;
  getDshAuthProvider?(): DshAuthProvider | undefined;
  listAgents(): Promise<AcpProcessStatus[]>;
  upsertAgent(agent: AcpAgentConfig): Promise<AcpProcessStatus | undefined>;
  updateAgent(id: string, patch: Partial<AcpAgentConfig>): Promise<AcpProcessStatus | undefined>;
  removeAgent(id: string): Promise<boolean>;
  attachAgent(id: string, client: AcpClient): void;
};

export function createBridgeRuntime(options?: {
  environmentId?: string;
  stateRoot?: string;
  role?: 'local' | 'manager' | 'execution';
  localWorkspaceRoots?: readonly RuntimeRoot[];
  runtimeDriverFactories?: Readonly<Record<string, RuntimeDriverFactory>>;
  runtimeTargets?: readonly RuntimeServices[];
  runtimeGrants?: readonly TargetGrant[];
  configStore?: BridgeConfigStore;
  nativeSupervisor?: ProcessSupervisor;
  acpManager?: AcpProcessManager;
  clientMethodHandler?: AcpClientMethodHandler;
}): BridgeRuntime;
