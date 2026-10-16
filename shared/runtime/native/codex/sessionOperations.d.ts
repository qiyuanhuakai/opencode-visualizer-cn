import type { SessionRef } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
import type {
  OperationJournal,
  OperationScope,
} from '../../../../bridge/runtime/operationJournal.js';
import type { InteractionStore } from '../../../../bridge/runtime/interactionStore.js';
import type { AppServerClient } from './appServerClient.js';
import type { RuntimeStore } from '../../../../bridge/runtime/storage/runtimeStore.js';
export interface ActiveTurn {
  readonly operationId: string;
  readonly turnId: string | null;
  readonly method: string;
}
export interface SessionMutation {
  readonly session: SessionRef;
  readonly method: string;
  readonly payload: JsonValue;
  readonly idempotencyKey: string;
  readonly turn?: boolean | 'compact';
  readonly queue?: boolean;
}
export interface CodexSessionOperations {
  bind(session: SessionRef): Promise<unknown>;
  loaded(session: SessionRef): Promise<void>;
  resume(session: SessionRef): Promise<unknown>;
  mutate(input: SessionMutation): Promise<JsonValue>;
  terminal(input: {
    readonly session: SessionRef;
    readonly turnId: string;
    readonly outcome: 'completed' | 'failed' | 'cancelled' | 'interrupted';
  }): Promise<void>;
  cancel(input: { readonly session: SessionRef; readonly operationId: string }): Promise<JsonValue>;
  activeFor(session: SessionRef): ActiveTurn | null;
  started(session: SessionRef, turnId: string): void;
  close(): Promise<void>;
}
export function createCodexSessionOperations(options: {
  readonly store: RuntimeStore;
  readonly fingerprint: (value: JsonValue) => string;
  readonly newId: () => string;
  readonly journal: OperationJournal;
  readonly interactions: InteractionStore;
  readonly request: AppServerClient['request'];
  readonly scopeFor: (session: SessionRef) => OperationScope;
  readonly assertCurrent: () => void;
  readonly emit: (event: {
    readonly type: string;
    readonly session: SessionRef;
    readonly payload: JsonValue;
  }) => void;
  readonly authorizeSession: (session: SessionRef) => Promise<string>;
}): CodexSessionOperations;
