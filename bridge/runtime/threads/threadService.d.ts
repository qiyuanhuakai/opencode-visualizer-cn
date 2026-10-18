import type { EnvironmentId, HarnessInstanceId, RepoRef, SessionRef } from '../../../shared/runtime/identity.js';
import type { ParticipantId, ThreadId, ThreadSessionSource } from '../../../shared/runtime/thread.js';
import type { ParticipantRecord, ParticipantThread, ParticipantView } from './participantService.js';

export interface ThreadRecord extends ParticipantThread {
  readonly threadId: ThreadId;
  readonly createdAt: number;
  activeParticipantId: ParticipantId | null;
}
export interface ThreadSummary {
  readonly threadId: ThreadId;
  readonly environmentId: EnvironmentId;
  readonly repoKey: string;
  readonly revision: number;
  readonly activeParticipantId: ParticipantId | null;
  readonly harnessInstanceIds: readonly HarnessInstanceId[];
  readonly participants: readonly ParticipantView[];
}
export interface ThreadHistory {
  readonly threadId: ThreadId;
  readonly participants: readonly ParticipantView[];
}
export interface ThreadService {
  bind(input: { readonly session: unknown; readonly repo: RepoRef }): Promise<ThreadRecord>;
  join(input: { readonly threadId: string; readonly session: unknown; readonly repo: RepoRef }): Promise<ParticipantRecord>;
  leave(input: { readonly threadId: string; readonly participantId: string }): ParticipantRecord;
  resume(input: { readonly threadId: string; readonly participantId: string }): Promise<ParticipantRecord>;
  activate(input: { readonly threadId: string; readonly participantId: string }): ParticipantRecord;
  active(threadId: string): ParticipantRecord | null;
  get(threadId: string): ThreadSummary;
  history(threadId: string): ThreadHistory;
  nativeHistory(threadId: string, participantId: string): ParticipantView;
  close(): Promise<void>;
  readonly state: { readonly threads: number; readonly bindings: number; readonly active: number; readonly closed: boolean };
}
/**
 * Canonical Thread service. Threads are created lazily on the first explicit bind; an index of
 * existing sessions never materializes threads by itself. The same native SessionRef always
 * resolves to the same wrapper, and every participant keeps its own native history.
 */
export function createThreadService(options: { readonly resolveSession: ThreadSessionSource }): ThreadService;
