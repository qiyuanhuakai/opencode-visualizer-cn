/**
 * The runtime's ONE id source, and the reason it is not `node:crypto`.
 *
 * The thread and participant services mint their ids here. They used to import
 * `randomUUID` from `node:crypto`, and that import is what pushed both services
 * out of the browser bundle: Vite/Rolldown externalizes `node:crypto` for the
 * browser and leaves an empty module behind, so a real browser held no
 * `randomUUID` at all and opening a Host Thread failed the moment a thread or
 * participant id was minted — while the build still succeeded and the unit
 * tests (Node realm) still passed.
 *
 * `globalThis.crypto` is the Web Crypto API: every browser exposes it, and Node
 * has provided it as a global since v19, so this module imports NOTHING and is
 * safe in every realm the runtime services execute in — the browser app, the
 * bridge process, the QA browser harness and the test runner alike.
 */

/**
 * Mint an RFC-4122 v4 UUID from the realm's own Web Crypto.
 *
 * `crypto.randomUUID` is the primary path. The `getRandomValues` fallback keeps
 * an embedder that predates `randomUUID` working without degenerating into a
 * guessable counter; a realm with neither is refused loudly rather than handing
 * out predictable ids.
 */
export function webCryptoUuid() {
  const webcrypto = globalThis.crypto;
  if (webcrypto !== undefined && webcrypto !== null) {
    if (typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
    if (typeof webcrypto.getRandomValues === 'function') {
      const bytes = new Uint8Array(16);
      webcrypto.getRandomValues(bytes);
      bytes[6] = (bytes[6] & 0x0f) | 0x40;
      bytes[8] = (bytes[8] & 0x3f) | 0x80;
      const hex = Array.from(bytes, (byte) => byte.toString(16).padStart(2, '0')).join('');
      return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
    }
  }
  throw new Error('runtime.ids: no Web Crypto is available in this realm; ids cannot be minted safely');
}
