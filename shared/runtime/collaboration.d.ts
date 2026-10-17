import { ProtocolError } from './capabilities.js';
import type { ErrorCode } from './capabilities.js';
import type { SessionRef } from './identity.js';

/** One schema version for the whole collaboration contract. */
export const COLLABORATION_SCHEMA_VERSION: 1;

/**
 * The five coordination budgets, frozen once and shared by every enforcing service.
 *
 *   maxConcurrency      — attempts in flight across one coordinator
 *   maxSessionMutations — concurrent attempts mutating ONE native session
 *   maxDepth            — the longest dependency chain a task may sit on
 *   maxChildren         — direct children of one parent task
 *   maxMailbox          — notices one team mailbox may hold
 */
export interface CollaborationBudgets {
  readonly maxConcurrency: 4;
  readonly maxSessionMutations: 1;
  readonly maxDepth: 4;
  readonly maxChildren: 32;
  readonly maxMailbox: 1000;
}
export const COLLABORATION_BUDGETS: CollaborationBudgets;

/** The task lifecycle. `paused` is the VISIBLE budget state — never a silent drop, never a silent run. */
export const TASK_STATES: readonly ['pending', 'dispatched', 'review', 'accepted', 'failed', 'cancelled', 'paused'];
/** The attempt ladder: accepted → sent → observed → terminal, or the reconcile stop. */
export const ATTEMPT_STATES: readonly ['accepted', 'sent', 'observed', 'terminal', 'reconcile'];
/** The native terminal reasons an attempt can report. `completed` is NOT a task acceptance. */
export const ATTEMPT_TERMINAL_REASONS: readonly ['completed', 'failed', 'cancelled', 'timeout', 'aborted'];
/** Task review, independent of the attempt: a task is reviewed by a reviewer, never by its run. */
export const REVIEW_STATES: readonly ['none', 'pending', 'approved', 'rejected'];
/** Task acceptance, independent of the attempt: only the acceptance path can reach `accepted`. */
export const ACCEPTANCE_STATES: readonly ['none', 'pending', 'accepted', 'rejected'];
/** Every budget reason a visibly paused task can carry. */
export const BUDGET_REASONS: readonly [
  'collaboration_concurrency',
  'collaboration_session_mutation',
  'collaboration_depth',
  'collaboration_children',
  'collaboration_mailbox',
];

export type TaskState = (typeof TASK_STATES)[number];
export type AttemptState = (typeof ATTEMPT_STATES)[number];
export type AttemptTerminalReason = (typeof ATTEMPT_TERMINAL_REASONS)[number];
export type ReviewState = (typeof REVIEW_STATES)[number];
export type AcceptanceState = (typeof ACCEPTANCE_STATES)[number];
export type BudgetReason = (typeof BUDGET_REASONS)[number];

export const MAX_TASK_TITLE_CHARS: 512;
export const MAX_CRITERIA_COUNT: 32;
export const MAX_CRITERION_ID_CHARS: 128;
export const MAX_CRITERION_CHARS: 512;
export const MAX_DELIVERABLES: 16;
export const MAX_DELIVERABLE_PATHS: 64;
export const MAX_PATH_CHARS: 1024;
export const MAX_MAILBOX_TEXT_CHARS: 512;
export const MAX_NAMES: Readonly<{ team: 512; participant: 128; owner: 128; reviewer: 128 }>;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class CollaborationError extends ProtocolError {
  readonly reason: string;
  readonly detail: Readonly<Record<string, unknown>> | null;
  constructor(code: ErrorCode, reason: string, detail?: Readonly<Record<string, unknown>> | null);
}

export interface Criterion {
  readonly id: string;
  readonly text: string;
  readonly required: boolean;
}
export interface CriterionInput {
  readonly id: string;
  readonly text: string;
  readonly required?: boolean;
}
export interface CriterionVerdict {
  readonly id: string;
  readonly met: boolean;
}
export interface TaskOwner {
  readonly participantId: string;
  readonly session: SessionRef;
}
export interface LeaseInput {
  readonly ownerId: string;
  readonly expiresAt: number;
}
export interface Deliverable {
  readonly deliverableId: string;
  readonly artifactHash: string;
  readonly bytes: number;
  readonly paths: readonly string[];
}

export function parseTaskId(value: unknown): string;
export function parseAttemptId(value: unknown): string;
export function parseTeamId(value: unknown): string;
export function parseLeaseId(value: unknown): string;
export function parseMessageId(value: unknown): string;
export function parseTaskState(value: unknown): TaskState;
export function parseAttemptState(value: unknown): AttemptState;
export function parseTerminalReason(value: unknown): AttemptTerminalReason;
export function parseBudgetReason(value: unknown): BudgetReason;
export function parseReviewState(value: unknown): ReviewState;
export function parseAcceptanceState(value: unknown): AcceptanceState;
/** A monotonic-ish clock reading: an explicit `at` is required for every observable transition. */
export function parseAt(value?: number): number;
export function parseTeamName(value: unknown): string;
export function parseTaskTitle(value: unknown): string;
export function parseCriterion(value: unknown): Criterion;
export function parseCriteria(value: unknown): readonly Criterion[];
export function parseOwner(value: unknown): TaskOwner;
export function parseLeaseInput(value: unknown): LeaseInput;
export function parseDeliverable(value: unknown): Deliverable;
export function parseCriteriaVerdicts(value: unknown, criteria: readonly Criterion[]): readonly CriterionVerdict[];
/** The canonical key of the native session a task mutates. */
export function parseSessionMutationKey(value: unknown): string;
/** The frozen limit row the coordinator reports: the shared object, verbatim. */
export function collaborationBudgetLimits(): CollaborationBudgets;
