// Task 44 registered QA case — owned fixture and resource teardown.
//
// Analogue of task-43-fixture.mjs / task-30-fixture.mjs (same runner contract): a private root under
// the runner-owned temporary root, an append-only resource ledger, and a teardown that releases
// every owned resource with a receipt.
//
// Task 44 is a MEASUREMENT case and its world splits across three owners, so this fixture owns ONLY
// what THIS case module owns:
//   * the private root itself — created under the runner's temporary root (never inside the QA
//     worktree) and removed with an exact-path rm -rf plus an absent assertion. Nothing transient is
//     written under it by this case; its value is the proof that the case never writes into the
//     worktree and that its scratch world is fully reclaimed.
//   * the measurement stack — a real Vite dev server plus a real headless Chromium, allocated by
//     scripts/qa/runtime-v090-benchmark.mjs's createStack(). That harness records its own
//     lifecycle.json and closes page / context / browser connection / browser server / Vite in its
//     own close(); a stack cannot be registered before the harness allocates it, so this fixture
//     registers its observed port and browser PID the MOMENT it exists (ownExisting) and owns its
//     close, and the receipt then proves the port rebinds exclusively and the browser PID is absent
//     — the same guarantee task-30's fixture gives for a stack it builds itself.
//   * the persistent evidence directories are REGISTERED (so the ledger names every byte location
//     the run writes) but deliberately NOT owned: their teardown is "left on disk as evidence",
//     because the runner re-reads and re-hashes them after the worker exits. Removing them would
//     destroy the very artifacts the manifest binds to.
//   * the three LANDED profile reports (.omo/evidence/vis-v090/task-44/{standard,stress,network100ms}.json)
//     are READ-ONLY inputs written by the implementation lane's own registered invocations. This
//     fixture never writes to them and never removes them; they are verified, not owned.
//
// The runner injects VIS_RUNTIME_QA_TEMP only INSIDE the spawned worker (the task-25 lesson:
// task-25-fixture.mjs:65 read context.temporaryRoot in the parent and crashed), so the root prefers
// the runner's temporaryRoot and otherwise falls back to a private mkdtemp root.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { writeJson } from '../runtime-v090-evidence.mjs';

const alive = (pid) => {
  try { process.kill(pid, 0); return true; }
  catch (error) { if (error.code === 'ESRCH') return false; throw error; }
};

function processIdentity(pid) {
  return { pid, startTime: readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[19] };
}

/** Exclusively rebind a TCP port on loopback: proof the previous owner really released it. */
function assertPortReleased(port) {
  return new Promise((resolve, reject) => {
    const server = createServer();
    server.once('error', (error) => { server.close(); reject(new Error(`port ${port} not released: ${error.code}`)); });
    server.listen(port, '127.0.0.1', () => { server.close(() => resolve({ port, exclusiveRebind: true })); });
  });
}

export async function createFixture(context) {
  const runnerRoot = typeof context.temporaryRoot === 'string' && context.temporaryRoot.length > 0 ? context.temporaryRoot : null;
  const fallbackRoot = runnerRoot === null ? mkdtempSync(path.join(tmpdir(), `task44-owned-${process.pid}-`)) : null;
  const root = path.join(runnerRoot ?? fallbackRoot, `task44-${randomUUID()}`);
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
  register({ kind: 'private-root', root, temporaryRootSource: runnerRoot === null ? 'mkdtemp-fallback' : 'runner', teardown: 'rm -rf the exact private root, then assert it is absent' });
  await mkdir(root, { recursive: true });
  own('private-root', async () => { await rm(root, { recursive: true, force: true }); return { root, absent: !existsSync(root) }; });
  if (fallbackRoot !== null) own('temporary-root-fallback', async () => { await rm(fallbackRoot, { recursive: true, force: true }); return { root: fallbackRoot, absent: !existsSync(fallbackRoot) }; });
  const ledgerPath = path.join(context.evidenceDir, 'ownedresources.json');
  register({ kind: 'resource-ledger', path: ledgerPath, teardown: 'receipt recorded: every owned resource is released and the ledger is left on disk as evidence' });
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
   * Registers a resource that ALREADY exists — the harness's measurement stack, whose Vite port and
   * browser PID the harness itself allocated — and owns its release. The receipt proves the port
   * rebinds exclusively and the browser PID is absent, exactly as a stack this fixture had built
   * itself would.
   */
  const ownExisting = (kind, entry, close) => {
    register({ kind, ...entry });
    own(kind, close);
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
    if (failures.length) throw new AggregateError(failures, 'task44 QA cleanup failed');
    return { cleanup, resources, ownedCount };
  };
  return { root, resources, register, own, ownExisting, close, persist, assertPortReleased };
}
