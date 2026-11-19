import { spawnSync } from 'node:child_process';
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { ProtocolError } from '../../shared/runtime/capabilities.js';

import {
  CONTROL_STORE_SCHEMA_VERSION,
  createSlurmControlStore,
  filesystemClass,
  isNetworkFilesystem,
  verifyLocalFilesystem,
} from '../../bridge/runtime/transports/slurmControlStore.js';
import {
  SLURM_HANDSHAKE_KIND,
  buildResourcePreview,
  buildSbatchArgv,
  buildSbatchScript,
  createSlurmHandshake,
  createSlurmJobController,
  mapQueueState,
  normalizeSlurmResources,
  parseSbatchOutput,
  parseScontrolShowJob,
  parseSlurmMemory,
  parseSlurmTime,
  parseSqueueOutput,
} from '../../bridge/runtime/transports/slurmJobs.js';
import {
  COMPUTE_DELIVERY_CHANNELS,
  SLURM_HOST_ROLES,
  assertIndependentRoots,
  parseSlurmHostProbe,
  planComputeDelivery,
  planSlurmBootstrap,
} from '../../bridge/runtime/transports/slurmBootstrap.js';
import { parseCliOptions } from '../../vis_bridge';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const CLUSTER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const EXT4 = 0xef53;
const NFS = 0x6969;
const LUSTRE = 0x0bd00bd0;

const RESOURCES = Object.freeze({
  partition: 'cpu',
  account: 'research',
  cpus: 4,
  memory: '8G',
  time: '01:00:00',
  gres: 'none',
});

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(
    temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })),
  );
});
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function localStatfs() {
  return { type: EXT4 };
}

async function openOwnerStore(root: string, ownerInstanceId = 'owner-test') {
  const store = createSlurmControlStore({
    root,
    environmentId: ENVIRONMENT,
    ownerInstanceId,
    platform: 'linux',
    statfs: localStatfs,
  });
  await store.open('owner');
  return store;
}

type SchedulerMatch = { jobId: string; name?: string; state?: string; comment?: string; partition?: string; nodes?: string };
function createScheduler(overrides: { jobId?: string; submit?: ((request: unknown) => unknown) | 'throw'; matches?: SchedulerMatch[] } = {}) {
  const submitCalls: Array<{ intentId: string; script: string; argv: readonly string[] }> = [];
  const queryCalls: Array<{ intentId: string; uuid: string }> = [];
  const cancelCalls: Array<{ intentId: string; jobId: string }> = [];
  let matches = overrides.matches ?? [];
  let submit: ((request: unknown) => unknown) | 'throw' | undefined = overrides.submit;
  const scheduler = {
    async submit(request: { intentId: string; script: string; argv: readonly string[] }) {
      submitCalls.push(request);
      if (submit === 'throw') throw new Error('submit acknowledgement lost');
      if (typeof submit === 'function') return submit(request);
      return { stdout: `${overrides.jobId ?? '24680'}\n` };
    },
    async query(request: { intentId: string; uuid: string }) {
      queryCalls.push(request);
      return { matches };
    },
    async cancel(request: { intentId: string; jobId: string }) {
      cancelCalls.push(request);
      return { cancelled: true };
    },
  };
  return {
    scheduler,
    submitCalls,
    queryCalls,
    cancelCalls,
    setMatches: (next: SchedulerMatch[]) => {
      matches = next;
    },
    setSubmit: (next: ((request: unknown) => unknown) | 'throw') => {
      submit = next;
    },
  };
}

describe('slurm control store: durable login-local ownership', () => {
  it('classifies network filesystems and verifies a local disk before opening', async () => {
    expect(filesystemClass(EXT4)).toBe('local');
    expect(filesystemClass(NFS)).toBe('network');
    expect(filesystemClass(LUSTRE)).toBe('network');
    expect(filesystemClass(undefined)).toBe('unknown');
    expect(isNetworkFilesystem(NFS)).toBe(true);
    expect(isNetworkFilesystem(EXT4)).toBe(false);

    const root = await temporaryDirectory('vis-slurm-fs-');
    await expect(
      verifyLocalFilesystem({ root, platform: 'linux', statfs: () => ({ type: NFS }) }),
    ).rejects.toMatchObject({ code: 'unsupported', field: 'store.filesystem' });
    await expect(
      verifyLocalFilesystem({ root, platform: 'linux', statfs: localStatfs }),
    ).resolves.toMatchObject({ filesystemClass: 'local', root: path.resolve(root) });

    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'nfs-owner',
      platform: 'linux',
      statfs: () => ({ type: LUSTRE }),
    });
    await expect(store.open('owner')).rejects.toMatchObject({ code: 'unsupported' });
  });

  it('persists intents durably across a reopen and keeps a verifiable journal', async () => {
    const root = await temporaryDirectory('vis-slurm-durable-');
    const store = await openOwnerStore(root);
    expect(CONTROL_STORE_SCHEMA_VERSION).toBe(1);
    expect(store.status()).toMatchObject({ writable: true, environmentId: ENVIRONMENT, ownerInstanceId: 'owner-test' });
    await store.writeIntent({ intentId: 'intent-a', uuid: 'intent-a', state: 'planned' });
    await store.updateIntent('intent-a', { state: 'submitted', jobId: '99' });
    expect(await store.verifyIntegrity()).toMatchObject({ ok: true });
    await store.close();

    const reopened = await openOwnerStore(root, 'owner-test');
    const restored = await reopened.readIntent('intent-a');
    expect(restored).toMatchObject({ intentId: 'intent-a', state: 'submitted', jobId: '99' });
    expect(await reopened.listIntents()).toHaveLength(1);
    await reopened.close();
  });

  it('fences a single owner and refuses a competing live writer while allowing read-only', async () => {
    const root = await temporaryDirectory('vis-slurm-fence-');
    const owner = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'owner-a',
      platform: 'linux',
      statfs: localStatfs,
      isProcessAlive: () => true,
    });
    await owner.open('owner');
    expect(await owner.bumpEpoch({ reason: 'requeue' })).toBe(1);

    const competitor = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'owner-b',
      platform: 'linux',
      statfs: localStatfs,
      isProcessAlive: () => true,
    });
    await expect(competitor.open('owner')).rejects.toMatchObject({ code: 'conflict', field: 'store.fence' });
    const reader = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'owner-c',
      platform: 'linux',
      statfs: localStatfs,
      isProcessAlive: () => true,
    });
    await reader.open('readonly');
    expect(reader.status()).toMatchObject({ writable: false, epoch: 1 });
    await expect(reader.writeIntent({ intentId: 'x' })).rejects.toMatchObject({ code: 'unauthorized' });
    await owner.close();
  });

  it('detects journal tampering instead of trusting a corrupted store', async () => {
    const root = await temporaryDirectory('vis-slurm-integrity-');
    const store = await openOwnerStore(root);
    await store.writeIntent({ intentId: 'intent-a', uuid: 'intent-a' });
    await store.writeIntent({ intentId: 'intent-b', uuid: 'intent-b' });
    const journalPath = path.join(root, 'journal.jsonl');
    const original = await readFile(journalPath, 'utf8');
    await writeFile(journalPath, `${original}${JSON.stringify({ seq: 99, type: 'intent.written', intentId: 'forged' })}\n`, 'utf8');
    await expect(store.verifyIntegrity()).rejects.toMatchObject({ code: 'conflict', field: 'store.integrity' });
    await store.close();
  });
});

describe('slurm resources: time and gres must be explicit', () => {
  it('parses explicit Slurm time and memory forms', () => {
    expect(parseSlurmTime('10')).toBe(600);
    expect(parseSlurmTime('1:30')).toBe(90);
    expect(parseSlurmTime('1:00:00')).toBe(3600);
    expect(parseSlurmTime('2-01:00:00')).toBe(176400);
    expect(() => parseSlurmTime('')).toThrow(/resources\.time/u);
    expect(parseSlurmMemory('2048')).toBe(2048);
    expect(parseSlurmMemory('2048M')).toBe(2048);
    expect(parseSlurmMemory('2G')).toBe(2048);
    expect(() => parseSlurmMemory('lots')).toThrow(/resources\.memory/u);
  });

  it('refuses a resource request that hides time or gres behind a default', () => {
    expect(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', gres: 'none' })).toThrow(/resources\.time/u);
    expect(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', time: '01:00:00' })).toThrow(/resources\.gres/u);
    expect(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', time: '01:00:00', gres: '  ' })).toThrow(/resources\.gres/u);

    const normalized = normalizeSlurmResources(RESOURCES);
    expect(normalized).toMatchObject({ cpus: 4, memoryMiB: 8192, timeSeconds: 3600, gres: 'none', nodes: 1, ntasks: 1, gpus: false });
    expect(Object.isFrozen(normalized)).toBe(true);
  });

  it('projects an explicit resource preview and writes it into the sbatch script and argv', () => {
    const intentId = '33333333-3333-4333-8333-333333333333';
    const preview = buildResourcePreview({ ...RESOURCES, gres: 'gpu:1' });
    expect(preview).toMatchObject({ cpus: 4, memoryMiB: 8192, timeSeconds: 3600, time: '01:00:00', gres: 'gpu:1', requestsGpu: true, partition: 'cpu' });

    const script = buildSbatchScript({
      intentId,
      resources: RESOURCES,
      command: '/opt/vis/vis_bridge',
      args: ['start', '--role=execution'],
      cwd: '/scratch/user/work',
    });
    expect(script).toContain(`#SBATCH --job-name=${intentId}`);
    expect(script).toContain('#SBATCH --time=01:00:00');
    expect(script).toContain('#SBATCH --gres=none');
    expect(script).toContain('#SBATCH --cpus-per-task=4');
    expect(script).toContain('#SBATCH --mem=8192M');
    expect(script).toContain("exec '/opt/vis/vis_bridge' 'start' '--role=execution'");

    const argv = buildSbatchArgv({ intentId, resources: RESOURCES });
    expect(argv).toContain('--parsable');
    expect(argv.some((token) => token.includes(intentId))).toBe(true);
  });
});

describe('slurm scheduler state round-trip', () => {
  it('reads state back through squeue/scontrol and the parsed sbatch id', () => {
    expect(parseSbatchOutput('24680\n')).toMatchObject({ jobId: '24680', cluster: null });
    expect(parseSbatchOutput('24680;cluster-a')).toMatchObject({ jobId: '24680', cluster: 'cluster-a' });
    expect(() => parseSbatchOutput('not-a-job')).toThrow(/sbatch\.jobId/u);

    const squeue = parseSqueueOutput('24680|intent-a|RUNNING|intent-a|cpu|node-1\n24681|intent-b|PENDING|intent-b|cpu|\n');
    expect(squeue).toHaveLength(2);
    expect(squeue[0]).toMatchObject({ jobId: '24680', state: 'RUNNING', comment: 'intent-a' });
    expect(squeue[1]).toMatchObject({ jobId: '24681', state: 'PENDING' });

    const scontrol = parseScontrolShowJob('JobId=24680 JobName=intent-a JobState=COMPLETED Partition=cpu Comment=intent-a NodeList=node-1 ExitCode=0:0\n');
    expect(scontrol).toMatchObject({ jobId: '24680', name: 'intent-a', jobState: 'COMPLETED', partition: 'cpu', comment: 'intent-a' });

    expect(mapQueueState('PENDING')).toMatchObject({ queue: 'PENDING', terminal: null });
    expect(mapQueueState('RUNNING')).toMatchObject({ queue: 'RUNNING', terminal: null });
    expect(mapQueueState('COMPLETED')).toMatchObject({ queue: 'COMPLETED', terminal: 'COMPLETED' });
    expect(mapQueueState('CANCELLED')).toMatchObject({ queue: 'CANCELLED', terminal: 'CANCELLED' });
    expect(mapQueueState('PREEMPTED')).toMatchObject({ requeued: true });
    expect(mapQueueState('NODE_FAIL')).toMatchObject({ requeued: true });
  });
});

describe('slurm job controller', () => {
  it('returns from submit with the explicit submitted state and never waits for ready', async () => {
    const root = await temporaryDirectory('vis-slurm-submit-');
    const store = await openOwnerStore(root);
    const fake = createScheduler({ jobId: '24680' });
    const controller = createSlurmJobController({ store, scheduler: fake.scheduler, environmentId: ENVIRONMENT });

    const result = await controller.submit({
      resources: RESOURCES,
      command: '/opt/vis/vis_bridge',
      args: ['start'],
      sharedRoot: '/shared/vis',
      computeWorkingRoot: '/scratch/user/work',
    });

    expect(result.state).toBe('submitted');
    expect(result.reconcile).toBeNull();
    expect(result.jobId).toBe('24680');
    expect(result.preview).toMatchObject({ cpus: 4, time: '01:00:00', gres: 'none' });
    expect(fake.submitCalls).toHaveLength(1);
    expect(fake.queryCalls).toHaveLength(0);
    expect(fake.submitCalls[0]!.script).toContain(result.intentId);
    await controller.close();
  });

  it('never resubmits to resolve an unconfirmed or ambiguous submit', async () => {
    const root = await temporaryDirectory('vis-slurm-ambiguous-');
    const store = await openOwnerStore(root);
    const fake = createScheduler({ submit: 'throw' });
    const controller = createSlurmJobController({ store, scheduler: fake.scheduler, environmentId: ENVIRONMENT });

    const submitted = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
    expect(submitted.state).toBe('submitted');
    expect(submitted.reconcile).toBe('unconfirmed');

    fake.setMatches([]);
    const unconfirmed = await controller.reconcile(submitted.intentId);
    expect(unconfirmed.reconcile).toBe('unconfirmed');
    expect(fake.submitCalls).toHaveLength(1);

    fake.setMatches([
      { jobId: '24680', state: 'RUNNING', comment: submitted.intentId },
      { jobId: '24681', state: 'RUNNING', comment: submitted.intentId },
    ]);
    const ambiguous = await controller.reconcile(submitted.intentId);
    expect(ambiguous.reconcile).toBe('ambiguous');
    expect(ambiguous.state).toBe('reconciling');
    expect(fake.submitCalls).toHaveLength(1);

    fake.setMatches([{ jobId: '24680', state: 'RUNNING', comment: submitted.intentId }]);
    const adopted = await controller.reconcile(submitted.intentId);
    expect(adopted.reconcile).toBeNull();
    expect(adopted.jobId).toBe('24680');
    expect(adopted.queue).toBe('RUNNING');
    expect(fake.submitCalls).toHaveLength(1);
    await controller.close();
  });

  it('detach does not cancel and stop signals only owned processes', async () => {
    const root = await temporaryDirectory('vis-slurm-stop-');
    const store = await openOwnerStore(root);
    const fake = createScheduler({ jobId: '24680' });
    const controller = createSlurmJobController({ store, scheduler: fake.scheduler, environmentId: ENVIRONMENT });

    const owned = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge' });
    const detached = await controller.detach(owned.intentId);
    expect(detached).toMatchObject({ attached: false, cancelled: false, signalled: false });
    expect(fake.cancelCalls).toHaveLength(0);

    const stopped = await controller.stop(owned.intentId);
    expect(stopped).toMatchObject({ signalled: true, cancelled: true, jobId: '24680' });
    expect(fake.cancelCalls).toHaveLength(1);
    expect(fake.cancelCalls[0]!.jobId).toBe('24680');

    const borrowed = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'borrowed' });
    const borrowedStop = await controller.stop(borrowed.intentId);
    expect(borrowedStop).toMatchObject({ signalled: false, cancelled: false, reason: 'borrowed' });
    expect(fake.cancelCalls).toHaveLength(1);
    await controller.close();
  });

  it('gates the compute bridge with a credential-protected handshake', () => {
    const handshake = createSlurmHandshake({ credential: 's3cret-credential' });
    const challenge = handshake.challenge('intent-a');
    expect(challenge.kind).toBe(SLURM_HANDSHAKE_KIND);
    expect(challenge).toMatchObject({ intentId: 'intent-a', credentialProtected: true });
    expect(JSON.stringify(challenge)).not.toContain('s3cret-credential');
    expect(handshake.verify({ intentId: challenge.intentId, nonce: challenge.nonce, token: challenge.token })).toBe(true);
    expect(handshake.verify({ intentId: challenge.intentId, nonce: challenge.nonce, token: 'deadbeef' })).toBe(false);

    const attacker = createSlurmHandshake({ credential: 'wrong-credential' });
    const forged = attacker.challenge('intent-a');
    expect(handshake.verify({ intentId: forged.intentId, nonce: forged.nonce, token: forged.token })).toBe(false);
  });
});

describe('slurm bootstrap: login control vs compute execution', () => {
  it('parses a per-host program probe', () => {
    expect(SLURM_HOST_ROLES).toEqual(['login', 'compute']);
    const login = parseSlurmHostProbe({
      role: 'login',
      platform: 'linux',
      programs: { sbatch: true, squeue: true, scontrol: true },
      bridgeInstalled: true,
      bridgeVersion: '0.9.0',
      controlRoot: '/home/user/.local/state/vis/bridge',
      workspaceRoot: '/home/user/work',
      nativeDataRoot: '/home/user/.local/share/vis/native',
    });
    expect(login).toMatchObject({ role: 'login', programsReady: true });
    expect(login.programs).toEqual({ sbatch: true, squeue: true, scontrol: true });
    const compute = parseSlurmHostProbe({
      role: 'compute',
      platform: 'linux',
      programs: { bridge: false },
      controlRoot: '/shared/vis-control',
      workspaceRoot: '/scratch/user/run',
      nativeDataRoot: '/scratch/user/native',
    });
    expect(compute).toMatchObject({ role: 'compute', programsReady: false });
    expect(() => parseSlurmHostProbe({ role: 'gpu', platform: 'linux', programs: {}, workspaceRoot: '/x' })).toThrow(/slurm\.role/u);
  });

  it('keeps the shared path and the compute working path independent', () => {
    expect(() =>
      assertIndependentRoots({ controlRoot: '/shared/vis-control', workspaceRoot: '/shared/vis-control', nativeDataRoot: '/scratch/native' }),
    ).toThrow(/slurm\.roots/u);
    expect(() =>
      assertIndependentRoots({ controlRoot: '/control', workspaceRoot: '/scratch/run', nativeDataRoot: '/scratch/run' }),
    ).toThrow(/slurm\.roots/u);
    expect(() =>
      assertIndependentRoots({ controlRoot: '/control', workspaceRoot: '/scratch/run', nativeDataRoot: '/scratch/native' }),
    ).not.toThrow();
  });

  it('plans compute delivery and pins control to login while execution stays on compute', () => {
    expect(COMPUTE_DELIVERY_CHANNELS).toEqual(['slurm-shared-root', 'slurm-controlled-channel']);
    expect(planComputeDelivery({ sharedRootAvailable: true })).toMatchObject({ channel: 'slurm-shared-root', shared: true, requiresExplicitAction: true });
    expect(planComputeDelivery({ sharedRootAvailable: false })).toMatchObject({ channel: 'slurm-controlled-channel', shared: false });

    const plan = planSlurmBootstrap({
      profile: { target: { kind: 'slurm', clusterEnvironmentId: CLUSTER_ENVIRONMENT } },
      login: {
        role: 'login',
        platform: 'linux',
        programs: { sbatch: true, squeue: true, scontrol: true },
        controlRoot: '/home/user/.local/state/vis/bridge',
        workspaceRoot: '/home/user/work',
        nativeDataRoot: '/home/user/.local/share/vis/native',
      },
      compute: {
        role: 'compute',
        platform: 'linux',
        programs: { bridge: true },
        bridgeInstalled: true,
        controlRoot: '/home/user/.local/state/vis/bridge',
        workspaceRoot: '/scratch/user/run',
        nativeDataRoot: '/scratch/user/native',
      },
      sharedRootAvailable: true,
    });
    expect(plan).toMatchObject({
      environmentId: CLUSTER_ENVIRONMENT,
      controlHost: 'login',
      executionHost: 'compute',
      submitControlHost: 'login',
      agentExecutionHost: 'compute',
      automatic: false,
    });
    expect(plan.loginControlRoot).toBe('/home/user/.local/state/vis/bridge');
    expect(plan.computeWorkingRoot).toBe('/scratch/user/run');
    expect(plan.loginControlRoot).not.toBe(plan.computeWorkingRoot);
    expect(plan.delivery).toMatchObject({ channel: 'slurm-shared-root' });
    expect(Object.isFrozen(plan)).toBe(true);
  });
});

describe('vis_bridge control-store role', () => {
  it('recognizes the control-store lifecycle command and validates its state root', () => {
    const options = parseCliOptions(['control-store', '--state-root', '/tmp/vis-control', '--environment', ENVIRONMENT], {});
    expect(options).toMatchObject({ command: 'control-store', role: 'control-store', stateRoot: '/tmp/vis-control', environmentId: ENVIRONMENT });
    expect(parseCliOptions(['control-store', '--help'], {})).toMatchObject({ command: 'control-store', help: true });
    expect(() => parseCliOptions(['control-store', '--environment', 'not-a-uuid', '--state-root', '/tmp/x'], {})).toThrow(/environment/u);
  });
});

describe('slurm sbatch script: hostile resource input cannot alter the script (PR #182 item 4)', () => {
  const INTENT = '33333333-3333-4333-8333-333333333333';
  const INJECTED = 'VIS_SBATCH_INJECTION_MARKER';

  function executeSbatchScript(script: string, cwd: string) {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-sbatch-behaviour-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'job.sh');
    writeFileSync(file, script, 'utf8');
    return spawnSync('bash', [file], { cwd, encoding: 'utf8' });
  }

  const hostilePartition = { ...RESOURCES, partition: `cpu\nprintf '${INJECTED}\\n'` };
  const hostileAccount = { ...RESOURCES, account: `research\nprintf '${INJECTED}\\n'` };
  const hostileGres = { ...RESOURCES, gres: `none\nprintf '${INJECTED}\\n'` };
  const hostileResources = [hostilePartition, hostileAccount, hostileGres];

  it('rejects a control character or a second token in any resource value', () => {
    expect(() => normalizeSlurmResources(hostilePartition)).toThrow(/resources\.partition/u);
    expect(() => normalizeSlurmResources(hostileAccount)).toThrow(/resources\.account/u);
    expect(() => normalizeSlurmResources(hostileGres)).toThrow(/resources\.gres/u);
    expect(() => normalizeSlurmResources({ ...RESOURCES, partition: 'cpu --mem=1G' })).toThrow(ProtocolError);
    expect(() => normalizeSlurmResources({ ...RESOURCES, partition: 'cpu\r' })).toThrow(/resources\.partition/u);
    expect(() => normalizeSlurmResources({ ...RESOURCES, account: 'research;whoami' })).toThrow(/resources\.account/u);
    expect(normalizeSlurmResources({ ...RESOURCES, gres: 'gpu:2,ssd:10' }).gres).toBe('gpu:2,ssd:10');
  });

  it('never runs a command injected through a resource field when the built script is executed', () => {
    for (const resources of hostileResources) {
      let script: string;
      try {
        script = buildSbatchScript({ intentId: INTENT, resources, command: 'true', cwd: tmpdir() });
      } catch (error) {
        expect(error).toBeInstanceOf(ProtocolError);
        continue;
      }
      const run = executeSbatchScript(script, tmpdir());
      expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).not.toContain(INJECTED);
    }
  });

  it('rejects env keys that are not legal shell identifiers', () => {
    const build = (env: Record<string, string>) => () =>
      buildSbatchScript({ intentId: INTENT, resources: RESOURCES, command: 'true', cwd: tmpdir(), env });
    expect(build({ 'NOT A NAME': 'x' })).toThrow(ProtocolError);
    expect(build({ 'SHELL;rm -rf /': 'x' })).toThrow(ProtocolError);
    expect(build({ 'EVIL\nNAME': 'x' })).toThrow(ProtocolError);
    expect(build({ GOOD_1: 'x' })).not.toThrow();
  });

  it('executes a legitimate script with spaces in the working path and a validated environment', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vis sbatch spaced '));
    temporaryDirectories.push(root);
    const workdir = path.join(root, 'compute work');
    mkdirSync(workdir, { recursive: true });

    const pwdRun = executeSbatchScript(
      buildSbatchScript({ intentId: INTENT, resources: RESOURCES, command: 'pwd', cwd: workdir }),
      tmpdir(),
    );
    expect(pwdRun.status).toBe(0);
    expect((pwdRun.stdout ?? '').trim()).toBe(workdir);

    const envRun = executeSbatchScript(
      buildSbatchScript({
        intentId: INTENT,
        resources: RESOURCES,
        command: 'sh',
        args: ['-c', 'printf %s "$VIS_MARKER"'],
        cwd: workdir,
        env: { VIS_MARKER: 'ok value' },
      }),
      tmpdir(),
    );
    expect(envRun.status).toBe(0);
    expect(envRun.stdout).toBe('ok value');
  });
});

describe('slurm sbatch script: the compute working directory fails closed (PR #182 item 5)', () => {
  const INTENT = '33333333-3333-4333-8333-333333333333';

  function executeSbatchScript(script: string, cwd: string) {
    const directory = mkdtempSync(path.join(tmpdir(), 'vis-sbatch-cwd-'));
    temporaryDirectories.push(directory);
    const file = path.join(directory, 'job.sh');
    writeFileSync(file, script, 'utf8');
    return spawnSync('bash', [file], { cwd, encoding: 'utf8' });
  }

  it('a missing compute working directory aborts before the command and never runs in the submission directory', () => {
    const missing = path.join(tmpdir(), `vis-sbatch-missing-${process.pid}-${Date.now()}`);
    const script = buildSbatchScript({
      intentId: INTENT,
      resources: RESOURCES,
      command: 'pwd',
      cwd: missing,
      output: `${missing}/slurm-%j.out`,
    });
    const run = executeSbatchScript(script, tmpdir());
    expect(run.status).not.toBe(0);
    expect((run.stdout ?? '').trim()).not.toBe(tmpdir());
    expect(`${run.stdout ?? ''}${run.stderr ?? ''}`).toContain('compute working directory is unavailable');
  });

  const isRoot = process.getuid?.() === 0;
  it.skipIf(isRoot)('a compute working directory without permission aborts before the command', () => {
    const root = mkdtempSync(path.join(tmpdir(), 'vis-sbatch-noperm-'));
    temporaryDirectories.push(root);
    const locked = path.join(root, 'locked');
    mkdirSync(locked, { recursive: true });
    chmodSync(locked, 0o000);
    try {
      const script = buildSbatchScript({
        intentId: INTENT,
        resources: RESOURCES,
        command: 'pwd',
        cwd: locked,
        output: `${locked}/slurm-%j.out`,
      });
      const run = executeSbatchScript(script, tmpdir());
      expect(run.status).not.toBe(0);
      expect((run.stdout ?? '').trim()).not.toBe(tmpdir());
    } finally {
      chmodSync(locked, 0o700);
    }
  });
});
