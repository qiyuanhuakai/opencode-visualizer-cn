import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { FollowState, HistoryPage } from '../../../shared/runtime/native/dsh/follow.js';
import type { DshTransport } from './dshTransport.js';
import type { InternalNativeHistoryHandle } from '../historyService.js';

export const DSH_HISTORY_LIMITS: Readonly<{ page: number; budgetBytes: number; chunkBytes: number }>;

export function readDshHistoryPage(options: { readonly transport: DshTransport; readonly session: SessionRef; readonly state: FollowState; readonly beforeSeq?: number; readonly throughSeq?: number; readonly limit?: number }): Promise<HistoryPage & { readonly session: SessionRef; readonly throughSeq: number; readonly generation: number; readonly revision: number }>;

/** Trusted authority captured by the driver from its owned-endpoint lease, never from caller params. */
export type DshHistoryAuthority = Readonly<{ readonly generation: number }>;
/** Live follow fence; `cursor` is the newest native seq and `-1` marks an empty session. */
export type DshHistoryFence = Readonly<{ readonly generation: number; readonly revision: number; readonly cursor: number }>;
/** One raw native history body. `release` drops the in-flight admission and settles the body. */
export type DshHistoryPull = Readonly<{ readonly body: ReadableStream<Uint8Array>; release(): void }>;
type DshHistoryObserver = Readonly<{
  next(): Promise<IteratorResult<unknown>>;
  return(): Promise<IteratorResult<unknown>>;
}>;

export function createDshHistory(options: Readonly<{
  readonly session: SessionRef;
  readonly authority: DshHistoryAuthority;
  current(): boolean;
  assertCurrent(): Promise<void>;
  fence(): DshHistoryFence;
  pullPage(request: Readonly<{ readonly before: number; readonly through: number; readonly signal?: AbortSignal }>): Promise<DshHistoryPull>;
  pullSnapshot(request: Readonly<{ readonly signal?: AbortSignal }>): Promise<DshHistoryPull>;
  subscribe(): DshHistoryObserver;
  randomUUID(): string;
}>): InternalNativeHistoryHandle;
