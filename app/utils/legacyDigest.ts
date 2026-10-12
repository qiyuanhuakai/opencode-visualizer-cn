import { DraftDigest } from '../runtime/migration/draftChunks';

const encoder = new TextEncoder();

/**
 * Task 24 — a synchronous UUID-shaped digest for deriving stable runtime
 * identities from a bridge endpoint.
 *
 * The runtime identity contract requires UUID-shaped ids for connection
 * profiles, environments and harness instances. A bridge endpoint must map to
 * exactly one of each so that switching targets changes the qualified identity
 * of every workspace action deterministically, and reconnecting to the same
 * endpoint yields the same identity.
 *
 * This runs inside the renderer during synchronous Vue component setup
 * (`App.vue`'s `deriveUuid`), where the page is served from `app://` with no
 * Node integration: Vite stubs `node:crypto` to an empty module, so
 * `createHash` is `undefined` and every call threw
 * `TypeError: (0, _.createHash) is not a function` at startup. SubtleCrypto is
 * async and therefore cannot serve a synchronous `computed()` either.
 *
 * The repo's existing pure-JS `DraftDigest` (draftChunks.ts) computes SHA-256
 * synchronously in the browser and is already pinned byte-for-byte against
 * `createHash('sha256')` by the draft-store tests, so reusing it keeps the
 * digest output — and therefore every previously derived identity — identical.
 */
export function legacyDigestSync(text: string): string {
  const digest = new DraftDigest();
  digest.update(encoder.encode(text));
  return digest.finish().slice(0, 32);
}
