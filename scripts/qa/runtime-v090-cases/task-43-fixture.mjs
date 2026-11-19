// Task 43 registered QA case — owned fixture and resource teardown.
//
// Analogue of task-42-fixture.mjs (same runner contract): a private root under the runner-owned
// temporary root, an append-only resource ledger that records every transient resource BEFORE it is
// created, and a teardown that releases every owned resource with a receipt.
//
// Task 43 is the FULL-CHAIN case, and its world splits across three owners, so this fixture owns
// ONLY the part this case module drives itself:
//   * the Node worker realm of THIS case module: the private legacy store directory the real
//     shared/runtime/migration/legacyExport.js walk reads (seeded from the independent seed090
//     oracle, the same one source the landed integration test reads), plus the private roots the
//     case's own checks need. Every one is registered in the ledger BEFORE its mkdir through
//     mkdirOwned and removed with an exact-path rm -rf plus an absent assertion.
//   * the Node worker realms of the two LANDED harnesses scripts/qa/runtime-v090-system.mjs and
//     scripts/qa/runtime-v090-faults.mjs — their private temporary git repositories, their runtime
//     store state roots, their spawned native producers and manager process groups — are owned by
//     THOSE modules' own ledgers (each is self-contained by design, because task 43's grant is
//     exactly two scripts plus the integration test and the browser entry). This fixture does NOT
//     reach into them, and their teardown receipts are their own evidence.
//   * the browser realm (the real unified session tree in a real headless Chromium over a
//     case-owned Vite server) is likewise owned by the harness that drives it.
// This fixture therefore starts NO Vite server, NO Chromium and NO process of its own, which is
// why its teardown has no port-rebind step: there is no owned port to prove free. What it does
// guarantee is the runner contract's register-before-create discipline and an absent assertion for
// every owned path, including the private root itself.
//
// The runner injects VIS_RUNTIME_QA_TEMP only INSIDE the spawned worker (the task-25 lesson:
// task-25-fixture.mjs:65 read context.temporaryRoot in the parent and crashed), so the root prefers
// the runner's temporaryRoot and otherwise falls back to a private mkdtemp root — never the QA
// worktree, and never an undefined path.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJson } from '../runtime-v090-evidence.mjs';

// Module-local helpers. `alive` and `processIdentity` are used by the ledger's register and
// teardown receipts below; nothing outside this module needs them, so they are not exported.
const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

function processIdentity(pid) {
  return { pid, startTime: readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] };
}

export async function createFixture(context) {
  const runnerRoot = typeof context.temporaryRoot === 'string' && context.temporaryRoot.length > 0 ? context.temporaryRoot : null;
  const fallbackRoot = runnerRoot === null ? mkdtempSync(path.join(tmpdir(), `task43-owned-${process.pid}-`)) : null;
  const root = path.join(runnerRoot ?? fallbackRoot, `task43-${randomUUID()}`);
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
  register({ kind: 'private-root', root, temporaryRootSource: runnerRoot === null ? 'mkdtemp-fallback' : 'runner', teardown: 'all owned directories are removed, then remove the exact private root' });
  await mkdir(root, { recursive: true });
  own('private-root', async () => { await rm(root, { recursive: true, force: true }); return { root, absent: !existsSync(root) }; });
  if (fallbackRoot !== null) own('temporary-root-fallback', async () => { await rm(fallbackRoot, { recursive: true, force: true }); return { root: fallbackRoot, absent: !existsSync(fallbackRoot) }; });
  const ledgerPath = path.join(context.evidenceDir, 'ownedresources.json');
  register({ kind: 'resource-ledger', path: ledgerPath, teardown: 'receipt recorded: every registered resource is released and the ledger is left on disk as evidence' });
  own('resource-ledger', async () => {
    const ledger = JSON.parse(readFileSync(ledgerPath, 'utf8'));
    return {
      path: ledgerPath,
      exists: true,
      resourceCount: ledger.resources.length,
      ownedCount: owners.length,
      cleanupCount: ledger.cleanup.length,
      allCleanupsPassed: ledger.cleanup.every((entry) => entry.passed === true),
    };
  });

  /**
   * Registers a private scratch directory in the ledger BEFORE creating it, then creates it and
   * owns an exact-path rm -rf with an absent assertion. The private legacy store the real legacy
   * export walk reads goes through this seam, so the register-before-create contract holds for
   * directories exactly as it does for servers and processes.
   */
  const mkdirOwned = async (kind, relativePath, teardownNote) => {
    const absolute = path.resolve(root, relativePath);
    register({ kind, path: absolute, teardown: teardownNote ?? `rm -rf the exact directory, then assert it is absent` });
    await mkdir(absolute, { recursive: true });
    own(kind, async () => { await rm(absolute, { recursive: true, force: true }); return { path: absolute, absent: !existsSync(absolute) }; });
    return absolute;
  };

  const close = async () => {
    const failures = [];
    const ownedCount = owners.length;
    for (const owner of owners.splice(0).reverse()) {
      try { cleanup.push({ kind: owner.kind, receipt: await owner.close(), passed: true }); }
      catch (error) { cleanup.push({ kind: owner.kind, passed: false, error: String(error) }); failures.push(error); }
      persist();
    }
    for (const entry of resources.filter((entry) => entry.pid)) assert.equal(alive(entry.pid), false, `Owned ${entry.kind} PID ${entry.pid} remains`);
    if (failures.length) throw new AggregateError(failures, 'task43 QA cleanup failed');
    return { cleanup, resources, ownedCount };
  };
  return { root, resources, register, own, close, persist, mkdirOwned };
}
