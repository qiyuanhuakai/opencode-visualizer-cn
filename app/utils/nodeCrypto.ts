/**
 * The `node:crypto` seam for realms that are not Node.
 *
 * The landed Thread / Handoff / collaboration services
 * (`bridge/runtime/threads/*`, `bridge/runtime/collaboration/*`) are pure
 * state machines whose ONLY Node dependency is `node:crypto`, and the app-side
 * seat of those services (see `app/runtime/threadPorts.ts` and
 * `collaborationPorts.ts`, whose headers state they compose the landed services
 * through narrow ports) runs them in the renderer realm, exactly as the
 * registered QA browser entries do. A browser realm has no `node:crypto`, so
 * this module is the ONE seam `vite.config.ts` maps the raw specifier onto.
 *
 * In a Node realm every consumer keeps the REAL builtin, unchanged: the bridge,
 * its SEA bundle, the workers and every test that imports `node:crypto` —
 * directly or through a bridge module — resolve it through Node's own loader
 * here, so nothing downstream is shadowed and no algorithm is re-implemented.
 * Only a realm without a Node builtin loader takes the browser branch below,
 * whose SHA-256 is the product's own pure implementation
 * (`shared/runtime/context.js` `evidenceHash`, which the contract tests pin
 * against `node:crypto`).
 *
 * The Node builtin is acquired WITHOUT any static `node:` specifier on purpose.
 * `import { createRequire } from 'node:module'` at module scope is externalized
 * by Vite for the browser and left as a bare import in the dev module graph,
 * which the browser cannot resolve: the whole graph dies before `main.ts` runs
 * and `pnpm dev` serves a blank page (the production build happened to survive
 * it, which is exactly why the defect went unnoticed). A runtime lookup through
 * `process.getBuiltinModule` (Node >= 22.3; this repo requires Node >= 24) or a
 * realm's own `require` is invisible to the bundler, so the browser branch is
 * chosen by realm rather than by whether the specifier could be resolved.
 */
import type { Buffer } from 'node:buffer';
import { evidenceHash } from '../../shared/runtime/context.js';

type NodeCrypto = typeof import('node:crypto');
type Digest = ReturnType<NodeCrypto['createHash']>;

function loadNodeCrypto(): NodeCrypto | undefined {
  const proc = (globalThis as { process?: { getBuiltinModule?: (id: string) => unknown } }).process;
  if (proc !== undefined && typeof proc.getBuiltinModule === 'function') {
    return proc.getBuiltinModule('node:crypto') as NodeCrypto;
  }
  const requirer = (globalThis as { require?: (id: string) => unknown }).require;
  if (typeof requirer === 'function') return requirer('node:crypto') as NodeCrypto;
  return undefined;
}

let nodeCrypto: NodeCrypto | undefined;
try {
  nodeCrypto = loadNodeCrypto();
} catch {
  nodeCrypto = undefined;
}

function requireNode(reason: string): NodeCrypto {
  if (nodeCrypto === undefined) {
    throw new TypeError(`node:crypto seam: ${reason} needs the Node builtin, which this realm does not have`);
  }
  return nodeCrypto;
}

/** The browser realm's own UUID source, with an RFC-4122-v4 fallback. */
function browserRandomUUID(): string {
  const webcrypto = globalThis.crypto;
  if (webcrypto !== undefined && typeof webcrypto.randomUUID === 'function') return webcrypto.randomUUID();
  if (webcrypto === undefined || typeof webcrypto.getRandomValues !== 'function') {
    throw new TypeError('node:crypto seam: no UUID primitive is available in this realm');
  }
  const bytes = new Uint8Array(16);
  webcrypto.getRandomValues(bytes);
  bytes[6] = (bytes[6] & 0x0f) | 0x40;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = [...bytes].map((byte) => byte.toString(16).padStart(2, '0')).join('');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

type DigestEncoding = 'hex' | 'base64' | 'base64url';

/**
 * A synchronous sha256 over the browser realm's own pure implementation.
 * Exported so the browser branch is covered by a test that runs in a Node
 * realm, where the seam answers with the real builtin instead.
 */
export function createBrowserHash(algorithm: string): Digest {
  if (algorithm !== 'sha256') {
    throw new TypeError(`node:crypto seam: unsupported hash algorithm ${algorithm}`);
  }
  // Accumulate so a multi-`update` digest is the digest of the concatenation,
  // which is what the callers rely on.
  const parts: (string | Uint8Array)[] = [];
  return {
    update(chunk: string | Uint8Array) {
      parts.push(chunk);
      return this;
    },
    digest(encoding: DigestEncoding): string {
      const merged = parts.map((part) => (typeof part === 'string' ? part : new TextDecoder().decode(part))).join('');
      const hex = evidenceHash(merged);
      if (encoding === 'hex') return hex;
      const raw = Uint8Array.from(hex.match(/../gu)!.map((byte) => Number.parseInt(byte, 16)));
      const base64 = btoa(String.fromCharCode(...raw));
      if (encoding === 'base64') return base64;
      return base64.replace(/\+/gu, '-').replace(/\//gu, '_').replace(/=+$/u, '');
    },
  } as unknown as Digest;
}

export function randomUUID(): string {
  return nodeCrypto === undefined ? browserRandomUUID() : nodeCrypto.randomUUID();
}

export function createHash(algorithm: string): Digest {
  if (nodeCrypto === undefined) return createBrowserHash(algorithm);
  const owned = nodeCrypto.createHash(algorithm);
  return {
    update(chunk: string | Uint8Array) {
      owned.update(chunk as string);
      return this;
    },
    digest: (encoding: DigestEncoding) => owned.digest(encoding),
  } as unknown as Digest;
}

export function createHmac(algorithm: string, key: string | Buffer): ReturnType<NodeCrypto['createHmac']> {
  return requireNode('createHmac').createHmac(algorithm, key);
}

export function randomBytes(size: number): Buffer {
  return requireNode('randomBytes').randomBytes(size);
}

export function timingSafeEqual(a: Buffer, b: Buffer): boolean {
  return requireNode('timingSafeEqual').timingSafeEqual(a, b);
}
