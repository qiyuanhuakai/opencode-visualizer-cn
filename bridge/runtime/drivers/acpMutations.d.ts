import type {
  EnvironmentId,
  HarnessInstanceId,
  InstanceId,
  SessionRef,
} from '../../../shared/runtime/identity.js';
import type { RuntimeStore, Json, Change } from '../storage/runtimeStore.js';
import type { AcpObject } from './acpRpc.js';
export interface AcpBinding {
  readonly target: EnvironmentId;
  readonly harnessInstanceId: HarnessInstanceId;
  readonly epoch: InstanceId;
  readonly processGeneration: number;
}
export type AcpScope = AcpBinding & { readonly session?: SessionRef };
export interface AcpMutation {
  readonly session?: SessionRef;
  readonly parent?: string;
  readonly interaction?: string;
  readonly idempotencyKey: string;
  readonly method: string;
  readonly payload: Json;
}
export type AcpMutationResult<T> = {
  readonly phase: 'native-executed' | 'already-completed';
  readonly operationId: string;
  readonly result: T;
};
export interface AcpMutations {
  readonly binding: AcpBinding;
  readonly processKey: string;
  readonly owner: string;
  run<T>(
    input: AcpMutation,
    enqueue: (input: { readonly operationId: string; readonly payload: Json }) => T | Promise<T>,
  ): Promise<AcpMutationResult<T>>;
  scopeFor(session?: SessionRef): AcpScope;
  get(id: string): Promise<{ readonly revision: number; readonly value: AcpObject } | null>;
  reconcile(id: string): Promise<void>;
  close(): Promise<void>;
  authority(): Promise<Change>;
  leaseKey(scope: AcpScope): string;
}
export function createAcpMutations(options: {
  readonly store: RuntimeStore;
  readonly target: string;
  readonly harnessInstanceId: string;
  readonly epoch: string;
  readonly processGeneration: number;
  readonly assertCurrent: () => void;
}): Promise<AcpMutations>;
