import type { JsonValue } from '../../capabilities.js';
import type { OperationScope } from '../../../../bridge/runtime/operationJournal.js';
import type { RuntimeStore } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type { AppServerClient } from './appServerClient.js';
export function createCodexCancellation(options: {
  readonly store: RuntimeStore;
  readonly fingerprint: (value: JsonValue) => string;
  readonly newId: () => string;
  readonly request: AppServerClient['request'];
  readonly assertCurrent: () => void;
}): (input: {
  readonly scope: OperationScope;
  readonly parentOperationId: string;
  readonly expectedTurnId: string;
  readonly assertActive: () => void;
}) => Promise<JsonValue>;
