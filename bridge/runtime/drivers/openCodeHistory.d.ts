import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { InternalNativeHistoryHandle } from '../historyService.js';
/** Trusted authority captured by the driver from its own construction, never from caller params. */
export type OpenCodeHistoryAuthority = Readonly<{ readonly epoch: string; readonly processGeneration: number }>;
/** One raw native HTTP history response. `release` drops the driver's admission slot and settles the body. */
export type OpenCodeHistoryPull = Readonly<{
  readonly body: ReadableStream<Uint8Array>;
  readonly cursor: string | null;
  release(): void;
}>;
type OpenCodeNativeEvent = Readonly<{ readonly type: string; readonly session?: SessionRef }>;
type OpenCodeObserver = Readonly<{
  next(): Promise<IteratorResult<unknown>>;
  return(): Promise<IteratorResult<unknown>>;
}>;
export function createOpenCodeHistory(options: Readonly<{
  readonly session: SessionRef;
  readonly authority: OpenCodeHistoryAuthority;
  current(): boolean;
  assertCurrent(): Promise<void>;
  subscribe(predicate: (event: OpenCodeNativeEvent) => boolean): OpenCodeObserver;
  pull(request: Readonly<{ readonly before: string | null; readonly signal?: AbortSignal }>): Promise<OpenCodeHistoryPull>;
  randomUUID(): string;
}>): InternalNativeHistoryHandle;
