import type { Binding, Snapshot, Replay } from '../../shared/runtime/protocol.js';
import type { RuntimeStore, SnapshotOptions, Collection } from './storage/runtimeStore.js';
export interface SnapshotConnection {
  page(input?: Partial<SnapshotOptions>): Promise<Snapshot>;
  readChunk(input: { readonly collection: Collection; readonly key: string; readonly revision: number; readonly offset: number; readonly token: string }): ReturnType<RuntimeStore['readChunk']>;
  replay(input: { readonly after: number; readonly limit?: number }): Promise<Replay>;
  close(): void;
}
export interface RuntimeSnapshots {
  connect(binding: Binding, isCurrent: () => boolean): Promise<SnapshotConnection>;
}
export const INDEX_COLLECTIONS: readonly Collection[];
export function createRuntimeSnapshots(options: { readonly store: RuntimeStore }): RuntimeSnapshots;
