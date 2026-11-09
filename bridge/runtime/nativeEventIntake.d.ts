import type { DiscoverySource } from './indexDiscovery.js';
import type { IndexMutations } from './indexMutations.js';
export type NativeSubscription = AsyncIterableIterator<unknown> | { read(): { readonly status: string; readonly events: readonly unknown[] } | Promise<{ readonly status: string; readonly events: readonly unknown[] }>; detach(): void };
export interface NativeEventIntake {
  publish(event: unknown): boolean;
  subscribe(open: () => NativeSubscription | Promise<NativeSubscription>): Promise<void>;
  flush(): Promise<void>;
  close(): Promise<void>;
  readonly state: { readonly bytes: number; readonly count: number; readonly sequence: number; readonly failure: string | null; readonly subscribed: boolean; readonly closed: boolean };
}
export const INTAKE_LIMITS: Readonly<{ bytes: 4194304; events: 256; frameBytes: 1048576 }>;
export function createNativeEventIntake(options: { readonly source: DiscoverySource; readonly mutations: IndexMutations; readonly dirty: () => void; readonly onControl: () => void; readonly onFailure: (reason: string) => void }): NativeEventIntake;
