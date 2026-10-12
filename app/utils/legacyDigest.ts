import { createHash } from 'node:crypto';

/**
 * Task 24 — a synchronous UUID-shaped digest for deriving stable runtime
 * identities from a bridge endpoint.
 *
 * The runtime identity contract requires UUID-shaped ids for connection
 * profiles, environments and harness instances. A bridge endpoint must map to
 * exactly one of each so that switching targets changes the qualified identity
 * of every workspace action deterministically, and reconnecting to the same
 * endpoint yields the same identity. The shared `legacyDigest` is async
 * because it is allowed to use SubtleCrypto; the runtime ids are needed during
 * synchronous component setup, so this helper uses Node's sync digest with the
 * same 32-hex-character shape.
 */
export function legacyDigestSync(text: string): string {
  return createHash('sha256').update(text, 'utf8').digest('hex').slice(0, 32);
}
