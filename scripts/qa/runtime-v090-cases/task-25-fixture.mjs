// Task 25 registered QA case — owned fixture and resource teardown.
//
// Analogue of task-30-fixture.mjs / task-28-fixture.mjs (same runner
// contract): a private root under the runner-owned temporary root, an
// append-only resource ledger that records every transient resource BEFORE it
// is created, and a teardown that asserts every owned PID is absent and every
// owned loopback port can be rebound exclusively afterwards.
//
// Task 25 allocates a REAL bridge HTTP listener and, for the browser half, a
// case-owned Vite server plus a real headless Chromium; the durable profile
// document and the case-owned native-history / owned-job registries are REAL
// files under this private root. No live SSH host and no live Slurm cluster is
// ever contacted — task 46 owns that end-to-end check.
import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
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

export async function listen(server) {
  await new Promise((resolve, reject) => {
    server.once('error', reject);
    server.listen({ port: 0, host: '127.0.0.1', exclusive: true }, resolve);
  });
  return server.address().port;
}

export async function closeServer(server) {
  // Node HTTP keep-alive can hold sockets open; drop them so `close` settles.
  server.closeAllConnections?.();
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

export async function createFixture(context) {
  // The runner only guarantees `context.temporaryRoot` INSIDE the spawned worker's env
  // (runtime-v090.mjs passes it as VIS_RUNTIME_QA_TEMP); a direct/in-process invocation
  // carries no such value. Derive the private root from a base that is ALWAYS defined:
  // prefer the runner-owned temporary root when present, otherwise create a unique root
  // with the runner's own convention (mkdtemp under os.tmpdir(), `vis-runtime-qa-` prefix).
  // The base is never a fixed or shared directory — each run stays unique.
  const root = context.temporaryRoot
    ? path.join(context.temporaryRoot, `task25-${randomUUID()}`)
    : await mkdtemp(path.join(tmpdir(), 'vis-runtime-qa-task25-'));
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
    if (failures.length) throw new AggregateError(failures, 'task25 QA cleanup failed');
    return { cleanup, resources };
  };
  return { root, resources, register, own, close, persist };
}
