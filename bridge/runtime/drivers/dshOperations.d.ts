import type { OperationJournal, OperationScope } from '../operationJournal.js';
import type { InteractionStore } from '../interactionStore.js';
import type { AdmissionQueue } from '../admissionQueue.js';
import type { RuntimeStore, Json } from '../storage/runtimeStore.js';
import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { DshTransport } from './dshTransport.js';
export interface InstanceOperationScope { readonly target: string; readonly harnessInstanceId: string; readonly epoch: string; readonly processGeneration: number }
export interface DshMutationResult {
  readonly phase: 'native-executed'; readonly operationId: string; readonly result: Json;
  readonly accepted: { readonly phase: 'durable-accepted'; readonly operationId: string };
}
export interface DshOperations {
  capture(session: SessionRef): OperationScope;
  capture(): InstanceOperationScope;
  current(scope: OperationScope | InstanceOperationScope): boolean;
  authority(scope: OperationScope | InstanceOperationScope): Promise<void>;
  bind(scope: OperationScope): Promise<void>;
  readonly journal: OperationJournal; readonly interactions: InteractionStore; readonly admission: AdmissionQueue;
  sessionMutation(input: { readonly session: SessionRef; readonly idempotencyKey: string; readonly method: string; readonly args: Json; readonly ongoing?: boolean; readonly capturedScope?: OperationScope }): Promise<DshMutationResult>;
  durable(input: { readonly session?: SessionRef; readonly parentOperationId?: string; readonly idempotencyKey: string; readonly method: string; readonly args: Json; readonly guard?: () => void; readonly capturedScope?: OperationScope | InstanceOperationScope }): Promise<DshMutationResult>;
  finish(session: SessionRef, outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted'): Promise<void>;
}
export function createDshOperations(options: { readonly store: RuntimeStore; readonly transport: DshTransport; readonly environmentId: string; readonly harnessInstanceId: string; readonly epoch: string }): DshOperations;
