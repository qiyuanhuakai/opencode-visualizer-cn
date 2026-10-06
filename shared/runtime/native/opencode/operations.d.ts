import type { SessionRef } from '../../identity.js';
import type { JsonValue } from '../../capabilities.js';
import type { RuntimeStore, Json } from '../../../../bridge/runtime/storage/runtimeStore.js';
import type { OperationScope } from '../../../../bridge/runtime/operationJournal.js';
import type { ProcessGuard } from './instanceOperations.js';
export type OpenCodeNativeOperation = 'forkSession' | 'updateSession' | 'deleteSession' | 'revertSession' | 'unrevertSession'
  | 'getSessionDiff' | 'getSessionChildren' | 'getSessionMessage' | 'getSessionTodos' | 'sendCommand' | 'patchMessagePart'
  | 'getGlobalConfig' | 'updateGlobalConfig' | 'listProviders' | 'listProviderAuthMethods' | 'authorizeProviderOAuth'
  | 'completeProviderOAuth' | 'setProviderAuth' | 'deleteProviderAuth' | 'listAgents' | 'listCommands' | 'getSessionStatusMap'
  | 'listPendingPermissions' | 'listPendingQuestions' | 'getMcpStatus' | 'getLspStatus' | 'updateMcp' | 'getSkillStatus';
export interface NativeRoute { readonly method: 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE'; readonly scope: 'instance' | 'session'; readonly path: string; readonly redact?: boolean }
export const OPEN_CODE_OPERATIONS: Readonly<Record<OpenCodeNativeOperation, Omit<NativeRoute, 'path'> & { readonly path?: string; readonly suffix?: string }>>;
export function nativeRoute(name: OpenCodeNativeOperation, session: SessionRef | undefined, params: Readonly<Record<string, JsonValue>>): NativeRoute;
export function supportsNativeRoute(document: unknown, name: OpenCodeNativeOperation): boolean;
export interface OpenCodeCancellation {
  readonly kind: 'opencode-cancellation'; readonly scope: OperationScope; readonly operationId: string;
  readonly intentId: string; readonly idempotencyKey: string; readonly digest: string;
  readonly phase: 'accepted' | 'sent' | 'observed' | 'reconciling';
}
export function cancelOwnedOperation(options: {
  readonly store: RuntimeStore; readonly scope: OperationScope; readonly operationId: string; readonly idempotencyKey: string;
  readonly authority: () => Promise<ProcessGuard>; readonly current: () => boolean; readonly fingerprint: (value: Json) => string; readonly randomUUID: () => string;
  readonly send: () => Promise<unknown>; readonly reconcile: () => Promise<unknown>;
}): Promise<{ readonly phase: 'native-executed'; readonly operationId: string; readonly cancelRequested: true }>;
/** IDs are path parameters; body is native JSON. Credentials use a server-resolved reference, never inline secrets. */
export interface OpenCodeNativeParams {
  readonly directory?: string; readonly workspace?: string; readonly messageID?: string; readonly partID?: string; readonly providerID?: string;
  readonly body?: JsonValue; readonly credentialRef?: string; readonly processGeneration?: number; readonly idempotencyKey?: string;
}
