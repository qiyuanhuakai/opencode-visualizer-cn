import type { RuntimeStore, Json } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type {
  OperationJournal,
  OperationScope,
} from '../../../../bridge/runtime/operationJournal.js';
import type { SessionRef } from '../../identity.js';
import type { AppServerClient } from './appServerClient.js';
import type { ActiveTurn } from './sessionOperations.js';
import type { createInstanceOperations } from './instanceOperations.js';
export function createCodexControls(options: {
  readonly store: RuntimeStore;
  readonly journal: OperationJournal;
  readonly instanceFactory: (
    authorize: () => Promise<void>,
  ) => ReturnType<typeof createInstanceOperations>;
  readonly fingerprint: (value: Json) => string;
  readonly request: AppServerClient['request'];
  readonly assertCurrent: () => void;
  readonly activeFor: (session: SessionRef) => ActiveTurn | null;
  readonly scopeFor: (session: SessionRef) => OperationScope;
}): (input: {
  readonly session: SessionRef;
  readonly expectedTurnId: string;
  readonly input: Json;
  readonly idempotencyKey: string;
}) => Promise<Json>;
