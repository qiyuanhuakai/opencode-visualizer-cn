import type { SessionRef } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
import type { OperationScope } from '../../../../bridge/runtime/operationJournal.js';
import type { InteractionStore } from '../../../../bridge/runtime/interactionStore.js';
import type { AppServerClient, NativeMessage } from './appServerClient.js';
import type { CodexSessionOperations } from './sessionOperations.js';
import type { CodexCatalog } from './catalog.js';
export function createCodexEvents(options: {
  readonly client: AppServerClient;
  readonly sessions: CodexSessionOperations;
  readonly interactions: InteractionStore;
  readonly sessionFor: (id: string) => SessionRef;
  readonly scopeFor: (session: SessionRef) => OperationScope;
  readonly assertCurrent: () => void;
  readonly emit: (event: {
    readonly type: string;
    readonly session?: SessionRef;
    readonly payload: JsonValue;
  }) => void;
  readonly privacy: (value: unknown) => JsonValue;
  readonly catalogChanged: CodexCatalog['changed'];
  readonly resolveCredential: (
    ref: string,
    context: { readonly session: SessionRef; readonly interactionId: string },
  ) => Promise<JsonValue>;
}): {
  onMessage(message: NativeMessage): Promise<void>;
  respond(input: {
    readonly session: SessionRef;
    readonly interactionId: string;
    readonly answer?: JsonValue;
    readonly credentialRef?: string;
  }): Promise<JsonValue>;
};
