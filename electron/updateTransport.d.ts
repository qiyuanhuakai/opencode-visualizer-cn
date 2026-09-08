import type { Agent } from 'node:https';

import type { AutomaticUpdateFile, ReleaseAsset, StableRelease } from './updatePolicy.js';

export interface UpdateTransport {
  getLatestRelease(): Promise<StableRelease>;
  downloadAsset(asset: ReleaseAsset, onProgress?: (percent: number) => void): Promise<string>;
  verifyAsset(
    filePath: string,
    asset: ReleaseAsset | AutomaticUpdateFile,
    expectedDigest: string,
    algorithm?: 'sha256' | 'sha512',
  ): Promise<void>;
  removeFile(filePath: string): Promise<void>;
  dispose(): void;
}

export declare function createUpdateTransport(options?: {
  readonly agent?: Agent;
}): UpdateTransport;
export declare function isAllowedUpdateUrl(rawUrl: string | URL): boolean;
