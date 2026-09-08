export type UpdateComponent = 'app' | 'bridge';
export type UpdatePlatform = 'darwin' | 'linux' | 'win32';
export type UpdateArchitecture = 'x64' | 'arm64';
export type AutomaticUpdateTarget = 'appimage' | 'deb' | 'nsis';
export type BridgeLinuxFormat = 'deb' | 'rpm';

export interface ReleaseAsset {
  readonly name: string;
  readonly digest: string | null;
  readonly size: number;
  readonly url: string;
}

export interface StableRelease {
  readonly version: string;
  readonly assets: readonly ReleaseAsset[];
}

export interface AutomaticUpdateFile {
  readonly name: string;
  readonly size: number;
  readonly sha512: string;
  readonly url: string;
}

export declare function parseStableRelease(value: unknown): StableRelease;
export declare function selectManualAsset(
  release: StableRelease,
  component: UpdateComponent,
  platform: UpdatePlatform,
  arch: UpdateArchitecture,
  linuxFormat?: BridgeLinuxFormat,
): ReleaseAsset;
export declare function selectBridgeAsset(
  release: StableRelease,
  platform: UpdatePlatform,
  arch: UpdateArchitecture,
  linuxFormat?: BridgeLinuxFormat,
): ReleaseAsset;
export declare function selectAutomaticAppFile(
  info: unknown,
  platform: UpdatePlatform,
  arch: UpdateArchitecture,
  target: AutomaticUpdateTarget,
): AutomaticUpdateFile;
export declare function sha256FromDigest(asset: ReleaseAsset): string;
export declare function isNewerVersion(candidate: string, current: string | null): boolean;
export declare function parseInstalledVersion(output: string): string | null;
export declare function automaticAppUpdateSupported(
  platform: string,
  hasAppImage: boolean,
  packageType: string | null,
): boolean;
export declare function automaticAppUpdateTarget(
  platform: string,
  hasAppImage: boolean,
  packageType: string | null,
): AutomaticUpdateTarget | null;
