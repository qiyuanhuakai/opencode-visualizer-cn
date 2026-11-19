// Task 28 registered QA browser entry — the browser-shaped surface of the
// recoverable Slurm job control: a real Chromium proves that the user-visible
// resource preview, the queue-state projection, the scheduler-output parsers and
// the credential-protected bridge handshake cannot leak a credential once they
// cross into a renderer.
//
// Loaded by scripts/qa/runtime-v090-cases/task-28.mjs from a runner-served page.
// The REAL landed code executes here:
//   * bridge/runtime/transports/slurmJobs.js — normalizeSlurmResources,
//     buildResourcePreview, buildSbatchScript, mapQueueState, parseSbatchOutput,
//     parseSqueueOutput, parseScontrolShowJob, createSlurmHandshake,
//     SLURM_HANDSHAKE_KIND;
//   * bridge/runtime/transports/slurmBootstrap.js — parseSlurmHostProbe,
//     assertIndependentRoots, planComputeDelivery, planSlurmBootstrap,
//     COMPUTE_DELIVERY_CHANNELS.
// The only controlled boundary is scripts/qa/runtime-v090-cases/task-28-browser-shim.mjs,
// which backs the `node:*` specifiers (in-memory files, a deterministic case-owned
// hash/HMAC, throwing spawn/connect/statfs) because a renderer has no OS primitives.
// The job/bootstrapping LOGIC is real; the OS edge is the worker fixture. This entry
// never contacts a scheduler and never claims a live Slurm verification — task 46
// owns that end-to-end check.
import { Buffer as NodeBuffer } from 'buffer';
import {
  SLURM_HANDSHAKE_KIND,
  buildResourcePreview,
  buildSbatchScript,
  createSlurmHandshake,
  mapQueueState,
  normalizeSlurmResources,
  parseSbatchOutput,
  parseScontrolShowJob,
  parseSqueueOutput,
} from '../../../bridge/runtime/transports/slurmJobs.js';
import {
  COMPUTE_DELIVERY_CHANNELS,
  assertIndependentRoots,
  parseSlurmHostProbe,
  planComputeDelivery,
  planSlurmBootstrap,
} from '../../../bridge/runtime/transports/slurmBootstrap.js';

type AnyRecord = Record<string, any>;

(globalThis as AnyRecord).Buffer = (globalThis as AnyRecord).Buffer ?? NodeBuffer;

const INTENT = '33333333-3333-4333-8333-333333333333';
const CLUSTER_ENVIRONMENT = '22222222-2222-4222-8222-222222222222';
const RESOURCES = Object.freeze({ partition: 'cpu', account: 'research', cpus: 4, memory: '8G', time: '01:00:00', gres: 'none' });

// ── console spy: prove a credential never reaches any console channel from the renderer ──
const consoleEntries: Array<{ level: string; text: string }> = [];
function safeString(value: unknown): string {
  if (typeof value === 'string') return value;
  if (value instanceof Error) return `${value.name}: ${value.message}`;
  try { return JSON.stringify(value); } catch { return String(value); }
}
for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
  const original = console[level].bind(console);
  console[level] = (...args: unknown[]) => {
    try { consoleEntries.push({ level, text: args.map(safeString).join(' ') }); } catch { /* capture never throws */ }
    original(...args);
  };
}
const errors: string[] = [];
window.addEventListener('error', (event) => { errors.push(`error: ${String(event.message)}`); });
window.addEventListener('unhandledrejection', (event) => { errors.push(`unhandledrejection: ${String((event.reason && (event.reason as AnyRecord).message) || event.reason)}`); });

const domHost = document.createElement('pre');
domHost.id = 'qa28-out';
domHost.style.cssText = 'white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.5 monospace;padding:8px;';
document.body.append(domHost);

const occurrences = (haystack: string, needle: string): number => (needle.length === 0 ? 0 : haystack.split(needle).length - 1);

/** Captures a typed ProtocolError's code/field without swallowing anything else. */
function capture(run: () => unknown): { code?: string; field?: string } {
  try { run(); return {}; }
  catch (error) {
    if (error && typeof error === 'object') {
      return { code: (error as AnyRecord).code, field: (error as AnyRecord).field };
    }
    return { code: String(error) };
  }
}

// ── BH1: explicit resources and the user-visible preview the renderer draws ──
function resources(): AnyRecord {
  const normalized = normalizeSlurmResources(RESOURCES);
  const previewNone = buildResourcePreview({ ...RESOURCES, gres: 'none' });
  const previewGpu = buildResourcePreview({ ...RESOURCES, gres: 'gpu:1' });
  const script = buildSbatchScript({
    intentId: INTENT, resources: RESOURCES, command: '/opt/vis/vis_bridge', args: ['start', '--role=execution'], cwd: '/scratch/user/work',
  });
  const missingTime = capture(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', gres: 'none' }));
  const missingGres = capture(() => normalizeSlurmResources({ partition: 'cpu', cpus: 4, memory: '8G', time: '01:00:00' }));
  domHost.textContent = JSON.stringify({ previewNone, previewGpu, firstLine: script.split('\n').slice(0, 3) });
  return {
    cpus: normalized.cpus,
    memoryMiB: normalized.memoryMiB,
    timeSeconds: normalized.timeSeconds,
    gres: normalized.gres,
    nodes: normalized.nodes,
    ntasks: normalized.ntasks,
    previewNoneRequestsGpu: previewNone.requestsGpu,
    previewGpuRequestsGpu: previewGpu.requestsGpu,
    timeDirectiveCount: occurrences(script, `#SBATCH --time=${RESOURCES.time}`),
    gresNoneDirectiveCount: occurrences(script, '#SBATCH --gres=none'),
    cpusDirectiveCount: occurrences(script, `#SBATCH --cpus-per-task=${RESOURCES.cpus}`),
    execLineCount: occurrences(script, "exec '/opt/vis/vis_bridge' 'start' '--role=execution'"),
    missingTimeCode: missingTime.code,
    missingTimeField: missingTime.field,
    missingGresCode: missingGres.code,
    missingGresField: missingGres.field,
    domLength: domHost.textContent.length,
  };
}

// ── BH2: queue-state and scheduler-output projections the renderer reads ──
function scheduler(): AnyRecord {
  const parsed = parseSbatchOutput('24680;cluster-a');
  const bad = capture(() => parseSbatchOutput('not-a-job'));
  const squeue = parseSqueueOutput('24680|intent-a|RUNNING|intent-a|cpu|node-1\n24681|intent-b|PENDING|intent-b|cpu|\n');
  const mapped: AnyRecord = {};
  for (const state of ['PENDING', 'RUNNING', 'COMPLETED', 'CANCELLED', 'PREEMPTED', 'NODE_FAIL', 'OUT_OF_MEMORY']) mapped[state] = mapQueueState(state);
  const scontrol = parseScontrolShowJob('JobId=24680 JobName=intent-a JobState=COMPLETED Partition=cpu Comment=intent-a NodeList=node-1 ExitCode=0:0\n');
  domHost.textContent = JSON.stringify({ parsed, squeue, mapped });
  return {
    jobId: parsed.jobId,
    cluster: parsed.cluster,
    badSbatchCode: bad.code,
    badSbatchField: bad.field,
    squeueCount: squeue.length,
    squeueRunning: squeue[0]?.state,
    squeuePending: squeue[1]?.state,
    scontrolJobState: scontrol.jobState,
    pendingRequeued: mapped.PENDING.requeued,
    runningTerminal: mapped.RUNNING.terminal,
    completedTerminal: mapped.COMPLETED.terminal,
    preemptQueue: mapped.PREEMPTED.queue,
    preemptRequeued: mapped.PREEMPTED.requeued,
    nodeFailRequeued: mapped.NODE_FAIL.requeued,
    outOfMemoryTerminal: mapped.OUT_OF_MEMORY.terminal,
    domLength: domHost.textContent.length,
  };
}

// ── BH3: the credential-protected bridge handshake never puts the credential on the wire ──
function handshake(credential: string, intentId: string): AnyRecord {
  const session = createSlurmHandshake({ credential });
  const challenge = session.challenge(intentId);
  const attacker = createSlurmHandshake({ credential: `${credential}-wrong` });
  const forged = attacker.challenge(intentId);
  domHost.textContent = JSON.stringify({ kind: challenge.kind, intentId: challenge.intentId, nonce: challenge.nonce, token: challenge.token });
  const domText = domHost.textContent ?? '';
  return {
    kind: challenge.kind,
    expectedKind: SLURM_HANDSHAKE_KIND,
    credentialProtected: challenge.credentialProtected,
    verifyCorrect: session.verify({ intentId: challenge.intentId, nonce: challenge.nonce, token: challenge.token }),
    verifyForgedCredential: session.verify({ intentId: forged.intentId, nonce: forged.nonce, token: forged.token }),
    verifyTamperedToken: session.verify({ intentId: challenge.intentId, nonce: challenge.nonce, token: 'deadbeef' }),
    credentialInChallengeJson: occurrences(JSON.stringify(challenge), credential),
    credentialInDom: occurrences(domText, credential),
    tokenHexLength: challenge.token.length,
    nonceLength: challenge.nonce.length,
    challengeKeyCount: Object.keys(challenge).length,
  };
}

// ── BH4: the bootstrap plan the renderer shows (control on login, execution on compute) ──
function bootstrap(): AnyRecord {
  const plan = planSlurmBootstrap({
    profile: { target: { kind: 'slurm', clusterEnvironmentId: CLUSTER_ENVIRONMENT } },
    login: {
      role: 'login', platform: 'linux', programs: { sbatch: true, squeue: true, scontrol: true },
      controlRoot: '/home/user/.local/state/vis/bridge', workspaceRoot: '/home/user/work', nativeDataRoot: '/home/user/.local/share/vis/native',
    },
    compute: {
      role: 'compute', platform: 'linux', programs: { bridge: true }, bridgeInstalled: true,
      controlRoot: '/home/user/.local/state/vis/bridge', workspaceRoot: '/scratch/user/run', nativeDataRoot: '/scratch/user/native',
    },
    sharedRootAvailable: true,
  });
  const collision = capture(() => assertIndependentRoots({ controlRoot: '/shared/vis-control', workspaceRoot: '/shared/vis-control', nativeDataRoot: '/scratch/native' }));
  const shared = planComputeDelivery({ sharedRootAvailable: true });
  const controlled = planComputeDelivery({ sharedRootAvailable: false });
  const loginProbe = parseSlurmHostProbe({
    role: 'login', platform: 'linux', programs: { sbatch: true, squeue: true, scontrol: true },
    controlRoot: '/home/user/.local/state/vis/bridge',
  });
  domHost.textContent = JSON.stringify({ plan, shared, controlled });
  return {
    environmentId: plan.environmentId,
    controlHost: plan.controlHost,
    executionHost: plan.executionHost,
    submitControlHost: plan.submitControlHost,
    agentExecutionHost: plan.agentExecutionHost,
    loginControlRoot: plan.loginControlRoot,
    computeWorkingRoot: plan.computeWorkingRoot,
    rootsIndependent: plan.loginControlRoot !== plan.computeWorkingRoot,
    automatic: plan.automatic,
    sharedChannel: shared.channel,
    controlledChannel: controlled.channel,
    channelCount: COMPUTE_DELIVERY_CHANNELS.length,
    loginProgramsReady: loginProbe.programsReady,
    collisionCode: collision.code,
    collisionField: collision.field,
    domLength: domHost.textContent.length,
  };
}

const api = {
  ready: true,
  errors: () => errors,
  consoleEntries: () => consoleEntries,
  domText: () => domHost.textContent ?? '',
  resources,
  scheduler,
  handshake,
  bootstrap,
};

(window as unknown as AnyRecord).task28 = api;
