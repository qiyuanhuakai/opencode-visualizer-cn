export const CONTROL_STORE_SCHEMA_VERSION: number;
export const CONTROL_STORE_FILES: {
  readonly journal: string;
  readonly intents: string;
  readonly fence: string;
};
export const NETWORK_FILESYSTEM_MAGIC: Readonly<Record<number, string>>;
export const LOCAL_FILESYSTEM_MAGIC: Readonly<Record<number, string>>;

export type FilesystemClass = 'local' | 'network' | 'unknown';
export function filesystemClass(type: unknown, platform?: string): FilesystemClass;
export function filesystemName(type: unknown, platform?: string): string | null;
export function isNetworkFilesystem(type: unknown, platform?: string): boolean;

export interface LocalFilesystem {
  readonly root: string;
  readonly type: number | null;
  readonly name: string | null;
  readonly filesystemClass: FilesystemClass;
}
export function verifyLocalFilesystem(options: { root: string; platform?: string; statfs?: (target: string) => { type?: number } | undefined }): Promise<LocalFilesystem>;

export interface SlurmIntentRecord {
  readonly schemaVersion: number;
  readonly environmentId: string;
  readonly intentId: string;
  readonly uuid?: string;
  readonly state?: string;
  readonly ownership?: string;
  readonly jobId?: string | null;
  readonly queue?: string;
  readonly terminal?: string | null;
  readonly reconcile?: string | null;
  readonly attached?: boolean;
  readonly [key: string]: unknown;
}

export interface ControlStoreStatus {
  readonly opened: boolean;
  readonly writable: boolean;
  readonly epoch: number;
  readonly environmentId: string;
  readonly ownerInstanceId: string;
  readonly root: string;
}

export type ControlStoreMode = 'owner' | 'readonly';

export interface SlurmControlStore {
  readonly root: string;
  readonly environmentId: string;
  readonly ownerInstanceId: string;
  open(mode?: ControlStoreMode): Promise<ControlStoreStatus>;
  close(): Promise<ControlStoreStatus>;
  status(): ControlStoreStatus;
  bumpEpoch(input?: { reason?: string }): Promise<number>;
  writeIntent(intent: { intentId: string; [key: string]: unknown }): Promise<SlurmIntentRecord>;
  updateIntent(intentId: string, patch: Record<string, unknown>): Promise<SlurmIntentRecord>;
  readIntent(intentId: string): Promise<SlurmIntentRecord | undefined>;
  listIntents(): Promise<readonly SlurmIntentRecord[]>;
  verifyIntegrity(): Promise<{ ok: boolean; records: number; lastHash: string }>;
}

export function createSlurmControlStore(options: {
  root: string;
  environmentId: string;
  ownerInstanceId: string;
  platform?: string;
  statfs?: (target: string) => { type?: number } | undefined;
  clock?: () => number;
  isProcessAlive?: (pid: number) => boolean;
}): SlurmControlStore;
