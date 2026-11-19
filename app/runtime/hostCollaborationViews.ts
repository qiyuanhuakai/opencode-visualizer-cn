import { jsonValue, ProtocolError } from '../../shared/runtime/capabilities.js';
import type { JsonValue } from '../../shared/runtime/capabilities.js';
import { encodeSessionKey, parseSessionRef } from '../../shared/runtime/identity.js';
import { deriveTaskPhase } from '../composables/useRuntimeCollaboration';
import type {
  CollaborationAttemptView, CollaborationDeliverableView, CollaborationMemberView,
  CollaborationTaskView, CollaborationTeamView,
  CollaborationWriterView, CollaborationBudgetView,
  CollaborationFanoutView,
} from '../composables/useRuntimeCollaboration';

type JsonObject = { readonly [key: string]: JsonValue };

function isObject(value: JsonValue): value is JsonObject {
  return value !== null && typeof value === 'object' && !Array.isArray(value);
}

export function hostObject(value: unknown): JsonObject {
  const parsed = jsonValue(value);
  if (!isObject(parsed)) throw new ProtocolError('invalid_request', 'host.result.object');
  return parsed;
}

export function hostArray(value: unknown): readonly JsonValue[] {
  const parsed = jsonValue(value);
  if (!Array.isArray(parsed)) throw new ProtocolError('invalid_request', 'host.result.array');
  return parsed;
}

export function hostString(value: unknown): string {
  if (typeof value !== 'string') throw new ProtocolError('invalid_request', 'host.result.string');
  return value;
}

function nullableString(value: unknown): string | null {
  return value === null ? null : hostString(value);
}

function boolean(value: unknown): boolean {
  if (typeof value !== 'boolean') throw new ProtocolError('invalid_request', 'host.result.boolean');
  return value;
}

function number(value: unknown): number {
  if (typeof value !== 'number' || !Number.isFinite(value) || value < 0) {
    throw new ProtocolError('invalid_request', 'host.result.number');
  }
  return value;
}

export interface HostPageView {
  readonly offset: number;
  readonly total: number;
  readonly nextCursor: number | null;
}

export function hostPage(value: unknown, collection: string): HostPageView {
  const raw = hostObject(value);
  const offset = number(raw.offset);
  const limit = number(raw.limit);
  const total = number(hostObject(raw.counts)[collection]);
  if (![offset, limit, total].every(Number.isSafeInteger) || limit < 1) throw new ProtocolError('invalid_request', 'host.result.pagination');
  return { offset, total, nextCursor: offset + limit < total ? offset + limit : null };
}

export function hostBudgets(value: unknown): CollaborationBudgetView {
  const raw = hostObject(value);
  function counters(value: unknown): Readonly<Record<string, number>> {
    return Object.fromEntries(Object.entries(hostObject(value)).map(([key, value]) => [key, number(value)]));
  }
  return { limits: counters(raw.limits), used: counters(raw.used) };
}

export function hostWriter(value: unknown, posture: unknown, nativeBinding: unknown = null): CollaborationWriterView {
  const raw = hostObject(value);
  const policy = hostObject(raw.policy);
  const binding = nativeBinding === null ? null : hostObject(nativeBinding);
  return {
    state: hostString(raw.state),
    binding: binding === null ? null : {
      phase: hostString(binding.phase),
      lastError: binding.lastError == null ? null : hostString(hostObject(binding.lastError).code),
    },
    leaseId: hostString(raw.leaseId), worktree: hostString(raw.worktree),
    nativeCwd: hostString(raw.nativeCwd), baseCommit: hostString(raw.baseCommit),
    policy: { worktreeAccess: hostString(policy.worktreeAccess), userRepository: hostString(policy.userRepository) },
    posture: hostObject(posture),
  };
}

export function hostFanout(value: unknown): CollaborationFanoutView {
  const raw = hostObject(value);
  const stats = Object.fromEntries(Object.entries(hostObject(raw.stats)).map(([key, value]) => [key, number(value)]));
  const targets = hostArray(raw.targets).map((value) => {
    const target = hostObject(value);
    const resolution = target.resolution === null ? null : hostObject(target.resolution);
    return {
      recipientId: hostString(target.recipientId), participantId: hostString(target.participantId),
      session: parseSessionRef(target.session), outcome: hostString(target.outcome),
      attachmentPath: nullableString(target.attachmentPath),
      resolution: resolution === null ? null : { code: hostString(resolution.code), field: hostString(resolution.field) },
      resolutionCode: resolution === null ? null : hostString(resolution.code),
    };
  });
  return {
    fanoutId: hostString(raw.fanoutId), state: hostString(raw.state), stats, targets,
    promptPreview: raw.promptPreview === undefined ? '' : hostString(raw.promptPreview).slice(0, 160),
    createdAt: raw.createdAt === undefined ? 0 : number(raw.createdAt),
    recipientCount: raw.recipientCount === undefined ? targets.length : number(raw.recipientCount),
    retryable: hostArray(raw.targets).filter((value) => hostObject(value).retryable === true)
      .map((value) => hostString(hostObject(value).recipientId)),
  };
}

export type FanoutAction = { type: 'cancel' | 'retry'; recipientId: string } | { type: 'reconcile' };

function strings(value: unknown): readonly string[] {
  return hostArray(value).map(hostString);
}

export function hostDeliverable(value: unknown): CollaborationDeliverableView {
  const raw = hostObject(value);
  return {
    deliverableId: hostString(raw.deliverableId), artifactHash: hostString(raw.artifactHash),
    bytes: number(raw.bytes), paths: strings(raw.paths),
  };
}

export function hostAttempt(value: unknown): CollaborationAttemptView {
  const raw = hostObject(value);
  return {
    attemptId: hostString(raw.attemptId), state: hostString(raw.state), sent: boolean(raw.sent),
    observed: boolean(raw.observed), terminal: boolean(raw.terminal),
    terminalReason: nullableString(raw.terminalReason), sends: number(raw.sends),
  };
}

export function hostMember(value: unknown): CollaborationMemberView {
  const raw = hostObject(value);
  const role = hostString(raw.role);
  if (role !== 'lead' && role !== 'worker') throw new ProtocolError('invalid_request', 'host.result.role');
  const session = parseSessionRef(raw.session);
  return {
    memberId: hostString(raw.memberId), participantId: hostString(raw.participantId), role,
    harnessKind: hostString(raw.harnessKind), session, sessionKey: encodeSessionKey(session),
  };
}

export function hostTeam(value: unknown): CollaborationTeamView {
  const raw = hostObject(value);
  return { teamId: hostString(raw.teamId), name: hostString(raw.name), members: hostArray(raw.members).map(hostMember) };
}

export function hostTask(value: unknown, attempts: readonly CollaborationAttemptView[] = []): CollaborationTaskView {
  const raw = hostObject(value);
  const review = hostObject(raw.review);
  const acceptance = hostObject(raw.acceptance);
  const owner = hostObject(raw.owner);
  const state = hostString(raw.state);
  const reviewView = {
    state: hostString(review.state), reviewer: nullableString(review.reviewer), reason: nullableString(review.reason),
  };
  const acceptanceView = {
    state: hostString(acceptance.state), acceptedBy: nullableString(acceptance.acceptedBy),
    deliverableId: nullableString(acceptance.deliverableId), criteria: strings(acceptance.criteria),
  };
  const pausedReasons = raw.paused === null ? [] : strings(hostObject(raw.paused).reasons);
  const phase = deriveTaskPhase({ state, review: reviewView, acceptance: acceptanceView });
  const attemptIds = strings(raw.attempts);
  return {
    taskId: hostString(raw.taskId), title: hostString(raw.title), state, phase, depth: number(raw.depth),
    review: reviewView, acceptance: acceptanceView,
    deliverables: hostArray(raw.deliverables).map(hostDeliverable),
    attempts: attempts.filter((attempt) => attemptIds.includes(attempt.attemptId)),
    owner: { participantId: hostString(owner.participantId), session: parseSessionRef(owner.session) },
    criteria: hostArray(raw.criteria).map((value) => {
      const criterion = hostObject(value);
      return { id: hostString(criterion.id), text: hostString(criterion.text), required: boolean(criterion.required) };
    }),
    dependsOn: strings(raw.dependsOn), children: strings(raw.children), blockedBy: strings(raw.blockedBy),
    ambiguous: boolean(raw.ambiguous), pausedReasons,
  };
}
