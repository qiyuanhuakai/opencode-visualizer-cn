import { describe, expect, it, vi } from 'vitest';

import type { ProjectInfo, SessionInfo } from '../types/sse';
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

  it('replays a child status event received before its project is known', () => {
    const builder = createStateBuilder();

    expect(builder.processSessionStatus('child', 'busy')).toBeNull();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.processSessionCreated({
      id: 'child',
      projectID: 'p1',
      parentID: 'root',
      title: 'Background child',
      slug: 'background-child',
      directory: '/repo',
      version: '1',
      time: { created: 1, updated: 1 },
    } satisfies SessionInfo);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.child?.status).toBe('busy');
  });

  it('replays a busy status snapshot when the child hydrates later', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);

    builder.applyStatusSnapshot(['child'], { child: { type: 'busy' } });
    builder.processSessionCreated({
      id: 'child',
      projectID: 'p1',
      parentID: 'root',
      title: 'Hydrated child',
      slug: 'hydrated-child',
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

  it('applies a 2,001-session empty status snapshot without overflowing its live fences', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const sessions = Array.from(
      { length: 2_001 },
      (_, index) =>
        ({
          id: `snapshot-${index}`,
          projectID: 'p1',
          title: `Snapshot ${index}`,
          slug: `snapshot-${index}`,
          directory: '/repo',
          version: '1',
          time: { created: 1, updated: 1 },
        }) satisfies SessionInfo,
    );
    builder.applySessions(sessions);
    builder.applyStatuses(
      Object.fromEntries(sessions.map((session) => [session.id, { type: 'busy' } as const])),
    );

    const snapshot = builder.beginStatusSnapshot();
    builder.applyStatusSnapshot(
      sessions.map((session) => session.id),
      {},
      snapshot,
    );

    expect(builder.consumeSnapshotOverflow()).toBe(false);
    expect(
      builder.getState().projects.p1.sandboxes['/repo'].sessions['snapshot-0']?.status,
    ).toBeUndefined();
    expect(
      builder.getState().projects.p1.sandboxes['/repo'].sessions['snapshot-2000']?.status,
    ).toBeUndefined();
    builder.completeStatusSnapshot(snapshot);
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
    const olderRevision = builder.beginStatusSnapshot();

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
    const olderRevision = builder.beginStatusSnapshot();

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
    const snapshotRevision = builder.beginStatusSnapshot();

    builder.processSessionStatus('root', 'busy', 'p1');
    builder.applyStatusSnapshot(['root'], {}, snapshotRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root?.status).toBe('busy');
  });

  it('retains deletion fences until an in-flight session snapshot finishes', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const snapshotRevision = builder.beginMutationSnapshot();

    builder.processSessionDeleted('victim', 'p1');
    for (let index = 0; index < 10_001; index += 1) {
      builder.processSessionDeleted(`other-${index}`, 'p1');
    }
    builder.applySessionSnapshot(
      [
        {
          id: 'victim',
          projectID: 'p1',
          title: 'Victim',
          slug: 'victim',
          directory: '/repo',
          version: '1',
          time: { created: 1, updated: 1 },
        },
      ],
      snapshotRevision,
    );

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.victim).toBeUndefined();
    builder.completeMutationSnapshot(snapshotRevision);
  });

  it('retains SSE status fences until an in-flight status snapshot finishes', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    builder.applySessions([
      {
        id: 'victim',
        projectID: 'p1',
        title: 'Victim',
        slug: 'victim',
        directory: '/repo',
        version: '1',
        time: { created: 1, updated: 1 },
      },
    ]);
    const snapshotRevision = builder.beginStatusSnapshot();

    builder.processSessionStatus('victim', 'busy', 'p1');
    for (let index = 0; index < 10_001; index += 1) {
      builder.processSessionStatus(`other-${index}`, 'busy', 'p1');
    }
    builder.applyStatusSnapshot(['victim'], { victim: { type: 'idle' } }, snapshotRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.victim?.status).toBe('busy');
    builder.completeStatusSnapshot(snapshotRevision);
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
    const snapshotRevision = builder.beginMutationSnapshot();

    builder.processSessionDeleted('root', 'p1');
    builder.applySessionSnapshot([session], snapshotRevision);

    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.root).toBeUndefined();
  });

  it('materializes a session snapshot after an earlier status-only event', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const snapshotRevision = builder.beginMutationSnapshot();

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

  it('rejects reserved project and session record keys', () => {
    const builder = createStateBuilder();
    const reservedKeys = Object.getOwnPropertyNames(Object.prototype).flatMap((key) => [
      key,
      ` ${key} `,
    ]);

    for (const id of reservedKeys) {
      expect(
        builder.processProjectUpdated({
          id,
          worktree: '/repo',
          time: { created: 1, updated: 1 },
          sandboxes: [],
        } satisfies ProjectInfo),
      ).toBeNull();
      expect(Object.prototype.hasOwnProperty.call(builder.getState().projects, id)).toBe(false);
    }

    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    for (const id of reservedKeys) {
      expect(
        builder.processSessionCreated({
          id,
          projectID: 'p1',
          title: id,
          slug: id,
          directory: '/repo',
          version: '1',
          time: { created: 1, updated: 1 },
        } satisfies SessionInfo),
      ).toBeNull();
      expect(
        Object.prototype.hasOwnProperty.call(
          builder.getState().projects.p1.sandboxes['/repo']?.sessions,
          id,
        ),
      ).toBe(false);
    }
  });

  it('rejects every Object.prototype key across project, session, and directory ingress', () => {
    const objectPrototypeKeys = Object.getOwnPropertyNames(Object.prototype);
    const originalPrototypeKeys = [...objectPrototypeKeys];

    for (const key of objectPrototypeKeys) {
      for (const candidate of [key, ` ${key} `]) {
        const builder = createStateBuilder();
        builder.applyProjects([
          {
            id: 'p1',
            worktree: '/repo',
            sandboxes: [],
            time: { created: 1, updated: 1 },
          },
        ]);
        builder.processSessionCreated({
          id: 'root',
          projectID: 'p1',
          title: 'Root',
          slug: 'root',
          directory: '/repo',
          version: '1',
          time: { created: 1, updated: 1 },
        } satisfies SessionInfo);
        const baseline = JSON.stringify(builder.getState());

        expect(() =>
          builder.processProjectUpdated({
            id: candidate,
            worktree: '/repo',
            sandboxes: [],
            time: { created: 1, updated: 1 },
          } satisfies ProjectInfo),
        ).not.toThrow();
        expect(() =>
          builder.processProjectUpdated({
            id: 'p1',
            worktree: '/repo',
            sandboxes: [candidate],
            time: { created: 1, updated: 1 },
          } satisfies ProjectInfo),
        ).not.toThrow();
        expect(() =>
          builder.processSessionCreated({
            id: candidate,
            projectID: 'p1',
            title: candidate,
            slug: candidate,
            directory: '/repo',
            version: '1',
            time: { created: 1, updated: 1 },
          } satisfies SessionInfo),
        ).not.toThrow();
        expect(() =>
          builder.processSessionCreated({
            id: `session-${key}`,
            projectID: 'p1',
            title: candidate,
            slug: candidate,
            directory: candidate,
            version: '1',
            time: { created: 1, updated: 1 },
          } satisfies SessionInfo),
        ).not.toThrow();
        expect(builder.registerSandboxDirectory('p1', candidate)).toBeNull();
        expect(builder.removeSandboxDirectory('p1', candidate)).toBeNull();
        expect(JSON.stringify(builder.getState())).toBe(baseline);
        expect(Object.getOwnPropertyNames(Object.prototype)).toEqual(originalPrototypeKeys);
        expect(Object.getPrototypeOf(builder.getState().projects)).toBe(Object.prototype);
        expect(Object.getPrototypeOf(builder.getState().projects.p1?.sandboxes)).toBe(
          Object.prototype,
        );
        expect(
          Object.getPrototypeOf(builder.getState().projects.p1?.sandboxes['/repo']?.sessions),
        ).toBe(Object.prototype);
      }
    }
  });

  it('rejects unsafe normalized sandbox directory keys without touching prototypes', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);

    expect(() =>
      builder.processSessionCreated({
        id: 'constructor-session',
        projectID: 'p1',
        title: 'Constructor directory',
        slug: 'constructor-directory',
        directory: 'constructor',
        version: '1',
        time: { created: 1, updated: 1 },
      } satisfies SessionInfo),
    ).not.toThrow();

    for (const directory of ['__proto__', 'constructor', 'prototype', ' __proto__ ']) {
      expect(() =>
        builder.processProjectUpdated({
          id: `project-${directory.trim().replaceAll('_', 'u')}`,
          worktree: '/repo',
          sandboxes: [directory],
          time: { created: 1, updated: 1 },
        } satisfies ProjectInfo),
      ).not.toThrow();
      expect(builder.registerSandboxDirectory('p1', directory)).toBeNull();
      expect(builder.removeSandboxDirectory('p1', directory)).toBeNull();
      expect(
        builder.processSessionCreated({
          id: `session-${directory.trim().replaceAll('_', 'u')}`,
          projectID: 'p1',
          title: directory,
          slug: directory,
          directory,
          version: '1',
          time: { created: 1, updated: 1 },
        } satisfies SessionInfo),
      ).toBeNull();
    }

    const sandboxes = builder.getState().projects.p1?.sandboxes;
    expect(Object.prototype.hasOwnProperty.call(sandboxes, '__proto__')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sandboxes, 'constructor')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(sandboxes, 'prototype')).toBe(false);
    expect(Object.prototype.hasOwnProperty.call(Object.prototype, 'sessions')).toBe(false);
  });

  it('invalidates active snapshots instead of evicting their status fences', () => {
    const builder = createStateBuilder();
    builder.applyProjects([
      { id: 'p1', worktree: '/repo', sandboxes: [], time: { created: 1, updated: 1 } },
    ]);
    const snapshotRevision = builder.beginStatusSnapshot();

    builder.processSessionStatus('victim', 'busy', 'p1');
    for (let index = 0; index < 2_000; index += 1) {
      builder.processSessionStatus(`other-${index}`, 'busy', 'p1');
    }
    builder.applyStatusSnapshot(
      ['victim'],
      { victim: { type: 'idle' } },
      snapshotRevision,
    );
    builder.processSessionCreated({
      id: 'victim',
      projectID: 'p1',
      parentID: 'root',
      title: 'Victim',
      slug: 'victim',
      directory: '/repo',
      version: '1',
      time: { created: 1, updated: 1 },
    } satisfies SessionInfo);

    expect(builder.consumeSnapshotOverflow()).toBe(true);
    expect(builder.consumeSnapshotOverflow()).toBe(false);
    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.victim?.status).toBeUndefined();
    builder.completeStatusSnapshot(snapshotRevision);

    const freshSnapshot = builder.beginStatusSnapshot();
    builder.applyStatusSnapshot(['victim'], { victim: { type: 'busy' } }, freshSnapshot);
    expect(builder.getState().projects.p1.sandboxes['/repo'].sessions.victim?.status).toBe('busy');
    builder.completeStatusSnapshot(freshSnapshot);
  });
});
