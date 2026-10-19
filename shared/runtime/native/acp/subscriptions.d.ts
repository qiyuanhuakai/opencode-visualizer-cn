import type { SessionRef } from '../../identity.js';
import type { AcpBinding, AcpObject } from './capabilities.js';
export interface AcpSubscription {
  read(): {
    readonly events: readonly AcpObject[];
    readonly through: number;
    readonly floor: number;
    readonly status: 'complete' | 'partial';
  };
  detach(): void;
}
export interface AcpSubscriptions {
  emit(event: AcpObject): void;
  subscribe(input: {
    readonly subscriberId: string;
    readonly session?: SessionRef;
    readonly after?: number;
  }): AcpSubscription;
  readonly count: number;
  close(): void;
}
export function createAcpSubscriptions(binding: AcpBinding): AcpSubscriptions;
