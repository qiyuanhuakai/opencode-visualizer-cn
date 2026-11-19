import { describe, expect, it, vi } from 'vitest';
import { parseConnectionProfileId, parseSessionRef } from '../../shared/runtime/identity.js';
import type { CanonicalEntity, ObserverDelivery } from '../../shared/runtime/runtimeWire.js';
import type { RuntimeClient } from './client';
import type { SelectionCapture } from './selectionScope';
import { createInteractionProjection } from './interactionProjection';
const session = parseSessionRef({ environmentId: '11111111-1111-4111-8111-111111111111', harnessInstanceId: '22222222-2222-4222-8222-222222222222', nativeSessionId: 'same' });
function setup(parentOperationId?: string) {
  let current = true;
  const capture = { selection: { profileId: parseConnectionProfileId('33333333-3333-4333-8333-333333333333'), session }, signal: new AbortController().signal, isCurrent: () => current } as SelectionCapture;
  const row: CanonicalEntity = { collection: 'interactions', key: 'interaction:one', revision: 1, value: { kind: 'interaction', scope: { session }, phase: 'pending', ...(parentOperationId ? { parentOperationId } : {}) } };
  const detail = { interactionId: row.key, session, phase: 'pending', payload: { type: 'permission.asked', properties: { permission: 'bash' } } };
  let listener: ((target: typeof session.environmentId, delivery: ObserverDelivery) => void) | undefined;
  const request = vi.fn(async () => detail);
  const client = { request, readIndex: vi.fn(async (_target, _collection, options) => options.onPage('interactions', { items: [row] })), onObserverDelivery(callback: typeof listener) { listener = callback; return () => { listener = undefined; }; } } as unknown as RuntimeClient;
  const show = vi.fn(), remove = vi.fn(), error = vi.fn();
  const projection = createInteractionProjection({ client, capture: () => current ? capture : null, kind: () => 'opencode', show, remove, error });
  return { projection, request, show, remove, error, detail, capture, row, invalidate() { current = false; }, get listener() { return listener; } };
}
describe('captured interaction index projection', () => {
  it('keeps an active permission when another turn ends and removes it when its own parent ends', async () => {
    const fixture = setup('parent');
    await fixture.projection.start(session.environmentId);
    expect(fixture.show).toHaveBeenCalledTimes(1);
    fixture.projection.observeOperation({ collection: 'operations', key: 'other-parent', revision: 2, value: { phase: 'terminal' } });
    expect(fixture.remove).not.toHaveBeenCalled();
    fixture.projection.observeOperation({ collection: 'operations', key: 'parent', revision: 3, value: { phase: 'terminal' } });
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    await fixture.projection.select();
    expect(fixture.show).toHaveBeenCalledTimes(1);
    fixture.projection.dispose();
  });
  it('closes only the permission owned by the terminal turn and blocks a late detail response', async () => {
    const fixture = setup('parent');
    const gate = Promise.withResolvers<typeof fixture.detail>();
    fixture.request.mockImplementationOnce(() => gate.promise);
    const loading = fixture.projection.start(session.environmentId);
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1));
    fixture.projection.observeOperation({ collection: 'operations', key: 'other-parent', revision: 2, value: { phase: 'terminal' } });
    fixture.projection.observeOperation({ collection: 'operations', key: 'parent', revision: 3, value: { phase: 'terminal' } });
    gate.resolve(fixture.detail); await loading;
    expect(fixture.show).not.toHaveBeenCalled();
    fixture.projection.dispose();
  });
  it('loads pending metadata and dismisses dialogs when the captured selection is invalidated', async () => {
    const fixture = setup(); await fixture.projection.start(session.environmentId);
    expect(fixture.show).toHaveBeenCalledTimes(1);
    expect(fixture.request).toHaveBeenCalledWith(session.environmentId, 'runtime.interaction.read', { session, interactionId: fixture.row.key }, expect.objectContaining({ signal: fixture.capture.signal }));
    fixture.invalidate(); await fixture.projection.select();
    expect(fixture.remove).toHaveBeenCalledTimes(1);
    fixture.projection.dispose(); expect(fixture.listener).toBeUndefined();
  });
  it('discards a detail response that arrives after a selection race', async () => {
    const fixture = setup(); const gate = Promise.withResolvers<typeof fixture.detail>();
    fixture.request.mockImplementationOnce(() => gate.promise);
    const loading = fixture.projection.start(session.environmentId);
    await vi.waitFor(() => expect(fixture.request).toHaveBeenCalledTimes(1));
    fixture.invalidate(); await fixture.projection.select(); gate.resolve(fixture.detail); await loading;
    expect(fixture.show).not.toHaveBeenCalled(); fixture.projection.dispose();
  });
});
