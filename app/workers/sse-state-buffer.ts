import type { SsePacket } from '../types/sse';

export type BufferedStatePacket = {
  packet: SsePacket;
  bytes: number;
};

type BufferedStateOwner = {
  bufferedStatePackets: BufferedStatePacket[];
  bufferedStatePacketBytes: number;
  bufferedStateOverflowed: boolean;
};

const MAX_BUFFERED_STATE_PACKETS = 2_000;
const MAX_BUFFERED_STATE_BYTES = 4 * 1024 * 1024;

export function clearBufferedStatePackets(state: BufferedStateOwner): void {
  state.bufferedStatePackets = [];
  state.bufferedStatePacketBytes = 0;
}

export function bufferStatePacket(state: BufferedStateOwner, packet: SsePacket): void {
  const serialized = JSON.stringify(packet);
  if (serialized === undefined) return;
  const bytes = new TextEncoder().encode(serialized).byteLength;
  if (bytes > MAX_BUFFERED_STATE_BYTES) {
    state.bufferedStateOverflowed = true;
    return;
  }

  state.bufferedStatePackets.push({ packet, bytes });
  state.bufferedStatePacketBytes += bytes;
  while (
    state.bufferedStatePackets.length > MAX_BUFFERED_STATE_PACKETS ||
    state.bufferedStatePacketBytes > MAX_BUFFERED_STATE_BYTES
  ) {
    const oldest = state.bufferedStatePackets.shift();
    if (!oldest) break;
    state.bufferedStatePacketBytes -= oldest.bytes;
    state.bufferedStateOverflowed = true;
  }
}
