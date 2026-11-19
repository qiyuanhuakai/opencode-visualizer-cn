import { spawn } from 'node:child_process';
import { mkdir, writeFile, rm, readFile } from 'node:fs/promises';
import { DatabaseSync } from 'node:sqlite';
import { existsSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL, fileURLToPath } from 'node:url';
import { requireValue } from '../../../shared/runtime/capabilities.js';
import { parseEnvironmentId, parseInstanceId } from '../../../shared/runtime/identity.js';
import { createBridgeRuntime } from '../../bridgeRuntime.js';
import { createComputeRelay } from './computeRelay.js';
import { createRelayHandshake } from './relayHandshake.js';
import { buildStepArgv } from './slurmStepTransport.js';
import { slurmRuntimeBinding } from './slurmDeployment.js';
import { attachRelayRuntime } from './relayRuntime.js';
import { runScheduler } from './slurmScheduler.js';

export async function runSlurmCompute(spec, credential) {
  requireValue(process.env.SLURM_JOB_ID && process.env.SLURM_STEP_ID && process.env.SLURM_STEP_ID !== 'batch', 'slurm.compute_execution', 'unauthorized');
  const computeNode = process.env.SLURMD_NODENAME;
  const restartCount = Number(process.env.SLURM_RESTART_COUNT ?? 0);
  const binding = slurmRuntimeBinding(spec, computeNode, restartCount);
  const stateRoot = path.join(spec.deployment.computeStateRoot, spec.intentId);
  await mkdir(stateRoot, { recursive: true, mode: 0o700 });
  const markerPath = path.join(stateRoot, 'scheduler-epoch.json');
  let runtimeStoreTakeover;
  let previous;
  try { previous = JSON.parse(await readFile(markerPath, 'utf8')); }
  catch (error) { if (error.code !== 'ENOENT') throw error; }
  if (previous) {
    requireValue(previous.jobId === process.env.SLURM_JOB_ID && previous.environmentId === spec.environmentId, 'slurm.restart_owner', 'conflict');
    requireValue(restartCount > previous.restartCount, 'slurm.restart_epoch', 'conflict');
    const databasePath = path.join(stateRoot, 'runtime', 'runtime.db');
    if (existsSync(databasePath)) {
    const database = new DatabaseSync(databasePath, { readOnly: true });
    try {
      const row = database.prepare('SELECT fence FROM runtime_meta WHERE environment=?').get(spec.environmentId);
      requireValue(Number.isSafeInteger(row?.fence) && row.fence > 0, 'slurm.restart_fence', 'conflict');
      runtimeStoreTakeover = { expectedFence: row.fence };
    } finally { database.close(); }
    }
  }
  const configPath = path.join(stateRoot, 'bridge.json');
  await writeFile(configPath, JSON.stringify(spec.config), { mode: 0o600 });
  const registrationsRoot = path.join(stateRoot, 'runtime', 'registrations');
  await mkdir(registrationsRoot, { recursive: true, mode: 0o700 });
  for (const [key, id] of Object.entries(spec.registrations)) {
    requireValue(key === 'management-profile' || /^[A-Za-z0-9_-]+$/u.test(key), 'slurm.registration');
    parseInstanceId(id);
    await writeFile(path.join(registrationsRoot, `${key}.json`), JSON.stringify({ id }), { mode: 0o600 });
  }
  parseEnvironmentId(spec.environmentId);
  const runtime = createBridgeRuntime({ configPath, stateRoot, runtimeStoreTakeover, environmentId: spec.environmentId, role: 'execution',
    localWorkspaceRoots: [{ root: spec.deployment.computeWorkingRoot, permissions: ['read', 'write', 'command', 'pty', 'reverse'] }],
  });
  let relay;
  try {
    await writeFile(markerPath, JSON.stringify({ jobId: process.env.SLURM_JOB_ID, environmentId: spec.environmentId, restartCount }), { mode: 0o600 });
    await runtime.start();
    const host = await runtime.getRuntimeHost();
    await host.sourcesReady;
    const socketPath = path.join(stateRoot, 'runtime.sock');
    if (spec.deployment.mode === 'relay') await rm(socketPath, { force: true });
    relay = createComputeRelay({
      handshake: createRelayHandshake({ credential, binding }),
      mode: spec.deployment.mode === 'tcp' ? 'tcp' : 'local-socket',
      socketPath, host: '0.0.0.0', port: 0,
    });
    relay.onConnection(channel => {
      attachRelayRuntime(channel, host);
      void channel.requestStore('updateIntent', { intentId: spec.intentId, patch: { bridge: 'ready', transport: 'ready', computeNode, restartCount } }).catch(() => channel.close());
    });
    const address = await relay.listen();
    await runScheduler('scontrol', ['update', `JobId=${process.env.SLURM_JOB_ID}`, `Comment=${spec.intentId}:vis:${address.port ?? 0}:${restartCount}`]);
    let closed = false;
    return { binding, address, async close() {
      if (closed) return;
      closed = true; await relay.close(); await runtime.stop();
      if (spec.deployment.mode === 'relay') await rm(socketPath, { force: true });
    } };
  } catch (error) { await relay?.close(); await runtime.stop(); throw error; }
}

export async function runSlurmBatch(spec) {
  requireValue(process.env.SLURM_JOB_ID && process.env.SLURMD_NODENAME, 'slurm.batch_execution', 'unauthorized');
  const argv = buildStepArgv({
    mode: 'service', bridgeNode: process.env.SLURMD_NODENAME, jobId: process.env.SLURM_JOB_ID,
    stepId: spec.serviceStepId, compute: spec.deployment.resources, gres: spec.deployment.resources.gres,
    program: spec.nodeProgram, args: [spec.workerPath, 'service'],
  });
  const child = spawn('srun', argv, { stdio: 'inherit', shell: false, env: process.env });
  const stop = () => child.kill('SIGTERM');
  process.once('SIGTERM', stop); process.once('SIGINT', stop);
  return new Promise((resolve, reject) => {
    child.once('error', reject);
    child.once('exit', code => {
      process.removeListener('SIGTERM', stop); process.removeListener('SIGINT', stop);
      resolve(code ?? 1);
    });
  });
}

if (process.argv[1] && pathToFileURL(path.resolve(process.argv[1])).href === import.meta.url) {
  try {
    const spec = JSON.parse(process.env.VIS_SLURM_RUNTIME_SPEC ?? '');
    if (process.argv[2] === 'batch') process.exitCode = await runSlurmBatch(spec);
    else {
      const runtime = await runSlurmCompute(spec, process.env.VIS_BRIDGE_RELAY_CREDENTIAL);
      const stop = () => void runtime.close().then(() => { process.exitCode = 0; }, () => { process.exitCode = 1; });
      process.once('SIGTERM', stop); process.once('SIGINT', stop);
    }
  } catch (error) {
    const detail = String(error?.message ?? '').replaceAll(process.env.VIS_BRIDGE_RELAY_CREDENTIAL ?? '\0', '[redacted]').slice(0, 512);
    process.stderr.write(`Slurm runtime failed: ${error?.code ?? 'source_unavailable'} ${error?.field ?? 'startup'} ${detail}\n`);
    process.exitCode = 1;
  }
}

export const SLURM_COMPUTE_WORKER = fileURLToPath(import.meta.url);
