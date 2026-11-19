// Task 26 browser entry — node:* shim for the browser-shaped surface.
//
// scripts/qa/runtime-v090-cases/task-26.mjs serves app/dev/runtime-v090/task26.ts
// through a Vite dev server whose resolve.alias maps every `node:*` specifier used
// by the task-26 transport modules onto THIS file. That is the single controlled
// boundary of the browser case: the transport LOGIC under test (secret-box
// projection/redaction, secret-channel path delivery, length-prefixed relay framing)
// is the real landed code, but the browser has no OS primitives, so:
//   * file writes are recorded in memory (never a real disk, never env, never logged),
//   * spawn/connect/hashing throw because the browser surface must not reach the OS.
//
// It exports the union of the named imports and the default import the transport
// modules use (sshAuthentication.js default-imports `path`), plus a `Buffer` global
// so processRelay.js can build length-prefixed frames without a Node runtime.
import { Buffer as NodeBuffer } from 'buffer';

if (globalThis.Buffer === undefined) globalThis.Buffer = NodeBuffer;

const files = new Map();
let sequence = 0;

export function randomUUID() {
  sequence += 1;
  return `00000000-0000-4000-8000-${String(sequence).padStart(12, '0')}`;
}

function unavailable(name) {
  return () => { throw new Error(`browser-fixture: ${name} is not available in the browser surface`); };
}

export const createHash = unavailable('node:crypto createHash');
export const createHmac = unavailable('node:crypto createHmac');
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
export async function rm(filePath) { files.delete(String(filePath)); }
export async function stat(filePath) {
  if (!files.has(String(filePath))) { const error = new Error('ENOENT'); error.code = 'ENOENT'; throw error; }
  return { mode: 0o600, size: files.get(String(filePath)).length, isFile: () => true };
}

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
