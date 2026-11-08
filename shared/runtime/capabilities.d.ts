import type { HarnessInstanceId } from './identity.js';
export type JsonValue = null | boolean | number | string | readonly JsonValue[] | { readonly [key: string]: JsonValue };
export type ErrorCode = 'invalid_request' | 'unsupported' | 'version_mismatch' | 'unauthorized' | 'conflict' | 'cancelled' | 'timeout' | 'source_unavailable' | 'reconcile_required' | 'replay_required';
export const ERROR_CODES: readonly ErrorCode[];
export class ProtocolError extends TypeError {
  readonly code: ErrorCode;
  readonly field: string;
  constructor(code: ErrorCode, field: string);
}
export type Method = 'runtime.inspect' | 'runtime.snapshot' | 'runtime.replay'
  | 'session.list' | 'session.get' | 'session.history' | 'session.create' | 'session.send'
  | 'session.cancel' | 'interaction.respond' | 'session.subscribe' | 'session.close'
  | 'session.rename' | 'session.archive' | 'session.delete' | 'session.fork' | 'session.revert'
  | 'session.compact' | 'harness.models' | 'harness.providers' | 'harness.auth' | 'harness.settings'
  | 'harness.skills' | 'harness.mcp' | 'harness.commands' | 'harness.usage' | 'native.extension';
export const METHODS: Readonly<Record<Method, 'read' | 'mutation'>>;
export type NativeExtension = {
  readonly owner: HarnessInstanceId;
  readonly name: string;
  readonly permission: string;
  readonly schemaVersion: number;
  readonly metadata: JsonValue;
};
export type Capabilities = { readonly methods: readonly Method[]; readonly extensions: readonly NativeExtension[] };
export type ExtensionAuthorization = { readonly owner: HarnessInstanceId; readonly name: string; readonly permissions: readonly string[] };
/** Unknown native schema metadata is retained as data; this grants no executable dispatch. */
export function parseCapabilities(input: unknown): Capabilities;
export function authorizeExtension(input: unknown, authorization: ExtensionAuthorization): NativeExtension;
export function requireValue(condition: boolean, field: string, code?: ErrorCode): asserts condition;
export function objectFields(value: unknown, required: readonly string[], optional?: readonly string[]): Readonly<Record<string, unknown>>;
export function textValue(value: unknown, field: string): string;
export function integerValue(value: unknown, field: string, max?: number): number;
export function jsonValue(value: unknown, depth?: number): JsonValue;
