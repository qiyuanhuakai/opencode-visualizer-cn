import { describe, expect, it } from 'vitest';
import { createSelectionScope } from './selectionScope';
import type { RuntimeScope } from './client';
import { parseConnectionProfileId, parseEnvironmentId, parseHarnessInstanceId } from '../../shared/runtime/identity.js';
import type { EnvironmentId } from '../../shared/runtime/identity.js';

const profileId = parseConnectionProfileId('11111111-1111-4111-8111-111111111111');
const target = parseEnvironmentId('22222222-2222-4222-8222-222222222222');
const harness = parseHarnessInstanceId('33333333-3333-4333-8333-333333333333');
const otherHarness = parseHarnessInstanceId('44444444-4444-4444-8444-444444444444');
const session = { environmentId: target, harnessInstanceId: harness, nativeSessionId: 'same' };
function fixture() {
  const listeners = new Set<(target: EnvironmentId) => void>();
  let epoch = 'first'; let serverGeneration = 1; let localGeneration = 2; let attached = true;
  const client = {
    scope(environment: EnvironmentId): RuntimeScope {
      const binding = { target: environment, epoch, generation: serverGeneration };
      return { binding, generation: localGeneration, isCurrent: () => attached };
    },
    onDetach(listener: (target: EnvironmentId) => void) { listeners.add(listener); return () => { listeners.delete(listener); }; },
  };
  return { client, listeners, restart: () => { epoch = 'next'; }, reattach: () => { serverGeneration++; }, reconnect: () => { localGeneration++; }, detach: () => { attached = false; for (const listener of listeners) listener(target); } };
}

describe('qualified runtime selection capture', () => {
  it('invalidates synchronously when the same native ID belongs to another source', () => {
    // Given: a captured native ID in one harness instance.
    const fixtureState = fixture();
    const selection = createSelectionScope({ client: fixtureState.client, profileId });
    const old = selection.select(session);
    if (!old) throw new TypeError('fixture selection failed');
    // When: selection changes before an old async result can finish.
    const current = selection.select({ ...session, harnessInstanceId: otherHarness });
    // Then: the old capture is aborted even though native IDs match.
    expect(old.signal.aborted).toBe(true);
    expect(old.isCurrent()).toBe(false);
    expect(current?.selection.session.harnessInstanceId).toBe(otherHarness);
    expect(current?.selection.profileId).toBe(profileId);
    expect(current?.selectionGeneration).toBeGreaterThan(old.selectionGeneration);
    expect(current?.isCurrent()).toBe(true);
    selection.dispose();
  });

  it.each(['restart', 'reattach', 'reconnect'] as const)('rejects an old capture after %s changes its fence', (change) => {
    // Given: a currently selected session with a captured binding.
    const fixtureState = fixture();
    const selection = createSelectionScope({ client: fixtureState.client, profileId });
    const old = selection.select(session);
    // When: server epoch, wire generation or local generation changes.
    fixtureState[change]();
    // Then: a permissive isCurrent callback cannot bypass the explicit fences.
    expect(old?.isCurrent()).toBe(false);
    expect(selection.capture()).toBeNull();
    selection.dispose();
  });

  it('aborts a detached capture and unregisters its listener on repeated disposal', () => {
    // Given: a selected session whose target can detach.
    const fixtureState = fixture();
    const selection = createSelectionScope({ client: fixtureState.client, profileId });
    const old = selection.select(session);
    // When: the target detaches and the view subsequently disposes twice.
    fixtureState.detach(); selection.dispose(); selection.dispose();
    // Then: stale callers cannot resume and no listener remains owned.
    expect(old?.signal.aborted).toBe(true);
    expect(selection.capture()).toBeNull();
    expect(fixtureState.listeners.size).toBe(0);
    expect(() => selection.select(session)).toThrow();
  });

  it('keeps profiles isolated and copies the session identity at selection time', () => {
    // Given: two authenticated profiles viewing the same qualified native session.
    const fixtureState = fixture();
    const first = createSelectionScope({ client: fixtureState.client, profileId });
    const second = createSelectionScope({ client: fixtureState.client, profileId: parseConnectionProfileId('55555555-5555-4555-8555-555555555555') });
    const input = { ...session };
    const captured = first.select(input);
    second.select(session);
    // When: an outside object is edited after selection.
    input.nativeSessionId = 'changed';
    // Then: neither object mutation nor another profile makes that capture current there.
    expect(captured?.selection.session.nativeSessionId).toBe('same');
    if (!captured) throw new TypeError('fixture selection failed');
    expect(second.isCurrent(captured)).toBe(false);
    expect(first.isCurrent(captured)).toBe(true);
    first.dispose(); second.dispose();
  });
});
