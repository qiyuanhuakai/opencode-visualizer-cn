import type { RuntimeStore, Json } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../identity.js';
export interface InstanceScope { readonly environmentId: EnvironmentId; readonly harnessInstanceId: HarnessInstanceId; readonly epoch: string; readonly processGeneration: number }
export interface ProcessGuard { readonly collection: 'operations'; readonly key: string; readonly expectedRevision: number; readonly value: InstanceScope & { readonly alive: true } }
export interface InstanceOperation {
  readonly kind: 'opencode-instance-operation'; readonly scope: InstanceScope; readonly method: string; readonly digest: string;
  readonly phase: 'intent' | 'accepted' | 'sent' | 'observed' | 'reconciling'; readonly session?: SessionRef;
  readonly payloadRef: { readonly key: string; readonly chunks: number; readonly digest: string; readonly bytes: number };
}
export interface InstanceOperations {
  readonly ready: Promise<void>;
  assertCurrent(): Promise<ProcessGuard>;
  accept(input: { readonly idempotencyKey: string; readonly method: string; readonly payload: Json }): Promise<{ readonly phase: 'durable-accepted'; readonly operationId: string }>;
  execute<T>(id: string, send: (input: { readonly payload: Json; readonly method: string; readonly scope: InstanceScope }) => Promise<T>): Promise<{ readonly phase: 'native-executed'; readonly operationId: string; readonly result: T }>;
  bindResult(id: string, session: SessionRef): Promise<void>;
  get(id: string): Promise<InstanceOperation>;
  reconcile(id: string): Promise<void>;
  close(): Promise<void>;
}
export function createInstanceOperations(options: { readonly store: RuntimeStore; readonly scope: InstanceScope; readonly current: () => { readonly epoch: string; readonly processGeneration: number }; readonly fingerprint: (value: Json) => string; readonly randomUUID: () => string }): InstanceOperations;
