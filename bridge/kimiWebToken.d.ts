export const KIMI_TOKEN_MISSING: 'KIMI_TOKEN_MISSING';
export const KIMI_TOKEN_UNREADABLE: 'KIMI_TOKEN_UNREADABLE';

export type KimiWebTokenErrorCode =
  | typeof KIMI_TOKEN_MISSING
  | typeof KIMI_TOKEN_UNREADABLE;

export class KimiWebTokenError extends Error {
  readonly code: KimiWebTokenErrorCode;
  constructor(code: KimiWebTokenErrorCode, message: string);
}

export type KimiWebTokenProvider = {
  getAuthorization(): string;
};

export function createKimiWebTokenProvider(options?: {
  tokenPath?: string;
}): KimiWebTokenProvider;
