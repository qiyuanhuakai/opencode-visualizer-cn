import type { RuntimeStore } from './storage/runtimeStore.js';
import type { SessionRef } from '../../shared/runtime/identity.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
export type AcceptanceScope = { readonly target: string; readonly harnessInstanceId: string; readonly epoch: string; readonly processGeneration: number; readonly session?: SessionRef };
export type AcceptanceReceipt = { readonly operationId: string; readonly collection: 'operations' | 'interactions' };
export interface RuntimeAcceptance {
  readonly store: RuntimeStore;
  run(input: { readonly scope: AcceptanceScope; readonly method: string; readonly idempotencyKey: string; readonly interactionId?: string; readonly deadlineMs?: number; readonly signal?: AbortSignal; readonly onAccepted: (receipt: AcceptanceReceipt) => void }, invoke: () => Promise<unknown>): Promise<{ readonly receipt: AcceptanceReceipt; readonly value: JsonValue }>;
  close(): void;
}
export function createRuntimeAcceptance(options: { readonly store: RuntimeStore }): RuntimeAcceptance;

