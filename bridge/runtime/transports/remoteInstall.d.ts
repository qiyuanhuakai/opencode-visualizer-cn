import type { BridgeLinuxFormat, ReleaseAsset, StableRelease } from '../../../electron/updatePolicy.js';
import type { HostIdentity } from './remoteBootstrap.js';

export type InstallChannel =
  | 'local-installer'
  | 'wsl-terminal'
  | 'transport'
  | 'slurm-shared-root'
  | 'slurm-controlled-channel';
export type BackupTarget = 'program' | 'database';

export interface ArtifactPolicy {
  selectBridgeAsset(
    release: StableRelease,
    platform: string,
    arch: string,
    linuxFormat?: BridgeLinuxFormat,
  ): ReleaseAsset;
  sha256FromDigest(asset: ReleaseAsset): string;
}

export interface SelectedRemoteArtifact {
  readonly name: string;
  readonly size: number;
  readonly url: string;
  readonly sha256: string;
  readonly platform: string;
  readonly arch: string;
  readonly linuxFormat: BridgeLinuxFormat | null;
}

export interface RemoteInstallPlan {
  readonly hostEnvironmentId: string;
  readonly location: string;
  readonly channel: InstallChannel;
  readonly deliverLocalInstaller: boolean;
  readonly atomicSwitch: true;
  readonly requiresExplicitAction: true;
  readonly backup: readonly BackupTarget[];
  readonly artifact: SelectedRemoteArtifact;
}

export interface RemoteInstallReceipt {
  readonly action: 'install' | 'upgrade' | null;
  readonly switched: boolean;
  readonly rolledBack: boolean;
  readonly databasePreserved: boolean;
  readonly backups: { readonly program: unknown; readonly database: unknown };
}

export interface RemoteInstallAdapter {
  download(plan: RemoteInstallPlan): Promise<unknown>;
  verify(staged: unknown, plan: RemoteInstallPlan): Promise<boolean>;
  backup(host: HostIdentity, target: BackupTarget, plan: RemoteInstallPlan): Promise<unknown>;
  atomicSwitch(host: HostIdentity, staged: unknown, plan: RemoteInstallPlan): Promise<void>;
  restore(host: HostIdentity, target: BackupTarget, backup: unknown): Promise<void>;
  discard(staged: unknown): Promise<void>;
}

export interface RemoteInstallTransaction {
  install(): Promise<RemoteInstallReceipt>;
  upgrade(): Promise<RemoteInstallReceipt>;
  rollback(): Promise<RemoteInstallReceipt>;
  receipt(): RemoteInstallReceipt;
}

export const INSTALL_CHANNELS: readonly InstallChannel[];
export const REMOTE_CHANNELS: readonly InstallChannel[];
export const BACKUP_TARGETS: readonly BackupTarget[];

export function selectRemoteArtifact(options: {
  readonly release: StableRelease;
  readonly host: HostIdentity;
  readonly linuxFormat?: BridgeLinuxFormat;
  readonly policy?: ArtifactPolicy;
}): SelectedRemoteArtifact;
export function planRemoteInstall(options: {
  readonly release: StableRelease;
  readonly host: HostIdentity;
  readonly location: string;
  readonly channel: InstallChannel;
  readonly linuxFormat?: BridgeLinuxFormat;
  readonly sharedRootAvailable?: boolean;
  readonly policy?: ArtifactPolicy;
}): RemoteInstallPlan;
export function createRemoteInstallTransaction(options: {
  readonly host: HostIdentity;
  readonly plan: RemoteInstallPlan;
  readonly adapter: RemoteInstallAdapter;
}): RemoteInstallTransaction;
