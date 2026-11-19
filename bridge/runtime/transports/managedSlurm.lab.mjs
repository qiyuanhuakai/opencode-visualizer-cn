import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { mkdtemp, mkdir, writeFile, readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { setTimeout as pause } from 'node:timers/promises';
import { createRemoteServices } from '../remoteServices.js';
import { createProfileStore } from './profileStore.js';
import { encodeBinary, decodeBinary } from '../../../shared/runtime/protocol.js';
import { runScheduler } from './slurmScheduler.js';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

if (process.argv[2] === 'hold-manager') {
  const spec = JSON.parse(process.env.VIS_MANAGER_CRASH_SPEC);
  const remote = createRemoteServices({ stateRoot: spec.stateRoot, configPath: spec.configPath,
    profileStore: createProfileStore({ profilePath: path.join(spec.root, 'profiles.json') }) });
  await remote.mutate('connect', { profileId: spec.profileId });
  await writeFile(path.join(spec.root, 'crash-ready.json'), JSON.stringify({ target: remote.getTarget(spec.environmentId).hello.target }));
  await new Promise(() => {});
}

const mode = process.argv[2] ?? 'relay';
const borrowed = process.argv.includes('--borrow');
const expiry = process.argv.includes('--expiry');
assert(['tcp', 'relay'].includes(mode));
const root = await mkdtemp(path.join(tmpdir(), `managed-slurm-${mode}-`));
const configPath = path.join(root, 'bridge.json');
await writeFile(configPath, JSON.stringify({ version: 1, nativeServices: { opencode: false, codex: false, 'kimi-web': false, dsh: false }, acpAgents: [] }));
const workspace = path.join(root, 'workspace');
await mkdir(workspace);
const computeMountPid = process.env.VIS_COMPUTE_MOUNT_PID;
const computeArgs = computeMountPid ? [`--mount=/proc/${computeMountPid}/ns/mnt`] : [];
if (computeMountPid) execFileSync('nsenter', [...computeArgs, 'mkdir', '-p', workspace]);
const stateRoot = path.join(root, 'login');
const profileStore = createProfileStore({ profilePath: path.join(root, 'profiles.json') });
let remote = createRemoteServices({ stateRoot, configPath, profileStore });
assert.equal(remote.capabilities.slurm, true);
const profile = await remote.mutate('create', { name: 'real scheduler', role: 'execution', enabled: true, credentialRef: 'system',
  transport: { kind: 'slurm', endpoint: 'localhost' }, target: { kind: 'slurm', clusterEnvironmentId: randomUUID() } });
const record = { mode, root, profileId: profile.profileId, observations: [] };
let intentId;
let externalJobId;
try {
  if (borrowed) {
    externalJobId = (await runScheduler('sbatch', ['--parsable', '--partition=debug', '--nodes=1', '--cpus-per-task=4', '--mem=512M', '--gres=gpu:2', '--time=00:05:00', '--comment=external-allocation', '--wrap=sleep 300'])).stdout.trim();
    for (let attempt = 0; attempt < 120; attempt++) {
      if ((await runScheduler('squeue', ['--noheader', '--format=%T', `--jobs=${externalJobId}`])).stdout.trim() === 'RUNNING') break;
      await pause(250);
    }
  }
  const submitted = await remote.mutate(borrowed ? 'borrow' : 'submit', { profileId: profile.profileId, ...(borrowed ? { jobId: externalJobId } : {}), deployment: {
    mode, computeWorkingRoot: workspace, computeStateRoot: path.join(root, 'compute'),
    resources: { partition: 'debug', cpus: 3, memory: '384M', time: expiry ? '00:01:00' : '00:05:00', gres: 'gpu:2' },
  } });
  intentId = submitted.intentId;
  assert.equal(submitted.state, 'submitted');
  assert.match(submitted.jobId, /^\d+$/u);
  record.jobId = submitted.jobId; record.intentId = intentId;
  record.observations.push('submission returned before runtime readiness');
  let ready;
  for (let attempt = 0; attempt < 160; attempt++) {
    const status = await remote.mutate('reconcile', { profileId: profile.profileId, intentId });
    if (status.terminal) throw new Error(`job terminated: ${JSON.stringify(status)}`);
    if (status.schedulerComment?.includes(':vis:')) { ready = status; break; }
    await pause(250);
  }
  assert(ready, 'compute runtime published readiness');
  record.computeNode = ready.computeNode;
  await remote.mutate('connect', { profileId: profile.profileId });
  let target = remote.getTarget(profile.target.clusterEnvironmentId);
  assert(target);
  assert.equal(target.hello.target, profile.target.clusterEnvironmentId);
  const key = target.grant.workspaceKeys[0];
  assert(key);
  const snapshot = await target.request({ method: 'runtime.snapshot', params: { collection: 'workspaces', limit: 10 } });
  assert(snapshot.items.length > 0);
  record.observations.push('authenticated relay delivered real runtime hello, grant, workspace snapshot');
  if (computeMountPid) {
    execFileSync('nsenter', [...computeArgs, '/bin/sh', '-c', 'test ! -e /opt/vis/bridge; ! /usr/local/bin/node --version; test ! -e "$1/login"', 'vis-isolation', root]);
    record.observations.push('compute mount namespace hides login source, system Node, and login control-store directory');
  }
  const content = Buffer.from(`managed-${mode}-${randomUUID()}`);
  const file = await target.request({ method: 'runtime.channel.open', idempotencyKey: randomUUID(), params: {
    service: 'file', workspaceKey: key, path: 'proof.txt', size: content.length,
    sha256: createHash('sha256').update(content).digest('hex'),
  } });
  target.sendBinary(encodeBinary({ channelId: file.channelId, offset: 0, data: content }));
  await target.request({ method: 'runtime.channel.ack', params: { channelId: file.channelId, offset: 0, length: content.length } });
  await target.request({ method: 'runtime.channel.finish', idempotencyKey: randomUUID(), params: { channelId: file.channelId } });
  if (computeMountPid) {
    assert.deepEqual(execFileSync('nsenter', [...computeArgs, 'cat', path.join(workspace, 'proof.txt')]), content);
    await assert.rejects(readFile(path.join(workspace, 'proof.txt')), error => error.code === 'ENOENT');
  } else assert.deepEqual(await readFile(path.join(workspace, 'proof.txt')), content);
  record.observations.push('binary runtime upload wrote verified content on compute workspace');
  let output = '';
  target.subscribe(message => { if (message.kind === 'binary') output += Buffer.from(decodeBinary(message.data).data).toString(); });
  const pty = await target.request({ method: 'runtime.pty.create', idempotencyKey: randomUUID(), params: {
    workspaceKey: key, command: '/bin/sh', args: ['-c', 'hostname; printf "SLURM_NODE=%s\\n" "$SLURMD_NODENAME"; pwd; readlink "/proc/$PPID/exe"; sleep 2'],
  } });
  await target.request({ method: 'runtime.channel.open', idempotencyKey: randomUUID(), params: { service: 'pty', ptyId: pty.ptyId } });
  for (let attempt = 0; attempt < 40 && (!output.includes('SLURM_NODE=') || (ready.installRoot && !output.includes(ready.installRoot))); attempt++) {
    const read = await target.request({ method: 'runtime.pty.read', params: { ptyId: pty.ptyId } });
    for (const chunk of read.chunks) await target.request({ method: 'runtime.channel.ack', params: chunk });
    await pause(100);
  }
  assert(output.includes(`SLURM_NODE=${ready.computeNode}`), output);
  record.ptyOutput = output;
  const deploymentState = await remote.read('job', { profileId: profile.profileId, intentId });
  if (deploymentState.installRoot) {
    assert(output.includes(deploymentState.installRoot), output);
    assert(deploymentState.bootstrap.transferredBytes > 0);
    record.bootstrap = deploymentState.bootstrap;
    record.observations.push('srun stdio bootstrap installed independent Node and runtime closure; real compute PTY parent uses deployed Node');
  }
  const detached = await remote.mutate('detach', { profileId: profile.profileId, intentId });
  assert.equal(detached.cancelled, false);
  assert.equal(remote.getTarget(profile.target.clusterEnvironmentId), undefined);
  await remote.mutate('connect', { profileId: profile.profileId });
  target = remote.getTarget(profile.target.clusterEnvironmentId);
  assert(target);
  assert.equal((await remote.mutate('reconcile', { profileId: profile.profileId, intentId })).jobId, record.jobId);
  record.observations.push('detach and reattach retained same allocation and compute runtime');
  const beforeRestart = await target.request({ method: 'runtime.inspect', params: {} });
  record.allocation = (await runScheduler('scontrol', ['show', 'job', record.jobId])).stdout;
  record.steps = (await runScheduler('scontrol', ['show', 'step'])).stdout;
  await remote.close();
  if (process.argv.includes('--crash-manager')) {
    const child = spawn(process.execPath, [fileURLToPath(import.meta.url), 'hold-manager'], {
      stdio: ['ignore', 'ignore', 'inherit'], env: { ...process.env, VIS_MANAGER_CRASH_SPEC: JSON.stringify({
        root, stateRoot, configPath, profileId: profile.profileId, environmentId: profile.target.clusterEnvironmentId,
      }) },
    });
    try {
      let crashReady;
      for (let attempt = 0; attempt < 100; attempt++) {
        try { crashReady = JSON.parse(await readFile(path.join(root, 'crash-ready.json'), 'utf8')); break; }
        catch (error) { if (error.code !== 'ENOENT') throw error; }
        await pause(100);
      }
      assert.equal(crashReady?.target, profile.target.clusterEnvironmentId);
      const exited = new Promise(resolve => child.once('exit', resolve));
      child.kill('SIGKILL');
      await exited;
      record.observations.push('connected manager process was SIGKILLed without closing its control store or relay');
    } finally { if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL'); }
  }
  remote = createRemoteServices({ stateRoot, configPath, profileStore });
  await remote.mutate('connect', { profileId: profile.profileId });
  target = remote.getTarget(profile.target.clusterEnvironmentId);
  assert.equal((await target.request({ method: 'runtime.inspect', params: {} })).connectionProfileId, beforeRestart.connectionProfileId);
  record.observations.push('manager service restart recovered persisted intent and stable runtime identity');
  if ((!borrowed || process.argv.includes('--requeue-borrow')) && !expiry) {
  await remote.mutate('disconnect', { profileId: profile.profileId });
  await runScheduler('scontrol', ['requeue', record.jobId]);
  await runScheduler('scontrol', ['update', `JobId=${record.jobId}`, 'StartTime=now']);
  let requeued;
  for (let attempt = 0; attempt < 720; attempt++) {
    const state = await remote.mutate('reconcile', { profileId: profile.profileId, intentId });
    if (state.terminal) throw new Error(`requeued job terminated: ${JSON.stringify(state)}`);
    if (state.restartCount > ready.restartCount && state.schedulerComment?.endsWith(`:${state.restartCount}`)) { requeued = state; break; }
    if (borrowed && state.queue === 'RUNNING' && state.restartCount > ready.restartCount) {
      try { await remote.mutate('connect', { profileId: profile.profileId }); }
      catch (error) { if (error.code !== 'source_unavailable') throw error; }
    }
    await pause(250);
  }
  assert(requeued, 'requeued runtime published a new epoch');
  await remote.mutate('connect', { profileId: profile.profileId });
  target = remote.getTarget(profile.target.clusterEnvironmentId);
  assert.equal((await target.request({ method: 'runtime.inspect', params: {} })).connectionProfileId, beforeRestart.connectionProfileId);
  record.restartCount = requeued.restartCount;
  record.observations.push('real scheduler requeue created new authenticated epoch with stable runtime registration');
  }
  if (expiry) {
    let expired;
    for (let attempt = 0; attempt < 640; attempt++) {
      const state = await remote.mutate('reconcile', { profileId: profile.profileId, intentId });
      if (state.terminal) { expired = state; break; }
      await pause(250);
    }
    assert.equal(expired?.queue, 'TIMEOUT');
    for (let attempt = 0; attempt < 40 && remote.getTarget(profile.target.clusterEnvironmentId); attempt++) await pause(100);
    assert.equal(remote.getTarget(profile.target.clusterEnvironmentId), undefined);
    record.observations.push('actual scheduler time limit expired allocation and removed connected target without replacement submission');
    record.expiry = { queue: expired.queue, terminal: expired.terminal, jobId: expired.jobId };
  }
  record.passed = true;
} catch (error) {
  record.passed = false; record.error = { message: error.message, code: error.code, field: error.field, transportLog: error.transportLog,
    causes: error.errors?.map(cause => ({ message: cause.message, code: cause.code, field: cause.field, transportLog: cause.transportLog })) };
  process.exitCode = 1;
} finally {
  if (intentId) {
    try {
      record.stop = await remote.mutate('stop', { profileId: profile.profileId, intentId });
      if (borrowed) {
        const job = (await runScheduler('scontrol', ['show', 'job', externalJobId])).stdout;
        assert(job.includes('JobState=RUNNING') && job.includes('Comment=external-allocation'));
        assert.equal(record.stop.cancelled, false);
        assert.equal(record.stop.stoppedSteps, 1);
        record.observations.push('borrow stop removed only owned service step and restored original comment; external allocation still RUNNING');
      }
    }
    catch (error) { record.stopError = { code: error.code, message: error.message }; process.exitCode = 1; }
  }
  await remote.close();
  if (externalJobId) await runScheduler('scancel', [externalJobId]);
  console.log(JSON.stringify(record, null, 2));
}
