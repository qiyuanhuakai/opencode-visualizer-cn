import { randomUUID } from 'node:crypto';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { requireValue, textValue } from '../../../shared/runtime/capabilities.js';
import { stopProcessTree as defaultStopProcessTree } from '../../processTree.js';
import { createProcessRelay } from './processRelay.js';
import { assertNoShellConcatenation } from './sshTransport.js';
import { redactSecrets } from './sshAuthentication.js';
import { createRelayChannel, dispatchStoreOperation } from './computeRelay.js';
import { assertComputeTarget, createRelayBinding, createRelayHandshake } from './relayHandshake.js';

/**
 * Slurm step channel — login side (plan task 29 / Scope 13, second of the two required channels).
 *
 * When the compute node forbids SSH and application TCP, the batch-owned Bridge listens on a
 * compute-local socket and a single-task `srun` relay step forwards framed bytes over its stdio.
 * This module owns the login-side relay step:
 *
 *  - the allocation reserves `compute + 1 CPU` and `compute + 128 MiB`, so the service step can
 *    saturate the whole compute budget and the 1 CPU / 128 MiB relay step can still reconnect;
 *  - the service step uses `<computeCpu>`/`<computeMemoryMiB>` with the profile's explicit GRES;
 *    the relay step uses 1 CPU / 128 MiB / `--gres=none`; both use `--nodes=1 --ntasks=1`,
 *    `--nodelist=<bridgeNode>`, `--exact --exclusive` (frozen numbers, never a shell string);
 *  - framing is binary-clean over the srun pipes; `srun` stderr is captured separately and
 *    redacted, never merged into the binary stdout stream;
 *  - a relay loss stops and replaces only a step this transport owns, and `srun --parsable
 *    --async` is never used (it is not a compatibility baseline).
 *
 * The relay step runs the real `vis_bridge relay --stdio-forward` subcommand: its argument
 * vector carries the complete binding (environment / job / bridge-instance / compute-node /
 * compute-local socket / epoch), because a bare `relay` verb is refused by the CLI parser and
 * cannot establish the channel the login side waits on. The step's stdio is forwarded to the
 * compute-local socket where the long-term relay listens, and its stdout carries protocol
 * bytes only. The socket path is `options.relaySocketPath` when the caller knows the deployed
 * path, and otherwise the documented per-job convention `<tmpdir>/vis-relay-<intentId>.sock`;
 * either way a missing listener fails the handshake loudly instead of hanging.
 */
export const STEP_MODES = Object.freeze(['service', 'relay']);
export const RESERVE_CPUS = 1;
export const RESERVE_MEMORY_MIB = 128;
export const RELAY_STEP_CPUS = 1;
export const RELAY_STEP_MEMORY_MIB = 128;
export const STEP_CAPABILITIES = Object.freeze({ exact: true, exclusive: true, gresNone: true, reserve: true });
const STDERR_LOG_LIMIT = 64 * 1024;

/** The allocation reserves the compute budget plus the relay reserve, so reconnect always fits. */
export function buildAllocationResources(options = {}) {
  const compute = options.compute;
  requireValue(compute !== null && typeof compute === 'object', 'compute');
  requireValue(Number.isSafeInteger(compute.cpus) && compute.cpus > 0, 'compute.cpus');
  requireValue(Number.isSafeInteger(compute.memoryMiB) && compute.memoryMiB > 0, 'compute.memoryMiB');
  requireValue(typeof options.partition === 'string' && options.partition.length > 0, 'partition');
  requireValue(typeof options.time === 'string' && options.time.length > 0, 'time');
  requireValue(typeof options.gres === 'string' && options.gres.length > 0, 'gres');
  return Object.freeze({
    partition: options.partition,
    account: options.account ?? null,
    cpus: compute.cpus + RESERVE_CPUS,
    memory: `${compute.memoryMiB + RESERVE_MEMORY_MIB}M`,
    time: options.time,
    gres: options.gres,
    nodes: 1,
    ntasks: 1,
  });
}

/**
 * Builds the structured `srun` argument vector for one step mode. No shell concatenation, no
 * `--parsable`/`--async`, and the node binding / exact / exclusive / GRES flags are always present.
 * A relay step whose `relay` binding is supplied runs the complete `vis_bridge relay
 * --stdio-forward` command; without it the caller's own `args` (or the bare verb) are used.
 */
export function buildStepArgv(options = {}) {
  const mode = options.mode;
  requireValue(STEP_MODES.includes(mode), 'step.mode', 'unsupported');
  const bridgeNode = textValue(options.bridgeNode, 'step.bridgeNode');
  const jobId = textValue(String(options.jobId ?? ''), 'step.jobId');
  const stepId = textValue(options.stepId, 'step.stepId');
  const common = ['--nodes=1', '--ntasks=1', `--nodelist=${bridgeNode}`];
  let budget;
  if (mode === 'relay') {
    budget = [`--cpus-per-task=${RELAY_STEP_CPUS}`, `--mem=${RELAY_STEP_MEMORY_MIB}M`, '--gres=none'];
  } else {
    const compute = options.compute;
    requireValue(compute !== null && typeof compute === 'object', 'compute');
    requireValue(Number.isSafeInteger(compute.cpus) && compute.cpus > 0, 'compute.cpus');
    requireValue(Number.isSafeInteger(compute.memoryMiB) && compute.memoryMiB > 0, 'compute.memoryMiB');
    budget = [`--cpus-per-task=${compute.cpus}`, `--mem=${compute.memoryMiB}M`, `--gres=${textValue(options.gres, 'step.gres')}`];
  }
  let stepArgs;
  if (mode === 'relay' && options.relay !== undefined && options.relay !== null) {
    // The complete relay binding: without every one of these the real CLI refuses to start the
    // relay role and the login side would wait forever for a handshake that can never arrive.
    const relay = options.relay;
    requireValue(relay !== null && typeof relay === 'object', 'step.relay');
    stepArgs = [
      'relay',
      '--stdio-forward',
      '--socket',
      textValue(relay.socketPath, 'step.relay.socketPath'),
      '--environment',
      textValue(relay.environmentId, 'step.relay.environmentId'),
      '--job',
      textValue(relay.intentId, 'step.relay.intentId'),
      '--bridge-instance',
      textValue(relay.bridgeInstanceId, 'step.relay.bridgeInstanceId'),
      '--compute-node',
      bridgeNode,
      '--epoch',
      String(relay.epoch ?? 0),
    ];
  } else {
    stepArgs = Array.isArray(options.args) ? options.args : ['relay'];
  }
  const argv = [
    ...common,
    ...budget,
    '--exact',
    '--exclusive',
    `--jobid=${jobId}`,
    `--job-name=${stepId}`,
    '--',
    textValue(options.program ?? 'vis_bridge', 'step.program'),
    ...stepArgs,
  ];
  assertNoShellConcatenation(argv);
  return Object.freeze(argv);
}

/** Refuses to run a step whose runtime lacks exact / GRES-none / reserve support (`unsupported`). */
export function assertStepCapabilities(input) {
  requireValue(input !== null && typeof input === 'object', 'step.capabilities');
  const supported = STEP_CAPABILITIES;
  requireValue(
    input.exact === supported.exact &&
      input.exclusive === supported.exclusive &&
      input.gresNone === supported.gresNone &&
      input.reserve === supported.reserve,
    'step.capabilities',
    'unsupported',
  );
  return supported;
}

/**
 * Reconciliation plan for a lost relay. A step belonging to another operation is a `conflict`
 * (`step.ownership`); the currently-active step is a `duplicate`; a lower epoch is
 * `reconcile_required`. Otherwise the owned step is replaced.
 */
export function planStepReplacement(options = {}) {
  const candidate = options.candidate;
  requireValue(candidate !== null && typeof candidate === 'object', 'step.candidate');
  const current = options.current;
  if (current === undefined || current === null) return Object.freeze({ action: 'start', start: candidate.stepId, epoch: candidate.epoch ?? null });
  requireValue(current.intentId === candidate.intentId, 'step.ownership', 'conflict');
  requireValue(current.stepId !== candidate.stepId, 'step.duplicate', 'conflict');
  requireValue(
    candidate.epoch === undefined || current.epoch === undefined || Number(candidate.epoch) >= Number(current.epoch),
    'step.epoch',
    'reconcile_required',
  );
  return Object.freeze({ action: 'replace', stop: current.stepId, start: candidate.stepId, epoch: candidate.epoch ?? null });
}

function childStream(child) {
  const out = child.stdout;
  // A child spawn error or an early exit must reach the channel as a stream failure: the
  // channel listens on stdout, so the child's own lifecycle events are mirrored onto it and
  // the handshake is rejected instead of waiting for the handshake timeout.
  child.on?.('error', (error) => out?.emit?.('error', error));
  child.on?.('exit', () => out?.emit?.('end'));
  return {
    write: (chunk) => child.stdin?.write?.(chunk),
    on: (event, handler) => child.stdout?.on?.(event, handler),
    off: (event, handler) => child.stdout?.off?.(event, handler),
    end: () => child.stdin?.end?.(),
    destroy: () => child.kill?.(),
  };
}

/**
 * Creates the step transport. `open({ step })` spawns an owned `srun` relay step through a
 * process relay, wires its stdio into the binary relay channel and resolves only after the relay
 * handshake binds the live job + bridge instance.
 */
export function createSlurmStepTransport(options = {}) {
  const relay = options.relay ?? createProcessRelay({ spawn: options.spawn, stopProcessTree: options.stopProcessTree ?? defaultStopProcessTree });
  const redactions = options.redactions ?? [options.credential];
  let state = 'idle';
  let current = null;
  let stderrText = '';

  function appendStderr(chunk) {
    stderrText = (stderrText + redactSecrets(chunk, redactions)).slice(-STDERR_LOG_LIMIT);
  }

  /** The complete `vis_bridge relay` binding the relay step runs, derived from the channel binding. */
  function relayBindingFor(binding) {
    return Object.freeze({
      environmentId: binding.environmentId,
      intentId: binding.intentId,
      bridgeInstanceId: binding.bridgeInstanceId,
      epoch: binding.epoch,
      socketPath: options.relaySocketPath ?? path.join(tmpdir(), `vis-relay-${binding.intentId}.sock`),
    });
  }

  function connectionFor(target, binding, step, channel, argv) {
    return Object.freeze({
      ready: true,
      state: 'ready',
      target,
      binding,
      channel,
      argv,
      stepId: step.stepId,
      replaceOwnedStep,
      close,
    });
  }

  async function startStep({ argv, binding, target, step }) {
    const spawned = relay.spawnOwned({
      command: options.srunProgram ?? 'srun',
      args: argv,
      env: options.env,
      cwd: options.cwd,
    });
    const channel = createRelayChannel(childStream(spawned.child), {
      handshake: createRelayHandshake({ credential: options.credential, binding }),
      role: 'login',
      timeoutMs: options.timeoutMs,
    });
    if (options.store !== undefined) {
      channel.onStorageRequest((request) => dispatchStoreOperation(options.store, request));
    }
    spawned.child.stderr?.on?.('data', (chunk) => appendStderr(String(chunk)));
    state = 'connecting';
    // The step is recorded BEFORE the handshake settles: a failed handshake, an EOF or an
    // early close must still terminate the process this transport spawned.
    current = { relayId: spawned.id, step, argv, channel, binding, target };
    try {
      await channel.ready;
    } catch (error) {
      // An explicit close already settled this transport; only a genuine failure flips the state.
      if (state !== 'closed') state = 'failed';
      await relay.terminate(spawned.id);
      if (current !== null && current.relayId === spawned.id) current = null;
      throw error;
    }
    state = 'ready';
    return connectionFor(target, binding, step, channel, argv);
  }

  async function open(input = {}) {
    const step = input.step;
    requireValue(step !== null && typeof step === 'object', 'step');
    assertStepCapabilities(step.capabilities ?? STEP_CAPABILITIES);
    const binding = createRelayBinding(input.binding ?? options.binding);
    const target = assertComputeTarget({
      target: { kind: 'compute', node: step.bridgeNode, environmentId: binding.environmentId },
      loginHosts: options.loginHosts ?? [],
    });
    const argv = buildStepArgv({
      mode: step.mode,
      bridgeNode: step.bridgeNode,
      jobId: step.jobId,
      stepId: step.stepId,
      compute: step.compute,
      gres: step.gres,
      program: step.program,
      args: step.args,
      relay: relayBindingFor(binding),
    });
    return startStep({ argv, binding, target, step });
  }

  /** Stops and replaces only the owned relay step; a foreign operation is refused. */
  async function replaceOwnedStep(nextStep) {
    requireValue(current !== null, 'step.current', 'source_unavailable');
    const previous = current;
    const next = nextStep ?? { ...previous.step, stepId: options.uuid?.() ?? randomUUID() };
    const plan = planStepReplacement({
      current: {
        stepId: previous.step.stepId,
        intentId: previous.binding.intentId,
        jobId: previous.step.jobId,
        epoch: previous.binding.epoch,
      },
      candidate: {
        stepId: next.stepId,
        intentId: next.intentId ?? previous.binding.intentId,
        jobId: next.jobId ?? previous.step.jobId,
        epoch: next.epoch ?? previous.binding.epoch,
      },
    });
    if (plan.action === 'replace') {
      previous.channel.close();
      await relay.terminate(previous.relayId);
      current = null;
    }
    const step = { ...previous.step, ...next };
    const argv = buildStepArgv({
      mode: step.mode,
      bridgeNode: step.bridgeNode,
      jobId: step.jobId,
      stepId: step.stepId,
      compute: step.compute,
      gres: step.gres,
      program: step.program,
      args: step.args,
      relay: relayBindingFor(previous.binding),
    });
    return startStep({ argv, binding: previous.binding, target: previous.target, step });
  }

  async function close() {
    if (state === 'closed') return;
    state = 'closed';
    if (current !== null) {
      current.channel.close();
      await relay.terminate(current.relayId);
      current = null;
    }
  }

  return Object.freeze({
    state: () => state,
    ownedIds: () => relay.ownedIds(),
    stderrLog: () => stderrText,
    open,
    replaceOwnedStep,
    close,
  });
}
