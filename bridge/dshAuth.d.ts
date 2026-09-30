export const DSH_AUTH_EXCHANGE_FAILED: 'DSH_AUTH_EXCHANGE_FAILED';
export const DSH_COOKIE_MISSING: 'DSH_COOKIE_MISSING';

export type DshAuthErrorCode =
  | typeof DSH_AUTH_EXCHANGE_FAILED
  | typeof DSH_COOKIE_MISSING;

export class DshAuthError extends Error {
  readonly code: DshAuthErrorCode;
  constructor(code: DshAuthErrorCode, message: string);
}

/** Cookie name dsh derives from an authority: `dsh-auth-<base64url(sha256(authority))>`. */
export function computeDshAuthCookieName(authority: string): string;

export type DshExchangeRequest = {
  readonly authority: string;
  readonly launchToken: string;
};

export type DshExchangeResult = {
  readonly status: number;
  readonly setCookie: readonly string[];
};

export function createNodeDshExchange(options?: {
  readonly timeoutMs?: number;
}): (request: DshExchangeRequest) => Promise<DshExchangeResult>;

export type DshAuthProvider = {
  getCookie(authority: string): Promise<string>;
  invalidate(authority: string): boolean;
};

export function createDshAuthProvider(options?: {
  readonly exchange?: (request: DshExchangeRequest) => Promise<unknown>;
  readonly getLaunchToken: () => string | null | undefined;
  readonly now?: () => number;
}): DshAuthProvider;
