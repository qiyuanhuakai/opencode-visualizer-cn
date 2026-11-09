import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { AcpObject, AcpMessage, AcpRpc } from './acpRpc.js';
import type { AcpMutations, AcpMutationResult } from './acpMutations.js';
export interface AcpPendingInteraction {
  readonly interactionId: string;
  readonly session: SessionRef;
  readonly params: AcpObject;
  readonly parent: string;
  readonly nativeRequestId: string | number;
  readonly phase: 'pending' | 'invalidated';
}
export interface AcpInteractions {
  receive(message: AcpMessage): Promise<void>;
  list(): Promise<readonly AcpPendingInteraction[]>;
  respond(input: {
    readonly interactionId: string;
    readonly session: SessionRef;
    readonly answer: AcpObject;
    readonly idempotencyKey: string;
  }): Promise<AcpMutationResult<void>>;
  track<T>(promise: Promise<T>): Promise<T>;
  settled(): Promise<void>;
  settleParent(operationId: string): Promise<void>;
  get(key: string): Promise<AcpObject>;
}
export function createAcpInteractions(options: {
  readonly store: RuntimeStore;
  readonly mutations: AcpMutations;
  readonly rpc: AcpRpc;
  readonly active: ReadonlyMap<string, string>;
  readonly emit: (event: AcpObject) => void;
  readonly sessionFor: (id: string) => SessionRef;
}): AcpInteractions;
