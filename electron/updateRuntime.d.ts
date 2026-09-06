import type { EventEmitter } from 'node:events';
import type { AutomaticUpdateFile, AutomaticUpdateTarget, ReleaseAsset, StableRelease, UpdateArchitecture, UpdatePlatform } from './updatePolicy.js';

export interface UpdateInfo {
  readonly version: string;
  readonly files: readonly { readonly url: string; readonly size?: number; readonly sha512: string }[];
}

export interface DesktopAutoUpdater extends EventEmitter {
  autoDownload: boolean;
  autoInstallOnAppQuit: boolean;
  allowPrerelease: boolean;
  allowDowngrade: boolean;
  channel: string | null;
  checkForUpdates(): Promise<{ readonly updateInfo: UpdateInfo } | null>;
  downloadUpdate(cancellationToken?: { cancel(): void }): Promise<readonly string[]>;
  quitAndInstall(isSilent?: boolean, isForceRunAfter?: boolean): void;
}

export interface UpdateRuntime {
  readonly platform: UpdatePlatform;
  readonly arch: UpdateArchitecture;
  readonly automaticAppUpdates: boolean;
  readonly automaticAppUpdateTarget: AutomaticUpdateTarget | null;
  readonly updater: DesktopAutoUpdater;
  getLatestRelease(): Promise<StableRelease>;
  getBridgeVersion(): Promise<string | null>;
  downloadAppUpdate(): Promise<readonly string[]>;
  downloadAsset(asset: ReleaseAsset, onProgress: (percent: number) => void): Promise<string>;
  verifyAsset(
    filePath: string,
    asset: ReleaseAsset | AutomaticUpdateFile,
    expectedDigest: string,
    algorithm?: 'sha256' | 'sha512',
  ): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  dispose(): void;
}

export declare function createUpdateRuntime(): UpdateRuntime;
