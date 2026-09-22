import { chmodSync, mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import {
  KIMI_TOKEN_MISSING,
  KIMI_TOKEN_UNREADABLE,
  createKimiWebTokenProvider,
} from '../bridge/kimiWebToken.js';

const TOKEN_VALUE = 'unit-test-token-7f3a9c2e';
const isRoot = typeof process.getuid === 'function' && process.getuid() === 0;

const tempDirectories: string[] = [];

function createTokenPath(fileName = 'server.token'): string {
  const directory = mkdtempSync(path.join(tmpdir(), 'kimi-web-token-'));
  tempDirectories.push(directory);
  return path.join(directory, fileName);
}

function writeToken(tokenPath: string, content: string): void {
  writeFileSync(tokenPath, content, { mode: 0o600 });
}

function captureError(run: () => unknown): Error & { code?: string } {
  try {
    run();
  } catch (error) {
    return error as Error & { code?: string };
  }
  throw new Error('Expected the provider to throw, but it returned a value.');
}

afterEach(() => {
  for (const directory of tempDirectories.splice(0)) {
    rmSync(directory, { recursive: true, force: true });
  }
});

describe('createKimiWebTokenProvider', () => {
  it('reads the token file lazily on each call and returns a bearer authorization', () => {
    const tokenPath = createTokenPath();
    const provider = createKimiWebTokenProvider({ tokenPath });

    // The file does not exist when the provider is created: a provider that caches
    // at init time would be unable to serve this token.
    writeToken(tokenPath, `  ${TOKEN_VALUE}\n`);

    expect(provider.getAuthorization()).toBe(`Bearer ${TOKEN_VALUE}`);
  });

  it('returns the rotated token on the next call without restarting the provider', () => {
    const tokenPath = createTokenPath();
    const provider = createKimiWebTokenProvider({ tokenPath });

    writeToken(tokenPath, 'first-token\n');
    expect(provider.getAuthorization()).toBe('Bearer first-token');

    writeToken(tokenPath, 'second-token\n');
    expect(provider.getAuthorization()).toBe('Bearer second-token');
  });

  it('throws a typed KIMI_TOKEN_MISSING error when the token file does not exist', () => {
    const tokenPath = createTokenPath();
    const provider = createKimiWebTokenProvider({ tokenPath });

    const error = captureError(() => provider.getAuthorization());
    expect(error.code).toBe(KIMI_TOKEN_MISSING);
  });

  it.each([
    ['empty', ''],
    ['whitespace-only', '   \n\t  '],
  ])('throws KIMI_TOKEN_MISSING for a %s token file', (_label, content) => {
    const tokenPath = createTokenPath();
    const provider = createKimiWebTokenProvider({ tokenPath });
    writeToken(tokenPath, content);

    const error = captureError(() => provider.getAuthorization());
    expect(error.code).toBe(KIMI_TOKEN_MISSING);
  });

  it('throws a typed KIMI_TOKEN_MISSING error when the path is a directory', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'kimi-web-token-dir-'));
    tempDirectories.push(directory);
    const provider = createKimiWebTokenProvider({ tokenPath: directory });

    const error = captureError(() => provider.getAuthorization());
    expect(error.code).toBe(KIMI_TOKEN_MISSING);
  });

  it.skipIf(isRoot)('throws a typed KIMI_TOKEN_UNREADABLE error when the file is not readable', () => {
    const tokenPath = createTokenPath();
    writeToken(tokenPath, `${TOKEN_VALUE}\n`);
    chmodSync(tokenPath, 0o000);
    const provider = createKimiWebTokenProvider({ tokenPath });

    const error = captureError(() => provider.getAuthorization());
    expect(error.code).toBe(KIMI_TOKEN_UNREADABLE);
  });

  it('never leaks the token value into error messages or serialized errors', () => {
    const missingPath = createTokenPath();
    const missingProvider = createKimiWebTokenProvider({ tokenPath: missingPath });
    const missingError = captureError(() => missingProvider.getAuthorization());

    const unreadablePath = createTokenPath();
    writeToken(unreadablePath, `${TOKEN_VALUE}\n`);
    chmodSync(unreadablePath, 0o000);
    const unreadableProvider = createKimiWebTokenProvider({ tokenPath: unreadablePath });
    const unreadableError = captureError(() => unreadableProvider.getAuthorization());

    for (const error of [missingError, unreadableError]) {
      expect(error.message).not.toContain(TOKEN_VALUE);
      expect(String(error)).not.toContain(TOKEN_VALUE);
      expect(JSON.stringify(error)).not.toContain(TOKEN_VALUE);
      expect(error.stack ?? '').not.toContain(TOKEN_VALUE);
    }
  });
});
