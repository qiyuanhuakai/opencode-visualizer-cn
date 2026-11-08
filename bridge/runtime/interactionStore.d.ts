import type { RuntimeStore, Json } from './storage/runtimeStore.js';
import type { OperationScope } from './operationJournal.js';
import type { AdmissionQueue } from './admissionQueue.js';
export interface Interaction {
  readonly scope: OperationScope;
  readonly nativeRequestId: string | number;
  readonly payload: Json;
  readonly phase: 'pending' | 'replying' | 'replied' | 'reconciling' | 'invalidated';
}
export interface InteractionStore {
  bindProcess(scope: OperationScope): Promise<void>;
  processExited(scope: OperationScope): Promise<void>;
  pending(input: {
    readonly scope: OperationScope;
    readonly nativeRequestId: string | number;
    readonly payload: Json;
  }): Promise<string>;
  get(key: string): Promise<Interaction>;
  reply(
    key: string,
    scope: OperationScope,
    answer: Json,
    submit: (input: {
      readonly scope: OperationScope;
      readonly nativeRequestId: string | number;
      readonly answer: Json;
      readonly signal: AbortSignal;
    }) => void | Promise<void>,
    options?: { readonly deadlineMs?: number },
  ): Promise<{ readonly phase: 'native-executed'; readonly interactionId: string }>;
}
export function createInteractionStore(options: {
  readonly store: RuntimeStore;
  readonly admission?: AdmissionQueue;
}): InteractionStore;
