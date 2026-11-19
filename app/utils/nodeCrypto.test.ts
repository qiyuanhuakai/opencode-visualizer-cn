/**
 * The `node:crypto` realm seam.
 *
 * The seam is load-bearing in both directions: in a Node realm it must hand back
 * the REAL builtin (the bridge, its SEA bundle, the workers and every test that
 * imports `node:crypto` transitively must keep using it), and in a browser realm
 * it must supply primitives the landed Thread / Handoff / collaboration services
 * can call. A test that runs in a Node realm can only prove the first half and
 * the browser branch directly, so it does both.
 */
import { createHash, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';

import { createBrowserHash, randomUUID as seamRandomUUID, createHash as seamCreateHash } from './nodeCrypto';

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-4[\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/;

describe('the node:crypto seam', () => {
  it('hands the real builtin back in a Node realm, so nothing downstream is shadowed', () => {
    // Given/When: the seam's primitives are used in this realm.
    const seamHash = seamCreateHash('sha256').update('vis-runtime').digest('hex');
    const nodeHash = createHash('sha256').update('vis-runtime').digest('hex');

    // Then: they are Node's own, byte for byte, and the UUID is a real v4.
    expect(seamHash).toBe(nodeHash);
    expect(seamRandomUUID()).toMatch(UUID_PATTERN);
    expect(randomUUID()).toMatch(UUID_PATTERN);
  });

  it('digests a multi-update input as the concatenation, like the builtin does', () => {
    const seam = seamCreateHash('sha256').update('one-').update('two').digest('hex');
    const builtin = createHash('sha256').update('one-').update('two').digest('hex');
    expect(seam).toBe(builtin);
  });

  it('supplies a browser sha256 that matches the product pinned digest for a known vector', () => {
    // "abc" is the FIPS-180 SHA-256 test vector; the browser branch is backed by
    // the product's own pure SHA-256, so it must produce exactly this.
    expect(createBrowserHash('sha256').update('abc').digest('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    expect(createBrowserHash('sha256').update('a').update('bc').digest('hex')).toBe(
      'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
  });

  it('refuses an algorithm the browser branch does not implement instead of guessing', () => {
    expect(() => createBrowserHash('md5')).toThrowError(/unsupported hash algorithm/u);
  });
});
