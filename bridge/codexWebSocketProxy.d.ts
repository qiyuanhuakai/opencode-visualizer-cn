import type { Socket } from 'node:net';

export type UpstreamWebSocket = {
  readonly socket: Socket;
  readonly head: Buffer;
};

export type UpstreamAuthorization = string | (() => string);

export function connectUpstreamWebSocket(
  target: string,
  authorization?: UpstreamAuthorization,
  options?: {
    readonly handshakeTimeoutMs?: number;
    readonly maxHeaderBytes?: number;
  },
): Promise<UpstreamWebSocket>;
