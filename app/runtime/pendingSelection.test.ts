import { describe, expect, it } from 'vitest';
import { encodeSessionKey, parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import { createPendingSelection, parseRuntimeSelection, runtimeSelectionQuery } from './pendingSelection';

const profileId = parseConnectionProfileId('33333333-3333-4333-8333-333333333333');
const session = { environmentId: parseEnvironmentId('11111111-1111-4111-8111-111111111111'), harnessInstanceId: parseHarnessInstanceId('22222222-2222-4222-8222-222222222222'), nativeSessionId: 'same-native' };
const requested = { profileId, sessionKey: encodeSessionKey(session) };
const reference = { profileId, url: 'ws://runtime.test/runtime', expectedEnvironmentId: session.environmentId };

describe('Runtime pending deep-link selection', () => {
  it('roundtrips only public profile and composite session identity', () => {
    const query = runtimeSelectionQuery(requested);
    expect([...new URLSearchParams(query).keys()]).toEqual(['runtimeProfile', 'runtimeSession']);
    expect(parseRuntimeSelection(query)).toEqual(requested); expect(parseRuntimeSelection('project=legacy&session=hint')).toBeNull();
  });
  it.each(['token', 'bridgeToken', 'runtimeUrl', 'endpoint', 'password'])('rejects a credential or endpoint query key %s', key => {
    expect(() => parseRuntimeSelection(`${runtimeSelectionQuery(requested)}&${key}=private`)).toThrow();
  });
  it('rejects malformed, incomplete and duplicate public identities', () => {
    expect(() => parseRuntimeSelection('runtimeProfile=bad&runtimeSession=bad')).toThrow();
    expect(() => parseRuntimeSelection(`runtimeProfile=${profileId}`)).toThrow();
    expect(() => parseRuntimeSelection(`${runtimeSelectionQuery(requested)}&runtimeProfile=${profileId}`)).toThrow();
  });
  it('retains the exact request across paging, missing results and reconnect', () => {
    const pending = createPendingSelection(requested);
    expect(pending.reconcile({ reference: null, sessions: [session], complete: false }).kind).toBe('pending');
    expect(pending.reconcile({ reference, sessions: [], complete: false }).kind).toBe('pending');
    expect(pending.reconcile({ reference, sessions: [], complete: true }).kind).toBe('missing');
    expect(pending.state.requested).toEqual(requested);
    pending.suspend(); expect(pending.state.kind).toBe('pending');
    expect(pending.reconcile({ reference, sessions: [session], complete: false }).kind).toBe('resolved');
    expect(pending.reconcile({ reference, sessions: [], complete: true }).kind).toBe('resolved');
    pending.suspend(); expect(pending.state.requested).toEqual(requested);
  });
  it('never resolves same native ID on a different target, harness or profile', () => {
    const pending = createPendingSelection(requested);
    const wrongTarget = { ...session, environmentId: parseEnvironmentId('44444444-4444-4444-8444-444444444444') };
    const wrongHarness = { ...session, harnessInstanceId: parseHarnessInstanceId('55555555-5555-4555-8555-555555555555') };
    expect(pending.reconcile({ reference, sessions: [wrongTarget, wrongHarness], complete: true }).kind).toBe('missing');
    const wrongProfile = { ...reference, profileId: parseConnectionProfileId('66666666-6666-4666-8666-666666666666') };
    expect(pending.reconcile({ reference: wrongProfile, sessions: [session], complete: true }).kind).toBe('pending');
  });
  it('leaves an ambiguous exact match unresolved with its identity retained', () => {
    const pending = createPendingSelection(requested);
    expect(pending.reconcile({ reference, sessions: [session, session], complete: true }).kind).toBe('ambiguous');
    expect(pending.reconcile({ reference, sessions: [session], complete: true }).kind).toBe('ambiguous');
    expect(pending.state.requested).toEqual(requested);
  });
});
