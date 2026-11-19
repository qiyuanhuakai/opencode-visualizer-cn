import type { Binding } from '../../shared/runtime/protocol.js';
import type { JsonObject } from '../../shared/runtime/runtimeWire.js';
import type { HistoryCapabilities, HistoryFence, HistoryOpenParams, HistoryOpenResult, HistoryPageParams, HistoryPage, HistoryChunkParams, HistoryChunk, HistoryReadParams, HistoryChange, HistoryCloseParams } from '../../shared/runtime/historyPage.js';
import type { createHistoryStream, HistoryChunk as StreamChunk } from './historyStream.js';
export type HistoryStreamStore = ReturnType<typeof createHistoryStream>;
/** Inert until open. Every method checks the captured native authority after awaits.
 * close cancels pending reads/open, settles their IO, and releases only this history owner.
 * page releases the requested owned pages before allocating one staging page.
 */
export type InternalNativeHistoryHandle = Readonly<{
  capabilities: HistoryCapabilities;
  open(resources: Readonly<{ signal: AbortSignal; streamStore: HistoryStreamStore }>): Promise<Readonly<{ fence: HistoryFence; reason?: string }>>;
  page(request: Readonly<{ cursor?: string; releasePageIds?: readonly string[]; signal: AbortSignal }>): Promise<Omit<HistoryPage, 'historyId' | 'session' | 'fence'>>;
  chunk(request: Readonly<{ pageId: string; descriptorId: string; offset: number; signal: AbortSignal }>): Promise<StreamChunk>;
  read(request: Readonly<{ after: number; signal: AbortSignal }>): Promise<Omit<HistoryChange, 'historyId' | 'fence'>>;
  close(): Promise<void>;
}>;
export function createHistoryService(options: Readonly<{
  binding: Binding;
  authorize(params: HistoryOpenParams): Promise<JsonObject>;
  openProducer(params: HistoryOpenParams, authority: JsonObject): Promise<InternalNativeHistoryHandle>;
}>): Readonly<{
  open(params: HistoryOpenParams): Promise<HistoryOpenResult>;
  page(params: HistoryPageParams): Promise<HistoryPage>;
  chunk(params: HistoryChunkParams): Promise<HistoryChunk>;
  read(params: HistoryReadParams): Promise<HistoryChange>;
  close(params: HistoryCloseParams): Promise<Readonly<{ closed: true }>>;
  dispose(): Promise<void>;
}>;
