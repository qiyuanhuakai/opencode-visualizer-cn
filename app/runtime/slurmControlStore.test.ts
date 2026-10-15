import { spawn } from 'node:child_process';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { afterEach, describe, expect, it, vi } from 'vitest';

import {
  CONTROL_STORE_FILES,
  CONTROL_STORE_SCHEMA_VERSION,
  createSlurmControlStore,
  verifyLocalFilesystem,
} from '../../bridge/runtime/transports/slurmControlStore.js';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const EXT4 = 0xef53;
const NFS = 0x6969;

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function localStatfs() {
  return { type: EXT4 };
}

function ownerStore(root: string, ownerInstanceId: string) {
  return createSlurmControlStore({
    root,
    environmentId: ENVIRONMENT,
    ownerInstanceId,
    platform: 'linux',
    statfs: localStatfs,
    isProcessAlive: () => true,
  });
}

function forgedFence(ownerInstanceId: string, epoch: number) {
  return `${JSON.stringify({
    schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
    environmentId: ENVIRONMENT,
    ownerInstanceId,
    pid: process.pid,
    epoch,
    released: false,
    openedAt: new Date().toISOString(),
  })}\n`;
}

interface RacerResult {
  owner: string;
  opened: boolean;
  writable: boolean;
  wrote: boolean;
  code: string | null;
  field: string | null;
}

/**
 * Runs one owner in a *separate process*. Every racer blocks until a shared wall-clock
 * barrier and then attempts the open concurrently, and the winner holds its ownership for
 * `STORE_HOLD_MS` so a loser cannot slip in through a release window. This proves the lock
 * is mutually exclusive across processes, not merely across instances in one event loop.
 */
function runRacerProcess(environment: NodeJS.ProcessEnv) {
  const script = `
const { createSlurmControlStore } = await import(process.env.STORE_MODULE);
const result = { owner: process.env.STORE_OWNER, opened: false, writable: false, wrote: false, code: null, field: null };
const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
await wait(Math.max(0, Number(process.env.STORE_START_AT) - Date.now()));
try {
  const store = createSlurmControlStore({
    root: process.env.STORE_ROOT,
    environmentId: process.env.STORE_ENV,
    ownerInstanceId: process.env.STORE_OWNER,
  });
  const status = await store.open('owner');
  result.opened = status.opened;
  result.writable = status.writable;
  if (status.writable) {
    await store.writeIntent({ intentId: process.env.STORE_INTENT, uuid: process.env.STORE_INTENT });
    result.wrote = true;
    await wait(Number(process.env.STORE_HOLD_MS));
    await store.close();
  }
} catch (error) {
  result.code = error && error.code ? error.code : null;
  result.field = error && error.field ? error.field : null;
}
process.stdout.write(JSON.stringify(result));
`;
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: { ...process.env, ...environment },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => { stdout += chunk.toString('utf8'); });
    child.stderr.on('data', (chunk: Buffer) => { stderr += chunk.toString('utf8'); });
    child.on('exit', (code) => resolve({ code, stdout, stderr }));
  });
}

describe('slurm control store: single-writer fence is atomic', () => {
  it('admits exactly one writable owner when two owners race the same root in-process', async () => {
    const root = await temporaryDirectory('vis-store-race-');
    const ownerA = ownerStore(root, 'owner-a');
    const ownerB = ownerStore(root, 'owner-b');

    const opens = await Promise.allSettled([ownerA.open('owner'), ownerB.open('owner')]);
    const writableOwners = [
      opens[0].status === 'fulfilled' && opens[0].value.writable ? ownerA : null,
      opens[1].status === 'fulfilled' && opens[1].value.writable ? ownerB : null,
    ].filter((store): store is NonNullable<typeof store> => store !== null);
    expect(writableOwners).toHaveLength(1);

    const writes = await Promise.allSettled([
      ownerA.writeIntent({ intentId: 'intent-a', uuid: 'intent-a' }),
      ownerB.writeIntent({ intentId: 'intent-b', uuid: 'intent-b' }),
    ]);
    const succeeded = writes.filter((result) => result.status === 'fulfilled');
    expect(succeeded).toHaveLength(1);

    const verification = await writableOwners[0].verifyIntegrity();
    expect(verification).toMatchObject({ ok: true });
    await writableOwners[0].close();
  }, 20000);

  it('admits exactly one writable owner when two owners race across processes', async () => {
    const root = await temporaryDirectory('vis-store-proc-race-');
    const storeModule = pathToFileURL(
      path.resolve(import.meta.dirname, '../../bridge/runtime/transports/slurmControlStore.js'),
    ).href;
    const startAt = Date.now() + 1500;
    const shared = {
      STORE_MODULE: storeModule,
      STORE_ROOT: root,
      STORE_ENV: ENVIRONMENT,
      STORE_START_AT: String(startAt),
      STORE_HOLD_MS: '800',
    };
    const [racerA, racerB] = await Promise.all([
      runRacerProcess({ ...shared, STORE_OWNER: 'process-a', STORE_INTENT: 'intent-a' }),
      runRacerProcess({ ...shared, STORE_OWNER: 'process-b', STORE_INTENT: 'intent-b' }),
    ]);
    expect(racerA.code).toBe(0);
    expect(racerB.code).toBe(0);
    const results = [JSON.parse(racerA.stdout), JSON.parse(racerB.stdout)] as RacerResult[];

    expect(results.filter((result) => result.writable)).toHaveLength(1);
    expect(results.filter((result) => result.wrote)).toHaveLength(1);
    const loser = results.find((result) => !result.writable);
    expect(loser).toMatchObject({ opened: false, wrote: false, code: 'conflict' });

    const verifier = ownerStore(root, 'verifier');
    expect(await verifier.verifyIntegrity()).toMatchObject({ ok: true, records: 3 });
  }, 20000);

  it('rejects a write once the fence no longer names this owner (owner/epoch re-check)', async () => {
    const root = await temporaryDirectory('vis-store-fenced-write-');
    const store = ownerStore(root, 'owner-a');
    await store.open('owner');
    await store.writeIntent({ intentId: 'intent-a', uuid: 'intent-a' });

    await writeFile(path.join(root, CONTROL_STORE_FILES.fence), forgedFence('intruder', 42), 'utf8');
    await expect(store.writeIntent({ intentId: 'intent-b', uuid: 'intent-b' })).rejects.toMatchObject({
      code: 'conflict',
    });
    await expect(store.bumpEpoch({ reason: 'requeue' })).rejects.toMatchObject({ code: 'conflict' });
  }, 20000);

  it('refuses to release a fence this owner no longer holds', async () => {
    const root = await temporaryDirectory('vis-store-fenced-release-');
    const store = ownerStore(root, 'owner-a');
    await store.open('owner');

    const fencePath = path.join(root, CONTROL_STORE_FILES.fence);
    await writeFile(fencePath, forgedFence('intruder', 42), 'utf8');
    await expect(store.close()).rejects.toMatchObject({ code: 'conflict' });
    // The intruder's fence must not be overwritten with a release by the fenced-out owner.
    expect(JSON.parse(await readFile(fencePath, 'utf8'))).toMatchObject({ ownerInstanceId: 'intruder', released: false });
  }, 20000);

  it('reloads the journal under the lock so a normal handoff cannot fork the chain', async () => {
    // The pre-lock journal read cannot see records a previous owner appends while this open waits
    // for the ownership lock. Owner B is parked between those two steps by its own liveness probe
    // (the first probe runs right after loadJournal), so A can close — appending store.closed and
    // releasing the lock — before B ever refreshes its view.
    const root = await temporaryDirectory('vis-store-handoff-');
    const control = await temporaryDirectory('vis-store-handoff-ctl-');
    const reached = path.join(control, 'reached');
    const release = path.join(control, 'release');
    const storeModule = pathToFileURL(
      path.resolve(import.meta.dirname, '../../bridge/runtime/transports/slurmControlStore.js'),
    ).href;
    const script = `
import { existsSync, writeFileSync } from 'node:fs';
const { createSlurmControlStore } = await import(process.env.STORE_MODULE);
const result = { opened: false, writable: false, code: null, field: null };
let announced = false;
const nap = () => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, 20);
const store = createSlurmControlStore({
  root: process.env.STORE_ROOT,
  environmentId: process.env.STORE_ENV,
  ownerInstanceId: 'owner-b',
  platform: 'linux',
  statfs: () => ({ type: 0xef53 }),
  isProcessAlive: () => {
    if (!announced) {
      announced = true;
      writeFileSync(process.env.STORE_REACHED, 'parked');
    }
    const deadline = Date.now() + 20000;
    while (!existsSync(process.env.STORE_RELEASE) && Date.now() < deadline) nap();
    return false;
  },
});
try {
  const status = await store.open('owner');
  result.opened = status.opened;
  result.writable = status.writable;
  await store.close();
} catch (error) {
  result.code = error && error.code ? error.code : null;
  result.field = error && error.field ? error.field : null;
}
process.stdout.write(JSON.stringify(result));
`;
    let racerStdout = '';
    let racerStderr = '';
    const ownerA = ownerStore(root, 'owner-a');
    await ownerA.open('owner');
    const racer = spawn(process.execPath, ['--input-type=module', '--eval', script], {
      env: {
        ...process.env,
        STORE_MODULE: storeModule,
        STORE_ROOT: root,
        STORE_ENV: ENVIRONMENT,
        STORE_REACHED: reached,
        STORE_RELEASE: release,
      },
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    racer.stdout.on('data', (chunk: Buffer) => { racerStdout += chunk.toString('utf8'); });
    racer.stderr.on('data', (chunk: Buffer) => { racerStderr += chunk.toString('utf8'); });
    try {
      await vi.waitFor(() => expect(existsSync(reached)).toBe(true));
      // A closes normally: store.closed is appended and the lock is released while B is parked.
      await ownerA.close();
      await writeFile(release, 'go', 'utf8');
      const exited = await new Promise<number | null>((resolve) => racer.on('exit', (code) => resolve(code)));
      expect(exited).toBe(0);
      expect(racerStderr).toBe('');
      const outcome = JSON.parse(racerStdout || '{}') as {
        opened: boolean;
        writable: boolean;
        code: string | null;
      };
      // B legitimately wins the handoff — the corruption is invisible to B itself.
      expect(outcome).toMatchObject({ opened: true, writable: true, code: null });

      // And the chain B appended must still verify: A's store.closed landed while B was parked,
      // so B has to pick up A's record instead of forking from its pre-lock view.
      const verifier = ownerStore(root, 'verifier');
      await expect(verifier.verifyIntegrity()).resolves.toMatchObject({ ok: true, records: 4 });
    } finally {
      if (racer.exitCode === null) racer.kill('SIGKILL');
    }
  }, 30000);
});

describe('slurm control store: first-time creation cannot bypass the network-filesystem guard', () => {
  it('probes the nearest existing ancestor and refuses a not-yet-created root under NFS', async () => {
    const parent = await temporaryDirectory('vis-store-ancestor-');
    const root = path.join(parent, 'state');
    const probed: string[] = [];
    const statfs = (target: string) => {
      probed.push(target);
      if (existsSync(target)) return { type: NFS };
      throw new Error('not created yet');
    };

    await expect(verifyLocalFilesystem({ root, platform: 'linux', statfs })).rejects.toMatchObject({
      code: 'unsupported',
      field: 'store.filesystem',
    });
    expect(probed).toContain(parent);

    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'nfs-owner',
      platform: 'linux',
      statfs,
    });
    await expect(store.open('owner')).rejects.toMatchObject({ code: 'unsupported' });
    expect(existsSync(root)).toBe(false);
  }, 20000);

  it('re-confirms the mount after creating the root and refuses one that became NFS', async () => {
    const parent = await temporaryDirectory('vis-store-reconfirm-');
    const root = path.join(parent, 'state');
    const statfs = (target: string) => {
      if (target === root) {
        if (existsSync(root)) return { type: NFS };
        throw new Error('not created yet');
      }
      return { type: EXT4 };
    };

    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'late-nfs-owner',
      platform: 'linux',
      statfs,
    });
    await expect(store.open('owner')).rejects.toMatchObject({ code: 'unsupported' });
  }, 20000);

  it('does not treat an unprobeable mount as verified local storage on linux', async () => {
    const parent = await temporaryDirectory('vis-store-noprobe-');
    const root = path.join(parent, 'state');
    const statfs = () => {
      throw new Error('statfs unavailable');
    };

    await expect(verifyLocalFilesystem({ root, platform: 'linux', statfs })).rejects.toMatchObject({
      code: 'unsupported',
      field: 'store.filesystem',
    });

    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'no-probe-owner',
      platform: 'linux',
      statfs,
    });
    await expect(store.open('owner')).rejects.toMatchObject({ code: 'unsupported' });
  }, 20000);

  it('still accepts a local-disk ancestor for a root that does not exist yet', async () => {
    const parent = await temporaryDirectory('vis-store-ancestor-local-');
    const root = path.join(parent, 'state');
    await expect(
      verifyLocalFilesystem({ root, platform: 'linux', statfs: localStatfs }),
    ).resolves.toMatchObject({ filesystemClass: 'local', root: path.resolve(root) });
  }, 20000);
});
