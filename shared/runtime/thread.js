import { ProtocolError } from './capabilities.js';
import { encodeSessionKey, parseSessionRef } from './identity.js';

/** One schema version for the whole Thread binding contract. */
export const THREAD_SCHEMA_VERSION = 1;
/** The owner binds the thread's origin session; participants join later. */
export const THREAD_ROLES = Object.freeze(['owner', 'participant']);
/** A left or orphaned participant keeps its native history; it is never deleted. */
export const PARTICIPANT_STATES = Object.freeze(['active', 'left', 'orphaned']);

const UUID_PATTERN = /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;

/** Every rejection carries an explicit protocol code plus the plain rejection field. */
export class ThreadError extends ProtocolError {
  constructor(code, reason) {
    super(code, `runtime.thread.${reason}`);
    this.name = 'ThreadError';
    this.reason = reason;
    this.field = reason;
  }
}

function requireUuid(value, reason) {
  if (typeof value !== 'string' || !UUID_PATTERN.test(value)) throw new ThreadError('invalid_request', reason);
  return value.toLowerCase();
}

export const parseThreadId = (value) => requireUuid(value, 'thread_id');
export const parseParticipantId = (value) => requireUuid(value, 'participant_id');

export function parseThreadRole(value) {
  if (!THREAD_ROLES.includes(value)) throw new ThreadError('invalid_request', 'thread_role');
  return value;
}

export function parseParticipantState(value) {
  if (!PARTICIPANT_STATES.includes(value)) throw new ThreadError('invalid_request', 'participant_state');
  return value;
}

/** Canonical binding key: one stable key per native SessionRef, so the same session always resolves to one Thread wrapper. */
export function threadBindingKey(value) {
  try {
    return encodeSessionKey(value);
  } catch (error) {
    if (error instanceof TypeError) throw new ThreadError('invalid_request', 'thread_session');
    throw error;
  }
}

/** Receiver-side binding parse: role + referenced native SessionRef + its preserved native parent. */
export function parseThreadBinding(value) {
  if (value === null || typeof value !== 'object' || Array.isArray(value)
    || Object.keys(value).length !== 3
    || !Object.hasOwn(value, 'role') || !Object.hasOwn(value, 'session') || !Object.hasOwn(value, 'nativeParent')) {
    throw new ThreadError('invalid_request', 'thread_binding');
  }
  let session;
  let nativeParent = null;
  try {
    session = parseSessionRef(value.session);
    if (value.nativeParent !== null) nativeParent = parseSessionRef(value.nativeParent);
  } catch (error) {
    if (error instanceof TypeError) throw new ThreadError('invalid_request', 'thread_binding');
    throw error;
  }
  return Object.freeze({
    role: parseThreadRole(value.role),
    session,
    nativeParent,
  });
}
