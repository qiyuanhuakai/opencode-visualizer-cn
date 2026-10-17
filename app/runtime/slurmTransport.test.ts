import { EventEmitter } from 'node:events';
import { spawn } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { connect as netConnect } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createSlurmControlStore } from '../../bridge/runtime/transports/slurmControlStore.js';
import {
  COMPUTE_OPERATION_KINDS,
  RELAY_HANDSHAKE_KIND,
  RELAY_HELLO_ACK_KIND,
  assertComputeTarget,
  assertRelayHello,
  createRelayBinding,
  createRelayHandshake,
  routeComputeOperation,
} from '../../bridge/runtime/transports/relayHandshake.js';
import {
  RELAY_STORAGE_OPS,
  RELAY_TAG,
  createComputeRelay,
  createRelayChannel,
  decodeRelayMessages,
  dispatchStoreOperation,
  encodeRelayMessage,
} from '../../bridge/runtime/transports/computeRelay.js';
import { createSlurmTcpTransport } from '../../bridge/runtime/transports/slurmTcpTransport.js';
import {
  RELAY_STEP_CPUS,
  RELAY_STEP_MEMORY_MIB,
  RESERVE_CPUS,
  RESERVE_MEMORY_MIB,
  STEP_MODES,
  assertStepCapabilities,
  buildAllocationResources,
  buildStepArgv,
  createSlurmStepTransport,
  planStepReplacement,
} from '../../bridge/runtime/transports/slurmStepTransport.js';
import { parseCliOptions } from '../../vis_bridge';

const ENVIRONMENT = '11111111-1111-4111-8111-111111111111';
const INTENT = '22222222-2222-4222-8222-222222222222';
const BRIDGE_INSTANCE = '33333333-3333-4333-8333-333333333333';
const STEP_ID = '44444444-4444-4444-8444-444444444444';
const REPLACEMENT_STEP = '55555555-5555-4555-8555-555555555555';
const COMPUTE_NODE = 'compute-01.cluster';
const LOGIN_NODE = 'login-01.cluster';
const CREDENTIAL = 'relay-s3cret-credential';
const EXT4 = 0xef53;

function binding(overrides: Record<string, unknown> = {}) {
  return createRelayBinding({
    environmentId: ENVIRONMENT,
    intentId: INTENT,
    bridgeInstanceId: BRIDGE_INSTANCE,
    epoch: 3,
    computeNode: COMPUTE_NODE,
    stepId: STEP_ID,
    ...overrides,
  });
}

function handshake(overrides: Record<string, unknown> = {}) {
  return createRelayHandshake({ credential: CREDENTIAL, binding: binding(overrides) });
}

function relayOptions(overrides: Record<string, unknown> = {}) {
  return { binding: binding(), loginHosts: [LOGIN_NODE], credential: CREDENTIAL, ...overrides };
}

interface TestStream extends EventEmitter {
  push(chunk: Buffer): void;
  write(chunk: Buffer): boolean;
  end(): void;
  destroy(): void;
}

/**
 * A buffered duplex EventEmitter stream. Writes made before a `data` listener attaches are
 * queued and flushed on attach, so a challenge written at channel construction is never lost.
 */
function duplex(): TestStream {
  const stream = new EventEmitter() as TestStream;
  const pending: Buffer[] = [];
  const flush = () => {
    while (pending.length > 0 && stream.listenerCount('data') > 0) stream.emit('data', pending.shift());
  };
  stream.push = (chunk: Buffer) => {
    const buf = Buffer.from(chunk);
    if (stream.listenerCount('data') > 0) stream.emit('data', buf);
    else pending.push(buf);
  };
  const baseOn = EventEmitter.prototype.on.bind(stream);
  stream.on = ((event: string | symbol, handler: (...args: unknown[]) => void) => {
    baseOn(event, handler);
    if (event === 'data') flush();
    return stream;
  }) as TestStream['on'];
  stream.write = () => true;
  stream.end = () => {};
  stream.destroy = () => {
    stream.emit('close');
  };
  stream.off = ((event: string | symbol, handler: (...args: unknown[]) => void) => stream.removeListener(event, handler)) as TestStream['off'];
  return stream;
}

const temporaryDirectories: string[] = [];
afterEach(async () => {
  await Promise.all(temporaryDirectories.splice(0).map((directory) => rm(directory, { recursive: true, force: true })));
});
async function temporaryDirectory(prefix: string) {
  const directory = await mkdtemp(path.join(tmpdir(), prefix));
  temporaryDirectories.push(directory);
  return directory;
}

/** Links two relay endpoints so bytes written on one are delivered to the other's `data` readers. */
function linkedPair() {
  const left = duplex();
  const right = duplex();
  left.write = (chunk: Buffer) => {
    right.push(chunk);
    return true;
  };
  right.write = (chunk: Buffer) => {
    left.push(chunk);
    return true;
  };
  return { left, right };
}

/** A fake `srun` child whose stdio is linked to the remote (compute) end of the same step IO. */
function stdioHarness() {
  const toLogin = duplex();
  const toCompute = duplex();
  toCompute.write = (chunk: Buffer) => {
    toLogin.push(chunk);
    return true;
  };
  const child = new EventEmitter() as EventEmitter & Record<string, unknown>;
  child.pid = 4242;
  child.exitCode = null;
  child.stdout = toLogin;
  child.stdin = { write: (chunk: Buffer) => { toCompute.push(chunk); return true; }, end: vi.fn() };
  child.stderr = new EventEmitter();
  child.kill = vi.fn(() => true);
  return { child, compute: toCompute };
}

describe('relay handshake: binds live job + bridge instance + epoch', () => {
  it('accepts a matching challenge and rejects a forged credential or a changed binding', () => {
    const login = handshake();
    const compute = handshake();
    const challenge = login.challenge();
    expect(challenge.kind).toBe(RELAY_HANDSHAKE_KIND);
    expect(challenge).toMatchObject({ nonce: expect.any(String), token: expect.any(String) });
    expect(JSON.stringify(challenge)).not.toContain(CREDENTIAL);
    expect(compute.verify(challenge)).toBe(true);

    const ack = compute.ack(challenge.nonce);
    expect(ack.kind).toBe(RELAY_HELLO_ACK_KIND);
    expect(login.verify(ack)).toBe(true);

    const attacker = createRelayHandshake({ credential: 'wrong-credential', binding: binding() });
    expect(login.verify(attacker.challenge())).toBe(false);
  });

  it('rejects a relay loss whose job requeued to a new epoch with reconcile_required', () => {
    const expected = binding();
    expect(() => assertRelayHello({ expected, actual: binding() })).not.toThrow();
    expect(() =>
      assertRelayHello({ expected, actual: binding({ epoch: 4 }) }),
    ).toThrow(expect.objectContaining({ code: 'reconcile_required', field: 'relay.epoch' }));
    expect(() =>
      assertRelayHello({ expected, actual: binding({ bridgeInstanceId: '66666666-6666-4666-8666-666666666666' }) }),
    ).toThrow(expect.objectContaining({ code: 'conflict', field: 'relay.binding' }));
    expect(() =>
      assertRelayHello({ expected, actual: binding({ intentId: '77777777-7777-4777-8777-777777777777' }) }),
    ).toThrow(expect.objectContaining({ code: 'conflict', field: 'relay.binding' }));
  });

  it('proves every FS/Git/PTY/driver operation targets the compute node and rejects a login fallback', () => {
    expect(COMPUTE_OPERATION_KINDS).toEqual(['fs', 'git', 'pty', 'driver']);
    const target = { kind: 'compute', node: COMPUTE_NODE, environmentId: ENVIRONMENT };
    for (const kind of COMPUTE_OPERATION_KINDS) {
      const route = routeComputeOperation(kind, { target, loginHosts: [LOGIN_NODE] });
      expect(route).toMatchObject({ kind, host: COMPUTE_NODE });
    }
    expect(() =>
      routeComputeOperation('fs', { target: { kind: 'compute', node: LOGIN_NODE, environmentId: ENVIRONMENT }, loginHosts: [LOGIN_NODE] }),
    ).toThrow(expect.objectContaining({ code: 'unauthorized', field: 'target.login_fallback' }));
    expect(() =>
      assertComputeTarget({ target: { kind: 'local', node: LOGIN_NODE, environmentId: ENVIRONMENT }, loginHosts: [LOGIN_NODE] }),
    ).toThrow(expect.objectContaining({ code: 'unsupported', field: 'target.kind' }));
  });
});

describe('relay framing and channel', () => {
  it('frames control/data/reverse-storage messages binary-clean across chunk boundaries', () => {
    expect(RELAY_TAG).toMatchObject({ control: 1, data: 2, storageRequest: 3, storageAck: 4 });
    expect(RELAY_STORAGE_OPS).toContain('writeIntent');

    const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00, 0x7f]);
    const framed = Buffer.concat([
      encodeRelayMessage(RELAY_TAG.data, payload),
      encodeRelayMessage(RELAY_TAG.control, '{"kind":"ping"}'),
    ]);
    // Deliver the same bytes split at every boundary; the framer must reassemble identical payloads.
    for (let split = 0; split <= framed.length; split += 1) {
      const decoded = decodeRelayMessages(Buffer.concat([framed.subarray(0, split), framed.subarray(split)]));
      expect(decoded.messages).toHaveLength(2);
      expect(decoded.messages[0]).toEqual({ tag: RELAY_TAG.data, payload });
      expect(decoded.messages[1]!.payload.toString('utf8')).toBe('{"kind":"ping"}');
      expect(decoded.remaining).toHaveLength(0);
    }
  });

  it('round-trips arbitrary binary over a live channel with no PTY and no text coercion', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login' });
    const compute = createRelayChannel(right, { handshake: handshake(), role: 'compute' });
    await Promise.all([login.ready, compute.ready]);

    const received: Buffer[] = [];
    compute.onData((chunk) => received.push(chunk));
    const binary = Buffer.from(Array.from({ length: 300 }, (_, index) => (index * 7) % 256));
    login.sendData(binary);
    expect(Buffer.concat(received).equals(binary)).toBe(true);

    login.close();
    compute.close();
  });

  it('carries a durable reverse storage RPC from compute to the login control store', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login' });
    const compute = createRelayChannel(right, { handshake: handshake(), role: 'compute' });
    const root = await temporaryDirectory('vis-relay-store-');
    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'relay-login',
      platform: 'linux',
      statfs: () => ({ type: EXT4 }),
    });
    await store.open('owner');
    login.onStorageRequest((request: { op: string; params: Record<string, unknown> }) =>
      dispatchStoreOperation(store, request),
    );
    await Promise.all([login.ready, compute.ready]);

    const ack = await compute.requestStore('writeIntent', { intentId: INTENT, uuid: INTENT, state: 'planned' });
    expect(ack).toMatchObject({ ok: true, durable: true });
    expect(await store.readIntent(INTENT)).toMatchObject({ intentId: INTENT, state: 'planned' });

    login.close();
    compute.close();
    await store.close();
  });

  it('refuses an unknown storage op rather than forwarding it', async () => {
    const root = await temporaryDirectory('vis-relay-store-op-');
    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'relay-login',
      platform: 'linux',
      statfs: () => ({ type: EXT4 }),
    });
    await store.open('owner');
    await expect(dispatchStoreOperation(store, { op: 'dropDatabase', params: {} })).rejects.toMatchObject({
      code: 'unsupported',
      field: 'relay.storage.op',
    });
    await store.close();
  });
});

describe('Slurm step transport: reserve, modes, node binding and replacement', () => {
  it('reserves compute + 1 CPU / + 128 MiB and emits the two step modes with exact/exclusive/GRES-none', () => {
    expect([RESERVE_CPUS, RESERVE_MEMORY_MIB, RELAY_STEP_CPUS, RELAY_STEP_MEMORY_MIB]).toEqual([1, 128, 1, 128]);
    expect(STEP_MODES).toEqual(['service', 'relay']);

    const resources = buildAllocationResources({
      compute: { cpus: 4, memoryMiB: 8192 },
      partition: 'cpu',
      account: 'research',
      time: '01:00:00',
      gres: 'none',
    });
    expect(resources).toMatchObject({ cpus: 5, memory: '8320M', time: '01:00:00', gres: 'none', partition: 'cpu', account: 'research' });

    const relayArgv = buildStepArgv({ mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' });
    expect(relayArgv).toContain(`--nodelist=${COMPUTE_NODE}`);
    expect(relayArgv).toContain('--cpus-per-task=1');
    expect(relayArgv).toContain('--mem=128M');
    expect(relayArgv).toContain('--gres=none');
    expect(relayArgv).toContain('--exact');
    expect(relayArgv).toContain('--exclusive');
    expect(relayArgv).toContain('--jobid=24680');
    expect(relayArgv.some((token) => token.includes(STEP_ID))).toBe(true);
    expect(relayArgv).not.toContain('--parsable');
    expect(relayArgv).not.toContain('--async');

    const serviceArgv = buildStepArgv({ mode: 'service', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'gpu:1' });
    expect(serviceArgv).toContain('--cpus-per-task=4');
    expect(serviceArgv).toContain('--mem=8192M');
    expect(serviceArgv).toContain('--gres=gpu:1');
    expect(serviceArgv).toContain('--exact');
    expect(serviceArgv).toContain('--exclusive');
    expect(serviceArgv).not.toContain('--parsable');
    expect(serviceArgv).not.toContain('--async');
  });

  it('marks a step unsupported when exact / GRES-none / reserve support is missing', () => {
    expect(() => assertStepCapabilities({ exact: true, exclusive: true, gresNone: true, reserve: true })).not.toThrow();
    expect(() => assertStepCapabilities({ exact: true, exclusive: true, gresNone: false, reserve: true })).toThrow(
      expect.objectContaining({ code: 'unsupported', field: 'step.capabilities' }),
    );
    expect(() => assertStepCapabilities({ exact: false, exclusive: true, gresNone: true, reserve: true })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
    expect(() => assertStepCapabilities({ exact: true, exclusive: true, gresNone: true, reserve: false })).toThrow(
      expect.objectContaining({ code: 'unsupported' }),
    );
  });

  it('replaces only an owned relay step and refuses a foreign operation or a duplicate step', () => {
    const current = { stepId: STEP_ID, intentId: INTENT, jobId: '24680', epoch: 3 };
    expect(planStepReplacement({ current, candidate: { ...current, stepId: REPLACEMENT_STEP } })).toMatchObject({
      action: 'replace',
      stop: STEP_ID,
      start: REPLACEMENT_STEP,
    });
    expect(planStepReplacement({ current: undefined, candidate: { ...current, stepId: REPLACEMENT_STEP } })).toMatchObject({ action: 'start' });
    expect(() => planStepReplacement({ current, candidate: { ...current, stepId: REPLACEMENT_STEP, intentId: '88888888-8888-4888-8888-888888888888' } })).toThrow(
      expect.objectContaining({ code: 'conflict', field: 'step.ownership' }),
    );
    expect(() => planStepReplacement({ current, candidate: { ...current } })).toThrow(
      expect.objectContaining({ code: 'conflict', field: 'step.duplicate' }),
    );
    expect(() => planStepReplacement({ current, candidate: { ...current, stepId: REPLACEMENT_STEP, epoch: 2 } })).toThrow(
      expect.objectContaining({ code: 'reconcile_required', field: 'step.epoch' }),
    );
  });
});

describe('acceptance: connection through an approved step IO (no compute SSH, no application TCP)', () => {
  it('connects through the srun step stdio and round-trips binary with no ssh and no TCP socket', async () => {
    const harness = stdioHarness();
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: (command: string, args: readonly string[]) => {
        spawned.push({ command, args });
        return harness.child;
      },
      stopProcessTree: vi.fn(async () => true),
    });

    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    const compute = createRelayChannel(harness.compute, { handshake: handshake(), role: 'compute' });
    const connection = await opening;
    await compute.ready;
    expect(connection.ready).toBe(true);
    expect(connection.target).toMatchObject({ kind: 'compute', node: COMPUTE_NODE });

    const seen: Buffer[] = [];
    compute.onData((chunk) => seen.push(chunk));
    const payload = Buffer.from([0x9, 0x0, 0xff, 0x42, 0x0]);
    connection.channel.sendData(payload);
    expect(Buffer.concat(seen).equals(payload)).toBe(true);

    expect(spawned).toHaveLength(1);
    expect(spawned[0]!.command).toBe('srun');
    expect(spawned[0]!.args).not.toContain('ssh');
    expect(spawned[0]!.args.some((token) => token.includes('--parsable') || token.includes('--async'))).toBe(false);
    expect(spawned[0]!.args).toContain(`--nodelist=${COMPUTE_NODE}`);

    connection.close();
    compute.close();
  });

  it('redacts srun stderr and never merges it into the binary stdout framing', async () => {
    const harness = stdioHarness();
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: () => harness.child,
      stopProcessTree: vi.fn(async () => true),
    });
    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    const compute = createRelayChannel(harness.compute, { handshake: handshake(), role: 'compute' });
    const connection = await opening;
    await compute.ready;

    (harness.child.stderr as EventEmitter).emit('data', `srun: error credential=${CREDENTIAL}\n`);
    expect(transport.stderrLog()).not.toContain(CREDENTIAL);
    expect(transport.stderrLog()).toContain('[redacted]');

    const seen: Buffer[] = [];
    compute.onData((chunk) => seen.push(chunk));
    const payload = Buffer.from([0x1, 0x2, 0x3, 0xfe, 0xff]);
    connection.channel.sendData(payload);
    expect(Buffer.concat(seen).equals(payload)).toBe(true);

    connection.close();
    compute.close();
  });

  it('replaces only the owned step on relay loss and refuses a foreign operation', async () => {
    const harnesses = [stdioHarness(), stdioHarness()];
    let index = 0;
    const stopProcessTree = vi.fn(async () => true);
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: () => harnesses[index++]!.child,
      stopProcessTree,
    });

    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    const compute1 = createRelayChannel(harnesses[0]!.compute, { handshake: handshake(), role: 'compute' });
    await opening;
    await compute1.ready;
    expect(transport.ownedIds()).toHaveLength(1);

    const replacing = transport.replaceOwnedStep({
      mode: 'relay',
      bridgeNode: COMPUTE_NODE,
      jobId: '24680',
      stepId: REPLACEMENT_STEP,
      compute: { cpus: 4, memoryMiB: 8192 },
      gres: 'none',
    });
    const compute2 = createRelayChannel(harnesses[1]!.compute, { handshake: handshake(), role: 'compute' });
    const connection = await replacing;
    await compute2.ready;
    expect(connection.stepId).toBe(REPLACEMENT_STEP);
    expect(transport.ownedIds()).toHaveLength(1);

    await expect(
      transport.replaceOwnedStep({
        mode: 'relay',
        bridgeNode: COMPUTE_NODE,
        jobId: '24680',
        stepId: '99999999-9999-4999-8999-999999999999',
        intentId: '88888888-8888-4888-8888-888888888888',
        compute: { cpus: 4, memoryMiB: 8192 },
        gres: 'none',
      }),
    ).rejects.toMatchObject({ code: 'conflict', field: 'step.ownership' });

    await transport.close();
    compute1.close();
    compute2.close();
  });
});

describe('acceptance: disconnecting the laptop does not kill the login relay or the job', () => {
  it('keeps the relay listening and the job binding after a client disconnects', async () => {
    const relay = createComputeRelay({
      handshake: handshake(),
      mode: 'local-socket',
      socketPath: path.join(await temporaryDirectory('vis-relay-sock-'), 'relay.sock'),
    });
    const address = await relay.listen();
    expect(relay.state()).toBe('listening');
    expect(address.mode).toBe('local-socket');

    const client = createRelayChannel(netConnect(address.path as string), { handshake: handshake(), role: 'login' });
    await client.ready;
    await vi.waitFor(() => expect(relay.connectionCount()).toBe(1));

    client.close();
    await vi.waitFor(() => expect(relay.connectionCount()).toBe(0));

    expect(relay.state()).toBe('listening');
    expect(relay.jobBindings()).toHaveLength(1);
    expect(relay.jobBindings()[0]).toMatchObject({ intentId: INTENT, epoch: 3 });

    const client2 = createRelayChannel(netConnect(address.path as string), { handshake: handshake(), role: 'login' });
    await client2.ready;
    await vi.waitFor(() => expect(relay.connectionCount()).toBe(1));
    client2.close();
    await relay.close();
    expect(relay.state()).toBe('closed');
  });
});

describe('Slurm TCP transport: authenticated listener + login SSH forward', () => {
  it('dials the forwarded loopback port and gates readiness on the relay hello, not forward setup', async () => {
    const relay = createComputeRelay({
      handshake: handshake(),
      mode: 'tcp',
      host: '127.0.0.1',
      port: 0,
    });
    const address = await relay.listen();
    expect(relay.state()).toBe('listening');

    const accepted: unknown[] = [];
    relay.onConnection((channel: { binding: unknown }) => accepted.push(channel.binding));

    const transport = createSlurmTcpTransport(relayOptions({ connect: netConnect }));
    const connection = await transport.open({
      forward: { localHost: '127.0.0.1', localPort: address.port, remoteHost: COMPUTE_NODE, remotePort: 23004 },
    });
    expect(connection.ready).toBe(true);
    expect(connection.target).toMatchObject({ kind: 'compute', node: COMPUTE_NODE });
    await vi.waitFor(() => expect(accepted).toHaveLength(1));

    // A login-node target is an explicit rejection, never a silent local fallback.
    const rejected = createSlurmTcpTransport(relayOptions({ connect: netConnect }));
    await expect(
      rejected.open({ forward: { localHost: '127.0.0.1', localPort: address.port, remoteHost: LOGIN_NODE, remotePort: 23004 } }),
    ).rejects.toMatchObject({ code: 'unauthorized', field: 'target.login_fallback' });

    connection.close();
    await relay.close();
  });
});

describe('vis_bridge relay role', () => {
  it('recognizes the relay lifecycle command and validates its binding inputs', () => {
    const options = parseCliOptions(
      ['relay', '--environment', ENVIRONMENT, '--job', INTENT, '--bridge-instance', BRIDGE_INSTANCE, '--compute-node', COMPUTE_NODE, '--socket', '/tmp/vis-relay.sock', '--epoch', '3'],
      {},
    );
    expect(options).toMatchObject({ command: 'relay', role: 'relay', environmentId: ENVIRONMENT, intentId: INTENT, bridgeInstanceId: BRIDGE_INSTANCE, computeNode: COMPUTE_NODE, socketPath: '/tmp/vis-relay.sock', epoch: 3 });
    expect(parseCliOptions(['relay', '--help'], {})).toMatchObject({ command: 'relay', help: true });
    expect(() => parseCliOptions(['relay', '--environment', 'not-a-uuid', '--socket', '/tmp/x'], {})).toThrow(/environment/u);
    expect(() => parseCliOptions(['relay', '--environment', ENVIRONMENT, '--job', INTENT, '--bridge-instance', BRIDGE_INSTANCE, '--compute-node', COMPUTE_NODE], {})).toThrow(/socket/u);
  });
});

// ─────────────────────────────────────────────────────────────────────────────
// PR #183 source-review remediation (findings i1 [P1], i2 [P1], i3, i4).
//
// i1 [P1 credential boundary] — reverse storage executed before the handshake proved the
//    credential: `dispatch` only gated the control branch on `handshaking`, so data /
//    storageRequest / storageAck were dispatched to a peer that had proved nothing.
// i2 [P1 credential reflection] — hello and ack shared one HMAC input and the receiver never
//    matched the ACK nonce against the challenge it issued, so the ACK was reflectable by
//    flipping the message kind, and a captured ACK/hello replayed on another connection.
// i3 — the default `srun` step ran a bare `vis_bridge relay` with none of the required
//    arguments, and the relay role only listened instead of forwarding stdio to the
//    compute-local socket.
// i4 — EOF / a silent peer during the handshake left `ready` unsettled forever, so `open`
//    hung and the spawned step was never reclaimed.
// ─────────────────────────────────────────────────────────────────────────────

describe('i1 [P1]: nothing but the expected handshake is processed before the credential proof', () => {
  it('refuses a reverse storage write from a relay peer that has not proven the credential', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    const root = await temporaryDirectory('vis-relay-boundary-');
    const store = createSlurmControlStore({
      root,
      environmentId: ENVIRONMENT,
      ownerInstanceId: 'relay-login',
      platform: 'linux',
      statfs: () => ({ type: EXT4 }),
    });
    await store.open('owner');
    login.onStorageRequest((request: { op: string; params: Record<string, unknown> }) => dispatchStoreOperation(store, request));

    // The attacker controls the relay-side stream and can send frames, but has proved no
    // credential: no hello was ever answered. It asks the login control store for a durable
    // write directly.
    left.push(
      encodeRelayMessage(
        RELAY_TAG.storageRequest,
        JSON.stringify({ id: 'attacker-1', op: 'writeIntent', params: { intentId: INTENT, uuid: INTENT, state: 'planned' } }),
      ),
    );
    const outcome = await Promise.race([
      login.ready.then(
        () => 'ready' as const,
        () => 'rejected' as const,
      ),
      new Promise<'pending'>((resolve) => setTimeout(() => resolve('pending'), 250)),
    ]);
    const persisted = await store.readIntent(INTENT);

    expect({
      outcome,
      persisted: persisted === undefined ? null : 'written',
      state: login.state(),
    }).toEqual({ outcome: 'rejected', persisted: null, state: 'rejected' });

    login.close();
    right.end();
    await store.close();
  });

  it('refuses data, storageAck and non-handshake control frames sent before the proof', async () => {
    const refused: Array<{ tag: number; code: string; field: string }> = [];
    for (const [name, frame] of [
      ['data', encodeRelayMessage(RELAY_TAG.data, Buffer.from([0x01, 0x02]))],
      ['storageAck', encodeRelayMessage(RELAY_TAG.storageAck, JSON.stringify({ id: 'x', ok: true }))],
      ['control', encodeRelayMessage(RELAY_TAG.control, JSON.stringify({ kind: 'slurm.relay.verb', body: 'x' }))],
    ] as const) {
      const { left, right } = linkedPair();
      const channel = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
      const seen: Buffer[] = [];
      channel.onData((chunk) => seen.push(chunk));
      left.push(frame);
      await expect(channel.ready, name).rejects.toMatchObject({ code: 'unauthorized', field: 'relay.handshake' });
      expect(seen, name).toHaveLength(0);
      refused.push({ tag: frame[0], code: 'unauthorized', field: 'relay.handshake' });
      right.end();
    }
    expect(refused).toHaveLength(3);
  });

  it('stops processing the rest of a batch after a failed handshake', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    const dispatched: unknown[] = [];
    login.onStorageRequest((request: unknown) => {
      dispatched.push(request);
      return { ok: true };
    });
    // One batch: a hello the login role never expects (it awaits the ACK), followed by a
    // storage request. The failed handshake must stop the batch before the request runs.
    const batch = Buffer.concat([
      encodeRelayMessage(RELAY_TAG.control, JSON.stringify(handshake().challenge())),
      encodeRelayMessage(RELAY_TAG.storageRequest, JSON.stringify({ id: 'smuggled', op: 'readIntent', params: { intentId: INTENT } })),
    ]);
    left.push(batch);
    await expect(login.ready).rejects.toMatchObject({ code: 'unauthorized', field: 'relay.handshake' });
    expect(dispatched).toHaveLength(0);
    right.end();
  });
});

describe('i2 [P1]: the ACK proves the compute peer holds the credential', () => {
  it('refuses an ACK reflected from the challenge by flipping the message kind', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    const wire: Buffer[] = [];
    right.on('data', (chunk: Buffer) => wire.push(Buffer.from(chunk)));
    // The login issues its challenge at construction; the attacker reads it off the wire.
    const { messages } = decodeRelayMessages(Buffer.concat(wire));
    expect(messages).toHaveLength(1);
    const challenge = JSON.parse(messages[0]!.payload.toString('utf8')) as Record<string, unknown>;
    expect(challenge.kind).toBe(RELAY_HANDSHAKE_KIND);

    // The attacker holds no credential: it reflects the challenge with only the kind flipped.
    const reflected = { ...challenge, kind: RELAY_HELLO_ACK_KIND };
    left.push(encodeRelayMessage(RELAY_TAG.control, JSON.stringify(reflected)));
    await expect(login.ready).rejects.toMatchObject({ code: 'unauthorized', field: 'relay.handshake' });
    expect(login.state()).toBe('rejected');
    right.end();
  });

  it('refuses a historical ACK minted for another connection (cross-connection replay)', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    // A legitimate ACK captured from a DIFFERENT connection, replayed at this one.
    const historical = handshake().ack('99999999-9999-4999-8999-999999999999');
    left.push(encodeRelayMessage(RELAY_TAG.control, JSON.stringify(historical)));
    await expect(login.ready).rejects.toMatchObject({ code: 'unauthorized', field: 'relay.handshake' });
    expect(login.state()).toBe('rejected');
    right.end();
  });

  it('refuses a replayed hello on the compute side with a fresh challenge the replayer cannot answer', async () => {
    const { left, right } = linkedPair();
    const compute = createRelayChannel(right, { handshake: handshake(), role: 'compute', timeoutMs: 150 });
    // A hello captured from another legitimate connection, replayed at this relay.
    left.push(encodeRelayMessage(RELAY_TAG.control, JSON.stringify(handshake().challenge())));
    await expect(compute.ready).rejects.toMatchObject({ code: 'timeout', field: 'relay.handshake' });
    expect(compute.state()).toBe('rejected');
    left.end();
  });

  it('refuses a complete captured handshake stream replayed at a fresh relay', async () => {
    const first = linkedPair();
    const loginWrites: Buffer[] = [];
    const computeWrites: Buffer[] = [];
    const leftWrite = first.left.write;
    const rightWrite = first.right.write;
    first.left.write = (chunk: Buffer) => {
      loginWrites.push(Buffer.from(chunk));
      return leftWrite(chunk);
    };
    first.right.write = (chunk: Buffer) => {
      computeWrites.push(Buffer.from(chunk));
      return rightWrite(chunk);
    };
    const loginA = createRelayChannel(first.left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    const computeA = createRelayChannel(first.right, { handshake: handshake(), role: 'compute', timeoutMs: 400 });
    await Promise.all([loginA.ready, computeA.ready]);
    const session = Buffer.concat([...loginWrites, ...computeWrites]);
    expect(session.length).toBeGreaterThan(0);
    loginA.close();
    computeA.close();

    const second = linkedPair();
    const computeB = createRelayChannel(second.right, { handshake: handshake(), role: 'compute', timeoutMs: 400 });
    // The whole captured stream is replayed at the fresh relay's input.
    second.right.push(session);
    await expect(computeB.ready).rejects.toMatchObject({ code: 'unauthorized', field: 'relay.handshake' });
    expect(computeB.state()).toBe('rejected');
    second.left.end();
  });

  it('still completes the mutual handshake between the legitimate ends', async () => {
    const { left, right } = linkedPair();
    const login = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 400 });
    const compute = createRelayChannel(right, { handshake: handshake(), role: 'compute', timeoutMs: 400 });
    await expect(Promise.all([login.ready, compute.ready])).resolves.toEqual([
      { role: 'login', binding: binding() },
      { role: 'compute', binding: binding() },
    ]);
    const received: Buffer[] = [];
    compute.onData((chunk) => received.push(chunk));
    const binary = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00, 0x7f]);
    login.sendData(binary);
    expect(Buffer.concat(received).equals(binary)).toBe(true);
    login.close();
    compute.close();
  });
});

describe('i3: the srun relay step runs the real vis_bridge relay subcommand', () => {
  it('builds the complete relay argument vector the real CLI accepts', async () => {
    const harness = stdioHarness();
    const spawned: Array<{ command: string; args: readonly string[] }> = [];
    const socketPath = path.join(await temporaryDirectory('vis-relay-argv-'), 'compute.sock');
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: (command: string, args: readonly string[]) => {
        spawned.push({ command, args });
        return harness.child;
      },
      stopProcessTree: vi.fn(async () => true),
      relaySocketPath: socketPath,
    });
    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    const compute = createRelayChannel(harness.compute, { handshake: handshake(), role: 'compute' });
    const connection = await opening;
    await compute.ready;

    // The command the step actually runs, after srun's `--` separator and the program.
    const relayArgv = spawned[0]!.args.slice(spawned[0]!.args.indexOf('--') + 2);
    expect(relayArgv[0]).toBe('relay');
    expect(relayArgv).toEqual(
      expect.arrayContaining([
        '--stdio-forward',
        '--socket',
        socketPath,
        '--environment',
        ENVIRONMENT,
        '--job',
        INTENT,
        '--bridge-instance',
        BRIDGE_INSTANCE,
        '--compute-node',
        COMPUTE_NODE,
        '--epoch',
        '3',
      ]),
    );
    // The REAL CLI parser must accept the exact command the step runs.
    const parsed = parseCliOptions(relayArgv, {});
    expect(parsed).toMatchObject({
      command: 'relay',
      role: 'relay',
      stdioForward: true,
      environmentId: ENVIRONMENT,
      intentId: INTENT,
      bridgeInstanceId: BRIDGE_INSTANCE,
      computeNode: COMPUTE_NODE,
      socketPath,
      epoch: 3,
    });

    connection.close();
    compute.close();
  });

  it('establishes the channel through a REAL vis_bridge relay subprocess with stdout carrying only protocol bytes', async () => {
    const root = await temporaryDirectory('vis-relay-subprocess-');
    const socketPath = path.join(root, 'compute.sock');
    const relay = createComputeRelay({ handshake: handshake(), mode: 'local-socket', socketPath });
    const address = await relay.listen();
    expect(address.mode).toBe('local-socket');
    const accepted: Buffer[] = [];
    let tracked = false;
    relay.onConnection((channel: { onData(handler: (payload: Buffer) => void): void; sendData(payload: Buffer): void }) => {
      tracked = true;
      channel.onData((payload) => {
        accepted.push(payload);
        channel.sendData(payload);
      });
    });

    // The exact argument vector the step transport builds for the relay step.
    const relayArgv = buildStepArgv({
      mode: 'relay',
      bridgeNode: COMPUTE_NODE,
      jobId: '24680',
      stepId: STEP_ID,
      compute: { cpus: 4, memoryMiB: 8192 },
      gres: 'none',
      relay: { environmentId: ENVIRONMENT, intentId: INTENT, bridgeInstanceId: BRIDGE_INSTANCE, socketPath, epoch: 3 },
    });
    // The exact argument vector the step transport builds for the relay step, after srun's
    // `--` separator and the program name.
    const command = relayArgv.slice(relayArgv.indexOf('--') + 2);
    const cliEntry = path.resolve(process.cwd(), 'vis_bridge.js');
    const child = spawn(process.execPath, [cliEntry, ...command], {
      stdio: ['pipe', 'pipe', 'pipe'],
    });
    const stdoutBytes: Buffer[] = [];
    child.stdout!.on('data', (chunk: Buffer) => stdoutBytes.push(Buffer.from(chunk)));
    const channel = createRelayChannel(
      {
        write: (chunk: Buffer) => child.stdin!.write(chunk),
        on: (event: string, handler: (...args: unknown[]) => void) => child.stdout!.on(event, handler),
        off: (event: string, handler: (...args: unknown[]) => void) => child.stdout!.off(event, handler),
        end: () => child.stdin!.end(),
        destroy: () => child.kill(),
      },
      { handshake: handshake(), role: 'login', timeoutMs: 10_000 },
    );
    try {
      // The handshake crossed a real subprocess and a real compute-local unix socket.
      await channel.ready;
      // The relay-side channel is tracked (and its handlers attached) one microtask after the
      // confirm settles, so a consumer must wait for it before the first data frame.
      await vi.waitFor(() => expect(tracked).toBe(true));
      const received: Buffer[] = [];
      channel.onData((chunk) => received.push(chunk));
      const payload = Buffer.from([0x00, 0xff, 0x10, 0x0a, 0x00, 0x7f]);
      channel.sendData(payload);
      await vi.waitFor(() => expect(Buffer.concat(received).equals(payload)).toBe(true));
      expect(Buffer.concat(accepted).equals(payload)).toBe(true);
      // stdout carried protocol bytes only: every byte decodes as a tagged relay frame.
      const decoded = decodeRelayMessages(Buffer.concat(stdoutBytes));
      expect(decoded.remaining).toHaveLength(0);
      expect(decoded.messages.length).toBeGreaterThan(0);
      expect(decoded.messages.every((message) => message.tag >= RELAY_TAG.control && message.tag <= RELAY_TAG.storageAck)).toBe(true);
    } finally {
      channel.close();
      child.kill();
      await relay.close();
    }
  });
});

describe('i4: a handshake that never completes settles instead of hanging', () => {
  it('rejects the handshake when the peer goes silent (timeout)', async () => {
    const silent = duplex();
    const channel = createRelayChannel(silent, { handshake: handshake(), role: 'login', timeoutMs: 60 });
    await expect(channel.ready).rejects.toMatchObject({ code: 'timeout', field: 'relay.handshake' });
    expect(channel.state()).toBe('rejected');
  });

  it('rejects the handshake when the peer EOFs before the credential proof', async () => {
    const { left, right } = linkedPair();
    const channel = createRelayChannel(left, { handshake: handshake(), role: 'login', timeoutMs: 5_000 });
    left.emit('end');
    await expect(channel.ready).rejects.toMatchObject({ code: 'source_unavailable', field: 'relay.stream' });
    expect(channel.state()).toBe('rejected');
    right.end();
  });

  it('rejects an explicit close before the handshake completes', async () => {
    const stream = duplex();
    const channel = createRelayChannel(stream, { handshake: handshake(), role: 'login', timeoutMs: 5_000 });
    channel.close();
    await expect(channel.ready).rejects.toMatchObject({ code: 'cancelled', field: 'relay.handshake' });
    expect(channel.state()).toBe('closed');
  });

  it('terminates the spawned srun step when the relay EOFs before ready', async () => {
    const harness = stdioHarness();
    const stopProcessTree = vi.fn(async () => true);
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: () => harness.child,
      stopProcessTree,
    });
    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    await vi.waitFor(() => expect(transport.ownedIds()).toHaveLength(1));
    // The srun step's stdout EOFs before any handshake byte arrives.
    (harness.child.stdout as EventEmitter).emit('end');
    await expect(opening).rejects.toMatchObject({ code: 'source_unavailable', field: 'relay.stream' });
    expect(transport.ownedIds()).toHaveLength(0);
    expect(transport.state()).toBe('failed');
    expect(stopProcessTree).toHaveBeenCalled();
    await transport.close();
  });

  it('rejects the handshake when the spawned child errors or exits before ready', async () => {
    const harness = stdioHarness();
    const stopProcessTree = vi.fn(async () => true);
    const transport = createSlurmStepTransport({
      binding: binding(),
      loginHosts: [LOGIN_NODE],
      credential: CREDENTIAL,
      spawn: () => harness.child,
      stopProcessTree,
    });
    const opening = transport.open({
      step: { mode: 'relay', bridgeNode: COMPUTE_NODE, jobId: '24680', stepId: STEP_ID, compute: { cpus: 4, memoryMiB: 8192 }, gres: 'none' },
    });
    await vi.waitFor(() => expect(transport.ownedIds()).toHaveLength(1));
    // A spawn failure (ENOENT/EACCES) reaches the channel as a stream error.
    harness.child.emit('error', new Error('spawn ENOENT'));
    await expect(opening).rejects.toMatchObject({ code: 'source_unavailable', field: 'relay.stream' });
    expect(transport.ownedIds()).toHaveLength(0);
    expect(stopProcessTree).toHaveBeenCalled();
    await transport.close();
  });
});
