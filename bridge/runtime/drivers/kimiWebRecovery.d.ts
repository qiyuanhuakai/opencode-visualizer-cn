import type { RuntimeStore } from '../storage/runtimeStore.js';
import type { OperationScope } from '../operationJournal.js';
import type { KimiTranscript } from '../../../shared/runtime/native/kimiWeb/transcript.js';
export function createKimiWebRecovery(options: {
  readonly store: RuntimeStore;
  readonly isCurrent: (scope: OperationScope) => boolean;
}): {
  adopt(scope: OperationScope, page: KimiTranscript): Promise<OperationScope | null>;
  retire(scope: OperationScope, previous: OperationScope, nativeRequestId: string, operationId: string, nativeState?: string, parentScope?: OperationScope, processAuthority?: { readonly epoch: string; readonly processGeneration: number }): Promise<void>;
};
