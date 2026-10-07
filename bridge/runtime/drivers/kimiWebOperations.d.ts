import type { Json } from '../storage/runtimeStore.js';
import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { OperationScope, OperationJournal } from '../operationJournal.js';
import type { InteractionStore } from '../interactionStore.js';
import type { AdmissionQueue } from '../admissionQueue.js';
import type { KimiWebTransport } from './kimiWebTransport.js';
export interface KimiInstanceScope { readonly target: string; readonly harnessInstanceId: string; readonly epoch: string; readonly processGeneration: number }
export type KimiExecution = { readonly phase: 'native-executed'; readonly operationId: string; readonly result: Json; readonly promptId?: string };
export interface KimiWebOperations {
  instance(scope: KimiInstanceScope, method: string, payload: Json, idempotencyKey: string, pathname: string): Promise<KimiExecution>;
  send(scope: OperationScope, payload: Json, idempotencyKey: string): Promise<KimiExecution>;
  started(scope: OperationScope, payload: Readonly<Record<string, Json>>): Promise<void>;
  cancel(scope: OperationScope, operationId: string, idempotencyKey: string): Promise<KimiExecution>;
  pending(scope: OperationScope, kind: 'approval' | 'question', nativeRequestId: string, payload: Json): Promise<string>;
  reply(scope: OperationScope, interactionId: string, answer: Json, idempotencyKey: string): Promise<KimiExecution>;
  terminal(scope: OperationScope, payload: Readonly<Record<string, Json>>): Promise<void>;
  invalidate(scope: OperationScope): Promise<void>; close(): Promise<void>;
  readonly journal: OperationJournal; readonly interactions: InteractionStore; readonly admission: AdmissionQueue;
}
export function createKimiWebOperations(options: { readonly store: RuntimeStore; readonly transport: KimiWebTransport; readonly isCurrent: (scope: OperationScope | KimiInstanceScope) => boolean; readonly admission?: AdmissionQueue }): KimiWebOperations;
