import { describe, expect, it } from 'vitest';
import { useServerState } from './useServerState';
import type { WorkerToTabMessage } from '../types/sse-worker';
import type { ProjectState, WorkerNotificationEntry } from '../types/worker-state';

type BootstrapMessage = Extract<WorkerToTabMessage, { type: 'state.bootstrap' }>;

function createProject(id: string): ProjectState {
  return { id, worktree: `/repo/${id}`, sandboxes: {} };
}

function createBootstrap(
  overrides: Partial<BootstrapMessage> = {},
): BootstrapMessage {
  return {
    type: 'state.bootstrap',
    projects: {},
    notifications: {},
    ...overrides,
  };
}

describe('useServerState session hydration', () => {
  it('replaces the whole hydration map on bootstrap', () => {
    // Given: a bootstrapped state whose hydration map has stale entries
    const state = useServerState();
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: { '/repo/a': { status: 'loaded' } },
      }),
    );
    state.handleStateMessage({
      type: 'state.directory-hydration-updated',
      directory: '/repo/stale',
      hydration: { status: 'loading' },
    });

    // When: a new bootstrap arrives with a different hydration map
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: { '/repo/b': { status: 'loading' } },
      }),
    );

    // Then: the map is wholesale-replaced; no stale entries survive
    expect(state.sessionHydrationByDirectory).toEqual({
      '/repo/b': { status: 'loading' },
    });
  });

  it('updates one directory from loading to loaded without touching others', () => {
    // Given: a bootstrap with two unloaded directories
    const state = useServerState();
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: {
          '/repo/a': { status: 'unloaded' },
          '/repo/b': { status: 'unloaded' },
        },
      }),
    );

    // When: directory /repo/a transitions loading then loaded
    const loadingHandled = state.handleStateMessage({
      type: 'state.directory-hydration-updated',
      directory: '/repo/a',
      hydration: { status: 'loading' },
    });
    const loadedHandled = state.handleStateMessage({
      type: 'state.directory-hydration-updated',
      directory: '/repo/a',
      hydration: { status: 'loaded' },
    });

    // Then: only /repo/a changed; /repo/b is still unloaded
    expect(loadingHandled).toBe(true);
    expect(loadedHandled).toBe(true);
    expect(state.sessionHydrationByDirectory['/repo/a']).toEqual({ status: 'loaded' });
    expect(state.sessionHydrationByDirectory['/repo/b']).toEqual({ status: 'unloaded' });
  });

  it('stores the error string when a directory hydration fails', () => {
    // Given: a bootstrapped state
    const state = useServerState();
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: { '/repo/a': { status: 'loading' } },
      }),
    );

    // When: the worker reports a hydration error for /repo/a
    state.handleStateMessage({
      type: 'state.directory-hydration-updated',
      directory: '/repo/a',
      hydration: { status: 'error', error: 'spawn opencode ENOENT' },
    });

    // Then: the entry carries the error status and message
    expect(state.sessionHydrationByDirectory['/repo/a']).toEqual({
      status: 'error',
      error: 'spawn opencode ENOENT',
    });
  });

  it('sets fullTreeHydrated when background hydration completes', () => {
    // Given: a bootstrapped state that has not finished background hydration
    const state = useServerState();
    state.handleStateMessage(createBootstrap());
    expect(state.fullTreeHydrated.value).toBe(false);

    // When: the worker signals background hydration completion
    const handled = state.handleStateMessage({ type: 'state.background-hydration-complete' });

    // Then: the complete flag flips to true
    expect(handled).toBe(true);
    expect(state.fullTreeHydrated.value).toBe(true);
  });

  it('resets the complete flag and replaces the map on a reconnect bootstrap', () => {
    // Given: a state that completed background hydration
    const state = useServerState();
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: { '/repo/a': { status: 'loaded' } },
      }),
    );
    state.handleStateMessage({ type: 'state.background-hydration-complete' });
    expect(state.fullTreeHydrated.value).toBe(true);

    // When: a reconnect bootstrap arrives with a fresh hydration map
    state.handleStateMessage(
      createBootstrap({
        sessionHydrationByDirectory: { '/repo/c': { status: 'loading' } },
      }),
    );

    // Then: the complete flag is reset and the map matches the new bootstrap
    expect(state.fullTreeHydrated.value).toBe(false);
    expect(state.sessionHydrationByDirectory).toEqual({
      '/repo/c': { status: 'loading' },
    });
  });

  it('preserves project and notification state across hydration updates', () => {
    // Given: a bootstrap with project and notification state
    const state = useServerState();
    const project = createProject('p1');
    const notification: WorkerNotificationEntry = {
      projectId: 'p1',
      sessionId: 's1',
      requestIds: ['r1'],
    };
    state.handleStateMessage(
      createBootstrap({
        projects: { p1: project },
        notifications: { n1: notification },
        sessionHydrationByDirectory: { '/repo/a': { status: 'unloaded' } },
      }),
    );

    // When: hydration updates and the completion signal arrive
    state.handleStateMessage({
      type: 'state.directory-hydration-updated',
      directory: '/repo/a',
      hydration: { status: 'loaded' },
    });
    state.handleStateMessage({ type: 'state.background-hydration-complete' });

    // Then: unrelated project/notification/bootstrap state is untouched
    expect(state.projects).toEqual({ p1: project });
    expect(state.notifications).toEqual({ n1: notification });
    expect(state.bootstrapped.value).toBe(true);
    expect(state.fullTreeHydrated.value).toBe(true);
  });
});
