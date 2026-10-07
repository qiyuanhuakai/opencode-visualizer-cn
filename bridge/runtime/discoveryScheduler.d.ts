export type DiscoveryPriority = 'selected' | 'expanded' | 'recent' | 'background';
export interface DiscoveryDemand {
  readonly environmentId: string;
  readonly harnessInstanceId: string;
  readonly scope: string;
  readonly priority?: DiscoveryPriority;
  readonly interactive?: boolean;
  readonly deadlineMs?: number;
}
export interface DiscoveryLease {
  readonly signal: AbortSignal;
  readonly deadlineAt: number;
  isCurrent(): boolean;
  assertCurrent(): void;
}
export interface DiscoveryScheduler {
  schedule<T>(demand: DiscoveryDemand, action: (lease: DiscoveryLease) => T | Promise<T>): Promise<T>;
  cancel(demand: DiscoveryDemand): boolean;
  close(): void;
  readonly state: {
    readonly background: number;
    readonly interactive: number;
    readonly queued: number;
    readonly native: number;
    readonly abandoned: number;
    readonly closed: boolean;
  };
}
export const DISCOVERY_LIMITS: Readonly<{ background: 4; perSource: 2; interactive: 1; queued: 256; native: 8; deadlineMs: 15000 }>;
export function createDiscoveryScheduler(): DiscoveryScheduler;
