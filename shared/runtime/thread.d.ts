import { ProtocolError } from './capabilities.js';
import type { ErrorCode } from './capabilities.js';
import type { SessionKey, SessionRef } from './identity.js';

/** One schema version for the whole Thread binding contract. */
export const THREAD_SCHEMA_VERSION: 1;
/** The owner binds the thread's origin session; participants join later. */
export const THREAD_ROLES: readonly ['owner', 'participant'];
/** A left or orphaned participant keeps its native history; it is never deleted. */
export const PARTICIPANT_STATES: readonly ['active', 'left', 'orphaned'];

export type ThreadRole = 'owner' | 'participant';
export type ParticipantState = 'active' | 'left' | 'orphaned';

declare const threadBrand: unique symbol;
type ThreadIdentity<Name extends string> = string & { readonly [threadBrand]: Name };
export type ThreadId = ThreadIdentity<'ThreadId'>;
export type ParticipantId = ThreadIdentity<'ParticipantId'>;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class ThreadError extends ProtocolError {
  readonly reason: string;
  constructor(code: ErrorCode, reason: string);
}

export function parseThreadId(value: unknown): ThreadId;
export function parseParticipantId(value: unknown): ParticipantId;
export function parseThreadRole(value: unknown): ThreadRole;
export function parseParticipantState(value: unknown): ParticipantState;
/** Canonical binding key: one stable key per native SessionRef. */
export function threadBindingKey(value: unknown): SessionKey;

export interface ThreadBinding {
  readonly role: ThreadRole;
  readonly session: SessionRef;
  readonly nativeParent: SessionRef | null;
}
export function parseThreadBinding(value: unknown): ThreadBinding;

/** The narrow session view a Thread binding needs from the session index. */
export interface ThreadSessionView {
  readonly session: SessionRef;
  readonly archived: boolean;
  readonly parentSession: SessionRef | null;
}
export type ThreadSessionSource = (session: SessionRef) => Promise<ThreadSessionView | null>;
