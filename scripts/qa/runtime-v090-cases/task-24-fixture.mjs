// Task 24 registered QA case — owned fixture, legacy data and resource teardown.
//
// Analogue of task-30-fixture.mjs / task-29-fixture.mjs / task-26-fixture.mjs (same
// runner contract): a private root under the runner-owned temporary root, an
// append-only resource ledger that records every transient resource BEFORE it is
// created, and a teardown that asserts every owned PID is absent and every owned
// loopback port can be rebound exclusively afterwards.
//
// This case owns three resource classes beyond the shared skeleton:
//   * the Vite dev server + owned headless Chromium that project the REAL landed
//     Vue surfaces (ConnectionEntry / MigrationWizard) and the REAL migration
//     modules over the page's REAL localStorage and REAL IndexedDB;
//   * a REAL workspace directory (real files, real `git` repository) under the
//     private root, driven through the REAL bridge WorkspaceService, the REAL
//     target git command (real `git` binary) and the REAL pty service (real
//     node-pty spawn) — every spawned PID is registered and asserted absent;
//   * the legacy fixture below, which is the ONE injected data boundary: it is
//     written into the page's real localStorage / real IndexedDB, and every
//     module that reads it afterwards is real landed code.
//
// It never performs a live SSH or a live Slurm verification — task 46 owns that —
// and it authors no PASS verdict. No product or test file is edited by this module.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import { writeJson } from '../runtime-v090-evidence.mjs';

export const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

export function processIdentity(pid) {
  return { pid, startTime: readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] };
}

export async function until(predicate, label, timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await predicate()) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`Timed out: ${label}`);
}

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return server.address().port;
}

export async function closeServer(server) {
  await new Promise((resolve, reject) => server.close((error) => (error ? reject(error) : resolve())));
}

// Proves a port is free again by taking it exclusively and releasing it.
export async function assertPortReleased(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
}

// ── the injected legacy fixture (the ONE case-owned data boundary) ─────────────────
//
// Four legacy pieces across two REAL browser authorities (localStorage + the real
// IndexedDB `opencode.backendHistory` store), shaped exactly as the product's own
// legacy contract expects:
//   * a composer draft under `opencode.drafts.composer.v1` (a JSON string-map whose
//     entries are drafts, so the real `importLegacyDrafts` can read a body);
//   * the SAME native session id stored twice — once in localStorage and once in
//     IndexedDB under the same `backend-history-v1:<scope>` namespace — which is the
//     "same id, multiple sources" shape the failure case must refuse to guess about;
//   * one local credential key (`opencode.credentials.v1`), which the REAL export
//     must exclude as local-only and never hand to a target.
//
// Every reader of this data is real landed code: `createBrowserLegacySource`,
// `createBrowserLegacySourcePort`, `openLegacyExport`, `describeLocalBinding`,
// `createImportCoordinator`, `archiveLegacySource`, `importLegacyDrafts` and the
// real `DraftStore` over the page's real IndexedDB.
export const SCOPE_HEX = 'a1b2c3d4e5f60718293a4b5c6d7e8f90';
export const SESSION_ID = 'session-0001';
export const COMPOSER_KEY = 'opencode.drafts.composer.v1';
export const HISTORY_KEY = `opencode.state.backendHistory.v1.${SCOPE_HEX}.${encodeURIComponent(SESSION_ID)}`;
export const CREDENTIAL_KEY = 'opencode.credentials.v1';
export const COMPOSER_VALUE = '{"draft-1":{"messageInput":"legacy composer draft carried into the single entry","attachments":[]}}';
export const HISTORY_VALUE = 'legacy backend history record for the shared native session id';
export const CREDENTIAL_VALUE = '{"token":"legacy-local-credential-never-exported"}';
export const IDB_DATABASE = 'opencode.backendHistory';
export const IDB_STORE = 'histories';
export const IDB_ROW_KEY = HISTORY_KEY;
export const IDB_ROW_VALUE = 'legacy backend history record persisted in IndexedDB';

export function createLegacyFixture() {
  return Object.freeze({
    storage: Object.freeze([
      Object.freeze({ key: COMPOSER_KEY, value: COMPOSER_VALUE }),
      Object.freeze({ key: CREDENTIAL_KEY, value: CREDENTIAL_VALUE }),
      Object.freeze({ key: HISTORY_KEY, value: HISTORY_VALUE }),
    ]),
    indexedDB: Object.freeze({
      database: IDB_DATABASE,
      store: IDB_STORE,
      rows: Object.freeze([Object.freeze({ key: IDB_ROW_KEY, value: IDB_ROW_VALUE })]),
    }),
    expectations: Object.freeze({
      // Four pieces: composer + credential + localStorage history + IndexedDB history.
      pieceCount: 4,
      // Every piece ends its record, so four records; the credential is excluded.
      records: 4,
      localOnlyRecords: 1,
      exportableRecords: 3,
      // Two different authorities carry the same native session id.
      historyAuthorities: Object.freeze(['unattached', 'indexeddb']),
    }),
  });
}

// The stable identities the case drives the surfaces with. They are ordinary
// runtime identity UUIDs (the contract `deriveUuid` produces), NOT credentials.
export const TARGET_ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
export const FOREIGN_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
export const HARNESS_INSTANCE = '33333333-3333-4333-8333-333333333333';
export const LOCAL_BRIDGE_URL = 'ws://127.0.0.1:23004';
export const REMOTE_BRIDGE_URL = 'ws://lab.example.com:23004';
export const REMOTE_HTTP_URL = 'https://lab.example.com:23004/healthz';
export const LOOPBACK_HTTP_URL = 'http://127.0.0.1:23004/healthz';
export const BRIDGE_VERSION = '0.9.0';

// The one-shot PTY argv shape the product's open-in-editor path uses
// (App.vue `handleFloatingWindowOpen`): `/bin/sh -c <command> vis-open-editor <path>`.
export const OPEN_IN_EDITOR_SHELL_COMMAND = 'command -v';
export const LOCAL_FILE_PATH = '/workspace/src/main.ts';

export async function createFixture(context) {
  const root = path.join(context.temporaryRoot, `task24-${randomUUID()}`);
  const resources = [];
  const cleanup = [];
  const owners = [];
  const persist = () => {
    writeJson(path.join(context.evidenceDir, 'ownedresources.json'), { case: context.case, resources, cleanup });
    writeJson(path.join(context.runDir, 'resources.json'), { case: context.case, resources, cleanup });
  };
  const register = (entry) => {
    resources.push({ at: new Date().toISOString(), ...entry, ...(entry.pid && alive(entry.pid) ? processIdentity(entry.pid) : {}) });
    persist();
  };
  const own = (kind, close) => owners.push({ kind, close });
  register({ kind: 'private-root', root, teardown: 'all owned servers/processes close, then remove the exact private root' });
  await mkdir(root, { recursive: true });
  own('private-root', async () => { await rm(root, { recursive: true, force: true }); return { root, absent: !existsSync(root) }; });
  const close = async () => {
    const failures = [];
    for (const owner of owners.splice(0).reverse()) {
      try { cleanup.push({ kind: owner.kind, receipt: await owner.close(), passed: true }); }
      catch (error) { cleanup.push({ kind: owner.kind, passed: false, error: String(error) }); failures.push(error); }
      persist();
    }
    for (const entry of resources.filter((entry) => entry.pid)) assert.equal(alive(entry.pid), false, `Owned ${entry.kind} PID ${entry.pid} remains`);
    if (failures.length) throw new AggregateError(failures, 'task24 QA cleanup failed');
    return { cleanup, resources };
  };
  return { root, resources, register, own, close, persist };
}
