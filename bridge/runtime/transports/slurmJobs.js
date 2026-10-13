import { createHmac, randomUUID, timingSafeEqual } from 'node:crypto';

import { ProtocolError, requireValue, textValue } from '../../../shared/runtime/capabilities.js';
import { parseEnvironmentId } from '../../../shared/runtime/identity.js';
import { CONTROL_STORE_SCHEMA_VERSION } from './slurmControlStore.js';
import { assertNoShellConcatenation } from './sshTransport.js';

/**
 * Recoverable Slurm job model (plan task 28 / Scope 12).
 *
 * The invariants this module owns:
 *  - a job is an intent UUID that lands on disk *before* any `sbatch` is issued;
 *  - resources `time` and `gres` are always explicit — no silent default that would hide a
 *    resource request (in particular `gres=none` is written, never omitted);
 *  - `submit` returns with an explicit non-ready state the moment the scheduler acks; it
 *    never waits for readiness;
 *  - an ambiguous submit (lost ack, several UUID matches) is reconciled by *querying* the
 *    scheduler, never by resubmitting (a resubmit would create a duplicate job);
 *  - `detach` only stops tracking (it never cancels); `stop` signals only an owned job and
 *    never touches a borrowed allocation;
 *  - the compute Bridge is gated by a credential-protected handshake derived from a nonce.
 */
export const SLURM_HANDSHAKE_KIND = 'slurm.bridge.hello';

/** Managed lifecycle fields kept independent so queue/resource/bridge/transport/terminal never merge. */
export const JOB_STATE_FIELDS = Object.freeze(['state', 'queue', 'resource', 'bridge', 'transport', 'terminal', 'reconcile']);

const LINE_SPLIT = /\r?\n/u;

function shellQuote(token) {
  return `'${String(token).replace(/'/gu, "'\\''")}'`;
}

/** Parses a Slurm time limit into seconds. Accepts `mm`, `mm:ss`, `hh:mm:ss`, `d-hh`, `d-hh:mm`, `d-hh:mm:ss`. */
export function parseSlurmTime(value) {
  const text = textValue(value, 'resources.time');
  const match = /^(?:(\d+)-)?(?:(\d+)(?::(\d+))?(?::(\d+))?)$/u.exec(text);
  if (match === null) throw new ProtocolError('invalid_request', 'resources.time');
  const days = match[1] === undefined ? 0 : Number(match[1]);
  const first = Number(match[2]);
  const second = match[3] === undefined ? 0 : Number(match[3]);
  const third = match[4] === undefined ? 0 : Number(match[4]);
  if (second > 59 || third > 59) throw new ProtocolError('invalid_request', 'resources.time');
  // Without a day prefix the units are minutes / minutes:seconds / hours:minutes:seconds.
  // With a day prefix they are days-hours / days-hours:minutes / days-hours:minutes:seconds.
  let seconds;
  if (match[1] === undefined) {
    if (match[4] !== undefined) seconds = first * 3600 + second * 60 + third;
    else if (match[3] !== undefined) seconds = first * 60 + second;
    else seconds = first * 60;
  } else {
    seconds = days * 86400 + first * 3600 + second * 60 + third;
  }
  requireValue(Number.isSafeInteger(seconds) && seconds > 0, 'resources.time');
  return seconds;
}

/** Parses a Slurm memory request into MiB (`2048`, `2048M`, `2G`, `1T`). */
export function parseSlurmMemory(value) {
  const text = typeof value === 'string' ? value.trim() : String(value ?? '').trim();
  const match = /^(\d+)([KMGTP])?$/iu.exec(text);
  if (match === null) throw new ProtocolError('invalid_request', 'resources.memory');
  const amount = Number(match[1]);
  const unit = (match[2] ?? 'M').toUpperCase();
  const factor = { K: 1 / 1024, M: 1, G: 1024, T: 1024 * 1024, P: 1024 * 1024 * 1024 }[unit];
  const mebibytes = Math.ceil(amount * factor);
  requireValue(Number.isSafeInteger(mebibytes) && mebibytes > 0, 'resources.memory');
  return mebibytes;
}

/**
 * Normalizes a resource request. `time` and `gres` are required and validated as explicit
 * strings; a caller that omits either gets a typed error rather than a hidden default.
 */
export function normalizeSlurmResources(input) {
  requireValue(input !== null && typeof input === 'object' && !Array.isArray(input), 'resources');
  requireValue(typeof input.time === 'string' && input.time.trim().length > 0, 'resources.time');
  const timeSeconds = parseSlurmTime(input.time);
  requireValue(typeof input.gres === 'string' && input.gres.trim().length > 0, 'resources.gres');
  const gres = input.gres.trim();
  const partition = textValue(input.partition, 'resources.partition');
  requireValue(Number.isSafeInteger(input.cpus) && input.cpus > 0, 'resources.cpus');
  const memoryMiB = parseSlurmMemory(input.memory);
  const account =
    input.account === undefined || input.account === null ? null : textValue(input.account, 'resources.account');
  return Object.freeze({
    account,
    partition,
    cpus: input.cpus,
    memory: typeof input.memory === 'string' ? input.memory : String(input.memory),
    memoryMiB,
    time: input.time,
    timeSeconds,
    gres,
    gpus: gres !== 'none',
    nodes: 1,
    ntasks: 1,
  });
}

/** The user-visible resource preview: exactly what the scheduler will be asked for. */
export function buildResourcePreview(resources) {
  const normalized = resources !== null && typeof resources === 'object' && 'timeSeconds' in resources
    ? resources
    : normalizeSlurmResources(resources);
  return Object.freeze({
    nodes: normalized.nodes,
    ntasks: normalized.ntasks,
    cpus: normalized.cpus,
    memory: normalized.memory,
    memoryMiB: normalized.memoryMiB,
    time: normalized.time,
    timeSeconds: normalized.timeSeconds,
    gres: normalized.gres,
    requestsGpu: normalized.gpus,
    partition: normalized.partition,
    account: normalized.account,
  });
}

/** Builds the sbatch payload script: structured directives + a quoted `exec`, never a shell-concatenated line. */
export function buildSbatchScript(options = {}) {
  const intentId = textValue(options.intentId, 'intentId');
  const resources = normalizeSlurmResources(options.resources);
  const command = textValue(options.command, 'command');
  const args = Array.isArray(options.args) ? options.args : [];
  assertNoShellConcatenation([intentId, command, ...args]);
  const cwd = options.cwd === undefined || options.cwd === null ? '.' : textValue(options.cwd, 'cwd');
  const output = options.output ?? `${cwd}/slurm-${intentId}-%j.out`;
  const env = options.env ?? {};
  const directives = [
    `#SBATCH --job-name=${intentId}`,
    `#SBATCH --comment=${intentId}`,
    `#SBATCH --partition=${resources.partition}`,
    ...(resources.account === null ? [] : [`#SBATCH --account=${resources.account}`]),
    `#SBATCH --nodes=${resources.nodes}`,
    `#SBATCH --ntasks=${resources.ntasks}`,
    `#SBATCH --cpus-per-task=${resources.cpus}`,
    `#SBATCH --mem=${resources.memoryMiB}M`,
    `#SBATCH --time=${resources.time}`,
    `#SBATCH --gres=${resources.gres}`,
    `#SBATCH --output=${output}`,
  ];
  const exports = Object.entries(env).map(([key, value]) => `export ${key}=${shellQuote(value)}`);
  const commandLine = `exec ${[command, ...args].map(shellQuote).join(' ')}`;
  return ['#!/bin/bash', ...directives, ...exports, `cd ${shellQuote(cwd)}`, commandLine, ''].join('\n');
}

/** Builds the structured `sbatch` argument vector (no shell string). The intent UUID rides on the job name. */
export function buildSbatchArgv(options = {}) {
  const intentId = textValue(options.intentId, 'intentId');
  return Object.freeze(['--parsable', `--job-name=${intentId}`, `--comment=${intentId}`]);
}

/** Extracts the numeric job id from `sbatch --parsable` output (`12345` or `12345;cluster`). */
export function parseSbatchOutput(stdout) {
  const text = String(stdout ?? '').trim();
  requireValue(text.length > 0, 'sbatch.stdout', 'source_unavailable');
  const firstLine = text.split(LINE_SPLIT)[0].trim();
  const [jobId, cluster] = firstLine.split(';');
  requireValue(/^\d+$/u.test(jobId ?? ''), 'sbatch.jobId');
  return Object.freeze({ jobId, cluster: cluster === undefined || cluster === '' ? null : cluster });
}

/** Parses `squeue --noheader --format="%i|%j|%T|%k|%P|%N"` output. */
export function parseSqueueOutput(text) {
  const jobs = [];
  for (const line of String(text ?? '').split(LINE_SPLIT)) {
    const trimmed = line.trim();
    if (trimmed === '') continue;
    const [jobId, name, state, comment, partition, nodes] = trimmed.split('|');
    jobs.push(Object.freeze({
      jobId: jobId ?? '',
      name: name ?? '',
      state: state ?? '',
      comment: comment ?? '',
      partition: partition ?? '',
      nodes: nodes ?? '',
    }));
  }
  return Object.freeze(jobs);
}

/** Parses the first `scontrol show job` block. */
export function parseScontrolShowJob(text) {
  const block = String(text ?? '').trim().split(/\r?\n\s*\r?\n/u)[0] ?? '';
  const fields = {};
  for (const match of block.matchAll(/([A-Za-z]+)=("[^"]*"|\S*)/gu)) {
    fields[match[1]] = match[2].replace(/^"|"$/gu, '');
  }
  return Object.freeze({
    jobId: fields.JobId ?? null,
    name: fields.JobName ?? null,
    comment: fields.Comment ?? null,
    jobState: fields.JobState ?? null,
    partition: fields.Partition ?? null,
    nodeList: fields.NodeList ?? null,
    exitCode: fields.ExitCode ?? null,
  });
}

/** Maps a raw Slurm state to the managed queue/terminal/requeue tuple. */
export function mapQueueState(raw) {
  switch (String(raw ?? '').toUpperCase()) {
    case 'PENDING':
    case 'CONFIGURING':
      return Object.freeze({ queue: 'PENDING', terminal: null, requeued: false });
    case 'RUNNING':
    case 'COMPLETING':
    case 'SUSPENDED':
    case 'STAGE_OUT':
      return Object.freeze({ queue: 'RUNNING', terminal: null, requeued: false });
    case 'COMPLETED':
      return Object.freeze({ queue: 'COMPLETED', terminal: 'COMPLETED', requeued: false });
    case 'CANCELLED':
      return Object.freeze({ queue: 'CANCELLED', terminal: 'CANCELLED', requeued: false });
    case 'FAILED':
    case 'TIMEOUT':
    case 'OUT_OF_MEMORY':
    case 'BOOT_FAIL':
    case 'DEADLINE':
      return Object.freeze({ queue: String(raw).toUpperCase(), terminal: 'FAILED', requeued: false });
    case 'PREEMPTED':
    case 'NODE_FAIL':
    case 'REQUEUED':
      return Object.freeze({ queue: 'PENDING', terminal: null, requeued: true });
    default:
      return Object.freeze({ queue: 'UNKNOWN', terminal: null, requeued: false });
  }
}

/**
 * Credential-protected handshake between the login job owner and the compute Bridge. The
 * credential never travels in the challenge; only an HMAC over (kind, intentId, nonce) does.
 */
export function createSlurmHandshake(options = {}) {
  const credential = textValue(options.credential, 'handshake.credential');
  const token = (intentId, nonce) =>
    createHmac('sha256', credential).update(`${SLURM_HANDSHAKE_KIND}\0${intentId}\0${nonce}`).digest('hex');
  return Object.freeze({
    kind: SLURM_HANDSHAKE_KIND,
    credentialProtected: true,
    challenge(intentId) {
      const id = textValue(intentId, 'intentId');
      const nonce = randomUUID();
      return Object.freeze({ kind: SLURM_HANDSHAKE_KIND, credentialProtected: true, intentId: id, nonce, token: token(id, nonce) });
    },
    verify(response) {
      if (response === null || typeof response !== 'object') return false;
      const { intentId, nonce, token: presented } = response;
      if (typeof intentId !== 'string' || typeof nonce !== 'string' || typeof presented !== 'string') return false;
      const expected = Buffer.from(token(intentId, nonce));
      const actual = Buffer.from(presented);
      return expected.length === actual.length && timingSafeEqual(expected, actual);
    },
  });
}

/**
 * The recoverable job controller. It persists the intent through the durable control store
 * *before* submitting and afterwards only ever reconciles by querying the scheduler.
 */
export function createSlurmJobController(options = {}) {
  const store = options.store;
  const scheduler = options.scheduler;
  requireValue(store !== null && typeof store === 'object', 'store');
  requireValue(scheduler !== null && typeof scheduler === 'object', 'scheduler');
  const environmentId = parseEnvironmentId(options.environmentId);
  const clock = options.clock ?? (() => Date.now());
  const newUuid = options.uuid ?? randomUUID;

  async function submit(request) {
    requireValue(request !== null && typeof request === 'object', 'submit');
    const resources = normalizeSlurmResources(request.resources);
    const preview = buildResourcePreview(resources);
    const ownership = request.ownership === 'borrowed' ? 'borrowed' : 'owned';
    const intentId = newUuid();
    const intent = {
      schemaVersion: CONTROL_STORE_SCHEMA_VERSION,
      kind: 'slurm.job',
      environmentId,
      intentId,
      uuid: intentId,
      ownership,
      resources,
      sharedRoot: request.sharedRoot ?? null,
      computeWorkingRoot: request.computeWorkingRoot ?? null,
      state: 'planned',
      queue: 'UNKNOWN',
      resource: 'UNKNOWN',
      bridge: 'UNKNOWN',
      transport: 'UNKNOWN',
      terminal: null,
      reconcile: null,
      attached: true,
      jobId: null,
      createdAt: clock(),
      submittedAt: null,
    };
    const durable = await store.writeIntent(intent);
    requireValue(durable.intentId === intentId, 'store.intent');
    const script = buildSbatchScript({
      intentId,
      resources,
      command: request.command,
      args: request.args,
      cwd: request.computeWorkingRoot,
      env: request.env,
      output: request.output,
    });
    const argv = buildSbatchArgv({ intentId, resources });

    let ack;
    try {
      ack = await scheduler.submit({ intentId, script, argv, resources, ownership });
    } catch {
      // The ack was lost. Persist the ambiguity; the job may already exist. Never resubmit.
      const record = await store.updateIntent(intentId, { state: 'submitted', reconcile: 'unconfirmed', submittedAt: clock() });
      return Object.freeze({ intentId, state: 'submitted', reconcile: 'unconfirmed', jobId: null, ownership, preview, intent: record });
    }
    const { jobId } = parseSbatchOutput(ack?.stdout);
    const record = await store.updateIntent(intentId, {
      state: 'submitted',
      jobId,
      queue: 'PENDING',
      reconcile: null,
      submittedAt: clock(),
    });
    return Object.freeze({ intentId, state: 'submitted', reconcile: null, jobId, ownership, preview, intent: record });
  }

  /** Queries the scheduler by intent UUID. Zero matches → unconfirmed; several → ambiguous; one → adopt. */
  async function reconcile(intentId) {
    const intent = await store.readIntent(intentId);
    requireValue(intent !== undefined, 'intent', 'source_unavailable');
    let outcome;
    try {
      outcome = await scheduler.query({ intentId, uuid: intent.uuid ?? intent.intentId });
    } catch {
      return store.updateIntent(intent.intentId, { reconcile: 'unconfirmed' });
    }
    const matches = Array.isArray(outcome?.matches) ? outcome.matches : [];
    if (matches.length === 0) {
      return store.updateIntent(intent.intentId, { state: 'submitted', reconcile: 'unconfirmed' });
    }
    if (matches.length > 1) {
      return store.updateIntent(intent.intentId, { state: 'reconciling', reconcile: 'ambiguous' });
    }
    const match = matches[0];
    const mapped = mapQueueState(match.state);
    return store.updateIntent(intent.intentId, {
      state: mapped.terminal === null ? mapped.queue : mapped.terminal,
      jobId: match.jobId ?? intent.jobId ?? null,
      queue: mapped.queue,
      terminal: mapped.terminal,
      requeued: mapped.requeued,
      reconcile: null,
    });
  }

  async function state(intentId) {
    return store.readIntent(intentId);
  }

  /** Detaches local tracking. It never cancels the job. */
  async function detach(intentId) {
    const intent = await store.readIntent(intentId);
    requireValue(intent !== undefined, 'intent', 'source_unavailable');
    await store.updateIntent(intent.intentId, { attached: false });
    return Object.freeze({ intentId: intent.intentId, attached: false, cancelled: false, signalled: false });
  }

  /** Cancels only a job this controller owns. A borrowed allocation is never signalled. */
  async function stop(intentId) {
    const intent = await store.readIntent(intentId);
    requireValue(intent !== undefined, 'intent', 'source_unavailable');
    if (intent.ownership !== 'owned') {
      return Object.freeze({ intentId: intent.intentId, signalled: false, cancelled: false, reason: 'borrowed', jobId: intent.jobId ?? null });
    }
    if (intent.jobId === null || intent.jobId === undefined || intent.terminal !== null) {
      return Object.freeze({
        intentId: intent.intentId,
        signalled: false,
        cancelled: false,
        reason: intent.jobId === null || intent.jobId === undefined ? 'no-job' : 'terminal',
        jobId: intent.jobId ?? null,
      });
    }
    await scheduler.cancel({ intentId: intent.intentId, jobId: intent.jobId });
    await store.updateIntent(intent.intentId, { terminal: 'CANCELLED', queue: 'CANCELLED', attached: false });
    return Object.freeze({ intentId: intent.intentId, signalled: true, cancelled: true, jobId: intent.jobId });
  }

  async function close() {
    return store.close();
  }

  return {
    environmentId,
    submit,
    reconcile,
    state,
    detach,
    stop,
    preview: buildResourcePreview,
    close,
  };
}
