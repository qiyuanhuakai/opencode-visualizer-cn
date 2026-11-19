import { ProtocolError } from '../../shared/runtime/capabilities.js';
import { parseEnvironmentId } from '../../shared/runtime/identity.js';
import { RUNTIME_CHALLENGE_KINDS } from '../composables/useRuntimeProfiles';
import type { RuntimeChallenge, RuntimeConnectionStatus, SlurmLifecycleStatus, SlurmResourcePreview, RuntimeTransportAvailability } from '../composables/useRuntimeProfiles';
import { hostObject, hostString } from './hostCollaborationViews';

function integer(value: unknown): number {
  if (typeof value !== 'number' || !Number.isSafeInteger(value) || value < 0) throw new ProtocolError('invalid_request', 'remote.result.integer');
  return value;
}
function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError('invalid_request', 'remote.result.boolean');
  return value;
}
function optionalText(value: unknown): string | null { return value == null ? null : hostString(value); }

export function remoteAvailability(value: unknown): RuntimeTransportAvailability {
  const raw = hostObject(value);
  return { direct: boolean(raw.direct), ssh: boolean(raw.ssh), slurm: boolean(raw.slurm) };
}
export function remoteStatus(value: unknown): RuntimeConnectionStatus {
  const raw = hostObject(value);
  const state = raw.state;
  if (state !== 'disconnected' && state !== 'connecting' && state !== 'connected' && state !== 'failed') throw new ProtocolError('invalid_request', 'remote.result.state');
  return { profileId: hostString(raw.profileId), environmentId: parseEnvironmentId(raw.environmentId), state, generation: integer(raw.generation) };
}
export function remoteChallenge(value: unknown): RuntimeChallenge {
  const raw = hostObject(value);
  const kind = RUNTIME_CHALLENGE_KINDS.find((kind) => kind === raw.kind);
  if (!kind || raw.echo !== false || raw.redacted !== true) throw new ProtocolError('invalid_request', 'remote.result.challenge');
  return {
    challengeId: hostString(raw.challengeId), kind, prompt: hostString(raw.prompt), echo: false, redacted: true, createdAt: integer(raw.createdAt),
    ...(raw.fingerprint === undefined ? {} : { fingerprint: hostString(raw.fingerprint) }),
  };
}
export function remoteSlurm(value: unknown): SlurmLifecycleStatus {
  const raw = hostObject(value);
  const ownership = raw.ownership;
  if (ownership !== 'owned' && ownership !== 'borrowed') throw new ProtocolError('invalid_request', 'remote.result.ownership');
  return {
    environmentId: parseEnvironmentId(raw.environmentId), intentId: hostString(raw.intentId), jobId: optionalText(raw.jobId),
    state: hostString(raw.state), queue: optionalText(raw.queue), terminal: optionalText(raw.terminal), reconcile: optionalText(raw.reconcile),
    attached: boolean(raw.attached), ownership, computeNode: optionalText(raw.computeNode), stepId: optionalText(raw.serviceStepId ?? raw.relayStepId),
    epoch: raw.restartCount == null ? null : integer(raw.restartCount), bridgeInstanceId: null,
  };
}

export function remoteIdentity(value: unknown) {
  if (value === null) return null;
  const raw = hostObject(value);
  return { environmentId: parseEnvironmentId(raw.environmentId), instanceId: hostString(raw.instanceId), epoch: hostString(raw.epoch), generation: integer(raw.generation) };
}
export function remotePreview(value: unknown): SlurmResourcePreview {
  const raw = hostObject(value);
  return {
    nodes: integer(raw.nodes), ntasks: integer(raw.ntasks), cpus: integer(raw.cpus), memory: hostString(raw.memory), memoryMiB: integer(raw.memoryMiB),
    time: hostString(raw.time), timeSeconds: integer(raw.timeSeconds), gres: hostString(raw.gres), requestsGpu: boolean(raw.requestsGpu),
    partition: hostString(raw.partition), account: optionalText(raw.account),
  };
}
