import type { IncomingMessage, ServerResponse } from 'node:http';

export const DSH_HTTP_PROXY_PREFIX: '/dsh/';
export const DSH_HTTP_UPSTREAM_ORIGIN: 'http://127.0.0.1:3080';

export const DSH_HTTP_PROXY_PATH: 'DSH_HTTP_PROXY_PATH';
export const DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE: 'DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE';
export const DSH_HTTP_UPSTREAM_TIMEOUT: 'DSH_HTTP_UPSTREAM_TIMEOUT';
export const DSH_HTTP_UPSTREAM_UNREACHABLE: 'DSH_HTTP_UPSTREAM_UNREACHABLE';

export type DshHttpProxyErrorCode =
  | typeof DSH_HTTP_PROXY_PATH
  | typeof DSH_HTTP_UPSTREAM_COOKIE_UNAVAILABLE
  | typeof DSH_HTTP_UPSTREAM_TIMEOUT
  | typeof DSH_HTTP_UPSTREAM_UNREACHABLE;

export type DshUpstreamCookieGetter = () => string | Promise<string>;

export type DshHttpProxyOptions = {
  getUpstreamCookie?: DshUpstreamCookieGetter;
  upstreamOrigin?: string;
  upstreamTimeoutMs?: number;
};

export function proxyDshHttp(
  request: IncomingMessage,
  response: ServerResponse,
  options?: DshHttpProxyOptions,
): void;
