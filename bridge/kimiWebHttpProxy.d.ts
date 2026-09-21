import type { IncomingMessage, ServerResponse } from 'node:http';

export const KIMI_WEB_PROXY_PREFIX: '/kimi-web/';
export const KIMI_WEB_UPSTREAM_ORIGIN: 'http://127.0.0.1:58627';

export const KIMI_WEB_PROXY_PATH: 'KIMI_WEB_PROXY_PATH';
export const KIMI_WEB_TOKEN_UNAVAILABLE: 'KIMI_WEB_TOKEN_UNAVAILABLE';
export const KIMI_WEB_UPSTREAM_TIMEOUT: 'KIMI_WEB_UPSTREAM_TIMEOUT';
export const KIMI_WEB_UPSTREAM_UNREACHABLE: 'KIMI_WEB_UPSTREAM_UNREACHABLE';

export type KimiWebProxyErrorCode =
  | typeof KIMI_WEB_PROXY_PATH
  | typeof KIMI_WEB_TOKEN_UNAVAILABLE
  | typeof KIMI_WEB_UPSTREAM_TIMEOUT
  | typeof KIMI_WEB_UPSTREAM_UNREACHABLE;

export type KimiWebProxyTokenProvider = {
  getAuthorization(): string;
};

export type KimiWebProxyOptions = {
  getUpstreamAuthorization?: () => string;
  tokenProvider?: KimiWebProxyTokenProvider;
  tokenPath?: string;
  upstreamOrigin?: string;
  upstreamTimeoutMs?: number;
};

export function proxyKimiWebHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options?: KimiWebProxyOptions,
): void;
