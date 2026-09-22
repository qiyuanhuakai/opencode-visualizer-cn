import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import path from 'node:path';

export const KIMI_TOKEN_MISSING = 'KIMI_TOKEN_MISSING';
export const KIMI_TOKEN_UNREADABLE = 'KIMI_TOKEN_UNREADABLE';

const DEFAULT_TOKEN_PATH = path.join(homedir(), '.kimi-code', 'server.token');

export class KimiWebTokenError extends Error {
  constructor(code, message) {
    super(message);
    this.name = 'KimiWebTokenError';
    this.code = code;
  }
}

function readTokenText(tokenPath) {
  try {
    return readFileSync(tokenPath, 'utf8');
  } catch (error) {
    const code = error && typeof error === 'object' ? error.code : undefined;
    if (code === 'EACCES' || code === 'EPERM') {
      throw new KimiWebTokenError(
        KIMI_TOKEN_UNREADABLE,
        `Kimi web token file is not readable: ${tokenPath}`,
      );
    }
    throw new KimiWebTokenError(
      KIMI_TOKEN_MISSING,
      `Kimi web token file is unavailable: ${tokenPath}`,
    );
  }
}

/**
 * Builds a lazily-reading provider for the local `kimi web` bearer token.
 *
 * The token file is re-read on every `getAuthorization()` call so that
 * `kimi web rotate-token` takes effect immediately without restarting the
 * bridge. The token value is never logged and never embedded in errors.
 */
export function createKimiWebTokenProvider({ tokenPath = DEFAULT_TOKEN_PATH } = {}) {
  return {
    getAuthorization() {
      const token = readTokenText(tokenPath).trim();
      if (!token) {
        throw new KimiWebTokenError(
          KIMI_TOKEN_MISSING,
          `Kimi web token file is empty: ${tokenPath}`,
        );
      }
      return `Bearer ${token}`;
    },
  };
}
