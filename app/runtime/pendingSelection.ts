import { decodeSessionKey, encodeSessionKey, parseConnectionProfileId, type ConnectionProfileId, type SessionKey, type SessionRef } from '../../shared/runtime/identity.js';
import type { PublicConnectionReference } from '../../shared/runtime/runtimeWire.js';
import { RuntimeConnectionError } from './connectionProfile';

export type RuntimeSelection = Readonly<{ profileId: ConnectionProfileId; sessionKey: SessionKey }>;
export type PendingSelectionState = Readonly<{ kind: 'pending' | 'missing' | 'ambiguous' | 'resolved'; requested: RuntimeSelection }>;

export function parseRuntimeSelection(search: string): RuntimeSelection | null {
  const query = new URLSearchParams(search);
  if (['token', 'bridgeToken', 'runtimeToken', 'runtimeUrl', 'runtimeEndpoint', 'url', 'endpoint', 'username', 'password', 'authorization', 'access_token'].some(key => query.has(key))) throw new RuntimeConnectionError('invalid_request');
  const profile = query.getAll('runtimeProfile');
  const session = query.getAll('runtimeSession');
  if (!profile.length && !session.length) return null;
  if (profile.length !== 1 || session.length !== 1) throw new RuntimeConnectionError('invalid_request');
  return Object.freeze({ profileId: parseConnectionProfileId(profile[0]), sessionKey: encodeSessionKey(decodeSessionKey(session[0])) });
}

export function runtimeSelectionQuery(selection: RuntimeSelection): string {
  return new URLSearchParams({ runtimeProfile: parseConnectionProfileId(selection.profileId), runtimeSession: encodeSessionKey(decodeSessionKey(selection.sessionKey)) }).toString();
}

export function createPendingSelection(requested: RuntimeSelection) {
  const selection = Object.freeze({ profileId: parseConnectionProfileId(requested.profileId), sessionKey: encodeSessionKey(decodeSessionKey(requested.sessionKey)) });
  let state: PendingSelectionState = { kind: 'pending', requested: selection };
  let matched = false;
  let ambiguous = false;
  return {
    get state() { return state; },
    suspend() { matched = ambiguous = false; state = { kind: 'pending', requested: selection }; },
    reconcile(input: Readonly<{ reference: PublicConnectionReference | null; sessions: readonly SessionRef[]; complete: boolean }>): PendingSelectionState {
      if (!input.reference || input.reference.profileId !== selection.profileId) { matched = ambiguous = false; return state = { kind: 'pending', requested: selection }; }
      const matches = input.sessions.filter(session => encodeSessionKey(session) === selection.sessionKey);
      if (matches.length === 1) matched = true;
      if (matches.length > 1) ambiguous = true;
      const kind = ambiguous ? 'ambiguous' : matched ? 'resolved' : input.complete ? 'missing' : 'pending';
      return state = { kind, requested: selection };
    },
  };
}
