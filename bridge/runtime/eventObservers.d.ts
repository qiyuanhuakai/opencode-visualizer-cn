import type { Binding, RuntimeEvent, Chunk, BinaryInput } from '../../shared/runtime/protocol.js';
export type ObserverDelivery = { readonly kind: 'event' | 'control'; readonly frame: RuntimeEvent }
  | { readonly kind: 'replay_required'; readonly after: number; readonly through: number; readonly reason: string }
  | ({ readonly kind: 'binary'; readonly encoded: Uint8Array } & Chunk);
export interface EventObserver {
  readonly binding: Binding;
  push(frame: RuntimeEvent, priority?: boolean): void;
  recover(reason: string): void;
  read(): ObserverDelivery | null;
  resume(afterReplay: number): void;
  openChannel(channelId: number): void;
  sendBinary(input: BinaryInput): Chunk;
  acknowledgeChunk(chunk: Chunk): void;
  closeChannel(channelId: number): void;
  close(): void;
  readonly state: { readonly bytes: number; readonly normal: number; readonly control: number; readonly bulk: number; readonly inflight: number; readonly through: number; readonly consumed: number; readonly recovery: string | null; readonly closed: boolean };
}
export const OBSERVER_LIMITS: Readonly<{ bytes: 8388608; normalBytes: 6291456; controlBytes: 1048576; normalFrames: 256; controlFrames: 64; observers: 64 }>;
export function createEventObserver(options: { readonly binding: Binding; readonly after: number; readonly isCurrent: () => boolean; readonly onClose: () => void }): EventObserver;
