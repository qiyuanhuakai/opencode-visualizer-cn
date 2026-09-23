import { describe, expect, it } from 'vitest';
import { createKimiWebNormalizer } from '../backends/kimiWeb/normalize';
import type { ProjectState } from '../types/worker-state';
import { applyKimiWebSessionEvent } from './kimiWebSessionEvents';

function apply(
  projects: Record<string, ProjectState>,
  type: string,
  payload: Record<string, unknown>,
) {
  const result = createKimiWebNormalizer().ingest({ type, session_id: '__global__', payload });
  for (const op of result.ops) {
    if (op.kind === 'session') applyKimiWebSessionEvent(projects, op);
  }
}

describe('Kimi lifecycle events', () => {
  it('keeps a newly created untouched session hollow until work completes', () => {
    const projects: Record<string, ProjectState> = {};
    apply(projects, 'event.session.created', { session: {
      id: 'new', workspace_id: 'workspace', title: 'New', metadata: { cwd: '/repo' }, busy: false, archived: false,
    } });
    const entry = projects.workspace.sandboxes['/repo'].sessions.new;
    expect(entry.status).toBe('unknown');
    apply(projects, 'event.session.status_changed', { sessionId: 'new', status: 'idle' });
    expect(entry.status).toBe('unknown');
    apply(projects, 'event.session.work_changed', { sessionId: 'new', busy: true });
    expect(entry.status).toBe('busy');
    apply(projects, 'event.session.work_changed', { sessionId: 'new', busy: false, last_turn_reason: 'completed' });
    expect(entry.status).toBe('idle');
  });
  it('applies other-client create, rename, archive, restore snapshot and delete to one tree owner', () => {
    // Given
    const projects: Record<string, ProjectState> = {};
    const session = {
      id: 'external',
      workspace_id: 'workspace',
      title: 'External',
      metadata: { cwd: '/repo' },
      busy: true,
      archived: false,
    };
    // When
    apply(projects, 'event.session.created', { session });
    apply(projects, 'session.meta.updated', { sessionId: 'external', title: 'Renamed' });
    // Then
    expect(projects.workspace.sandboxes['/repo'].sessions.external).toMatchObject({
      title: 'Renamed',
      status: 'busy',
    });
    apply(projects, 'event.session.archived', { sessionId: 'external', workspace_id: 'workspace' });
    expect(projects.workspace.sandboxes['/repo'].sessions.external.timeArchived).toBeGreaterThan(0);
    apply(projects, 'event.session.created', {
      session: { ...session, title: 'Renamed', archived: false },
    });
    expect(projects.workspace.sandboxes['/repo'].sessions.external.timeArchived).toBeUndefined();
    apply(projects, 'event.session.deleted', { sessionId: 'external', workspace_id: 'workspace' });
    expect(projects.workspace.sandboxes['/repo'].sessions.external).toBeUndefined();
    expect(projects.workspace.sandboxes['/repo'].rootSessions).toEqual([]);
  });
});
