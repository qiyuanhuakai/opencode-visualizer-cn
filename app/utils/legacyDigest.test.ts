import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { describe, expect, it } from 'vitest';

import { legacyDigestSync } from './legacyDigest';

/**
 * The runtime identity contract derives connection profile, environment and
 * harness instance ids from a bridge endpoint with `legacyDigestSync`. These
 * ids are persisted (connection profiles, environment bindings), so the digest
 * output must stay byte-identical to the Node `createHash('sha256')` shape this
 * helper originally used — otherwise every previously derived identity would
 * silently change and reconnect to a known bridge as a stranger.
 *
 * Node's `createHash` is the oracle here on purpose: it is the implementation
 * this helper was first written against, and the renderer has no Node crypto
 * (Vite stubs `node:crypto` to an empty module), which is exactly why the
 * packaged app crashed at startup before the helper was made browser-safe.
 */
const ORACLE = (text: string) => createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);

/** Representative seeds: every `deriveUuid` call site in App.vue. */
const SEEDS = [
  'profile:opencode:http://localhost:4096',
  'profile:codex:ws://localhost:23004/codex',
  'profile:acp:ws://localhost:23004',
  'profile:kimi-web:ws://localhost:23004/kimi-web/ws',
  'profile:dsh:ws://localhost:23004/dsh/ws',
  'profile:opencode:http://127.0.0.1:4096',
  'profile:opencode:http://192.168.1.50:4096',
  'profile:opencode:ws://bridge.example.com:23004',
  'environment:opencode:http://localhost:4096',
  'harness:profile:opencode:http://localhost:4096',
] as const;

/** Inputs that straddle every SHA-256 padding boundary (55/56/57, 63/64/65). */
const BOUNDARY_LENGTHS = [0, 1, 54, 55, 56, 57, 63, 64, 65, 119, 120, 127, 128, 129, 1000, 100000] as const;

describe('legacyDigestSync', () => {
  it('returns the same 32-hex-character digest as Node createHash for bridge endpoint seeds', () => {
    for (const seed of SEEDS) {
      expect(legacyDigestSync(seed), seed).toBe(ORACLE(seed));
    }
  });

  it('matches Node createHash across every SHA-256 block/padding boundary', () => {
    for (const length of BOUNDARY_LENGTHS) {
      const text = 'a'.repeat(length);
      expect(legacyDigestSync(text), `length ${length}`).toBe(ORACLE(text));
    }
  });

  it('matches Node createHash for multi-byte utf8 and structured seeds', () => {
    const texts = [
      '',
      'abc',
      'The quick brown fox jumps over the lazy dog',
      'héllo wörld 日本語 🎉',
      'a\u0301b',
      '\u0000\u0001\u0002',
      'x'.repeat(64),
      JSON.stringify(['profile:opencode:http://localhost:4096', 1, { nested: 'x'.repeat(500) }]),
    ];
    for (const text of texts) {
      expect(legacyDigestSync(text), JSON.stringify(text).slice(0, 60)).toBe(ORACLE(text));
    }
  });

  it('produces a 32-character lowercase hex string', () => {
    for (const seed of [...SEEDS, '']) {
      expect(legacyDigestSync(seed)).toMatch(/^[0-9a-f]{32}$/u);
    }
  });

  it('is deterministic and keeps no state between calls', () => {
    // Interleaved calls prove a fresh digest instance per call: a shared or
    // reused instance would return a chained hash for the second 'seed-a'.
    const firstA = legacyDigestSync('seed-a');
    const firstB = legacyDigestSync('seed-b');
    expect(legacyDigestSync('seed-a')).toBe(firstA);
    expect(legacyDigestSync('seed-b')).toBe(firstB);
    expect(legacyDigestSync('seed-a')).toBe(ORACLE('seed-a'));
  });

  it('does not import a Node builtin on the renderer path', () => {
    // Regression guard: the packaged renderer is served from app:// with no
    // Node integration, and Vite stubs `node:crypto` to an empty module, so any
    // such import here crashes App.vue setup with
    // `TypeError: (0, _.createHash) is not a function`.
    const source = readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'legacyDigest.ts'),
      'utf8',
    );
    expect(source).not.toMatch(/from ['"]node:/u);
    expect(source).not.toMatch(/require\(['"]node:/u);
  });
});
