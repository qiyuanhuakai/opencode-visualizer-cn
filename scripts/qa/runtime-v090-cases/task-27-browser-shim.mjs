// Task 27 browser entry — `node:*` shim for the browser-shaped surface.
//
// scripts/qa/runtime-v090-cases/task-27.mjs serves app/dev/runtime-v090/task27.ts
// through a Vite dev server whose resolve.alias maps every `node:*` specifier onto
// THIS file. The task-27 browser entry drives the REAL landed browser-safe
// remoteBootstrap rules (bridge/runtime/transports/remoteBootstrap.js is documented
// "pure and browser-safe (no `node:` imports)") and the REAL bridge-version
// composables, so a renderer proves the host-identity/upgrade-path projections it
// receives. A renderer has no OS primitives, so the shim records file writes in
// memory and makes hashing/spawn/connect throw.
//
// It exports the union of the named imports and the default import the modules may
// use, plus a `Buffer` global so any length-prefixed logic can build frames without
// a Node runtime.
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
