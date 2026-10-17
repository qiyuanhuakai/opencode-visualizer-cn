import type { JsonValue } from '../../capabilities.js';
import type { HarnessScope } from '../../harnessContract.js';
import type { SessionRef } from '../../identity.js';
export { ProtocolError as DshError } from '../../capabilities.js';
export function fail(code: string, reason: string): never;
export function record(value: unknown): Record<string, unknown>;
export function text(value: unknown): string;
export function integer(value: unknown, min?: number, max?: number): number;
export function request(method: string, args: unknown, rpcId: string): JsonValue;
export function response(value: unknown, rpcId: string): JsonValue;
export function muxFrame(value: unknown): { readonly type: 'item' | 'end' | 'error'; readonly streamId: string; readonly value?: JsonValue; readonly error?: { readonly code: string } };
export type ApprovalAnswer = 'allowed-once' | 'rejected' | 'unavailable';
export type ApprovalOutcome = { readonly kind: 'result'; readonly value: 'allowed-once' | 'rejected' } | { readonly kind: 'rejected'; readonly error: { readonly name: string; readonly message: string } };
export function approvalOutcome(value: unknown): ApprovalOutcome;
export interface DshSummary {
  readonly session: SessionRef; readonly title: string; readonly directory: string | null;
  readonly workspaceId: string | null; readonly archived: boolean; readonly pinned: boolean;
  readonly createdAt: JsonValue; readonly updatedAt: JsonValue;
}
export function summaries(value: unknown, baseline: unknown, identity: HarnessScope): readonly DshSummary[];
export function selectModel(catalog: unknown, selection: unknown): { readonly provider: string; readonly model: string; readonly reasoningEffort?: string };
