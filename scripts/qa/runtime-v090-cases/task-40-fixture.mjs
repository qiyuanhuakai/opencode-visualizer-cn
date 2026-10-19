// Task 40 registered QA case — owned fixture and resource teardown.
//
// Analogue of task-38-fixture.mjs / task-37-fixture.mjs (same runner contract): a private root
// under the runner-owned temporary root, an append-only resource ledger that records every
// transient resource BEFORE it is created, and a teardown that asserts every owned PID is absent
// and every owned loopback port can be rebound exclusively afterwards.
//
// Task 40's product is bridge-side: bridge/runtime/collaboration/writerLeases.js imports
// node:crypto / node:fs / node:path / node:child_process on its first lines, artifactStore.js
// imports node:crypto / node:fs, and artifactService.js imports node:crypto / node:fs /
// node:path plus writerLeases.js, so NONE of the three product modules can cross into a browser
// realm at all. The owned transient resources are therefore:
//   * the private root;
//   * one private scratch directory per world — the temporary git repositories (NEVER the QA
//     worktree), the writer roots that hold the product-created git worktrees, and the artifact
//     store roots — every one registered in the ledger BEFORE its mkdir through mkdirOwned and
//     removed with an exact-path rm -rf plus an absent assertion;
//   * one loopback Vite server and one owned headless Chromium used to prove the frozen shared
//     contract produces the SAME values in a second JS realm.
// There is no scheduler, no SSH host and no live harness — task 46 owns end-to-end verification.
// It never claims a live SSH or live Slurm check, and it performs no git operation in the
// worktree: every git command the case runs names a private temporary repository or worktree.
import assert from 'node:assert/strict';
import { existsSync, mkdtempSync, readFileSync } from 'node:fs';
import { mkdir, rm } from 'node:fs/promises';
import { createServer } from 'node:net';
import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
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

// Proves a port is free again by taking it exclusively and releasing it.
export async function assertPortReleased(port) {
  const probe = createServer();
  await new Promise((resolve, reject) => {
    probe.once('error', reject);
    probe.listen({ host: '127.0.0.1', port, exclusive: true }, resolve);
  });
  await new Promise((resolve, reject) => probe.close((error) => (error ? reject(error) : resolve())));
}

export async function createFixture(context) {
  // The runner guarantees temporaryRoot only INSIDE the spawned worker's env (the task-25
  // lesson). Prefer the runner's root; fall back to a private mkdtemp root so the fixture
  // is never silently rooted at an undefined path.
  const runnerRoot = typeof context.temporaryRoot === 'string' && context.temporaryRoot.length > 0 ? context.temporaryRoot : null;
  const fallbackRoot = runnerRoot === null ? mkdtempSync(path.join(tmpdir(), `task40-owned-${process.pid}-`)) : null;
  const root = path.join(runnerRoot ?? fallbackRoot, `task40-${randomUUID()}`);
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
  register({ kind: 'private-root', root, temporaryRootSource: runnerRoot === null ? 'mkdtemp-fallback' : 'runner', teardown: 'all owned servers/processes close, then remove the exact private root' });
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
   * owns an exact-path rm -rf with an absent assertion. Every world the case builds (the
   * temporary git repositories, the writer roots, the artifact store roots, the pristine apply
   * targets) goes through this seam, so the ledger's register-before-create contract holds for
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
    if (failures.length) throw new AggregateError(failures, 'task40 QA cleanup failed');
    return { cleanup, resources, ownedCount };
  };
  return { root, resources, register, own, close, persist, mkdirOwned };
}
