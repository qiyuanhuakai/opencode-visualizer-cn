import { computed, isRef, ref, type Ref } from 'vue';
import * as opencodeApi from '../utils/opencode';
import { waitForState } from '../utils/waitForState';
import type { ProjectState, SessionState } from '../types/worker-state';

type ProjectsMap = Record<string, ProjectState>;

type SessionInfo = {
  id: string;
  projectID?: string;
  projectId?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  status?: 'busy' | 'idle' | 'retry';
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
  };
};

type ProjectUpdatePayload = {
  directory?: string;
  name?: string;
  icon?: {
    url?: string;
    override?: string;
    color?: string;
  };
  commands?: {
    start?: string;
  };
};

type ListSessionsOptions = {
  directory?: string;
  instanceDirectory?: string;
  roots?: boolean;
  search?: string;
  limit?: number;
};

type CreateWorktreeInfo = {
  name: string;
  branch: string;
  directory: string;
};

function normalizeId(value: string | undefined): string {
  return value?.trim() ?? '';
}

function findSession(
  project: ProjectState | undefined,
  sessionId: string,
): SessionState | undefined {
  if (!project) return undefined;
  const target = normalizeId(sessionId);
  if (!target) return undefined;
  for (const sandbox of Object.values(project.sandboxes)) {
    const session = sandbox.sessions[target];
    if (session) return session;
  }
  return undefined;
}

function hasSandbox(project: ProjectState | undefined, directory: string): boolean {
  if (!project) return false;
  return Boolean(project.sandboxes[directory]);
}

function matchProjectUpdate(
  project: ProjectState | undefined,
  payload: ProjectUpdatePayload,
): boolean {
  if (!project) return false;
  if (payload.directory !== undefined && project.worktree !== payload.directory) return false;
  if (payload.name !== undefined && project.name !== payload.name) return false;

  if (payload.icon) {
    if (payload.icon.url !== undefined && project.icon?.url !== payload.icon.url) return false;
    if (payload.icon.override !== undefined && project.icon?.override !== payload.icon.override) {
      return false;
    }
    if (payload.icon.color !== undefined && project.icon?.color !== payload.icon.color)
      return false;
  }

  if (payload.commands?.start !== undefined && project.commands?.start !== payload.commands.start) {
    return false;
  }

  return true;
}

export function useOpenCodeApi(projects: ProjectsMap | Ref<ProjectsMap>) {
  const pendingCount = ref(0);
  const pending = computed(() => pendingCount.value > 0);

  const getProjects = (): ProjectsMap => (isRef(projects) ? projects.value : projects);

  async function waitWithRetry(predicate: (projects: ProjectsMap) => boolean, timeoutMs = 30_000) {
    try {
      await waitForState(getProjects, predicate, timeoutMs);
      return;
    } catch {
      try {
        await waitForState(getProjects, predicate, timeoutMs);
        return;
      } catch {
        window.location.reload();
        throw new Error('State synchronization failed after retry. Reload requested.');
      }
    }
  }

  async function withPending<T>(runner: () => Promise<T>): Promise<T> {
    pendingCount.value += 1;
    try {
      return await runner();
    } finally {
      pendingCount.value = Math.max(0, pendingCount.value - 1);
    }
  }

  function requireProjectId(projectId: string): string {
    const normalized = normalizeId(projectId);
    if (!normalized) {
      throw new Error('Project ID is required for SSE-confirmed operations.');
    }
    return normalized;
  }

  async function createSession(
    directory: string | undefined,
    projectId: string,
  ): Promise<SessionInfo> {
    return withPending(async () => {
      const requestedProjectId = requireProjectId(projectId);
      const session = (await opencodeApi.createSession(directory)) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session create failed: invalid response.');
      }
      const effectiveProjectId =
        normalizeId(session.projectID || session.projectId) || requestedProjectId;
      const sessionId = normalizeId(session.id);
      await waitWithRetry((state) => Boolean(findSession(state[effectiveProjectId], sessionId)));
      return session;
    });
  }

  async function forkSession(payload: {
    sessionId: string;
    messageId: string;
    directory?: string;
    projectId: string;
  }): Promise<SessionInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const session = (await opencodeApi.forkSession(
        payload.sessionId,
        payload.messageId,
        payload.directory,
      )) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session fork failed: invalid response.');
      }
      const effectiveProjectId = normalizeId(session.projectID || session.projectId) || projectId;
      await waitWithRetry((state) => Boolean(findSession(state[effectiveProjectId], session.id)));
      return session;
    });
  }

  async function archiveSession(payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
    archivedAt?: number;
  }): Promise<SessionInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const archivedAt = payload.archivedAt ?? Date.now();
      const session = (await opencodeApi.updateSession(
        payload.sessionId,
        { time: { archived: archivedAt } },
        payload.directory,
      )) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session archive failed: invalid response.');
      }
      await waitWithRetry((state) => {
        const current = findSession(state[projectId], payload.sessionId);
        return Boolean(
          current && typeof current.timeArchived === 'number' && current.timeArchived > 0,
        );
      });
      return session;
    });
  }

  async function deleteSession(payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }): Promise<void> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      await opencodeApi.deleteSession(payload.sessionId, payload.directory);
      await waitWithRetry((state) => !findSession(state[projectId], payload.sessionId));
    });
  }

  async function updateProject(projectId: string, patch: ProjectUpdatePayload): Promise<unknown> {
    return withPending(async () => {
      const normalizedProjectId = requireProjectId(projectId);
      const result = await opencodeApi.updateProject(normalizedProjectId, patch);
      await waitWithRetry((state) => matchProjectUpdate(state[normalizedProjectId], patch));
      return result;
    });
  }

  async function revertSession(payload: {
    sessionId: string;
    messageId: string;
    projectId: string;
    directory?: string;
  }): Promise<void> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const before = findSession(getProjects()[projectId], payload.sessionId);
      const beforeUpdated = before?.timeUpdated ?? 0;
      await opencodeApi.revertSession(payload.sessionId, payload.messageId, payload.directory);
      await waitWithRetry((state) => {
        const current = findSession(state[projectId], payload.sessionId);
        return Boolean(current && (current.timeUpdated ?? 0) > beforeUpdated);
      });
    });
  }

  async function createWorktree(payload: {
    directory: string;
    projectId: string;
  }): Promise<CreateWorktreeInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const data = (await opencodeApi.createWorktree(payload.directory)) as CreateWorktreeInfo;
      const createdDir = data?.directory?.trim();
      if (!createdDir) {
        throw new Error('Worktree create failed: invalid response.');
      }
      await waitWithRetry((state) => hasSandbox(state[projectId], createdDir));
      return data;
    });
  }

  async function deleteWorktree(payload: {
    directory: string;
    targetDirectory: string;
    projectId: string;
  }): Promise<void> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const targetDirectory = payload.targetDirectory.trim();
      await opencodeApi.deleteWorktree(payload.directory, targetDirectory);
      await waitWithRetry((state) => !hasSandbox(state[projectId], targetDirectory));
    });
  }

  async function listSessions(options: ListSessionsOptions = {}): Promise<SessionInfo[]> {
    const data = (await opencodeApi.listSessions(options)) as SessionInfo[];
    return Array.isArray(data) ? data : [];
  }

  return {
    pending,
    createSession,
    forkSession,
    archiveSession,
    deleteSession,
    updateProject,
    revertSession,
    createWorktree,
    deleteWorktree,
    listSessions,
  };
}

export type UseOpenCodeApi = ReturnType<typeof useOpenCodeApi>;
