import type { RuntimeStore, Json } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type { HarnessScope } from '../../harnessContract.js';
export type InstanceScope = HarnessScope & {
  readonly epoch: string;
  readonly processGeneration: number;
};
export function createInstanceOperations(options: {
  readonly store: RuntimeStore;
  readonly scope: InstanceScope;
  readonly isCurrent: (scope: InstanceScope) => boolean;
  readonly authorize?: () => Promise<void>;
  readonly fingerprint: (input: Json) => string;
  readonly newId: () => string;
}): {
  accept(input: {
    readonly method: string;
    readonly payload: Json;
    readonly idempotencyKey: string;
  }): Promise<{ readonly phase: 'durable-accepted'; readonly operationId: string }>;
  execute<T>(
    id: string,
    submit: (input: { readonly method: string; readonly payload: Json }) => Promise<T>,
  ): Promise<{
    readonly phase: 'native-executed';
    readonly operationId: string;
    readonly result: T;
  }>;
  get(id: string): Promise<{
    readonly kind: 'codex-instance-operation';
    readonly scope: InstanceScope;
    readonly operationId: string;
    readonly method: string;
    readonly digest: string;
    readonly phase: 'intent' | 'accepted' | 'sent' | 'observed' | 'terminal' | 'reconciling';
    readonly outcome?: 'completed';
  }>;
};
