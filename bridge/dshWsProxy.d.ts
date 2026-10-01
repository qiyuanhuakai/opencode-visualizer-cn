import type { IncomingMessage } from 'node:http';
import type { Duplex } from 'node:stream';

export const DSH_WS_PATH: '/dsh/ws';
export const DSH_WS_TARGET: string;

/**
 * Resolves the `Cookie` header value for the dsh upstream mux endpoint, one
 * dial at a time. Implemented on top of bridge/dshAuth.js (`getCookie`), so it
 * may reject with a typed DshAuthError (`DSH_COOKIE_MISSING` /
 * `DSH_AUTH_EXCHANGE_FAILED`); the upgrade is then rejected without dialing.
 */
export type DshUpstreamCookieProvider = () => string | Promise<string>;

export type DshUpgradeOptions = {
  readonly host?: string;
  readonly bridgeToken?: string;
  readonly target?: string;
  readonly getUpstreamCookie?: DshUpstreamCookieProvider;
  readonly handshakeTimeoutMs?: number;
};

export function handleDshUpgrade(
  request: IncomingMessage,
  socket: Duplex,
  head: Buffer,
  options?: DshUpgradeOptions,
): boolean;
