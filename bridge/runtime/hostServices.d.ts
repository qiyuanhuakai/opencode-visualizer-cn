import type { JsonValue } from '../../shared/runtime/capabilities.js';
import type { RuntimeServices } from './runtimeServices.js';
import type { AcceptanceScope } from './runtimeAcceptance.js';
export interface HostContext {
  readonly target: string;
  readonly permissions: readonly string[];
  readonly workspaceKeys: readonly string[];
}
export interface HostServices {
  writerWorkspace(
    directory: string,
  ): RuntimeServices['workspace']['workspaces'][number] | undefined;
  read(input: unknown, context: HostContext): Promise<JsonValue>;
  mutate(
    input: unknown,
    context: HostContext & {
      readonly idempotencyKey: string;
      readonly onAccepted: (value: { readonly operationId: string }) => void;
    },
  ): Promise<{ readonly operationId: string; readonly value: JsonValue }>;
  observeNative(input: {
    readonly operationId: string;
    readonly scope: AcceptanceScope;
    readonly phase: string;
    readonly outcome?: string;
    readonly method: string;
  }): Promise<void> | undefined;
  close(): Promise<void>;
}
export function createHostServices(
  options: Pick<
    RuntimeServices,
    'store' | 'workspace' | 'registry' | 'authority' | 'acceptance' | 'remoteServices'
  > & {
    readonly refreshWriterHarness?: (harnessInstanceId: string) => Promise<unknown>;
    readonly ensureWriterHarness?: ReturnType<
      typeof import('./runtimeDriverFactories.js').createRuntimeDriverFactories
    >['ensureWriterHarness'];
    readonly commandWorkspaceKeys?: readonly string[];
    readonly probeWorkspace?: (key: string) => Promise<{ readonly kind: string; readonly repoKey?: string }>;
    readonly environmentId: string;
    readonly stateRoot: string;
    readonly role?: 'local' | 'manager' | 'execution';
  },
): Promise<HostServices>;
