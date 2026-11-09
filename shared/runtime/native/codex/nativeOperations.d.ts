import type { HarnessContext, HarnessMethod } from '../../harnessContract.js';
import type { JsonValue } from '../../capabilities.js';
import type { SessionRef } from '../../identity.js';
import type { AppServerClient } from './appServerClient.js';
import type { CodexSessionOperations } from './sessionOperations.js';
import type { createInstanceOperations } from './instanceOperations.js';
import type { createCodexControls } from './controlOperations.js';
import type { CodexCatalog } from './catalog.js';
export function createCodexNativeOperations(options: {
  readonly request: AppServerClient['request'];
  readonly sessions: CodexSessionOperations;
  readonly instance: ReturnType<typeof createInstanceOperations>;
  readonly validateContext: (context: HarnessContext, sessionRequired?: boolean) => void;
  readonly catalog: CodexCatalog;
  readonly summary: CodexCatalog['summary'];
  readonly steer: ReturnType<typeof createCodexControls>;
  readonly resolveCredential: (
    ref: string,
    context: { readonly operation: string },
  ) => Promise<JsonValue>;
  readonly privacy: (value: unknown) => JsonValue;
  readonly authorizeSession: (session: SessionRef) => Promise<string>;
}): Readonly<Record<string, HarnessMethod>>;
