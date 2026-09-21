import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const KIMI_WEB_WS_PATH: '/kimi-web/ws';
export const KIMI_WEB_WS_TARGET: string;

export type KimiWebUpgradeOptions = {
  readonly host?: string;
  readonly bridgeToken?: string;
  readonly target?: string;
  readonly getUpstreamAuthorization?: () => string;
  readonly handshakeTimeoutMs?: number;
};

export function handleKimiWebUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options?: KimiWebUpgradeOptions,
): boolean;
