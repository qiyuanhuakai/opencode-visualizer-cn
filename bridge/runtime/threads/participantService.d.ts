import type { EnvironmentId, HarnessInstanceId, SessionRef } from '../../../shared/runtime/identity.js';
import type {
  ParticipantId,
  ParticipantState,
  ThreadRole,
  ThreadSessionSource,
  ThreadSessionView,
} from '../../../shared/runtime/thread.js';

/** Public projection of a participant: its own native session, never a merged history. */
export interface ParticipantView {
  readonly participantId: ParticipantId;
  readonly role: ThreadRole;
  readonly state: ParticipantState;
  readonly session: SessionRef;
  readonly nativeParent: SessionRef | null;
  readonly harnessInstanceId: HarnessInstanceId;
}
export interface ParticipantRecord extends ParticipantView {
  readonly joinedAt: number;
  readonly leftAt: number | null;
  readonly orphanReason: string | null;
}
/** Minimal mutable thread shape a participant service mutates. */
export interface ParticipantThread {
  readonly environmentId: EnvironmentId;
  readonly repoKey: string;
  readonly participants: ParticipantRecord[];
  revision: number;
}
export interface ParticipantJoinInput {
  readonly thread: ParticipantThread;
  readonly session: unknown;
  readonly repoKey: string;
  readonly role?: ThreadRole;
  readonly summary?: ThreadSessionView | null;
}
export interface ParticipantService {
  join(input?: ParticipantJoinInput): Promise<ParticipantRecord>;
  leave(input: { readonly thread: ParticipantThread; readonly participantId: string }): ParticipantRecord;
  resume(input: { readonly thread: ParticipantThread; readonly participantId: string }): Promise<ParticipantRecord>;
  get(thread: ParticipantThread, participantId: string): ParticipantRecord;
  readonly state: { readonly joins: number; readonly leaves: number; readonly resumes: number; readonly orphans: number };
}
/** Participants reference native SessionRefs; native sub-agents stay native — they are never promoted to Host participants. */
export function createParticipantService(options?: { readonly resolveSession: ThreadSessionSource }): ParticipantService;
