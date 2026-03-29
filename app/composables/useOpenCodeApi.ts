import { computed, isRef, ref, type Ref } from 'vue';
import * as opencodeApi from '../utils/opencode';
import { waitForState } from '../utils/waitForState';
import type { ProjectState, SessionState } from '../types/worker-state';

type ProjectsMap = Record<string, ProjectState>;

type SessionInfo = {
  id: string;
  projectID: string;
  parentID?: string;
  title?: string;
  slug?: string;
  status?: 'busy' | 'idle' | 'retry';
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
    pinned?: number;
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

  async function createSession(directory: string): Promise<SessionInfo> {
    return withPending(async () => {
      const session = (await opencodeApi.createSession(directory)) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session create failed: invalid response.');
      }
      const effectiveProjectId = normalizeId(session.projectID);
      if (!effectiveProjectId) {
        throw new Error('Session create failed: missing projectID.');
      }
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
      const session = (await opencodeApi.forkSession(
        payload.sessionId,
        payload.messageId,
        payload.directory,
      )) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session fork failed: invalid response.');
      }
      const effectiveProjectId = normalizeId(session.projectID);
      if (!effectiveProjectId) {
        throw new Error('Session fork failed: missing projectID.');
      }
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
        { time: { archived: archivedAt, pinned: 0 } },
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

  async function pinSession(payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
    pinnedAt?: number;
  }): Promise<SessionInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const pinnedAt = payload.pinnedAt ?? Date.now();
      const session = (await opencodeApi.updateSession(
        payload.sessionId,
        { time: { pinned: pinnedAt } },
        payload.directory,
      )) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session pin failed: invalid response.');
      }
      await waitWithRetry((state) => {
        const current = findSession(state[projectId], payload.sessionId);
        return Boolean(current && typeof current.timePinned === 'number' && current.timePinned > 0);
      });
      return session;
    });
  }

  async function unpinSession(payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }): Promise<SessionInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const session = (await opencodeApi.updateSession(
        payload.sessionId,
        { time: { pinned: 0 } },
        payload.directory,
      )) as SessionInfo;
      if (!session?.id) {
        throw new Error('Session unpin failed: invalid response.');
      }
      await waitWithRetry((state) => {
        const current = findSession(state[projectId], payload.sessionId);
        return Boolean(current && !current.timePinned);
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
      return await opencodeApi.updateProject(normalizedProjectId, patch);
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

  async function unrevertSession(payload: {
    sessionId: string;
    projectId: string;
    directory?: string;
  }): Promise<SessionInfo> {
    return withPending(async () => {
      const projectId = requireProjectId(payload.projectId);
      const before = findSession(getProjects()[projectId], payload.sessionId);
      const beforeUpdated = before?.timeUpdated ?? 0;
      const session = (await opencodeApi.unrevertSession(
        payload.sessionId,
        payload.directory,
      )) as SessionInfo;
      await waitWithRetry((state) => {
        const current = findSession(state[projectId], payload.sessionId);
        return Boolean(current && (current.timeUpdated ?? 0) > beforeUpdated);
      });
      return session;
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

  async function openProject(directory: string): Promise<{ projectId: string; sessionId: string }> {
    return withPending(async () => {
      const sessions = await listSessions({ directory, roots: true });
      const roots = sessions
        .filter((session) => !session.parentID && !session.time?.archived)
        .slice()
        .sort(
          (a, b) => {
            const pinDiff = (b.time?.pinned ?? 0) - (a.time?.pinned ?? 0);
            if (pinDiff !== 0) return pinDiff;
            return (b.time?.updated ?? b.time?.created ?? 0) - (a.time?.updated ?? a.time?.created ?? 0);
          },
        );
      const preferred = roots[0];
      if (preferred) {
        return {
          projectId: preferred.projectID,
          sessionId: preferred.id,
        };
      }

      const created = (await opencodeApi.createSession(directory)) as SessionInfo;
      if (!created?.id) {
        throw new Error('Session create failed: invalid response.');
      }
      return {
        projectId: created.projectID,
        sessionId: created.id,
      };
    });
  }

  return {
    pending,
    createSession,
    forkSession,
    archiveSession,
    pinSession,
    unpinSession,
    deleteSession,
    updateProject,
    revertSession,
    unrevertSession,
    createWorktree,
    deleteWorktree,
    listSessions,
    openProject,
  };
}

export type UseOpenCodeApi = ReturnType<typeof useOpenCodeApi>;
