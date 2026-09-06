import type { AutomaticUpdateFile } from './updatePolicy.js';
import type { UpdateRuntime } from './updateRuntime.js';

export interface AutomaticUpdate {
  accept(info: unknown): AutomaticUpdateFile;
  clear(): void;
  recordDownload(paths: readonly string[]): string;
  verifyDownload(): Promise<void>;
}

export declare function createAutomaticUpdate(runtime: UpdateRuntime): AutomaticUpdate;
