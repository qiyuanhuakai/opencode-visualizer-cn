import type { Socket } from 'node:net';

export type UpstreamWebSocket = {
  readonly socket: Socket;
  readonly head: Buffer;
};

export function connectUpstreamWebSocket(
  target: string,
  authorization?: string,
  options?: {
    readonly handshakeTimeoutMs?: number;
    readonly maxHeaderBytes?: number;
  },
): Promise<UpstreamWebSocket>;
