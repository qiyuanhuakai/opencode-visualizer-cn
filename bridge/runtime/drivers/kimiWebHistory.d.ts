import type { SessionRef } from '../../../shared/runtime/identity.js';
import type { KimiWebTransport } from './kimiWebTransport.js';
import type { KimiCursor, KimiFrame, NativeRecord } from '../../../shared/runtime/native/kimiWeb/protocol.js';
import type { KimiTranscript } from '../../../shared/runtime/native/kimiWeb/transcript.js';
import type { InternalNativeHistoryHandle } from '../historyService.js';
export interface KimiHistoryPage {
  readonly agentId: string; readonly items: readonly NativeRecord[];
  readonly tasks: readonly NativeRecord[]; readonly interactions: readonly NativeRecord[]; readonly agents: readonly NativeRecord[];
  readonly metadata: NativeRecord; readonly cursor: string | null; readonly completeness: 'complete' | 'partial';
  readonly transcriptSeq: number; readonly durableCursor: KimiCursor | null;
}
export interface KimiWebHistory {
  selected(sessionId: string, agentId?: string): unknown;
  receive(frame: KimiFrame, connection: number): boolean;
  read(sessionId: string, options?: { readonly agentId?: string; readonly cursor?: string; readonly limit?: number; readonly signal?: AbortSignal }): Promise<KimiHistoryPage>;
  recover(sessionId: string): Promise<{ readonly cursor: KimiCursor; readonly recovered: true }>;
  cursor(sessionId: string): KimiCursor | undefined;
  transcriptCursors(sessionId: string): Readonly<Record<string, number>>;
  inspect(sessionId: string, agentId?: string): { readonly cursor: KimiCursor | null; readonly transcriptSeq: number | null; readonly snapshot: KimiTranscript; readonly recovering: boolean };
  clear(): void;
}
export function createKimiWebHistory(options: { readonly transport: KimiWebTransport; readonly onRecovered?: (sessionId: string, value: { readonly cursor: KimiCursor; readonly buffered: number }) => void }): KimiWebHistory;

/** Trusted authority captured by the driver from its own construction, never from caller params. */
export type KimiHistoryAuthority = Readonly<{ readonly epoch: string; readonly processGeneration: number }>;
/** One raw native transcript body. `release` drops the driver's admission slot and settles the body. */
export type KimiHistoryPull = Readonly<{
  readonly body: AsyncIterable<Uint8Array>;
  release(): void;
}>;
type KimiNativeEvent = Readonly<{ readonly type?: string; readonly session?: SessionRef }>;
type KimiObserver = Readonly<{
  next(): Promise<IteratorResult<unknown>>;
  return(): Promise<IteratorResult<unknown>>;
}>;
export const KIMI_WEB_HISTORY_LIMITS: Readonly<{ page: 200; chunkBytes: 65536 }>;
export function createKimiWebHistoryProducer(options: Readonly<{
  readonly session: SessionRef;
  readonly authority: KimiHistoryAuthority;
  current(): boolean;
  assertCurrent(): Promise<void>;
  pull(request: Readonly<{ readonly before: string | null; readonly signal?: AbortSignal }>): Promise<KimiHistoryPull>;
  subscribe(predicate: (event: KimiNativeEvent) => boolean): KimiObserver;
  releaseOwner(): void | Promise<void>;
  sessionEpoch(): string | undefined;
  randomUUID(): string;
}>): InternalNativeHistoryHandle;
