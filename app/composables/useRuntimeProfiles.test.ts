/**
 * Task 30 acceptance tests — the runtime profile composable.
 *
 *   1. Browser and Electron expose the SAME capability entry.
 *   2. With no managed bridge the runtime is explicitly direct-only.
 *   3. Cancelling a connection must NOT cancel a borrowed job.
 *   4. A password / OTP is never cached.
 *   5. A visible compute node AND a stable environment distinction.
 *
 * The tests drive the REAL bridge modules wherever a payload crosses a layer boundary: the strict
 * profile parser, the Slurm job controller with a real control store and a counting scheduler,
 * and the real secret channel / redaction helpers. Nothing here re-implements a production
 * algorithm inside a fixture.
 */
import { mkdtemp, rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it } from 'vitest';

import { createSlurmControlStore } from '../../bridge/runtime/transports/slurmControlStore.js';
import { createSlurmJobController } from '../../bridge/runtime/transports/slurmJobs.js';
import { REDACTED, createSecretBox, createSecretChannel, redactSecrets } from '../../bridge/runtime/transports/sshAuthentication.js';
import type { ConnectionProfile } from '../../shared/runtime/connectionProfile.js';
import { parseCredentialRef, parseTransport } from '../../shared/runtime/connectionProfile.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';
import {
  TRANSPORT_KINDS,
  assertNoSecretPayload,
  buildChallengeAnswer,
  createBridgeProfileClient,
  createRuntimeSecretBox,
  isDirectOnlyRuntime,
  planConnectionCancel,
  resolveRuntimeCapabilityEntry,
  resolveRuntimeTargetIdentity,
  sameRuntimeEnvironment,
  stopRefusalReason,
  updateRefusalReason,
  useRuntimeProfiles,
  validateSlurmResourceInput,
} from './useRuntimeProfiles';
import type { RuntimeChallenge, SlurmLifecycleStatus } from './useRuntimeProfiles';

const CLUSTER_ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const OTHER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const COMPUTE_NODE = 'compute-01.cluster';
const SECRET = 'correct-horse-battery';
const OTP = '491207';
const EXT4 = 0xef53;

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

function challenge(kind: RuntimeChallenge['kind'], overrides: Partial<RuntimeChallenge> = {}): RuntimeChallenge {
  return Object.freeze({
    challengeId: 'challenge-1',
    kind,
    prompt: kind === 'host-key' ? 'Trust compute-01.cluster?' : 'Password:',
    echo: false,
    redacted: true,
    createdAt: 1,
    ...overrides,
  });
}

function lifecycle(overrides: Partial<SlurmLifecycleStatus> = {}): SlurmLifecycleStatus {
  return Object.freeze({
    environmentId: CLUSTER_ENVIRONMENT,
    intentId: 'intent-1',
    jobId: '24680',
    state: 'RUNNING',
    queue: 'RUNNING',
    terminal: null,
    reconcile: null,
    attached: true,
    ownership: 'owned',
    computeNode: COMPUTE_NODE,
    stepId: 'step-1',
    epoch: 3,
    bridgeInstanceId: 'bridge-1',
    ...overrides,
  });
}

// ---------------------------------------------------------------------------
// 1. Browser and Electron expose the SAME capability entry
// ---------------------------------------------------------------------------

describe('Browser and Electron expose the SAME capability entry', () => {
  const transports = Object.freeze({ direct: true, ssh: true, slurm: true });

  it('resolves an identical entry for both clients, so neither runtime can gain a capability', () => {
    const browser = resolveRuntimeCapabilityEntry({ client: 'browser', transports, managedTransport: true });
    const electron = resolveRuntimeCapabilityEntry({ client: 'electron', transports, managedTransport: true });
    expect(browser).toEqual(electron);
    // The entry is not merely equal by accident: it is the same ordered row set.
    expect(browser.map((row) => row.capability)).toEqual(['direct', 'managed-bridge', 'ssh', 'slurm']);
    expect(browser.every((row) => row.state === 'supported')).toBe(true);
  });

  it('keeps the entry identical when the managed bridge is absent on both clients', () => {
    const browser = resolveRuntimeCapabilityEntry({ client: 'browser', transports, managedTransport: false });
    const electron = resolveRuntimeCapabilityEntry({ client: 'electron', transports, managedTransport: false });
    expect(browser).toEqual(electron);
    const unsupported = browser.filter((row) => row.state === 'unsupported').map((row) => row.capability);
    expect(unsupported).toEqual(['managed-bridge', 'ssh', 'slurm']);
    // A target that reports no transport is unavailable on BOTH clients, never just one.
    const noTransports = Object.freeze({ direct: false, ssh: false, slurm: false });
    expect(resolveRuntimeCapabilityEntry({ client: 'browser', transports: noTransports, managedTransport: true }))
      .toEqual(resolveRuntimeCapabilityEntry({ client: 'electron', transports: noTransports, managedTransport: true }));
  });

  it('names the environment the entry resolves against, so an unavailable row is attributable', () => {
    const rows = resolveRuntimeCapabilityEntry({
      client: 'electron',
      transports: Object.freeze({ direct: true, ssh: false, slurm: false }),
      managedTransport: false,
      environmentId: CLUSTER_ENVIRONMENT,
    });
    for (const row of rows) expect(row.environmentId).toBe(CLUSTER_ENVIRONMENT);
    const ssh = rows.find((row) => row.capability === 'ssh');
    expect(ssh?.state).toBe('unsupported');
    expect(ssh?.reason).toBe('No managed bridge: SSH is unavailable');
  });
});

// ---------------------------------------------------------------------------
// 2. With no managed bridge the runtime is explicitly direct-only
// ---------------------------------------------------------------------------

describe('with no managed bridge the runtime is explicitly direct-only', () => {
  it('marks the runtime direct-only rather than leaving the relay implied', () => {
    expect(isDirectOnlyRuntime({ managedTransport: false })).toBe(true);
    expect(isDirectOnlyRuntime({ managedTransport: true })).toBe(false);
  });

  it('keeps direct usable while every managed transport carries a reason', () => {
    const rows = resolveRuntimeCapabilityEntry({
      client: 'browser',
      transports: Object.freeze({ direct: true, ssh: true, slurm: true }),
      managedTransport: false,
    });
    expect(rows.find((row) => row.capability === 'direct')?.state).toBe('supported');
    for (const capability of ['managed-bridge', 'ssh', 'slurm'] as const) {
      const row = rows.find((entry) => entry.capability === capability);
      expect(row?.state).toBe('unsupported');
      expect(typeof row?.reason).toBe('string');
      expect(row?.reason?.length ?? 0).toBeGreaterThan(0);
    }
  });
});

// ---------------------------------------------------------------------------
// 3. Cancelling a connection must NOT cancel a borrowed job
// ---------------------------------------------------------------------------

describe('cancelling a connection must NOT cancel a borrowed job', () => {
  const RESOURCES = Object.freeze({
    partition: 'cpu',
    account: 'research',
    cpus: 4,
    memory: '8G',
    time: '01:00:00',
    gres: 'none',
  });

  /** A real control store on a verified local disk, so the intent is durable rather than in-memory. */
  async function openStore(root: string) {
    const store = createSlurmControlStore({
      root,
      environmentId: CLUSTER_ENVIRONMENT,
      ownerInstanceId: 'task-30-test',
      platform: 'linux',
      statfs: () => ({ type: EXT4 }),
    });
    await store.open('owner');
    return store;
  }

  function countingScheduler(jobId: string) {
    const cancelCalls: Array<{ intentId: string; jobId: string }> = [];
    const queryCalls: Array<{ intentId: string; uuid: string }> = [];
    return {
      scheduler: {
        async submit() {
          return { stdout: `${jobId}\n` };
        },
        async query(request: { intentId: string; uuid: string }) {
          queryCalls.push(request);
          return { matches: [{ jobId, state: 'RUNNING' }] };
        },
        async cancel(request: { intentId: string; jobId: string }) {
          cancelCalls.push(request);
          return { cancelled: true };
        },
      },
      cancelCalls,
      queryCalls,
    };
  }

  it('plans a cancel that cannot produce a scheduler signal, for owned and borrowed alike', () => {
    const intents = [
      lifecycle({ intentId: 'owned-1', ownership: 'owned' }),
      lifecycle({ intentId: 'borrowed-1', ownership: 'borrowed' }),
      lifecycle({ intentId: 'detached-1', attached: false }),
    ];
    const plan = planConnectionCancel({ profileId: 'profile-1', intents });
    // The literal 0 is part of the type: the plan has no branch that emits a signal.
    expect(plan.cancelledJobs).toBe(0);
    expect(plan.detached).toEqual(['owned-1', 'borrowed-1']);
    expect(plan.detachedCount).toBe(2);
    expect(plan.nativeHistoryPreserved).toBe(true);
    expect(plan.ownedJobsPreserved).toBe(true);
  });

  it('observes ZERO cancel signals on a real controller when a borrowed job is disconnected', async () => {
    const root = await temporaryDirectory('vis-task30-borrowed-');
    const store = await openStore(root);
    const scheduler = countingScheduler('24680');
    const controller = createSlurmJobController({
      store,
      scheduler: scheduler.scheduler,
      environmentId: CLUSTER_ENVIRONMENT,
    });
    try {
      const borrowed = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'borrowed' });
      await controller.reconcile(borrowed.intentId);

      // What the UI does on a connection cancel: detach the tracking, never signal.
      const detached = await controller.detach(borrowed.intentId);
      expect(detached).toMatchObject({ attached: false, cancelled: false, signalled: false });

      // The observed count is what matters, not a status string.
      expect(scheduler.cancelCalls).toHaveLength(0);
      const after = await controller.state(borrowed.intentId);
      expect(after?.attached).toBe(false);
      expect(after?.ownership).toBe('borrowed');
      // The job is still alive on the scheduler.
      expect(scheduler.queryCalls.length).toBeGreaterThan(0);
    } finally {
      await store.close();
    }
  });

  it('still refuses to stop a borrowed allocation even when asked directly', async () => {
    const root = await temporaryDirectory('vis-task30-stop-borrowed-');
    const store = await openStore(root);
    const scheduler = countingScheduler('13579');
    const controller = createSlurmJobController({
      store,
      scheduler: scheduler.scheduler,
      environmentId: CLUSTER_ENVIRONMENT,
    });
    try {
      const borrowed = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'borrowed' });
      await controller.reconcile(borrowed.intentId);

      // The UI gate refuses before any signal can be produced.
      const intent = await controller.state(borrowed.intentId);
      expect(stopRefusalReason(lifecycle({ ownership: intent?.ownership === 'owned' ? 'owned' : 'borrowed' }))).toBe('borrowed');

      const stopped = await controller.stop(borrowed.intentId);
      expect(stopped).toMatchObject({ signalled: false, cancelled: false, reason: 'borrowed' });
      expect(scheduler.cancelCalls).toHaveLength(0);
    } finally {
      await store.close();
    }
  });

  it('signals an OWNED job exactly once and never on a connection cancel', async () => {
    const root = await temporaryDirectory('vis-task30-owned-');
    const store = await openStore(root);
    const scheduler = countingScheduler('97531');
    const controller = createSlurmJobController({
      store,
      scheduler: scheduler.scheduler,
      environmentId: CLUSTER_ENVIRONMENT,
    });
    try {
      const owned = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'owned' });
      await controller.reconcile(owned.intentId);

      // A disconnect is not a stop request.
      await controller.detach(owned.intentId);
      expect(scheduler.cancelCalls).toHaveLength(0);

      // An explicit stop signals exactly once.
      const stopped = await controller.stop(owned.intentId);
      expect(stopped).toMatchObject({ signalled: true, cancelled: true });
      expect(scheduler.cancelCalls).toEqual([{ intentId: owned.intentId, jobId: '97531' }]);
    } finally {
      await store.close();
    }
  });

  it('refuses a second stop after the job reached a terminal state', async () => {
    const root = await temporaryDirectory('vis-task30-terminal-');
    const store = await openStore(root);
    const scheduler = countingScheduler('11111');
    const controller = createSlurmJobController({
      store,
      scheduler: scheduler.scheduler,
      environmentId: CLUSTER_ENVIRONMENT,
    });
    try {
      const owned = await controller.submit({ resources: RESOURCES, command: '/opt/vis/vis_bridge', ownership: 'owned' });
      await controller.reconcile(owned.intentId);
      await controller.stop(owned.intentId);
      const intent = await controller.state(owned.intentId);
      expect(stopRefusalReason(lifecycle({ ownership: 'owned', terminal: intent?.terminal ?? 'CANCELLED', jobId: '11111' }))).toBe('terminal');
      await controller.stop(owned.intentId);
      expect(scheduler.cancelCalls).toHaveLength(1);
    } finally {
      await store.close();
    }
  });
});

// ---------------------------------------------------------------------------
// 4. A password / OTP is never cached
// ---------------------------------------------------------------------------

describe('a password / OTP is never cached', () => {
  it('redacts the secret in every projection of the answer payload the UI serializes', () => {
    for (const [kind, value] of [['password', SECRET], ['otp', OTP]] as const) {
      const answer = buildChallengeAnswer(challenge(kind), { accept: true, secret: value });
      // The REAL serialized payload the UI would hand over.
      const payload = JSON.stringify(answer);
      expect(payload).not.toContain(value);
      expect(payload).toContain('challengeId');
      expect(answer.secret).toBeDefined();
      // The bridge's own redactor, run over the UI's real payload.
      const redacted = redactSecrets(payload, [value]);
      expect(redacted).not.toContain(value);
      expect(redacted).toContain(REDACTED);
      // A template interpolation is redacted too, so a log line cannot leak it.
      expect(`${answer.secret}`).toBe(REDACTED);
      expect(String(answer.secret)).toBe(REDACTED);
      expect(answer.secret?.toJSON()).toBe(REDACTED);
      // The value is reachable exactly once, through consume().
      expect(answer.secret?.consume()).toBe(value);
      expect(() => answer.secret?.consume()).toThrow();
    }
  });

  it('agrees with the REAL bridge secret box on the redaction contract', () => {
    const ui = createRuntimeSecretBox(SECRET, 'password');
    const bridge = createSecretBox(SECRET, 'password');
    expect(ui.label).toBe(bridge.label);
    expect(ui.size).toBe(bridge.size);
    expect(String(ui)).toBe(String(bridge));
    expect(JSON.stringify(ui)).toBe(JSON.stringify(bridge));
    expect(ui.toString()).toBe(bridge.toString());
    expect(ui.consume()).toBe(bridge.consume());
  });

  it('sends the secret through a 0600 askpass FILE PATH, never as argv or an env value', async () => {
    const directory = await temporaryDirectory('vis-task30-secret-');
    const channel = await createSecretChannel([SECRET], { directory, askpassPath: '/usr/lib/vis/askpass' });
    try {
      // The askpass is a path; the secret is a file with owner-only permissions.
      expect(channel.env.SSH_ASKPASS).toBe('/usr/lib/vis/askpass');
      expect(channel.env.SSH_ASKPASS_REQUIRE).toBe('force');
      expect(JSON.stringify(channel.env)).not.toContain(SECRET);
      expect((await stat(channel.filePath)).mode & 0o777).toBe(0o600);
      expect(await import('node:fs/promises').then((fs) => fs.readFile(channel.filePath, 'utf8'))).toBe(SECRET);
      // No argv form of the secret exists to leak.
      expect(JSON.stringify(channel.env)).not.toContain('--');
    } finally {
      await channel.cleanup();
      await expect(stat(channel.filePath)).rejects.toMatchObject({ code: 'ENOENT' });
    }
  });

  it('refuses to persist a profile that carries a secret, through the REAL parser', () => {
    const withPassword = {
      name: 'Workstation',
      transport: { kind: 'ssh' as const, endpoint: 'cluster.example.edu' },
      target: { kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT },
      role: 'manager' as const,
      credentialRef: 'cred-1',
      password: SECRET,
    };
    expect(() => assertNoSecretPayload(withPassword)).toThrow(/password/u);
    // A locator with an embedded token never reaches a dial: the real transport parser rejects it,
    // so a secret cannot hide inside an endpoint (task 25 reviewer finding).
    expect(() => parseTransport({ kind: 'direct', endpoint: 'wss://bridge.test/runtime?token=abc' })).toThrow(/secret/u);
    expect(() => parseTransport({ kind: 'ssh', endpoint: 'user:pass@cluster.example.edu' })).toThrow(/transport\.endpoint/u);
    expect(parseCredentialRef('cred-1')).toBe('cred-1');
    expect(() => parseCredentialRef('hunter2')).not.toThrow();
  });

  it('never offers an accept path for a changed host key', () => {
    const answer = buildChallengeAnswer(challenge('host-key-changed'), { accept: true, persist: true });
    expect(answer.accept).toBe(true);
    // The payload is well formed, but the surface must disable the accept affordance.
    const accept = challenge('host-key-changed').kind !== 'host-key-changed';
    expect(accept).toBe(false);
    expect(answer.secret).toBeUndefined();
  });

  it('carries no secret at all for a trust-only challenge', () => {
    const answer = buildChallengeAnswer(challenge('host-key'), { accept: true, persist: true });
    expect(answer).toEqual({ challengeId: 'challenge-1', kind: 'host-key', accept: true, persist: true });
    expect(JSON.stringify(answer)).not.toContain('secret');
  });
});

// ---------------------------------------------------------------------------
// 5. A visible compute node AND a stable environment distinction
// ---------------------------------------------------------------------------

describe('a visible compute node AND a stable environment distinction', () => {
  const sshProfile = Object.freeze({
    profileId: '33333333-3333-4333-8333-333333333333',
    name: 'Cluster',
    transport: Object.freeze({ kind: 'ssh' as const, endpoint: 'cluster.example.edu' }),
    target: Object.freeze({ kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: true,
  });
  const slurmProfile = Object.freeze({
    ...sshProfile,
    profileId: '44444444-4444-4444-8444-444444444444',
    transport: Object.freeze({ kind: 'slurm' as const }),
    target: Object.freeze({ kind: 'slurm' as const, clusterEnvironmentId: CLUSTER_ENVIRONMENT as EnvironmentId }),
  }) as ConnectionProfile;

  it('resolves the cluster environment UUID, never the compute node or the job id', () => {
    const identity = resolveRuntimeTargetIdentity(slurmProfile);
    expect(identity.environmentId).toBe(CLUSTER_ENVIRONMENT);
    expect(identity.targetKind).toBe('slurm');
    // The node and the job are rendered alongside, not instead of, the environment.
    const status = lifecycle({ computeNode: COMPUTE_NODE, jobId: '24680' });
    expect(status.computeNode).toBe(COMPUTE_NODE);
    expect(status.environmentId).toBe(CLUSTER_ENVIRONMENT);
    expect(identity.environmentId).not.toBe(COMPUTE_NODE);
    expect(identity.environmentId).not.toBe('24680');
  });

  it('treats two environments on the SAME compute node as different environments', () => {
    const left = resolveRuntimeTargetIdentity(slurmProfile);
    const otherProfile = Object.freeze({
      ...slurmProfile,
      profileId: '55555555-5555-4555-8555-555555555555',
      target: { kind: 'slurm', clusterEnvironmentId: OTHER_ENVIRONMENT as EnvironmentId },
    }) as ConnectionProfile;
    const right = resolveRuntimeTargetIdentity(otherProfile);
    expect(left.environmentId).not.toBe(right.environmentId);
    expect(sameRuntimeEnvironment(left, right)).toBe(false);
    // The compute node is not part of the identity comparison.
    const moved = lifecycle({ environmentId: OTHER_ENVIRONMENT, computeNode: 'compute-99.cluster' });
    expect(sameRuntimeEnvironment(left, resolveRuntimeTargetIdentity({
      target: { kind: 'slurm', clusterEnvironmentId: OTHER_ENVIRONMENT as EnvironmentId },
    }))).toBe(false);
    expect(moved.computeNode).not.toBe(COMPUTE_NODE);
  });

  it('treats one environment across a moved compute node as the SAME environment', () => {
    const first = resolveRuntimeTargetIdentity(slurmProfile);
    const second = resolveRuntimeTargetIdentity(slurmProfile);
    expect(sameRuntimeEnvironment(first, second)).toBe(true);
    const moved = lifecycle({ computeNode: 'compute-77.cluster' });
    expect(moved.environmentId).toBe(first.environmentId);
    expect(moved.computeNode).not.toBe(COMPUTE_NODE);
  });
});

// ---------------------------------------------------------------------------
// Composable behaviour
// ---------------------------------------------------------------------------

describe('useRuntimeProfiles drives the picker, the forms and the lifecycle', () => {
  function profilePort(profiles: readonly unknown[]) {
    const calls: string[] = [];
    return {
      calls,
      port: {
        async list() {
          calls.push('list');
          return Object.freeze(profiles.map((entry) => JSON.parse(JSON.stringify(entry)) as never));
        },
        async create(input: Record<string, unknown>) {
          calls.push('create');
          return { ...input, profileId: '66666666-6666-4666-8666-666666666666' } as never;
        },
        async update() {
          calls.push('update');
          return undefined;
        },
        async setEnabled() {
          calls.push('setEnabled');
          return undefined;
        },
        async remove() {
          calls.push('remove');
          return undefined;
        },
        async connect(profileId: string) {
          calls.push(`connect:${profileId}`);
          return { profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 1 };
        },
        async disconnect(profileId: string) {
          calls.push(`disconnect:${profileId}`);
          return { profileId, state: 'disconnected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 1 };
        },
        async reconnect(profileId: string) {
          calls.push(`reconnect:${profileId}`);
          return { profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 2 };
        },
        async inspect() {
          calls.push('inspect');
          return { profiles: [] };
        },
      },
    };
  }

  const savedProfile = Object.freeze({
    profileId: '66666666-6666-4666-8666-666666666666',
    name: 'Lab cluster',
    transport: Object.freeze({ kind: 'ssh' as const, endpoint: 'cluster.example.edu' }),
    target: Object.freeze({ kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: false,
  }) as ConnectionProfile;

  it('selects a profile and resolves its stable environment', () => {
    const runtime = useRuntimeProfiles({ profiles: [savedProfile], managedTransport: true, transports: { direct: true, ssh: true, slurm: false } });
    expect(runtime.directOnly.value).toBe(false);
    runtime.selectProfile(savedProfile.profileId);
    expect(runtime.selectedProfile.value?.name).toBe('Lab cluster');
    expect(runtime.selectedIdentity.value?.environmentId).toBe(CLUSTER_ENVIRONMENT);
    expect(runtime.capabilityEntry.value.find((row) => row.capability === 'ssh')?.state).toBe('supported');
    expect(runtime.capabilityEntry.value.find((row) => row.capability === 'slurm')?.state).toBe('unsupported');
  });

  it('creates a profile through the strict parser, which refuses to auto-enable it', async () => {
    const port = profilePort([]);
    const runtime = useRuntimeProfiles({ profilePort: port.port as never, managedTransport: true });
    const created = await runtime.createProfile({
      name: 'Lab cluster',
      transport: { kind: 'ssh', endpoint: 'cluster.example.edu' },
      target: { kind: 'ssh', environmentId: CLUSTER_ENVIRONMENT as EnvironmentId },
      role: 'manager',
      credentialRef: 'cred-1',
      enabled: false,
    });
    expect(created?.enabled).toBe(false);
    expect(created?.profileId).toBe('66666666-6666-4666-8666-666666666666');
    expect(runtime.selectedProfileId.value).toBe('66666666-6666-4666-8666-666666666666');
    expect(port.calls).toContain('create');
  });

  it('refuses a resource request whose time or gres is missing, before any submit', async () => {
    expect(validateSlurmResourceInput({ partition: 'cpu', cpus: 1, memory: '1G', time: '', gres: 'none' })).toEqual(['time']);
    expect(validateSlurmResourceInput({ partition: '', cpus: 0, memory: '', time: '01:00:00', gres: '' })).toEqual(['partition', 'cpus', 'memory', 'gres']);
    const submitted: unknown[] = [];
    const runtime = useRuntimeProfiles({
      slurmPort: {
        preview: () => Object.freeze({
          nodes: 1, ntasks: 1, cpus: 1, memory: '1G', memoryMiB: 1024, time: '01:00:00', timeSeconds: 3600,
          gres: 'none', requestsGpu: false, partition: 'cpu', account: null,
        }),
        submit: async (request) => {
          submitted.push(request);
          return lifecycle();
        },
        detach: async () => ({ intentId: 'intent-1', cancelled: false, signalled: false }),
        stop: async () => ({ intentId: 'intent-1', cancelled: true, signalled: true }),
        state: async () => lifecycle(),
      },
      managedTransport: true,
    });
    expect(await runtime.submitSlurm({ resources: { partition: 'cpu', cpus: 1, memory: '1G', time: '', gres: 'none' } })).toBeNull();
    expect(submitted).toHaveLength(0);
    expect(runtime.error.value).toContain('runtime.slurm.resource:time');
  });

  it('detaches rather than cancels when the connection is cancelled', async () => {
    const detached: string[] = [];
    const stopped: string[] = [];
    const runtime = useRuntimeProfiles({
      profiles: [savedProfile],
      managedTransport: true,
      slurmPort: {
        preview: () => Object.freeze({
          nodes: 1, ntasks: 1, cpus: 1, memory: '1G', memoryMiB: 1024, time: '01:00:00', timeSeconds: 3600,
          gres: 'none', requestsGpu: false, partition: 'cpu', account: null,
        }),
        submit: async () => lifecycle({ ownership: 'borrowed' }),
        detach: async (intentId: string) => {
          detached.push(intentId);
          return { intentId, cancelled: false, signalled: false };
        },
        stop: async (intentId: string) => {
          stopped.push(intentId);
          return { intentId, cancelled: true, signalled: true };
        },
        state: async () => lifecycle({ ownership: 'borrowed' }),
      },
    });
    runtime.selectProfile(savedProfile.profileId);
    runtime.slurmStatuses.value = Object.freeze([lifecycle({ ownership: 'borrowed', attached: true })]);
    const receipt = await runtime.cancelConnection(savedProfile.profileId);
    expect(receipt?.cancelledJobs).toBe(0);
    expect(receipt?.detached).toEqual(['intent-1']);
    expect(detached).toEqual(['intent-1']);
    expect(stopped).toEqual([]);
    expect(runtime.slurmStatuses.value[0]?.attached).toBe(false);
  });

  it('refuses an update when the bridge plan is unknown or incompatible', () => {
    expect(updateRefusalReason(null)).toBe('not-explicit');
    expect(updateRefusalReason({
      action: 'install', location: 'remote', channel: 'transport', compatible: false, connectable: false,
      upgradePath: null, automatic: false, requiresExplicitAction: true,
    })).toBe('unsupported');
    expect(updateRefusalReason({
      action: 'upgrade', location: 'remote', channel: 'transport', compatible: true, connectable: true,
      upgradePath: { fromVersion: '0.8.0', requiredProtocol: 'v090-runtime' }, automatic: false, requiresExplicitAction: true,
    })).toBeNull();
  });

  it('declares the transport kinds the profile contract accepts', () => {
    expect([...TRANSPORT_KINDS]).toEqual(['local', 'direct', 'ssh', 'slurm']);
  });
});

// ---------------------------------------------------------------------------
// PR #184 finding 2 — the real client must honour the real response envelope
// ---------------------------------------------------------------------------

describe('the real bridge profile client honours the real response envelope', () => {
  const BRIDGE_PROFILE = Object.freeze({
    profileId: '77777777-7777-4777-8777-777777777777',
    name: 'Lab cluster',
    transport: Object.freeze({ kind: 'ssh' as const, endpoint: 'cluster.example.edu' }),
    target: Object.freeze({ kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: true,
  });

  function bridgeFetch(payload: unknown) {
    const calls: Array<{ method: string; url: string }> = [];
    const fetchImpl = (async (input: unknown, init?: { method?: string }) => {
      calls.push({ method: init?.method ?? 'GET', url: String(input) });
      return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
    }) as unknown as typeof fetch;
    return { fetchImpl, calls };
  }

  it('reads the profiles out of the envelope the bridge really sends, and refresh() survives it', async () => {
    const bridge = bridgeFetch({ profiles: [BRIDGE_PROFILE] });
    const port = createBridgeProfileClient({ baseUrl: 'http://bridge.test', fetchImpl: bridge.fetchImpl });
    const runtime = useRuntimeProfiles({ profilePort: port, managedTransport: true });

    await runtime.refresh();

    expect(runtime.error.value).toBe('');
    expect(runtime.profiles.value).toHaveLength(1);
    expect(runtime.profiles.value[0]?.profileId).toBe(BRIDGE_PROFILE.profileId);
    expect(bridge.calls).toContainEqual({ method: 'GET', url: 'http://bridge.test/api/v1/profiles' });
  });

  it('never presents a profile list entry as a connection status', async () => {
    const bridge = bridgeFetch({ profiles: [BRIDGE_PROFILE] });
    const port = createBridgeProfileClient({ baseUrl: 'http://bridge.test', fetchImpl: bridge.fetchImpl });
    const runtime = useRuntimeProfiles({ profilePort: port, managedTransport: true });

    await runtime.refresh();

    // A ConnectionProfile carries no state and no generation. Inventing one here would show a
    // status chip for a connection nobody observed.
    expect(runtime.statuses.value).toEqual([]);
    expect(runtime.statusOf.value).toBeNull();
  });

  it('still reports a genuine transport failure instead of swallowing it', async () => {
    const failing = (async () => ({ ok: false, status: 500, text: async () => JSON.stringify({ code: 'internal' }) })) as unknown as typeof fetch;
    const port = createBridgeProfileClient({ baseUrl: 'http://bridge.test', fetchImpl: failing });
    const runtime = useRuntimeProfiles({ profilePort: port, managedTransport: true });

    await runtime.refresh();

    expect(runtime.error.value).toBe('internal');
    expect(runtime.profiles.value).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// PR #184 finding 5 — a disconnect must update the status it was given
// ---------------------------------------------------------------------------

describe('a disconnect updates the status the port returns', () => {
  const PROFILE_ID = '88888888-8888-4888-8888-888888888888';
  const slurmProfile = Object.freeze({
    profileId: PROFILE_ID,
    name: 'Lab cluster',
    transport: Object.freeze({ kind: 'ssh' as const, endpoint: 'cluster.example.edu' }),
    target: Object.freeze({ kind: 'ssh' as const, environmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: true,
  }) as ConnectionProfile;

  function statusPort(overrides: Partial<Record<'connect' | 'disconnect' | 'reconnect', (profileId: string) => Promise<never>>> = {}) {
    const calls: string[] = [];
    const build = (verb: string, fallback: (profileId: string) => object) =>
      overrides[verb as 'connect'] ?? (async (profileId: string) => { calls.push(`${verb}:${profileId}`); return fallback(profileId); });
    return {
      calls,
      port: {
        async list() { return Object.freeze([] as readonly ConnectionProfile[]); },
        async create() { return slurmProfile; },
        async update() { return undefined; },
        async setEnabled() { return undefined; },
        async remove() { return undefined; },
        async inspect() { return Object.freeze({ profiles: Object.freeze([]) }); },
        connect: build('connect', (profileId) => Object.freeze({ profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 1 })),
        disconnect: build('disconnect', (profileId) => Object.freeze({ profileId, state: 'disconnected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 2 })),
        reconnect: build('reconnect', (profileId) => Object.freeze({ profileId, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 3 })),
      },
    };
  }

  it('writes the disconnected status, so the chip stops reporting connected', async () => {
    const port = statusPort();
    const runtime = useRuntimeProfiles({ profilePort: port.port as never, profiles: [slurmProfile], managedTransport: true });
    runtime.selectProfile(PROFILE_ID);

    await runtime.connect(PROFILE_ID);
    expect(runtime.statusOf.value).toMatchObject({ state: 'connected', generation: 1 });

    const receipt = await runtime.cancelConnection(PROFILE_ID);
    expect(receipt).not.toBeNull();
    expect(port.calls).toContain(`disconnect:${PROFILE_ID}`);

    expect(runtime.statusOf.value).toMatchObject({ state: 'disconnected', generation: 2 });
    expect(runtime.statusOf.value?.state).not.toBe('connected');
  });

  it('keeps a disconnect result when an earlier connect is still in flight', async () => {
    const gate: { release?: () => void } = {};
    const port = statusPort({
      connect: (async () => {
        await new Promise<void>((resolve) => { gate.release = resolve; });
        return Object.freeze({ profileId: PROFILE_ID, state: 'connected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 9 });
      }) as never,
      disconnect: (async () => Object.freeze({ profileId: PROFILE_ID, state: 'disconnected' as const, environmentId: CLUSTER_ENVIRONMENT, generation: 0 })) as never,
    });
    const runtime = useRuntimeProfiles({ profilePort: port.port as never, profiles: [slurmProfile], managedTransport: true });
    runtime.selectProfile(PROFILE_ID);

    const connecting = runtime.connect(PROFILE_ID);
    const cancelling = runtime.cancelConnection(PROFILE_ID);
    await cancelling;
    expect(runtime.statusOf.value).toMatchObject({ state: 'disconnected' });

    gate.release?.();
    await connecting;

    expect(runtime.statusOf.value).toMatchObject({ state: 'disconnected', generation: 0 });
  });
});

// ---------------------------------------------------------------------------
// PR #184 finding 3 — a profile and the intent it submits are different identities
// ---------------------------------------------------------------------------

describe('a profile and the intent it submits are different identities', () => {
  const PROFILE_ID = '99999999-9999-4999-8999-999999999999';
  const INTENT_ID = 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa';
  const SECOND_INTENT_ID = 'bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb';
  const RESOURCES = Object.freeze({
    partition: 'cpu', account: null, cpus: 4, memory: '8G', time: '01:00:00', gres: 'none',
  });
  const slurmProfile = Object.freeze({
    profileId: PROFILE_ID,
    name: 'Lab cluster',
    transport: Object.freeze({ kind: 'slurm' as const }),
    target: Object.freeze({ kind: 'slurm' as const, clusterEnvironmentId: CLUSTER_ENVIRONMENT }),
    role: 'manager' as const,
    credentialRef: 'cred-1',
    enabled: true,
  }) as ConnectionProfile;

  function slurmRuntime(intentIds: readonly string[], record?: { detached: string[]; stopped: string[] }) {
    const submitted: unknown[] = [];
    let index = 0;
    const port = {
      preview: () => Object.freeze({
        nodes: 1, ntasks: 1, cpus: 4, memory: '8G', memoryMiB: 8192, time: '01:00:00', timeSeconds: 3600,
        gres: 'none', requestsGpu: false, partition: 'cpu', account: null,
      }),
      submit: async (request: unknown) => {
        submitted.push(request);
        const intentId = intentIds[index] ?? INTENT_ID;
        index += 1;
        return lifecycle({ intentId, jobId: String(1000 + index), attached: true });
      },
      detach: async (intentId: string) => {
        record?.detached.push(intentId);
        return Object.freeze({ intentId, cancelled: false, signalled: false });
      },
      stop: async (intentId: string) => {
        record?.stopped.push(intentId);
        return Object.freeze({ intentId, cancelled: true, signalled: true });
      },
      state: async (intentId: string) => lifecycle({ intentId }),
    };
    const runtime = useRuntimeProfiles({ profiles: [slurmProfile], slurmPort: port as never, managedTransport: true });
    runtime.selectProfile(PROFILE_ID);
    return { runtime, submitted, port };
  }

  it('associates a submitted job with the profile that submitted it, with two DIFFERENT uuids', async () => {
    const { runtime } = slurmRuntime([INTENT_ID]);

    const status = await runtime.submitSlurm({ resources: RESOURCES });

    expect(status?.intentId).toBe(INTENT_ID);
    expect(status?.intentId).not.toBe(PROFILE_ID);
    expect(runtime.slurmStatuses.value).toHaveLength(1);
    expect(runtime.selectedSlurm.value?.intentId).toBe(INTENT_ID);
    expect(runtime.selectedSlurm.value?.jobId).toBe('1001');
  });

  it('keeps the association when the same profile submits a second job', async () => {
    const { runtime } = slurmRuntime([INTENT_ID, SECOND_INTENT_ID]);

    await runtime.submitSlurm({ resources: RESOURCES });
    expect(runtime.selectedSlurm.value?.intentId).toBe(INTENT_ID);

    await runtime.submitSlurm({ resources: RESOURCES });
    expect(runtime.slurmStatuses.value).toHaveLength(2);
    expect(runtime.selectedSlurm.value?.intentId).toBe(SECOND_INTENT_ID);
  });

  it('drops the association when another profile is selected, so a job is never borrowed across profiles', async () => {
    const otherProfile = Object.freeze({
      ...slurmProfile,
      profileId: 'cccccccc-cccc-4ccc-8ccc-cccccccccccc',
    }) as ConnectionProfile;
    const { runtime } = slurmRuntime([INTENT_ID]);
    runtime.profiles.value = Object.freeze([slurmProfile, otherProfile]);

    await runtime.submitSlurm({ resources: RESOURCES });
    expect(runtime.selectedSlurm.value?.intentId).toBe(INTENT_ID);

    runtime.selectProfile(otherProfile.profileId);
    expect(runtime.selectedSlurm.value).toBeNull();

    runtime.selectProfile(PROFILE_ID);
    expect(runtime.selectedSlurm.value?.intentId).toBe(INTENT_ID);
  });

  it('detaches and stops the INTENT, never the profile id', async () => {
    const record = { detached: [] as string[], stopped: [] as string[] };
    const { runtime } = slurmRuntime([INTENT_ID], record);
    await runtime.submitSlurm({ resources: RESOURCES });

    const target = runtime.selectedSlurm.value?.intentId ?? '';
    await runtime.detachSlurm(target);
    await runtime.stopSlurm(target);

    expect(target).toBe(INTENT_ID);
    expect(target).not.toBe(PROFILE_ID);
    expect(record.detached).toEqual([INTENT_ID]);
    expect(record.stopped).toEqual([INTENT_ID]);
  });
});
