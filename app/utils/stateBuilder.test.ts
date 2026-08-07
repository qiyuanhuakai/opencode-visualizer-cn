import { describe, expect, it, vi } from 'vitest';

import type { SessionInfo } from '../types/sse';
import { createStateBuilder } from './stateBuilder';

describe('createStateBuilder regression', () => {
  it('preserves pinned and archived timestamps on partial session update', () => {
    const builder = createStateBuilder();

    builder.processSessionUpdated({
      id: 's1',
      projectID: 'p1',
      title: 'Test',
      slug: 'test',
      directory: '/',
      version: '1',
      time: { created: 1, updated: 1, pinned: 1000, archived: 2000 },
    } as SessionInfo);

    builder.processSessionUpdated({
      id: 's1',
      projectID: 'p1',
      time: { updated: 2 },
    } as SessionInfo);

    const session = builder.getState().projects.p1.sandboxes['/'].sessions.s1;

    expect(session.timePinned).toBe(1000);
    expect(session.timeArchived).toBe(2000);
  });

  it('removes a sandbox directory and clears its indexes', () => {
    const builder = createStateBuilder();

    builder.applyProjects([
      {
        id: 'p1',
        worktree: '/repo',
        sandboxes: ['/repo/feature'],
      },
    ] as any);

    builder.processSessionUpdated({
      id: 's1',
      projectID: 'p1',
      title: 'Feature work',
      slug: 'feature-work',
      directory: '/repo/feature',
      version: '1',
      time: { created: 1, updated: 2 },
    } as SessionInfo);

    expect(builder.resolveProjectIdForDirectory('/repo/feature')).toBe('p1');

    const changed = builder.removeSandboxDirectory('p1', '/repo/feature');

    expect(changed).toBe('p1');
    expect(builder.getState().projects.p1.sandboxes['/repo/feature']).toBeUndefined();
    expect(builder.resolveProjectIdForDirectory('/repo/feature')).toBe('');
  });

  it('keeps explicitly hydrated child metadata until the server deletes it', () => {
    const builder = createStateBuilder();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const applyAuthoritativeSessions = Reflect.get(builder, 'applyAuthoritativeSessions');

    expect(typeof applyAuthoritativeSessions).toBe('function');
    if (typeof applyAuthoritativeSessions !== 'function') return;
    applyAuthoritativeSessions([
      {
        id: 'child',
        projectID: 'p1',
        parentID: 'root',
        title: 'Persistent child',
        slug: 'persistent-child',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      } satisfies SessionInfo,
    ]);

    now.mockReturnValue(20 * 60 * 1000 + 2);
    builder.applyStatuses({ child: { type: 'idle' } });
    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.child?.title).toBe(
      'Persistent child',
    );

    builder.processSessionDeleted('child', 'p1');
    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.child).toBeUndefined();
    now.mockRestore();
  });

  it('keeps a child announced by session.created after the ephemeral TTL', () => {
    const builder = createStateBuilder();
    const now = vi.spyOn(Date, 'now').mockReturnValue(1);
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);

    builder.processSessionCreated({
      id: 'child',
      projectID: 'p1',
      parentID: 'root',
      title: 'Live child',
      slug: 'live-child',
      directory: '/repo',
      version: '1',
      time: { created: 1, updated: 1 },
    });
    now.mockReturnValue(20 * 60 * 1000 + 2);
    builder.applyStatuses({ child: { type: 'idle' } });

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.child?.title).toBe(
      'Live child',
    );
    now.mockRestore();
  });

  it('replays a status event that arrives before session creation', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);

    expect(builder.processSessionStatus('child', 'busy', 'p1')).toBeNull();
    builder.processSessionCreated({
      id: 'child',
      projectID: 'p1',
      parentID: 'root',
      title: 'Running child',
      slug: 'running-child',
      directory: '/repo',
      version: '1',
      time: { created: 1, updated: 1 },
    } satisfies SessionInfo);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.child?.status).toBe('busy');
  });

  it('keeps sessions omitted from a sparse status snapshot unknown', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'root',
        projectID: 'p1',
        title: 'Root',
        slug: 'root',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);

    builder.applyStatusSnapshot(['root'], {});

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBeUndefined();
  });

  it('clears an older busy status when an authoritative snapshot omits the session', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'root',
        projectID: 'p1',
        title: 'Root',
        slug: 'root',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    builder.applyStatuses({ root: { type: 'busy' } });

    builder.applyStatusSnapshot(['root'], {});

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBeUndefined();
  });

  it('does not let an older omitted snapshot clear a newer snapshot status', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'root',
        projectID: 'p1',
        title: 'Root',
        slug: 'root',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    const olderRevision = builder.getStatusRevision();

    builder.applyStatusSnapshot(['root'], { root: { type: 'busy' } }, olderRevision);
    builder.applyStatusSnapshot(['root'], {}, olderRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBe('busy');
  });

  it('does not let an older busy snapshot overwrite a newer omitted snapshot', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'root',
        projectID: 'p1',
        title: 'Root',
        slug: 'root',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    const olderRevision = builder.getStatusRevision();

    builder.applyStatusSnapshot(['root'], {}, olderRevision);
    builder.applyStatusSnapshot(['root'], { root: { type: 'busy' } }, olderRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBeUndefined();
  });

  it('does not let an older status snapshot overwrite a newer SSE status', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'root',
        projectID: 'p1',
        title: 'Root',
        slug: 'root',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    const snapshotRevision = builder.getStatusRevision();

    builder.processSessionStatus('root', 'busy', 'p1');
    builder.applyStatusSnapshot(['root'], {}, snapshotRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBe('busy');
  });

  it('does not let an older directory snapshot resurrect a deleted session', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const session: SessionInfo = {
      id: 'root',
      projectID: 'p1',
      title: 'Root',
      slug: 'root',
      directory: '/repo',
      version: '1',
      time: { created: 1, updated: 1 },
    };
    builder.applySessions([session]);
    const snapshotRevision = builder.getMutationRevision();

    builder.processSessionDeleted('root', 'p1');
    builder.applySessionSnapshot([session], snapshotRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root).toBeUndefined();
  });

  it('materializes a session snapshot after an earlier status-only event', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const snapshotRevision = builder.getMutationRevision();

    builder.processSessionStatus('root', 'busy', 'p1');
    builder.applySessionSnapshot(
      [
        {
          id: 'root',
          projectID: 'p1',
          title: 'Root',
          slug: 'root',
          directory: '/repo',
          version: '1',
          time: { created: 1, updated: 1 },
        },
      ],
      snapshotRevision,
    );

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBe('busy');
  });
});
