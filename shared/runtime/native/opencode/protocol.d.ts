import type { JsonValue } from '../../capabilities.js';
export const OPEN_CODE_VERSION: '1.18.34';
export const OPEN_CODE_LIMITS: Readonly<{ page: 100; maxPage: 200; frame: 1048576; producer: 4194304; pageBytes: 524288 }>;
export interface OpenCodeSummary {
  readonly id: string; readonly projectID: string; readonly parentID?: string; readonly directory: string;
  readonly title: string; readonly version: string;
  readonly time: { readonly created: number; readonly updated: number; readonly archived?: number };
}
export interface DiscoveryScope { readonly projectID?: string; readonly directory?: string; readonly parentID?: string; readonly roots?: boolean; readonly archived?: boolean }
export function pageLimit(value?: number): number;
export function summary(value: unknown): OpenCodeSummary;
export function discoveryScope(value?: unknown): DiscoveryScope;
export function redactSettings(value: unknown): JsonValue;
export function assertNoCredentials(value: JsonValue): void;
export function nativeEvent(input: unknown): { readonly type: string; readonly properties: Readonly<Record<string, JsonValue>>; readonly directory?: string; readonly nativeEventId?: string };
