import type { RuntimeStore } from './storage/runtimeStore.js';
import type { RuntimeSnapshots } from './snapshots.js';
import type { RuntimeEventBus } from './eventBus.js';
import type { SessionIndex } from './sessionIndex.js';
import type { RuntimeAcceptance } from './runtimeAcceptance.js';
import type { HarnessRegistry } from '../../shared/runtime/harnessContract.js';
import type { Capabilities } from '../../shared/runtime/capabilities.js';
import type { RuntimeInspection as WireInspection, TargetGrant } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeHost, RuntimeInspection } from './runtimeHost.js';
import type { RuntimeWorkspace, RuntimeDriverFactory, NativeAuthority } from './runtimeDriverFactories.js';
import type { BridgeConfig } from '../bridgeConfig.js';
import type { ProcessSupervisor } from '../processSupervisor.js';
import type { AcpRuntimeProcessManager } from '../acpProcessManager.js';
import type { createWorkspaceService } from './workspaceService.js';
export type RuntimeRoot = Parameters<typeof createWorkspaceService>[0]['roots'][number];
export interface RuntimeServices {
  readonly target: string; readonly epoch: string; readonly instanceId: string; readonly role: TargetGrant['role']; readonly connectionProfileId: string;
  readonly workspace: RuntimeWorkspace; readonly store: RuntimeStore; readonly index: SessionIndex; readonly registry: HarnessRegistry;
  readonly acceptance: RuntimeAcceptance; readonly capabilities: Capabilities; readonly grant: TargetGrant;
  readonly snapshots: RuntimeSnapshots; readonly events: RuntimeEventBus;
  authority(harnessInstanceId: string): NativeAuthority;
  start(): Promise<void>;
  inspect(base: RuntimeInspection, targets: readonly TargetGrant[]): Promise<WireInspection>;
  close(): Promise<void>;
}
export function createRuntimeServices(options: {
  readonly environmentId: string; readonly stateRoot: string; readonly role: TargetGrant['role']; readonly roots: readonly RuntimeRoot[];
  readonly config: BridgeConfig; readonly nativeSupervisor: ProcessSupervisor; readonly acpManager: AcpRuntimeProcessManager;
  readonly runtime: Pick<RuntimeHost, 'mutate'>; readonly factories?: Readonly<Record<string, RuntimeDriverFactory>>;
  readonly permissions?: readonly string[];
}): Promise<RuntimeServices>;
