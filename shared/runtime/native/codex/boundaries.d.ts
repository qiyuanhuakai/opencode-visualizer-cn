import type { JsonValue } from '../../capabilities.js';
export function record(value: unknown, field?: string): Readonly<Record<string, unknown>>;
export function fields(
  value: unknown,
  allowed: readonly string[],
): Readonly<Record<string, unknown>>;
export function nativeArguments(value: unknown, allowed: readonly string[]): JsonValue;
export function createPrivacy(secrets?: readonly string[]): (value: unknown) => JsonValue;
export function rejectSecretInput(value: unknown): void;
