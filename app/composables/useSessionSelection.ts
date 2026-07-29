import { computed, ref, type Ref } from 'vue';
import type { ProjectState } from '../types/worker-state';
import { waitForState } from '../utils/waitForState';
import { uniqueBy } from '../utils/array';

type CreateSessionFn = (
  projectId: string,
  directory?: string,
) => Promise<{ id: string; projectId: string }>;
type TranslateFn = (key: string, params?: Record<string, unknown>) => string;
type HydrateFn = (key: string) => Promise<void>;

export type SessionSelectionOptions = {
  ensureDirectoryHydrated?: HydrateFn;
  ensureProjectHydrated?: HydrateFn;
};

const noopHydrate: HydrateFn = async () => {};

function listSandboxes(project: ProjectState) {
  return Object.keys(project.sandboxes).map((key) => project.sandboxes[key]);
}

function getProjectSessionIds(project: ProjectState): string[] {
  const ids: string[] = [];
  listSandboxes(project).forEach((sandbox) => {
    ids.push(...sandbox.rootSessions);
  });
  return uniqueBy(ids, (x) => x);
}

function findMostRecentSession(
  projects: Record<string, ProjectState>,
): { projectId: string; sessionId: string } | null {
  let best: { projectId: string; sessionId: string; pinnedAt: number; time: number } | null = null;

  for (const [projectId, project] of Object.entries(projects)) {
    for (const sandbox of listSandboxes(project)) {
      for (const session of Object.values(sandbox.sessions)) {
        if (session.parentID) continue;
        if (session.timeArchived) continue;
        const pinnedAt = session.timePinned ?? 0;
        const time = session.timeUpdated ?? session.timeCreated ?? 0;
        if (!best || pinnedAt > best.pinnedAt || (pinnedAt === best.pinnedAt && time > best.time)) {
          best = { projectId, sessionId: session.id, pinnedAt, time };
        }
      }
    }
  }

  return best;
}

function findDirectoryRootSession(project: ProjectState, directory: string): string | null {
  let best: { sessionId: string; pinnedAt: number; time: number } | null = null;

  for (const sandbox of listSandboxes(project)) {
    if (sandbox.directory !== directory) continue;
    for (const session of Object.values(sandbox.sessions)) {
      if (session.parentID) continue;
      if (session.timeArchived) continue;
      const pinnedAt = session.timePinned ?? 0;
      const time = session.timeUpdated ?? session.timeCreated ?? 0;
      if (!best || pinnedAt > best.pinnedAt || (pinnedAt === best.pinnedAt && time > best.time)) {
        best = { sessionId: session.id, pinnedAt, time };
      }
    }
  }

  return best?.sessionId ?? null;
}

export function useSessionSelection(
  projects: Ref<Record<string, ProjectState>>,
  createSessionFn: CreateSessionFn,
  translate?: TranslateFn,
  options: SessionSelectionOptions = {},
) {
  const t = translate ?? ((key: string) => key);
  const ensureDirectoryHydrated = options.ensureDirectoryHydrated ?? noopHydrate;
  const ensureProjectHydrated = options.ensureProjectHydrated ?? noopHydrate;
  const selectedProjectId = ref<string>('');
  const selectedSessionId = ref<string>('');

  const projectMap = computed(() => projects.value);

  const project = computed(() => projectMap.value[selectedProjectId.value]);

  const activeDirectory = computed(() => {
    const currentProject = projectMap.value[selectedProjectId.value];
    const sessionId = selectedSessionId.value;
    if (!currentProject || !sessionId) return currentProject?.worktree ?? '';
    for (const sandbox of listSandboxes(currentProject)) {
      if (sandbox.sessions[sessionId]) return sandbox.directory;
    }
    return currentProject.worktree;
  });

  const projectDirectory = computed(() => project.value?.worktree ?? '');

  async function ensureSession(projectIdHint?: string): Promise<string> {
    const map = projectMap.value;
    let projectId = projectIdHint?.trim() || selectedProjectId.value.trim();

    if (!projectId || !map[projectId]) {
      const recent = findMostRecentSession(map);
      if (recent) {
        selectedProjectId.value = recent.projectId;
        selectedSessionId.value = recent.sessionId;
        return recent.sessionId;
      }
      projectId = Object.keys(map)[0] ?? 'global';
    }

    if (!projectId) {
      throw new Error(t('errors.noAvailableProject'));
    }

    const targetProject = map[projectId];
    const ids = getProjectSessionIds(targetProject);
    if (ids.length > 0) {
      const sessionId = ids[0] ?? '';
      if (!sessionId) {
        throw new Error(t('errors.failedToResolveSessionId'));
      }
      selectedProjectId.value = projectId;
      selectedSessionId.value = sessionId;
      return sessionId;
    }

    // The session list read was empty: hydrate the project, then RE-READ the
    // reactive map before deciding to create. A hydration error rejects as-is.
    await ensureProjectHydrated(projectId);
    const hydratedProject = projectMap.value[projectId];
    if (hydratedProject) {
      const hydratedIds = getProjectSessionIds(hydratedProject);
      if (hydratedIds.length > 0) {
        const sessionId = hydratedIds[0] ?? '';
        if (!sessionId) {
          throw new Error(t('errors.failedToResolveSessionId'));
        }
        selectedProjectId.value = projectId;
        selectedSessionId.value = sessionId;
        return sessionId;
      }
    }

    const created = await createSessionFn(projectId);
    const createdProjectId = (created.projectId || projectId).trim();
    const createdSessionId = created.id.trim();
    if (!createdProjectId || !createdSessionId) {
      throw new Error(t('errors.failedToResolveCreatedSession'));
    }
    selectedProjectId.value = createdProjectId;
    selectedSessionId.value = createdSessionId;
    return createdSessionId;
  }

  async function ensureDirectorySession(
    projectIdHint: string,
    directoryHint: string,
  ): Promise<string> {
    const projectId = projectIdHint.trim();
    const directory = directoryHint.trim();
    if (!projectId) {
      throw new Error(t('errors.noAvailableProject'));
    }
    if (!directory) {
      throw new Error(t('errors.sessionCreateEmptyDirectory'));
    }

    if (!projectMap.value[projectId]) {
      await ensureProjectHydrated(projectId);
    }
    const project = projectMap.value[projectId];
    if (!project) {
      throw new Error(t('errors.noAvailableProject'));
    }

    let sessionId = findDirectoryRootSession(project, directory);
    if (!sessionId) {
      await ensureDirectoryHydrated(directory);
      const hydratedProject = projectMap.value[projectId];
      sessionId = hydratedProject ? findDirectoryRootSession(hydratedProject, directory) : null;
    }

    if (sessionId) {
      selectedProjectId.value = projectId;
      selectedSessionId.value = sessionId;
      return sessionId;
    }

    const created = await createSessionFn(projectId, directory);
    const createdProjectId = (created.projectId || projectId).trim();
    const createdSessionId = created.id.trim();
    if (!createdProjectId || !createdSessionId) {
      throw new Error(t('errors.failedToResolveCreatedSession'));
    }
    selectedProjectId.value = createdProjectId;
    selectedSessionId.value = createdSessionId;
    return createdSessionId;
  }

  async function switchSession(projectId: string, sessionId: string) {
    const nextProjectId = projectId.trim();
    const nextSessionId = sessionId.trim();
    if (!nextProjectId || !nextSessionId) {
      await ensureSession(nextProjectId);
      return;
    }

    await waitForState(
      () => projectMap.value,
      (projects) => {
        const nextProject = projects[nextProjectId];
        if (!nextProject) return false;
        return listSandboxes(nextProject).some((sandbox) =>
          Boolean(sandbox.sessions[nextSessionId]),
        );
      },
    );

    selectedProjectId.value = nextProjectId;
    selectedSessionId.value = nextSessionId;
  }

  async function initialize() {
    if (selectedSessionId.value) return selectedSessionId.value;
    return ensureSession();
  }

  return {
    selectedProjectId,
    selectedSessionId,
    project,
    activeDirectory,
    projectDirectory,
    switchSession,
    ensureSession,
    ensureDirectorySession,
    initialize,
  };
}
