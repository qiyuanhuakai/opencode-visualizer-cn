import { describe, expect, it, vi } from 'vitest';
import { ref } from 'vue';
import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import { useSessionSelection } from './useSessionSelection';

function makeSession(id: string, overrides: Partial<SessionState> = {}): SessionState {
  return { id, ...overrides };
}

function makeSandbox(directory: string, sessions: SessionState[]): SandboxState {
  const sessionsById: Record<string, SessionState> = {};
  const rootSessions: string[] = [];
  for (const session of sessions) {
    sessionsById[session.id] = session;
    if (!session.parentID) rootSessions.push(session.id);
  }
  return { directory, name: 'main', rootSessions, sessions: sessionsById };
}

function makeProject(
  id: string,
  worktree: string,
  sandboxes: Record<string, SandboxState>,
): ProjectState {
  return { id, worktree, sandboxes };
}

function deferred() {
  let resolve: () => void = () => {};
  let reject: (reason?: unknown) => void = () => {};
  const promise = new Promise<void>((res, rej) => {
    resolve = res;
    reject = rej;
  });
  return { promise, resolve, reject };
}

async function flushMicrotasks(rounds = 10): Promise<void> {
  for (let i = 0; i < rounds; i += 1) {
    await Promise.resolve();
  }
}

describe('useSessionSelection', () => {
  describe('ensureDirectorySession', () => {
    it('waits for pending hydration before selecting or creating', async () => {
      // Given: a project whose directory has no sessions in the reactive map yet
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', []),
        }),
      });
      const gate = deferred();
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {
        await gate.promise;
        // Hydration populates the reactive map with a session in /dir
        projects.value = {
          p1: makeProject('p1', '/work', {
            '/work': makeSandbox('/work', []),
            '/dir': makeSandbox('/dir', [
              makeSession('s-hydrated', { timeUpdated: 42 }),
            ]),
          }),
        };
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated,
      });

      // When: ensureDirectorySession is called while hydration is pending
      const pending = selection.ensureDirectorySession('p1', '/dir');
      await flushMicrotasks();

      // Then: nothing is selected and nothing is created before hydration resolves
      expect(ensureDirectoryHydrated).toHaveBeenCalledWith('/dir');
      expect(createSessionFn).not.toHaveBeenCalled();
      expect(selection.selectedSessionId.value).toBe('');

      // When: hydration completes
      gate.resolve();
      const sessionId = await pending;

      // Then: the hydrated session is selected with zero creates
      expect(sessionId).toBe('s-hydrated');
      expect(selection.selectedProjectId.value).toBe('p1');
      expect(selection.selectedSessionId.value).toBe('s-hydrated');
      expect(createSessionFn).not.toHaveBeenCalled();
    });

    it('creates exactly one session in the requested directory when loaded-empty', async () => {
      // Given: hydration succeeds but the directory remains empty
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', [
            makeSession('s-other', { timeUpdated: 100 }),
          ]),
        }),
      });
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {});
      const createSessionFn = vi.fn(async (projectId: string, _directory?: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated,
      });

      // When: ensuring a session for an empty directory
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');

      // Then: hydration ran once, then exactly one create in the requested directory
      expect(ensureDirectoryHydrated).toHaveBeenCalledTimes(1);
      expect(ensureDirectoryHydrated).toHaveBeenCalledWith('/dir');
      expect(createSessionFn).toHaveBeenCalledTimes(1);
      expect(createSessionFn).toHaveBeenCalledWith('p1', '/dir');
      expect(sessionId).toBe('created-1');
      expect(selection.selectedProjectId.value).toBe('p1');
      expect(selection.selectedSessionId.value).toBe('created-1');
    });

    it('propagates hydration rejection and never creates', async () => {
      // Given: a directory that looks empty and hydration that fails
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', []),
        }),
      });
      const failure = new Error('hydration failed');
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {
        throw failure;
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated,
      });

      // When / Then: the rejection propagates as-is and create count is exactly 0
      await expect(selection.ensureDirectorySession('p1', '/dir')).rejects.toBe(failure);
      expect(createSessionFn).not.toHaveBeenCalled();
      expect(selection.selectedSessionId.value).toBe('');
    });

    it('selects an existing eligible root session with zero creates and no hydration', async () => {
      // Given: a loaded directory with a root session and a newer child session
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/dir': makeSandbox('/dir', [
            makeSession('s-root', { timeUpdated: 50 }),
            makeSession('s-child', { parentID: 's-root', timeUpdated: 999 }),
          ]),
        }),
      });
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {});
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated,
      });

      // When: ensuring a session for that directory
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');

      // Then: the root session is selected; child sessions are not eligible
      expect(sessionId).toBe('s-root');
      expect(createSessionFn).not.toHaveBeenCalled();
      expect(ensureDirectoryHydrated).not.toHaveBeenCalled();
      expect(selection.selectedProjectId.value).toBe('p1');
      expect(selection.selectedSessionId.value).toBe('s-root');
    });

    it('ignores archived root sessions and creates after hydration confirms empty', async () => {
      // Given: a directory whose only root session is archived
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/dir': makeSandbox('/dir', [
            makeSession('s-archived', { timeUpdated: 500, timeArchived: 600 }),
          ]),
        }),
      });
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {});
      const createSessionFn = vi.fn(async (projectId: string, _directory?: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated,
      });

      // When: ensuring a session for that directory
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');

      // Then: the archived session is ignored and exactly one session is created
      expect(sessionId).toBe('created-1');
      expect(ensureDirectoryHydrated).toHaveBeenCalledTimes(1);
      expect(createSessionFn).toHaveBeenCalledTimes(1);
      expect(createSessionFn).toHaveBeenCalledWith('p1', '/dir');
    });

    it('prefers pinned sessions over newer unpinned sessions', async () => {
      // Given: a directory with an unpinned newer session and a pinned older one
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/dir': makeSandbox('/dir', [
            makeSession('s-new', { timeUpdated: 300 }),
            makeSession('s-pinned', { timePinned: 10, timeUpdated: 100 }),
            makeSession('s-mid', { timeUpdated: 200 }),
          ]),
        }),
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated: async () => {},
      });

      // When / Then: pinned wins regardless of recency
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');
      expect(sessionId).toBe('s-pinned');
      expect(createSessionFn).not.toHaveBeenCalled();
    });

    it('orders unpinned sessions by timeUpdated then timeCreated descending', async () => {
      // Given: unpinned sessions where the most recent has only timeCreated
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/dir': makeSandbox('/dir', [
            makeSession('s-old', { timeUpdated: 100, timeCreated: 50 }),
            makeSession('s-new', { timeCreated: 400 }),
            makeSession('s-mid', { timeUpdated: 200, timeCreated: 60 }),
          ]),
        }),
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureDirectoryHydrated: async () => {},
      });

      // When / Then: timeUpdated ?? timeCreated decides, descending
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');
      expect(sessionId).toBe('s-new');
      expect(createSessionFn).not.toHaveBeenCalled();
    });

    it('hydrates a missing project before reading its session list', async () => {
      // Given: the project is not in the reactive map at all
      const projects = ref<Record<string, ProjectState>>({});
      const ensureProjectHydrated = vi.fn(async (_projectId: string) => {
        projects.value = {
          p1: makeProject('p1', '/work', {
            '/dir': makeSandbox('/dir', [
              makeSession('s-1', { timeUpdated: 10 }),
            ]),
          }),
        };
      });
      const ensureDirectoryHydrated = vi.fn(async (_directory: string) => {});
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureProjectHydrated,
        ensureDirectoryHydrated,
      });

      // When: ensuring a session for the missing project
      const sessionId = await selection.ensureDirectorySession('p1', '/dir');

      // Then: project hydration ran first and the re-read map provided the session
      expect(ensureProjectHydrated).toHaveBeenCalledWith('p1');
      expect(sessionId).toBe('s-1');
      expect(createSessionFn).not.toHaveBeenCalled();
    });

    it('propagates project hydration rejection with zero creates', async () => {
      // Given: the project is missing and project hydration fails
      const projects = ref<Record<string, ProjectState>>({});
      const failure = new Error('project hydration failed');
      const ensureProjectHydrated = vi.fn(async (_projectId: string) => {
        throw failure;
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureProjectHydrated,
      });

      // When / Then: the rejection propagates as-is and nothing is created
      await expect(selection.ensureDirectorySession('p1', '/dir')).rejects.toBe(failure);
      expect(createSessionFn).not.toHaveBeenCalled();
      expect(selection.selectedSessionId.value).toBe('');
    });
  });

  describe('legacy ensureSession without hydration options', () => {
    it('keeps the original create flow when no options are injected', async () => {
      // Given: a project with no sessions and no hydration functions injected
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', []),
        }),
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-legacy',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn);

      // When: ensuring a session
      const sessionId = await selection.ensureSession('p1');

      // Then: the legacy single-argument create flow still runs
      expect(sessionId).toBe('created-legacy');
      expect(createSessionFn).toHaveBeenCalledTimes(1);
      expect(createSessionFn).toHaveBeenCalledWith('p1');
      expect(selection.selectedProjectId.value).toBe('p1');
      expect(selection.selectedSessionId.value).toBe('created-legacy');
    });

    it('still selects the first existing session without creating', async () => {
      // Given: a project with an existing root session
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', [
            makeSession('s-existing', { timeUpdated: 5 }),
          ]),
        }),
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-legacy',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn);

      // When / Then: the existing session is selected, zero creates
      const sessionId = await selection.ensureSession('p1');
      expect(sessionId).toBe('s-existing');
      expect(createSessionFn).not.toHaveBeenCalled();
    });

    it('re-reads the map after project hydration before creating', async () => {
      // Given: an empty project whose hydration populates a session
      const projects = ref<Record<string, ProjectState>>({
        p1: makeProject('p1', '/work', {
          '/work': makeSandbox('/work', []),
        }),
      });
      const ensureProjectHydrated = vi.fn(async (_projectId: string) => {
        projects.value = {
          p1: makeProject('p1', '/work', {
            '/work': makeSandbox('/work', [
              makeSession('s-late', { timeUpdated: 7 }),
            ]),
          }),
        };
      });
      const createSessionFn = vi.fn(async (projectId: string) => ({
        id: 'created-1',
        projectId,
      }));
      const selection = useSessionSelection(projects, createSessionFn, undefined, {
        ensureProjectHydrated,
      });

      // When: ensuring a session
      const sessionId = await selection.ensureSession('p1');

      // Then: the hydrated session wins and nothing is created
      expect(sessionId).toBe('s-late');
      expect(ensureProjectHydrated).toHaveBeenCalledWith('p1');
      expect(createSessionFn).not.toHaveBeenCalled();
    });
  });
});
