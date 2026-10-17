import type { HarnessKind, HarnessRegistry, HarnessRegistration, HarnessManifest } from '../../shared/runtime/harnessContract.js';
import type { RuntimeStore } from './storage/runtimeStore.js';
import type { RuntimeHost } from './runtimeHost.js';
import type { SessionIndex } from './sessionIndex.js';
import type { createWorkspaceService } from './workspaceService.js';
import type { BridgeConfig } from '../bridgeConfig.js';
import type { ProcessSupervisor } from '../processSupervisor.js';
import type { AcpRuntimeProcessManager } from '../acpProcessManager.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
export type RuntimeWorkspace = Awaited<ReturnType<typeof createWorkspaceService>>;
export type NativeAuthority = { readonly epoch: string; readonly processGeneration: number };
export type RuntimeDriverFactory = (context: {
  readonly environmentId: string; readonly harnessInstanceId: string; readonly kind: HarnessKind; readonly epoch: string;
  readonly store: RuntimeStore; readonly workspace: RuntimeWorkspace; readonly runtime: Pick<RuntimeHost, 'mutate' | 'resources'>;
  readonly authority: () => NativeAuthority; readonly onEvent?: (event: JsonValue) => void;
}) => Promise<{ readonly registration: HarnessRegistration; close(): Promise<unknown>; readonly authority?: () => NativeAuthority }>;
export function unavailableRegistration(identity: Pick<HarnessManifest, 'environmentId' | 'harnessInstanceId' | 'kind'>, state: 'disabled' | 'starting' | 'missing' | 'auth-required' | 'failed'): HarnessRegistration;
export function createRuntimeDriverFactories(options: {
  readonly environmentId: string; readonly epoch: string; readonly registrations: ReadonlyMap<string, string>;
  readonly config: BridgeConfig; readonly nativeSupervisor: ProcessSupervisor; readonly acpManager: AcpRuntimeProcessManager;
  readonly workspace: RuntimeWorkspace; readonly store: RuntimeStore; readonly runtime: Pick<RuntimeHost, 'mutate'>;
  readonly factories?: Readonly<Record<string, RuntimeDriverFactory>>; readonly isCurrent: () => boolean;
  readonly authorizeDirectory: (directory: string) => Promise<unknown>;
}): { readonly registry: HarnessRegistry; authority(id: string): NativeAuthority; start(index: SessionIndex): Promise<void>; close(): Promise<void> };

