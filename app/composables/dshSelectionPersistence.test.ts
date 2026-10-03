import { beforeEach, describe, expect, it } from 'vitest';
import { mapDshSessionItem, mapDshSessionsToProjects } from '../backends/dsh/dshAdapter';
import { createDshSelectionPersistence, resolveDshSelection } from './dshSelectionPersistence';

const BRIDGE_A = 'ws://localhost:23004/dsh/ws';
const BRIDGE_B = 'ws://localhost:23005/dsh/ws';

function projects(workspaceId = 'workspace') {
  return mapDshSessionsToProjects([
    mapDshSessionItem({ sessionId: 'first', workspaceId, cwd: '/repo' }),
    mapDshSessionItem({ sessionId: 'selected', workspaceId, cwd: '/repo' }),
    mapDshSessionItem({ sessionId: 'archived', workspaceId, cwd: '/repo' }, { archived: true }),
  ]);
}

beforeEach(() => window.localStorage.clear());

describe('DSH selection persistence', () => {
  it('restores the latest selection after a fresh client is constructed', () => {
    // Given: a committed baseline and a subsequent user selection.
    const original = createDshSelectionPersistence();
    original.commit(BRIDGE_A, projects(), 'first');
    original.persist(BRIDGE_A, projects(), 'selected');
    // When: the page creates a fresh persistence instance.
    const refreshed = createDshSelectionPersistence();
    // Then: the exact selected session is preferred, independent of list order.
    expect(refreshed.preferredSessionId(BRIDGE_A)).toBe('selected');
  });

  it('resolves the current project by session identity after a project moves', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit(BRIDGE_A, projects('old-project'), 'selected');
    const refreshed = createDshSelectionPersistence();
    const restored = refreshed.commit(BRIDGE_A, projects('new-project'), refreshed.preferredSessionId(BRIDGE_A));
    expect(restored).toEqual({ projectId: 'new-project', sessionId: 'selected' });
  });

  it('keeps two bridge selections isolated and rejects pre-bootstrap writes', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit(BRIDGE_A, projects(), 'selected');
    // When: credentials switch before the second baseline is committed.
    persistence.persist(BRIDGE_B, projects(), 'selected');
    expect(persistence.preferredSessionId(BRIDGE_B)).toBe('');
    persistence.commit(BRIDGE_B, projects(), 'first');
    expect(persistence.preferredSessionId(BRIDGE_A)).toBe('selected');
    expect(persistence.preferredSessionId(BRIDGE_B)).toBe('first');
  });

  it('preserves the last selection while disconnect clears local state', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit(BRIDGE_A, projects(), 'selected');
    persistence.reset();
    persistence.persist(BRIDGE_A, projects(), 'first');
    expect(persistence.preferredSessionId(BRIDGE_A)).toBe('selected');
  });

  it('does not accept missing or archived sessions from a fresh baseline', () => {
    expect(resolveDshSelection(projects(), 'missing')).toBeUndefined();
    expect(resolveDshSelection(projects(), '__proto__')).toBeUndefined();
    expect(resolveDshSelection(projects(), 'archived')).toBeUndefined();
  });

  it('replaces a stale saved session with the baseline fallback', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit(BRIDGE_A, projects(), 'selected');
    const fresh = createDshSelectionPersistence();
    fresh.commit(BRIDGE_A, projects(), 'first');
    expect(fresh.preferredSessionId(BRIDGE_A)).toBe('first');
  });

  it('honors explicit deep links over stored selection', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit(BRIDGE_A, projects(), 'selected');
    expect(persistence.preferredSessionId(BRIDGE_A, 'first')).toBe('first');
  });

  it('does not store credentials in the connection identity', () => {
    const persistence = createDshSelectionPersistence();
    persistence.commit('ws://user:secret@localhost:23004/dsh/ws?token=secret#fragment', projects(), 'selected');
    expect(persistence.preferredSessionId(BRIDGE_A)).toBe('selected');
    expect(Object.keys(window.localStorage).join(' ')).not.toContain('secret');
  });
});
