import type { RuntimeStore, Json } from './storage/runtimeStore.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { AdmissionQueue } from './admissionQueue.js';
export interface OperationScope {
  readonly target: string;
  readonly epoch: string;
  readonly session: SessionRef;
  readonly processGeneration: number;
}
export interface Operation {
  readonly operationId: string;
  readonly scope: OperationScope;
  readonly method: string;
  readonly payloadRef: {
    readonly key: string;
    readonly bytes: number;
    readonly chunks: number;
    readonly digest: string;
  };
  readonly phase: 'intent' | 'accepted' | 'sent' | 'observed' | 'terminal' | 'reconciling';
  readonly cancelRequested: boolean;
  readonly outcome?: 'completed' | 'failed' | 'cancelled' | 'interrupted';
}
export interface OperationJournal {
  accept(input: {
    readonly scope: OperationScope;
    readonly idempotencyKey: string;
    readonly method: string;
    readonly payload: Json;
  }): Promise<{ readonly phase: 'durable-accepted'; readonly operationId: string }>;
  execute<T>(
    id: string,
    scope: OperationScope,
    send: (input: {
      readonly operationId: string;
      readonly scope: OperationScope;
      readonly method: string;
      readonly payload: Json;
      readonly signal: AbortSignal;
    }) => T | Promise<T>,
    options?: { readonly deadlineMs?: number },
  ): Promise<{
    readonly phase: 'native-executed';
    readonly operationId: string;
    readonly result: T;
  }>;
  get(id: string): Promise<Operation>;
  cancel(id: string, scope: OperationScope): Promise<Operation>;
  terminal(
    id: string,
    scope: OperationScope,
    outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted',
  ): Promise<Operation>;
  reconcile(id: string, scope: OperationScope): Promise<Operation>;
}
export function createOperationJournal(options: {
  readonly store: RuntimeStore;
  readonly admission?: AdmissionQueue;
  readonly isProcessCurrent: (scope: OperationScope) => boolean;
}): OperationJournal;
export function parseOperationScope(value: unknown): OperationScope;
export function fingerprint(value: Json): string;
