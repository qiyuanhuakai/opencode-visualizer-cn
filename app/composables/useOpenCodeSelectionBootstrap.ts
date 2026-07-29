import type { Ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import type { DirectorySessionHydration } from '../types/sse-worker';
import type { OpenCodeLastSelection } from '../utils/openCodeSelectionStorage';
import { waitForState } from '../utils/waitForState';
import { uniqueBy } from '../utils/array';

const PROJECT_DIRECTORY_SEARCH_CONCURRENCY = 2;

export type OpenCodeSelectionBootstrapParams = {
  projects: Ref<Record<string, ProjectState>>;
  sessionHydrationByDirectory: () => Record<string, DirectorySessionHydration>;
  serverWorktreePath: () => string;
  initialProjectId: () => string;
  initialSessionId: () => string;
  readStoredSelection: () => OpenCodeLastSelection | null;
  clearStoredSelection: () => void;
  loadDirectorySessions: (directory: string) => void;
  selectedProjectId: Ref<string>;
  selectedSessionId: Ref<string>;
  switchSessionSelection: (projectId: string, sessionId: string) => Promise<void>;
  ensureDirectorySession: (projectId: string, directory: string) => Promise<string>;
  translate?: (key: string) => string;
};

export function useOpenCodeSelectionBootstrap(params: OpenCodeSelectionBootstrapParams) {
  const t = params.translate ?? ((key: string) => key);

  function sessionExistsInProject(projectId: string, sessionId: string): boolean {
    const project = params.projects.value[projectId];
    if (!project) return false;
    return Object.values(project.sandboxes).some((sandbox) =>
      Boolean(sandbox.sessions[sessionId]),
    );
  }

  function findProjectIdForDirectory(directory: string): string {
    for (const [projectId, project] of Object.entries(params.projects.value)) {
      if (project.worktree === directory) return projectId;
      const matches = Object.values(project.sandboxes).some(
        (sandbox) => sandbox.directory === directory,
      );
      if (matches) return projectId;
    }
    return '';
  }

  function isKnownDirectory(directory: string): boolean {
    if (params.sessionHydrationByDirectory()[directory]) return true;
    return findProjectIdForDirectory(directory) !== '';
  }

  function candidateDirectories(projectId: string, recordedDirectory: string): string[] {
    const project = params.projects.value[projectId];
    const directories = [recordedDirectory];
    if (project) {
      directories.push(project.worktree);
      for (const sandbox of Object.values(project.sandboxes)) {
        directories.push(sandbox.directory);
      }
    }
    return uniqueBy(
      directories.map((directory) => directory.trim()).filter((directory) => directory !== ''),
      (directory) => directory,
    );
  }

  async function ensureDirectoryLoaded(directory: string): Promise<void> {
    const initial = params.sessionHydrationByDirectory()[directory];
    if (!initial) {
      // The worker silently ignores loads for unknown directories, so
      // waiting for hydration here would never resolve.
      throw new Error(t('errors.stateSyncFailed'));
    }
    if (initial.status === 'loaded') return;
    if (initial.status !== 'loading') {
      params.loadDirectorySessions(directory);
    }
    await waitForState(
      () => params.sessionHydrationByDirectory(),
      (hydration) => {
        const next = hydration[directory]?.status;
        return next === 'loaded' || next === 'error';
      },
    );
    const hydration = params.sessionHydrationByDirectory()[directory];
    if (hydration?.status === 'error') {
      throw new Error(hydration.error || t('errors.stateSyncFailed'));
    }
  }

  // Searches a session inside one project only: the recorded directory first,
  // then the rest of the project's directories at bounded concurrency. Never
  // touches other projects and never creates sessions.
  async function searchSessionInProject(
    projectId: string,
    sessionId: string,
    recordedDirectory: string,
  ): Promise<boolean> {
    if (sessionExistsInProject(projectId, sessionId)) return true;

    const candidates = candidateDirectories(projectId, recordedDirectory);
    let rest = candidates;
    if (recordedDirectory && candidates[0] === recordedDirectory) {
      await ensureDirectoryLoaded(recordedDirectory);
      if (sessionExistsInProject(projectId, sessionId)) return true;
      rest = candidates.slice(1);
    }

    let nextIndex = 0;
    let found = false;
    let failure: unknown = null;
    const workers = Array.from({ length: PROJECT_DIRECTORY_SEARCH_CONCURRENCY }, async () => {
      while (!found && !failure) {
        const directory = rest[nextIndex];
        nextIndex += 1;
        if (directory === undefined) return;
        try {
          await ensureDirectoryLoaded(directory);
        } catch (error) {
          failure = error;
          return;
        }
        if (sessionExistsInProject(projectId, sessionId)) found = true;
      }
    });
    await Promise.all(workers);
    if (found) return true;
    if (failure) throw failure;
    return false;
  }

  async function selectDirectoryTarget(projectId: string, directory: string): Promise<void> {
    await params.ensureDirectorySession(projectId, directory);
  }

  async function bootstrapOpenCodeSelection(): Promise<void> {
    if (params.selectedSessionId.value) return;

    const explicitProjectId = params.initialProjectId().trim();
    const explicitSessionId = params.initialSessionId().trim();
    const stored = params.readStoredSelection();

    // Tier 1: explicit deep link. Missing target is an error, never a create.
    if (explicitProjectId && explicitSessionId) {
      const recordedDirectory =
        stored && stored.projectId === explicitProjectId ? stored.directory : '';
      const found = await searchSessionInProject(
        explicitProjectId,
        explicitSessionId,
        recordedDirectory,
      );
      if (!found) {
        throw new Error(t('errors.sessionNotFound'));
      }
      await params.switchSessionSelection(explicitProjectId, explicitSessionId);
      return;
    }

    // Tier 2: persisted selection. A stale record is cleared, then we degrade.
    if (stored) {
      const storedProject = params.projects.value[stored.projectId];
      const storedDirectory = stored.directory.trim();
      const isStale =
        !storedProject || (storedDirectory !== '' && !isKnownDirectory(storedDirectory));
      if (isStale) {
        params.clearStoredSelection();
      } else {
        const found = await searchSessionInProject(
          stored.projectId,
          stored.sessionId,
          stored.directory,
        );
        if (found) {
          await params.switchSessionSelection(stored.projectId, stored.sessionId);
          return;
        }
        params.clearStoredSelection();
      }
    }

    // Tier 3: the server's current worktree.
    const worktree = params.serverWorktreePath().trim();
    if (worktree) {
      const projectId = findProjectIdForDirectory(worktree);
      if (projectId) {
        await selectDirectoryTarget(projectId, worktree);
        return;
      }
    }

    // Tier 4: the first project's worktree.
    const firstEntry = Object.entries(params.projects.value)[0];
    if (!firstEntry) {
      throw new Error(t('errors.noAvailableProject'));
    }
    const [projectId, project] = firstEntry;
    const directory = project.worktree.trim();
    if (!directory) {
      throw new Error(t('errors.sessionCreateEmptyWorktree'));
    }
    await selectDirectoryTarget(projectId, directory);
  }

  return {
    bootstrapOpenCodeSelection,
  };
}
