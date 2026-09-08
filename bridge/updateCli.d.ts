import type { ReleaseAsset, StableRelease, UpdateArchitecture, UpdatePlatform } from '../electron/updatePolicy.js';

export interface BridgeUpdateOptions {
  readonly command: 'update';
  readonly check: boolean;
  readonly help: boolean;
  readonly yes: boolean;
}

export interface BridgeUpdateHandoffRequest {
  readonly assetPath: string;
  readonly linuxFormat: 'deb' | 'rpm' | null;
  readonly nonInteractiveYes: boolean;
  readonly onAccepted: (resultLogPath?: string) => void;
}

export interface BridgeUpdateOffer {
  readonly currentVersion: string;
  readonly latestVersion: string;
  readonly asset: ReleaseAsset;
}

export interface BridgeUpdateDependencies {
  readonly currentVersion: string;
  readonly platform: UpdatePlatform;
  readonly arch: UpdateArchitecture;
  readonly interactive: boolean;
  readonly output: (message: string) => void;
  readonly presentOffer: (offer: BridgeUpdateOffer) => void;
  readonly confirm: (question: string) => Promise<boolean>;
  readonly assertInstallAllowed: (options: {
    readonly allowPrivilegedInspection: true;
    readonly nonInteractiveYes: boolean;
  }) => Promise<void>;
  readonly resolveLinuxFormat: (options: { readonly requireOwnership: boolean }) => Promise<'deb' | 'rpm'>;
  readonly handoff: (request: BridgeUpdateHandoffRequest) => Promise<void>;
  readonly transport: {
    getLatestRelease(): Promise<StableRelease>;
    downloadAsset(asset: ReleaseAsset, onProgress: (percent: number) => void): Promise<string>;
    verifyAsset(filePath: string, asset: ReleaseAsset, digest: string, algorithm: 'sha256'): Promise<void>;
    removeFile?(filePath: string): Promise<void>;
    dispose(): void;
  };
}

export type BridgeUpdateResult = {
  readonly kind: 'available' | 'cancelled' | 'current' | 'handed-off';
  readonly currentVersion: string;
  readonly latestVersion: string;
};

export declare function parseBridgeUpdateArgs(argv?: readonly string[]): BridgeUpdateOptions | null;
export declare function updateUsage(): string;
export declare function runBridgeUpdate(
  options: BridgeUpdateOptions,
  dependencies: Partial<BridgeUpdateDependencies> & Pick<BridgeUpdateDependencies, 'currentVersion'>,
): Promise<BridgeUpdateResult>;
