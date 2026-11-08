import type { EnvironmentId, HarnessInstanceId, SessionRef } from './identity.js';
import type { JsonValue } from './capabilities.js';
import type { LegacyCapability } from './nativeExtensions.js';
export type HarnessKind = 'opencode' | 'codex' | 'acp' | 'kimi-web' | 'dsh';
export type CoreOperation = 'inspect' | 'listSessionPage' | 'getSession' | 'readHistoryPage' | 'createSession' | 'send' | 'cancel' | 'respondInteraction' | 'subscribe' | 'close';
export type OperationScope = 'instance' | 'session' | 'optional-session';
export type InspectionState = 'supported' | 'disabled' | 'missing' | 'auth-required' | 'starting' | 'ready' | 'failed';
export type Inspection = { readonly state: InspectionState; readonly protocolVersion: 1 };
export type Support = { readonly state: 'supported' } | { readonly state: 'unsupported'; readonly code: 'unsupported'; readonly reason: string };
export type HarnessScope = { readonly environmentId: EnvironmentId; readonly harnessInstanceId: HarnessInstanceId };
export type HarnessContext = HarnessScope & { readonly session?: SessionRef; readonly params: JsonValue };
export type NativeExtensionDeclaration = {
  readonly name: string;
  readonly owner: HarnessInstanceId;
  readonly scope: OperationScope;
  readonly permission: string;
  readonly schemaVersion: number;
  readonly support: Support;
};
export type HarnessManifest = HarnessScope & {
  readonly kind: HarnessKind;
  readonly protocolVersion: 1;
  readonly core: Readonly<Record<CoreOperation, Support>>;
  readonly extensions: readonly NativeExtensionDeclaration[];
  readonly capabilities: Readonly<Partial<Record<LegacyCapability, Support>>>;
};
/** All calls carry the target/instance and, for session operations, a checked SessionRef.
 * Native parameters/results remain driver-specific and are never native endpoint URLs.
 * subscribe may return an AsyncIterable; structural registration does not exercise it.
 */
export type HarnessMethod = (context: HarnessContext) => unknown;
export type HarnessDriver = {
  readonly core: Readonly<Partial<Record<CoreOperation, HarnessMethod>>>;
  readonly native: Readonly<Record<string, HarnessMethod>>;
};
export type HarnessRegistration = { readonly manifest: HarnessManifest; readonly driver: HarnessDriver };
export type HarnessInvocation = HarnessContext & {
  readonly channel: 'core' | 'native';
  readonly operation: string;
  readonly permissions?: readonly string[];
};
export interface HarnessRegistry {
  register(input: HarnessRegistration): HarnessManifest;
  list(): readonly HarnessManifest[];
  invoke(input: HarnessInvocation): Promise<unknown>;
}
export const HARNESS_KINDS: readonly HarnessKind[];
export const CORE_OPERATIONS: Readonly<Record<CoreOperation, OperationScope>>;
export const INSPECTION_STATES: readonly InspectionState[];
export function unsupported(reason: string): Support;
export function validateHarnessManifest(input: unknown): HarnessManifest;
export function validateHarnessRegistration(input: unknown): HarnessRegistration;
export function createHarnessRegistry(): HarnessRegistry;
