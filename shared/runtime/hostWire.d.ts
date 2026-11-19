import type { SessionRef, RepoRef } from './identity.js';
import type { JsonValue } from './capabilities.js';
import type { ThreadService } from '../../bridge/runtime/threads/threadService.js';
import type { RuntimeHandoffPort } from '../../app/composables/useRuntimeThread.js';
import type { CollaborationCoordinatorPort } from '../../app/composables/useRuntimeCollaboration.js';
import type { ImportBatch } from '../../bridge/runtime/migration/importService.js';
import type { Ack } from '../../bridge/runtime/storage/runtimeStore.js';
import type { EvidenceRef, EvidenceTarget } from './context.js';

type Empty = Readonly<Record<string, never>>;
type PageArgs = { readonly cursor?: number | null; readonly limit?: number };
type ThreadRef = { readonly threadId: string };
type ParticipantRef = ThreadRef & { readonly participantId: string };
type TeamRef = { readonly teamId: string };
type TaskRef = { readonly taskId: string };
type AttemptRef = { readonly attemptId: string };
type HandoffRef = { readonly handoffId: string };
type ObjectArgs = Readonly<Record<string, JsonValue>>;
export interface HostReadParams {
  readonly 'thread.selection': { readonly session: SessionRef };
  readonly 'thread.manifest': { readonly session: SessionRef };
  readonly 'thread.repository': { readonly session: SessionRef };
  readonly 'thread.snapshot': ThreadRef & PageArgs;
  readonly 'thread.handoffs': ThreadRef & PageArgs;
  readonly 'thread.timeline': ThreadRef & {
    readonly cursor?: number | null;
    readonly limit?: number;
  };
  readonly 'thread.get': ThreadRef;
  readonly 'thread.participants': ThreadRef & PageArgs;
  readonly 'thread.resolveSession': ThreadRef & { readonly session: SessionRef };
  readonly 'thread.history': ThreadRef;
  readonly 'thread.active': ThreadRef;
  readonly 'thread.nativeHistory': ParticipantRef;
  readonly 'thread.state': Empty;
  readonly 'handoff.handoff': HandoffRef;
  readonly 'handoff.checkpoint': HandoffRef;
  readonly 'handoff.evidenceTarget': HandoffRef;
  readonly 'handoff.evidencePage': HandoffRef & {
    readonly ref: EvidenceRef;
    readonly currentTarget: EvidenceTarget;
    readonly offset?: number;
    readonly length?: number;
  };
  readonly 'handoff.handoffs': Empty;
  readonly 'handoff.ops': HandoffRef;
  readonly 'collaboration.team': TeamRef;
  readonly 'collaboration.teams': Empty;
  readonly 'collaboration.task': TaskRef;
  readonly 'collaboration.taskDetails': TaskRef & PageArgs;
  readonly 'collaboration.tasks': { readonly teamId?: string };
  readonly 'collaboration.attempt': AttemptRef;
  readonly 'collaboration.attempts': TaskRef;
  readonly 'collaboration.ops': AttemptRef;
  readonly 'collaboration.mailbox': TeamRef;
  readonly 'collaboration.budgets': Empty;
  readonly 'collaboration.state': Empty;
  readonly 'collaboration.snapshot': TeamRef & PageArgs;
  readonly 'collaboration.teamForThread': ThreadRef;
  readonly 'collaboration.members': TeamRef;
  readonly 'collaboration.membersPage': TeamRef & PageArgs;
  readonly 'collaboration.delegationTask': TaskRef;
  readonly 'collaboration.delegationTasks': TeamRef;
  readonly 'collaboration.readEvidence': { readonly memberId: string; readonly input: ObjectArgs };
  readonly 'collaboration.delegationStatus': {
    readonly memberId: string;
    readonly input: ObjectArgs;
  };
  readonly 'fanout.fanout': { readonly fanoutId: string };
  readonly 'fanout.fanouts': Empty;
  readonly 'fanout.fanoutsPage': TeamRef & PageArgs;
  readonly 'fanout.state': Empty;
  readonly 'writer.binding': { readonly leaseId: string };
  readonly 'writer.lease': { readonly leaseId: string };
  readonly 'writer.leases': Empty;
  readonly 'writer.nativeCwd': { readonly leaseId: string };
  readonly 'writer.posture': { readonly leaseId: string };
  readonly 'writer.retention': { readonly leaseId: string };
  readonly 'writer.state': Empty;
  readonly 'artifact.review': { readonly reviewId: string };
  readonly 'artifact.approval': { readonly approvalId: string };
  readonly 'artifact.integration': { readonly operationId: string };
  readonly 'artifact.workflow': { readonly artifactHash: string } & PageArgs;
  readonly 'artifact.entries': { readonly artifactHash: string } & PageArgs;
  readonly 'artifact.content': {
    readonly artifactHash: string;
    readonly path: string;
    readonly offset?: number;
    readonly limit?: number;
  };
  readonly 'artifact.inspect': { readonly artifactHash: string };
  readonly 'remote.capabilities': Empty;
  readonly 'remote.preview': { readonly resources: ObjectArgs };
  readonly 'remote.identity': { readonly profileId: string };
  readonly 'remote.profiles': Empty;
  readonly 'remote.status': ObjectArgs;
  readonly 'remote.challenges': { readonly profileId: string };
  readonly 'remote.jobs': { readonly profileId: string };
  readonly 'remote.job': { readonly profileId: string; readonly intentId: string };
}
export interface HostMutationParams {
  readonly 'thread.bind': { readonly session: SessionRef; readonly repo: RepoRef };
  readonly 'thread.join': {
    readonly threadId: string;
    readonly session: SessionRef;
    readonly repo: RepoRef;
  };
  readonly 'thread.leave': Parameters<ThreadService['leave']>[0];
  readonly 'thread.resume': Parameters<ThreadService['resume']>[0];
  readonly 'thread.activate': Parameters<ThreadService['activate']>[0];
  readonly 'handoff.begin': {
    readonly threadId: string;
    readonly sourceParticipantId: string;
    readonly targetParticipantId: string;
    readonly entries?: readonly JsonValue[];
    readonly handoffId?: string;
    readonly cancel?: boolean;
  };
  readonly 'handoff.captureEvidence': ThreadRef & { readonly kind: 'file' | 'diff'; readonly path: string };
  readonly 'handoff.attach': Parameters<RuntimeHandoffPort['attach']>[0];
  readonly 'handoff.prepare': Parameters<RuntimeHandoffPort['prepare']>[0];
  readonly 'handoff.deliver': Parameters<RuntimeHandoffPort['deliver']>[0];
  readonly 'handoff.cancel': Parameters<RuntimeHandoffPort['cancel']>[0];
  readonly 'handoff.resolve': {
    readonly handoffId: string;
    readonly resolution: 'reconcile' | 'failed';
    readonly code: string;
    readonly field: string;
    readonly reason?: string;
  };
  readonly 'collaboration.openTeam': { readonly threadId: string; readonly name: string };
  readonly 'collaboration.createTeam': ObjectArgs;
  readonly 'collaboration.addMember': ObjectArgs;
  readonly 'collaboration.delegate': { readonly memberId: string; readonly input: ObjectArgs };
  readonly 'collaboration.submitEvidence': {
    readonly memberId: string;
    readonly input: ObjectArgs;
  };
  readonly 'collaboration.message': { readonly memberId: string; readonly input: ObjectArgs };
  readonly 'collaboration.control': { readonly memberId: string; readonly input: ObjectArgs };
  readonly 'collaboration.createTask': ObjectArgs;
  readonly 'collaboration.addDependency': ObjectArgs;
  readonly 'collaboration.dispatch': Parameters<CollaborationCoordinatorPort['dispatch']>[0];
  readonly 'collaboration.send': Parameters<CollaborationCoordinatorPort['send']>[0];
  readonly 'collaboration.pump': ObjectArgs;
  readonly 'collaboration.cancelAttempt': ObjectArgs;
  readonly 'collaboration.registerDeliverable': Parameters<
    CollaborationCoordinatorPort['registerDeliverable']
  >[0];
  readonly 'collaboration.submitForReview': ObjectArgs;
  readonly 'collaboration.review': Parameters<CollaborationCoordinatorPort['review']>[0];
  readonly 'collaboration.accept': Parameters<CollaborationCoordinatorPort['accept']>[0];
  readonly 'collaboration.reject': ObjectArgs;
  readonly 'collaboration.failTask': ObjectArgs;
  readonly 'collaboration.cancelTask': ObjectArgs;
  readonly 'collaboration.postMessage': ObjectArgs;
  readonly 'fanout.createFanout': ObjectArgs;
  readonly 'fanout.dispatch': ObjectArgs;
  readonly 'fanout.cancelRecipient': ObjectArgs;
  readonly 'fanout.reconcile': ObjectArgs;
  readonly 'fanout.retry': ObjectArgs;
  readonly 'writer.allocate': {
    readonly taskId: string;
    readonly repository: string;
    readonly ttlMs?: number;
    readonly readOnly?: boolean;
  };
  readonly 'writer.reconnect': { readonly leaseId: string };
  readonly 'writer.reconcile': { readonly leaseId: string; readonly createMissing?: boolean };
  readonly 'writer.release': { readonly leaseId: string };
  readonly 'writer.confirmWorktreeRemoval': { readonly leaseId: string };
  readonly 'writer.removeWorktree': { readonly leaseId: string };
  readonly 'artifact.capture': { readonly leaseId: string };
  readonly 'artifact.review': {
    readonly artifactHash: string;
    readonly repository: string;
    readonly target: string;
  };
  readonly 'artifact.approve': { readonly reviewId: string };
  readonly 'artifact.integrate': {
    readonly approvalId: string;
    readonly tests: readonly {
      readonly criterionId: string;
      readonly command: string;
      readonly args: readonly string[];
    }[];
    readonly commitMessage?: string;
  };
  readonly 'artifact.apply': {
    readonly artifactHash: string;
    readonly target: string;
    readonly approved?: boolean;
    readonly dryRun?: boolean;
  };
  readonly 'migration.accept': ImportBatch;
  readonly 'migration.verify': {
    readonly importId: string;
    readonly sourceRevision: string;
    readonly expectedRecords: number;
    readonly expectedChunks: number;
  };
  readonly 'remote.create': ObjectArgs;
  readonly 'remote.update': ObjectArgs;
  readonly 'remote.enable': ObjectArgs;
  readonly 'remote.connect': ObjectArgs;
  readonly 'remote.reconnect': ObjectArgs;
  readonly 'remote.disconnect': ObjectArgs;
  readonly 'remote.delete': ObjectArgs;
  readonly 'remote.respond': ObjectArgs;
  readonly 'remote.submit': ObjectArgs;
  readonly 'remote.borrow': ObjectArgs;
  readonly 'remote.reconcile': { readonly profileId: string; readonly intentId: string };
  readonly 'remote.detach': { readonly profileId: string; readonly intentId: string };
  readonly 'remote.stop': { readonly profileId: string; readonly intentId: string };
}
export type HostReadResults = {
  readonly [K in keyof HostReadParams]: K extends `thread.${infer M extends keyof ThreadService}`
    ? ThreadService[M] extends (...args: never[]) => infer R
      ? Awaited<R>
      : ThreadService[M]
    : K extends `handoff.${infer M extends keyof RuntimeHandoffPort}`
      ? RuntimeHandoffPort[M] extends (...args: never[]) => infer R
        ? Awaited<R>
        : JsonValue
      : JsonValue;
};
export type HostMutationResults = {
  readonly [
    K in keyof HostMutationParams
  ]: K extends `thread.${infer M extends keyof ThreadService}`
    ? ThreadService[M] extends (...args: never[]) => infer R
      ? Awaited<R>
      : never
    : K extends 'migration.accept' | 'migration.verify'
      ? Ack
      : JsonValue;
};
type Wire<T> = unknown extends T
  ? JsonValue
  : T extends string | number | boolean | null | undefined
    ? T
    : T extends readonly (infer Item)[]
      ? readonly Wire<Item>[]
      : { readonly [K in keyof T]: Wire<T[K]> };
type Calls<Mapping> = {
  readonly [K in keyof Mapping]: K extends `${infer D}.${infer O}`
    ? { readonly domain: D; readonly operation: O; readonly args: Wire<Mapping[K]> }
    : never;
}[keyof Mapping];
export type HostReadCall = Calls<HostReadParams>;
export type HostMutationCall = Calls<HostMutationParams>;
export type HostDomain = HostReadCall['domain'] | HostMutationCall['domain'];
export const HOST_OPERATIONS: Readonly<
  Record<HostDomain, { readonly read: readonly string[]; readonly mutate: readonly string[] }>
>;
export function parseHostCall(mode: 'read', input: unknown): HostReadCall;
export function parseHostCall(mode: 'mutate', input: unknown): HostMutationCall;
