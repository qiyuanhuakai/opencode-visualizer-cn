import type { IncomingMessage } from 'node:http';

export type RawHttpSocket = {
  write(data: string | Buffer): boolean;
  end(data?: string | Buffer): unknown;
  destroy(error?: Error): unknown;
};

export function writeHttpResponse(
  socket: RawHttpSocket,
  statusCode: number,
  statusText: string,
  body: unknown,
  headers?: Readonly<Record<string, string>>,
): void;
export function isAuthorized(request: IncomingMessage, bridgeToken?: string): boolean;
export function isAllowedOrigin(origin?: string, bridgeToken?: string): boolean;
export function assertWebSocketRequest(request: IncomingMessage): string;
