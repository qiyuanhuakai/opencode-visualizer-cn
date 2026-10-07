import type { JsonValue } from '../../capabilities.js';
import type { HarnessScope } from '../../harnessContract.js';
import type { SessionRef } from '../../identity.js';
export type NativeRecord = { readonly [key: string]: JsonValue };
export interface KimiCursor { readonly epoch: string; readonly seq: number }
export interface KimiFrame {
  readonly type: string; readonly id?: string; readonly code?: number;
  readonly seq?: number; readonly epoch?: string; readonly offset?: number;
  readonly session_id?: string; readonly volatile?: boolean; readonly payload?: NativeRecord;
}
export interface KimiCapabilities {
  readonly catalogV2: boolean; readonly transcript: boolean; readonly snapshot: boolean;
  readonly subscribeV2: boolean; readonly subscribe: boolean; readonly create: boolean;
  readonly send: boolean; readonly cancel: boolean; readonly approvals: boolean;
  readonly questions: boolean; readonly models: boolean; readonly agents: boolean; readonly status: boolean;
}
export interface KimiSessionSummary {
  readonly session: SessionRef; readonly title: string; readonly directory: string | null;
  readonly nativeWorkspaceId: string | null; readonly archived: boolean;
  readonly updatedAt: JsonValue; readonly status: string; readonly parentSession?: SessionRef;
}
export interface KimiCatalogPage {
  readonly items: readonly NativeRecord[]; readonly cursor: string | null;
  readonly completeness: 'partial' | 'complete';
}
export function record(value: unknown, reason?: string): NativeRecord;
export function nativeText(value: unknown, reason?: string, maximum?: number): string;
export function nativeInteger(value: unknown, reason?: string): number;
export function pageSize(value?: unknown): number;
export function parseFrame(value: unknown): KimiFrame;
export function updateDurableCursor(current: KimiCursor | undefined, frame: KimiFrame): KimiCursor | undefined;
export function parseAck(frame: KimiFrame): { readonly payload: NativeRecord; readonly resync: readonly string[] };
export function parseCatalogPage(value: unknown, previousCursor?: string | null, limit?: number, grouped?: boolean): KimiCatalogPage;
export function sessionSummary(value: unknown, scope: HarnessScope): KimiSessionSummary;
export function parseNativeCapabilities(meta: unknown, openapi: unknown, asyncapi: unknown): KimiCapabilities;
export function recoverSnapshotFrames(snapshot: { readonly epoch: string; readonly as_of_seq: number; readonly in_flight_turn?: { readonly assistant_text: string; readonly thinking_text: string } | null }, buffered: readonly KimiFrame[]): readonly KimiFrame[];
