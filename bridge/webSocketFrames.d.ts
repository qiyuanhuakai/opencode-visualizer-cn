import type { EventEmitter } from 'node:events';

export type DecodedWebSocketFrame = {
  fin: boolean;
  opcode: number;
  masked: boolean;
  payload: Buffer;
};

export type RawWebSocketPeer = EventEmitter & {
  send(message: string): void;
  close(code?: number, reason?: string): void;
};

export type RawWebSocketSocket = {
  write(data: string | Buffer): unknown;
  end(data?: string | Buffer): unknown;
  destroy(): unknown;
  on(event: 'data', listener: (chunk: Buffer) => void): unknown;
  once(event: 'close' | 'error', listener: () => void): unknown;
};

export function createWebSocketAccept(secWebSocketKey: string): string;
export function encodeWebSocketFrame(data: string | Buffer, opcode?: number): Buffer;
export function decodeWebSocketFrames(buffer: Buffer, options?: { maxPayloadBytes?: number }): {
  frames: DecodedWebSocketFrame[];
  remaining: Buffer;
};
export function createRawWebSocketPeer(
  socket: RawWebSocketSocket,
  head?: Buffer,
  options?: { heartbeatIntervalMs?: number },
): RawWebSocketPeer;
