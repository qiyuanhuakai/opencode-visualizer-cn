import type { TransportKind } from '../../../shared/runtime/connectionProfile.js';

export type HostPlatform = 'darwin' | 'linux' | 'win32';
export type HostArchitecture = 'x64' | 'arm64';
export type UpdateLocation = 'local' | 'wsl' | 'remote' | 'slurm-compute';
export type BootstrapAction = 'connect' | 'install' | 'upgrade';
export type BootstrapChannel =
  | 'local-installer'
  | 'wsl-terminal'
  | 'transport'
  | 'slurm-shared-root'
  | 'slurm-controlled-channel';

export interface HostIdentity {
  readonly transportKind: TransportKind;
  readonly platform: HostPlatform;
  readonly arch: HostArchitecture;
  readonly protocol: string | null;
  readonly environmentId: string;
  readonly bridgeInstalled: boolean;
  readonly bridgeVersion: string | null;
  readonly hostname: string | null;
}

export interface BridgeUpgradePath {
  readonly action: 'install' | 'upgrade';
  readonly fromVersion: string | null;
  readonly platform: HostPlatform;
  readonly arch: HostArchitecture;
  readonly environmentId: string;
  readonly requiredProtocol: string;
}

export interface BootstrapCompatibility {
  readonly compatible: boolean;
  readonly connectable: boolean;
  readonly upgradePath: BridgeUpgradePath | null;
}

export interface BootstrapPlan {
  readonly profileId: string | null;
  readonly environmentId: string;
  readonly location: UpdateLocation;
  readonly channel: BootstrapChannel;
  readonly action: BootstrapAction;
  readonly connectable: boolean;
  readonly compatible: boolean;
  readonly upgradePath: BridgeUpgradePath | null;
  readonly deliverLocalInstaller: boolean;
  readonly localInstallerPath: string | null;
  readonly automatic: false;
  readonly requiresExplicitAction: boolean;
}

export const HOST_PLATFORMS: readonly HostPlatform[];
export const HOST_ARCHITECTURES: readonly HostArchitecture[];
export const UPDATE_LOCATIONS: readonly UpdateLocation[];
export const BRIDGE_PROTOCOL_GENERATION: string;
export const BOOTSTRAP_ACTIONS: readonly BootstrapAction[];

export function parseHostIdentity(input: unknown): HostIdentity;
export function probeHostIdentity(options: {
  readonly profile: { readonly transport: { readonly kind: TransportKind } };
  readonly probe: (profile: unknown) => Promise<unknown>;
}): Promise<HostIdentity>;
export function resolveUpdateLocation(options: {
  readonly host: HostIdentity;
  readonly localEnvironmentId: string;
  readonly localPlatform?: HostPlatform;
}): UpdateLocation;
export function evaluateBridgeCompatibility(options: {
  readonly host: HostIdentity;
  readonly requiredProtocol?: string;
}): BootstrapCompatibility;
export function createBootstrapPlan(options: {
  readonly profile?: unknown;
  readonly host: HostIdentity;
  readonly localEnvironmentId: string;
  readonly localPlatform?: HostPlatform;
  readonly requiredProtocol?: string;
  readonly sharedRootAvailable?: boolean;
}): BootstrapPlan;
export function assertNoLocalInstallerForRemote<T extends {
  readonly location?: string;
  readonly channel?: string;
  readonly deliverLocalInstaller?: boolean;
}>(plan: T): T;
