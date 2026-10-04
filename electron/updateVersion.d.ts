export interface UpdateVersion {
  readonly version: string;
  readonly core: readonly bigint[];
  readonly prerelease: readonly string[];
}
export declare function parseUpdateVersion(value: string): UpdateVersion;
export declare function isNewerVersion(candidate: string, current: string | null): boolean;
export declare function parseInstalledVersion(output: string): string | null;
