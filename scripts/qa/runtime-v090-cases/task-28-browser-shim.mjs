// Task 28 browser entry — node:* shim for the browser-shaped surface.
//
// scripts/qa/runtime-v090-cases/task-28.mjs serves app/dev/runtime-v090/task28.ts
// through a Vite dev server whose resolve.alias maps every `node:*` specifier used
// by the task-28 module graph onto THIS file. That is the single controlled
// boundary of the browser case: the LOGIC under test (resource normalization and the
// user-visible resource preview, the queue-state projection, the sbatch/squeue
// parsers, and the credential-protected bridge handshake challenge) is the real
// landed code, but a renderer has no OS primitives, so:
//   * hashing/HMAC are a deterministic case-owned stand-in (the REAL sha256/HMAC is
//     exercised in the Node worker by scripts/qa/runtime-v090-cases/task-28.mjs),
//   * spawn/connect throw because the browser surface must not reach the OS,
//   * file writes are recorded in memory (never a real disk, never env, never logged).
//
// It exports the union of the named imports and the default import the task-28
// module graph uses (slurmControlStore.js/slurmBootstrap.js default-import `path`),
// plus a `Buffer`/`process` global so the transport modules can build frames and
// read `process.platform` without a Node runtime.
import { Buffer as NodeBuffer } from 'buffer';

if (globalThis.Buffer === undefined) globalThis.Buffer = NodeBuffer;
if (globalThis.process === undefined) globalThis.process = { pid: 4242, platform: 'linux', env: {}, kill: () => {} };

const files = new Map();
let sequence = 0;

export function randomUUID() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function toyHex(input) {
  const text = String(input);
  let a = 0x811c9dc5;
  let b = 0x1000193;
  for (let index = 0; index < text.length; index += 1) {
    const code = text.charCodeAt(index);
    a = Math.imul(a ^ code, 0x01000193) >>> 0;
    b = Math.imul(b + code + 1, 0x85ebca6b) >>> 0;
  }
  const head = (a >>> 0).toString(16).padStart(8, '0');
  const tail = (b >>> 0).toString(16).padStart(8, '0');
  return `${head}${tail}`.repeat(4).slice(0, 64);
}

// Deterministic, case-owned stand-in for node:crypto's streaming hash/HMAC. The real
// sha256/HMAC runs in the Node worker; this only needs to be collision-consistent so
// the renderer can prove a challenge token verifies and a forged one does not.
function toyHasher(seed) {
  let buffer = String(seed ?? '');
  return {
    update(data) { buffer += String(data); return this; },
    digest(encoding) { const hex = toyHex(buffer); return encoding === 'hex' ? hex : Buffer.from(hex, 'hex'); },
  };
}

export const createHash = (algorithm) => toyHasher(`hash\0${algorithm ?? ''}\0`);
export const createHmac = (algorithm, key) => toyHasher(`hmac\0${algorithm ?? ''}\0${key}\0`);

export function timingSafeEqual(left, right) {
  const first = Buffer.isBuffer(left) ? left : Buffer.from(String(left));
  const second = Buffer.isBuffer(right) ? right : Buffer.from(String(right));
  if (first.length !== second.length) return false;
  let equal = 0;
  for (let index = 0; index < first.length; index += 1) equal |= first[index] ^ second[index];
  return equal === 0;
}

function unavailable(name) {
  return () => { throw new Error(`browser-fixture: ${name} is not available in the browser surface`); };
}

export const statfsSync = unavailable('node:fs statfsSync');
export const spawn = unavailable('node:child_process spawn');
export const connect = unavailable('node:net connect');

export async function mkdir() {}
export async function chmod() {}
export async function writeFile(filePath, data) { files.set(String(filePath), String(data)); }
export async function readFile(filePath) {
  const value = files.get(String(filePath));
  if (value === undefined) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
  return value;
}
export async function readdir() { return []; }
export async function rename() { throw unavailable('node:fs/promises rename')(); }
export async function rm(filePath) { files.delete(String(filePath)); }
export async function open() { throw unavailable('node:fs/promises open')(); }

export function tmpdir() { return '/browser-tmp'; }
export function homedir() { return '/browser-home'; }

export function join(...parts) {
  return parts
    .filter((part) => part !== undefined && part !== null && part !== '')
    .map(String)
    .join('/')
    .replace(/\/{2,}/gu, '/');
}
export function resolve(...parts) { return join(...parts); }
export function basename(value) { return String(value).split('/').filter(Boolean).pop() ?? ''; }
export function dirname(value) { const segments = String(value).split('/'); segments.pop(); return segments.join('/') || '/'; }
export const sep = '/';
export const delimiter = ':';

const pathDefault = { join, resolve, basename, dirname, sep, delimiter };
export default pathDefault;
