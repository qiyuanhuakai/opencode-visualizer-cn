import type { Binding } from '../../shared/runtime/protocol.js';
import type { RuntimeStore } from './storage/runtimeStore.js';
import type { EventObserver } from './eventObservers.js';
import type { ReplayLog } from './replayLog.js';
export interface RuntimeEventBus {
  connect(binding: Binding, options: { readonly after: number; readonly isCurrent: () => boolean }): Promise<EventObserver>;
  nudge(): Promise<void>;
  readonly log: ReplayLog;
  close(): Promise<void>;
  readonly state: { readonly observers: number; readonly through: number | null; readonly polling: boolean; readonly closed: boolean };
}
export function createRuntimeEventBus(options: { readonly store: RuntimeStore; readonly pollMs?: number }): RuntimeEventBus;
