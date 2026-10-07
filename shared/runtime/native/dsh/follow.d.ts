import type { JsonValue } from '../../capabilities.js';
export interface HistoryFence { readonly generation: number; readonly revision: number; readonly cursor: number }
export interface FollowInspection extends HistoryFence { readonly version: number | undefined; readonly phase: 'live' | 'rebuilding' | 'degraded' }
export interface FollowState {
  inspect(): FollowInspection;
  disconnect(): void;
  rebuild(): number;
  ingest(value: unknown, generation: number): { readonly action: 'drop' } | { readonly action: 'snapshot' | 'event'; readonly value: JsonValue };
  historyFence(): HistoryFence;
  assertHistory(fence: HistoryFence): void;
}
export interface HistoryPage {
  readonly records: readonly JsonValue[]; readonly nativeHasMore: boolean; readonly cursor: number | null;
  readonly completeness: 'partial' | 'complete';
}
export function createFollowState(): FollowState;
export function historyPage(value: unknown, throughSeq: number, beforeSeq: number, limit: number): HistoryPage;
