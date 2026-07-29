import { describe, expect, it, vi, type Mock } from 'vitest';
import { reactive, ref, type Ref } from 'vue';
import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import type { DirectorySessionHydration } from '../types/sse-worker';
import type { OpenCodeLastSelection } from '../utils/openCodeSelectionStorage';
import { useOpenCodeSelectionBootstrap } from './useOpenCodeSelectionBootstrap';
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
  directories: string[],
  sessionsByDirectory: Record<string, SessionState[]> = {},
): ProjectState {
  const sandboxes: Record<string, SandboxState> = {};
  for (const directory of directories) {
    sandboxes[directory] = makeSandbox(directory, sessionsByDirectory[directory] ?? []);
  }
  return { id, worktree, sandboxes };
}

type HarnessOptions = {
  projects: Record<string, ProjectState>;
  worktree?: string;
  initialProjectId?: string;
  initialSessionId?: string;
  stored?: OpenCodeLastSelection | null;
  alreadySelectedSessionId?: string;
  // Sessions appended to a directory's sandbox once that directory finishes loading.
  loadEffects?: Record<string, SessionState[]>;
  // Directories whose hydration fails with the given error message.
  loadErrors?: Record<string, string>;
  useRealDirectorySession?: boolean;
};

type EnsureDirectorySessionFn = (projectId: string, directory: string) => Promise<string>;

function createHarness(options: HarnessOptions) {
  const projects = ref<Record<string, ProjectState>>(options.projects);
  const hydration = reactive<Record<string, DirectorySessionHydration>>({});
  // Production invariant (sse-shared-worker): every directory in the topology
  // is pre-seeded with an 'unloaded' hydration entry; a missing entry means
  // the directory is unknown and the worker silently ignores its load.
  for (const project of Object.values(projects.value)) {
    hydration[project.worktree] = { status: 'unloaded' };
    for (const sandbox of Object.values(project.sandboxes)) {
      hydration[sandbox.directory] = { status: 'unloaded' };
    }
  }
  const loadCalls: string[] = [];
  let inFlight = 0;
  let maxInFlight = 0;

  const loadDirectorySessions = vi.fn((directory: string) => {
    if (!hydration[directory]) return;
    loadCalls.push(directory);
    hydration[directory] = { status: 'loading' };
    inFlight += 1;
    if (inFlight > maxInFlight) maxInFlight = inFlight;
    void Promise.resolve().then(() => {
      inFlight -= 1;
      const error = options.loadErrors?.[directory];
      if (error) {
        hydration[directory] = { status: 'error', error };
        return;
      }
      const arrivals = options.loadEffects?.[directory];
      if (arrivals) {
        for (const project of Object.values(projects.value)) {
          const sandbox = Object.values(project.sandboxes).find(
            (entry) => entry.directory === directory,
          );
          if (!sandbox) continue;
          for (const session of arrivals) {
            sandbox.sessions[session.id] = session;
            if (!session.parentID) sandbox.rootSessions.push(session.id);
          }
        }
      }
      hydration[directory] = { status: 'loaded' };
    });
  });

  const createSessionFn = vi.fn(async (projectId: string, _directory?: string) => ({
    id: 'created-1',
    projectId,
  }));
  const clearStoredSelection = vi.fn();

  let selectedProjectId: Ref<string>;
  let selectedSessionId: Ref<string>;
  let ensureDirectorySession: EnsureDirectorySessionFn;
  let ensureDirectorySessionSpy: Mock<EnsureDirectorySessionFn> | null = null;

  if (options.useRealDirectorySession) {
    const selection = useSessionSelection(projects, createSessionFn, undefined, {
      ensureDirectoryHydrated: async () => {},
      ensureProjectHydrated: async () => {},
    });
    selectedProjectId = selection.selectedProjectId;
    selectedSessionId = selection.selectedSessionId;
    ensureDirectorySession = selection.ensureDirectorySession;
  } else {
    selectedProjectId = ref('');
    selectedSessionId = ref(options.alreadySelectedSessionId ?? '');
    ensureDirectorySessionSpy = vi.fn<EnsureDirectorySessionFn>(async (projectId, _directory) => {
      selectedProjectId.value = projectId;
      selectedSessionId.value = 'created-1';
      return 'created-1';
    });
    ensureDirectorySession = ensureDirectorySessionSpy;
  }

  const switchSessionSelection = vi.fn(async (projectId: string, sessionId: string) => {
    selectedProjectId.value = projectId;
    selectedSessionId.value = sessionId;
  });

  const runtime = useOpenCodeSelectionBootstrap({
    projects,
    sessionHydrationByDirectory: () => hydration,
    serverWorktreePath: () => options.worktree ?? '',
    initialProjectId: () => options.initialProjectId ?? '',
    initialSessionId: () => options.initialSessionId ?? '',
    readStoredSelection: () => options.stored ?? null,
    clearStoredSelection,
    loadDirectorySessions,
    selectedProjectId,
    selectedSessionId,
    switchSessionSelection,
    ensureDirectorySession,
    translate: (key: string) => key,
  });

  return {
    projects,
    hydration,
    loadCalls,
    getMaxInFlight: () => maxInFlight,
    loadDirectorySessions,
    createSessionFn,
    clearStoredSelection,
    switchSessionSelection,
    ensureDirectorySessionSpy,
    selectedProjectId,
    selectedSessionId,
    bootstrap: runtime.bootstrapOpenCodeSelection,
  };
}

describe('useOpenCodeSelectionBootstrap', () => {
  it('does nothing when a session is already selected', async () => {
    // Given: an already-selected session and a stored record that would otherwise win
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1']),
      },
      alreadySelectedSessionId: 's-current',
      stored: { projectId: 'proj-1', sessionId: 's-stored', directory: '/p1' },
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: no loads, no switches, no creates
    expect(harness.loadCalls).toEqual([]);
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).not.toHaveBeenCalled();
    expect(harness.createSessionFn).not.toHaveBeenCalled();
    expect(harness.selectedSessionId.value).toBe('s-current');
  });

  it('selects an explicit deep-linked session after hydrating only the target project', async () => {
    // Given: the deep-linked session lives in the second sandbox of proj-1
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      initialProjectId: 'proj-1',
      initialSessionId: 's-deep',
      loadEffects: {
        '/p1/b': [makeSession('s-deep', { timeUpdated: 10 })],
      },
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the session is switched to, hydration stayed scoped to proj-1, zero creates
    expect(harness.switchSessionSelection).toHaveBeenCalledWith('proj-1', 's-deep');
    expect(harness.selectedSessionId.value).toBe('s-deep');
    expect([...harness.loadCalls].sort()).toEqual(['/p1', '/p1/b']);
    expect(harness.loadCalls.some((directory) => directory.startsWith('/p2'))).toBe(false);
    expect(harness.createSessionFn).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).not.toHaveBeenCalled();
  });

  it('selects an explicit session already present without any directory loads', async () => {
    // Given: the deep-linked session is already in the reactive map
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1'], {
          '/p1': [makeSession('s-here', { timeUpdated: 5 })],
        }),
      },
      initialProjectId: 'proj-1',
      initialSessionId: 's-here',
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: no hydration was needed
    expect(harness.loadCalls).toEqual([]);
    expect(harness.switchSessionSelection).toHaveBeenCalledWith('proj-1', 's-here');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('rejects with a translated not-found error and zero creates when the explicit target is missing', async () => {
    // Given: a deep link to a session that no directory of the project contains
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      initialProjectId: 'proj-1',
      initialSessionId: 's-missing',
    });

    // When/Then: bootstrap rejects with the translated not-found error
    await expect(harness.bootstrap()).rejects.toThrow('errors.sessionNotFound');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).not.toHaveBeenCalled();
    expect(harness.loadCalls.some((directory) => directory.startsWith('/p2'))).toBe(false);
  });

  it('propagates a target hydration error with zero creates', async () => {
    // Given: hydration of the recorded directory fails
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
      },
      initialProjectId: 'proj-1',
      initialSessionId: 's-x',
      loadErrors: { '/p1': 'boom' },
    });

    // When/Then: the hydration error propagates and nothing is created
    await expect(harness.bootstrap()).rejects.toThrow('boom');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).not.toHaveBeenCalled();
  });

  it('restores the stored selection from its recorded directory alone', async () => {
    // Given: the stored session appears once the recorded directory is loaded
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
      },
      stored: { projectId: 'proj-1', sessionId: 's-stored', directory: '/p1' },
      loadEffects: {
        '/p1': [makeSession('s-stored', { timeUpdated: 20 })],
      },
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: only the recorded directory was loaded
    expect(harness.loadCalls).toEqual(['/p1']);
    expect(harness.switchSessionSelection).toHaveBeenCalledWith('proj-1', 's-stored');
    expect(harness.clearStoredSelection).not.toHaveBeenCalled();
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('searches the rest of the project at concurrency two when the recorded directory misses', async () => {
    // Given: the stored session only appears in the last of four remaining directories
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b', '/p1/c', '/p1/d', '/p1/e']),
      },
      stored: { projectId: 'proj-1', sessionId: 's-late', directory: '/p1' },
      loadEffects: {
        '/p1/e': [makeSession('s-late', { timeUpdated: 30 })],
      },
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: recorded directory loaded first, the rest pooled two at a time
    expect(harness.loadCalls[0]).toBe('/p1');
    expect(harness.loadCalls).toContain('/p1/e');
    expect(harness.getMaxInFlight()).toBe(2);
    expect(harness.switchSessionSelection).toHaveBeenCalledWith('proj-1', 's-late');
    expect(harness.clearStoredSelection).not.toHaveBeenCalled();
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('clears a stored record whose project is absent from the topology and degrades with zero loads', async () => {
    // Given: the stored record points at a project that no longer exists
    const harness = createHarness({
      projects: {
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      stored: { projectId: 'proj-gone', sessionId: 's-stored', directory: '/gone' },
      worktree: '/p2',
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the stale record is cleared, selection degrades to the current worktree, zero loads
    expect(harness.clearStoredSelection).toHaveBeenCalledTimes(1);
    expect(harness.loadCalls).toEqual([]);
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).toHaveBeenCalledWith('proj-2', '/p2');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('clears a stored record whose directory is unknown and degrades without loading it', async () => {
    // Given: the stored directory is neither hydrated nor part of the project's topology
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
      },
      stored: { projectId: 'proj-1', sessionId: 's-stored', directory: '/p1/unknown' },
      worktree: '/p1',
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the stale record is cleared, selection degrades, the unknown directory never loads
    expect(harness.clearStoredSelection).toHaveBeenCalledTimes(1);
    expect(harness.loadCalls).toEqual([]);
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).toHaveBeenCalledWith('proj-1', '/p1');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('rejects promptly when a topology directory has no hydration entry instead of hanging', async () => {
    // Given: the stored directory is in the topology but its hydration entry is missing
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
      },
      stored: { projectId: 'proj-1', sessionId: 's-stored', directory: '/p1/b' },
    });
    delete harness.hydration['/p1/b'];

    // When/Then: bootstrap rejects with the translated sync error instead of waiting forever
    await expect(harness.bootstrap()).rejects.toThrow('errors.stateSyncFailed');
    expect(harness.loadCalls).not.toContain('/p1/b');
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
  });

  it('clears a stale stored record and falls back to the current worktree', async () => {
    // Given: the stored session no longer exists anywhere in its project
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1', '/p1/b']),
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      stored: { projectId: 'proj-1', sessionId: 's-gone', directory: '/p1' },
      worktree: '/p2',
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the record is cleared and selection degrades to the current worktree
    expect(harness.clearStoredSelection).toHaveBeenCalledTimes(1);
    expect(harness.switchSessionSelection).not.toHaveBeenCalled();
    expect(harness.ensureDirectorySessionSpy).toHaveBeenCalledWith('proj-2', '/p2');
    expect(harness.loadCalls.every((directory) => directory.startsWith('/p1'))).toBe(true);
    expect(harness.createSessionFn).not.toHaveBeenCalled();
  });

  it('selects the newest root session in the current worktree', async () => {
    // Given: the current worktree already has root sessions
    const harness = createHarness({
      projects: {
        'proj-2': makeProject('proj-2', '/p2', ['/p2'], {
          '/p2': [
            makeSession('s-old', { timeUpdated: 100 }),
            makeSession('s-new', { timeUpdated: 200 }),
            makeSession('s-archived', { timeUpdated: 300, timeArchived: 1 }),
          ],
        }),
      },
      worktree: '/p2',
      useRealDirectorySession: true,
    });
    harness.hydration['/p2'] = { status: 'loaded' };

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the newest unarchived root session is selected with zero creates
    expect(harness.selectedProjectId.value).toBe('proj-2');
    expect(harness.selectedSessionId.value).toBe('s-new');
    expect(harness.createSessionFn).not.toHaveBeenCalled();
    expect(harness.loadCalls).toEqual([]);
  });

  it('creates in the exact worktree directory when loaded-empty', async () => {
    // Given: the current worktree is loaded but empty
    const harness = createHarness({
      projects: {
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      worktree: '/p2',
      useRealDirectorySession: true,
    });
    harness.hydration['/p2'] = { status: 'loaded' };

    // When: bootstrapping
    await harness.bootstrap();

    // Then: exactly one create in the exact directory
    expect(harness.createSessionFn).toHaveBeenCalledTimes(1);
    expect(harness.createSessionFn).toHaveBeenCalledWith('proj-2', '/p2');
    expect(harness.selectedSessionId.value).toBe('created-1');
  });

  it('falls back to the first project worktree when no project matches the current worktree', async () => {
    // Given: the server worktree matches no known project directory
    const harness = createHarness({
      projects: {
        'proj-1': makeProject('proj-1', '/p1', ['/p1']),
        'proj-2': makeProject('proj-2', '/p2', ['/p2']),
      },
      worktree: '/nowhere',
    });

    // When: bootstrapping
    await harness.bootstrap();

    // Then: the first project's worktree is the directory target
    expect(harness.ensureDirectorySessionSpy).toHaveBeenCalledWith('proj-1', '/p1');
  });
});
