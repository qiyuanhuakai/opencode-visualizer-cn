import type { Binding, RuntimeEvent, Replay } from '../../shared/runtime/protocol.js';
import type { RuntimeStore, Collection, Item } from './storage/runtimeStore.js';
export interface RuntimePatch {
  readonly seq: number;
  readonly entityRevision: number;
  readonly epoch: string;
  readonly collection: Collection;
  readonly key: string;
  readonly deleted: boolean;
}
export interface ReplayLog {
  read(input: { readonly epoch: string; readonly after: number; readonly limit?: number }): Promise<{
    readonly epoch: string; readonly events: readonly RuntimePatch[]; readonly through: number; readonly watermark: number;
  }>;
  envelope(binding: Binding, patch: RuntimePatch): RuntimeEvent;
  frame(binding: Binding, input: { readonly after: number; readonly limit?: number }): Promise<Replay>;
  resolve(patch: RuntimePatch): Promise<Item & { readonly collection: Collection }>;
}
export function createReplayLog(options: { readonly store: RuntimeStore }): ReplayLog;
