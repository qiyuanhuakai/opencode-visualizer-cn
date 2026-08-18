import type { TopPanelWorktree } from '../types/top-panel';
import type { SessionTreeData, SessionTreeProject, SessionTreeSandbox, SessionTreeSession } from '../types/session-tree';
import type { ProjectState, SandboxState, SessionState } from '../types/worker-state';
import { isSandboxMarkedDeleted, type DeletedSandboxStore } from '../utils/deletedSandboxes';
import {
  normalizePinnedAt,
  pinnedSessionStoreKey,
  projectPinKey,
  sandboxPinKey,
  type LocalPinnedSessionStore,
} from '../utils/pinnedSessions';

type OpenCodeSessionStatus = 'busy' | 'idle' | 'retry' | 'unknown';

function buildEffectiveSessionStatuses(project: ProjectState): ReadonlyMap<string, OpenCodeSessionStatus> {
  const sessionsById = new Map<string, SessionState>();
  const statuses = new Map<string, OpenCodeSessionStatus>();
  Object.values(project.sandboxes).forEach((sandbox) => {
    Object.values(sandbox.sessions).forEach((session) => {
      sessionsById.set(session.id, session);
      statuses.set(session.id, (session.status ?? 'unknown') as OpenCodeSessionStatus);
    });
  });

  const propagatedActive = new Set<string>();
  for (const session of sessionsById.values()) {
    if (session.status !== 'busy' && session.status !== 'retry') continue;
    let parentId = session.parentID?.trim();
    while (parentId && !propagatedActive.has(parentId)) {
      propagatedActive.add(parentId);
      if (statuses.get(parentId) !== 'retry') statuses.set(parentId, 'busy');
      parentId = sessionsById.get(parentId)?.parentID?.trim();
    }
  }
  return statuses;
}

export function buildNativeOpenCodeTopPanelTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  deletedSandboxStore: DeletedSandboxStore;
  gitInfoByDirectory: Record<string, NonNullable<SessionState['gitInfo']>>;
  homePath: string;
  replaceHomePrefix: (path: string) => string;
  resolveProjectColor: (color?: string) => string | undefined;
}): TopPanelWorktree[] {
  const {
    projects,
    pinnedStore,
    deletedSandboxStore,
    replaceHomePrefix,
    resolveProjectColor,
  } = params;
  return Object.values(projects).map((project) => {
    const projectPinnedAt = normalizePinnedAt(pinnedStore[projectPinKey(project.id)]);
    const effectiveStatuses = buildEffectiveSessionStatuses(project);
    const sandboxes = (Object.values(project.sandboxes) as SandboxState[])
      .filter((sandbox) => sandbox.directory === project.worktree
        || !isSandboxMarkedDeleted(deletedSandboxStore, project.id, sandbox.directory))
      .map((sandbox) => {
        const pinnedAt = normalizePinnedAt(pinnedStore[sandboxPinKey(project.id, sandbox.directory)]);
        return {
          directory: sandbox.directory,
          branch: sandbox.name,
          kind: 'sandbox' as const,
          pinnedAt,
          isPinned: pinnedAt > 0,
          sessions: sandbox.rootSessions.map((id) => sandbox.sessions[id]).filter(Boolean).map((session) => {
            const sessionPinnedAt = normalizePinnedAt(pinnedStore[pinnedSessionStoreKey(project.id, session.id)])
              || normalizePinnedAt(session.timePinned);
            return {
              id: session.id,
              title: session.title,
              slug: session.slug,
              status: effectiveStatuses.get(session.id) ?? 'unknown',
              timeCreated: session.timeCreated,
              timeUpdated: session.timeUpdated,
              archivedAt: session.timeArchived,
              pinnedAt: sessionPinnedAt,
              isPinned: sessionPinnedAt > 0,
            };
          }),
        };
      });
    return {
      directory: project.worktree,
      label: replaceHomePrefix(project.worktree),
      name: project.name,
      projectId: project.id,
      projectColor: resolveProjectColor(project.icon?.color),
      kind: 'sandbox' as const,
      pinnedAt: projectPinnedAt,
      isPinned: projectPinnedAt > 0,
      sandboxes,
    };
  });
}

export function buildOpenCodeSessionTreeData(params: {
  projects: Record<string, ProjectState>;
  pinnedStore: LocalPinnedSessionStore;
  resolveProjectColor: (color?: string) => string | undefined;
}): SessionTreeData {
  const { projects, pinnedStore, resolveProjectColor } = params;
  const result: SessionTreeProject[] = [];
  for (const project of Object.values(projects)) {
    const effectiveStatuses = buildEffectiveSessionStatuses(project);
    const projectName = project.name?.trim() || project.worktree.replace(/\/+$/, '').split('/').pop() || project.id;
    const projectLocal = pinnedStore[projectPinKey(project.id)];
    const isProjectPinned = typeof projectLocal === 'number' && projectLocal > 0;

    const sandboxes: SessionTreeSandbox[] = [];
    for (const sandbox of Object.values(project.sandboxes) as SandboxState[]) {
      const sandboxLocal = pinnedStore[sandboxPinKey(project.id, sandbox.directory)];
      const isSandboxDirectlyPinned = typeof sandboxLocal === 'number' && sandboxLocal > 0;
      const isSandboxPinned = isSandboxDirectlyPinned;

      const sessions: SessionTreeSession[] = [];
      for (const session of Object.values(sandbox.sessions)) {
        if (session.parentID || session.timeArchived) continue;
        const sessionLocal = pinnedStore[pinnedSessionStoreKey(project.id, session.id)];
        const isSessionDirectlyPinned = typeof sessionLocal === 'number' && sessionLocal > 0;
        const isSessionUnpinned = typeof sessionLocal === 'number' && sessionLocal < 0;
        if (isSessionUnpinned) continue;

        const serverPinnedAt = session.timePinned;
        const isSessionPinned = isSessionDirectlyPinned || normalizePinnedAt(serverPinnedAt) > 0;
        const isSessionInPinnedTree = isSessionPinned;
        if (!isSessionInPinnedTree) continue;

        const isSessionImplicitlyPinned = false;
        const pinnedAt = isSessionPinned
          ? (isSessionDirectlyPinned ? (sessionLocal as number) : normalizePinnedAt(serverPinnedAt))
          : 0;
        sessions.push({
          type: 'session',
          sessionId: session.id,
          projectId: project.id,
          directory: sandbox.directory,
          title: session.title || session.slug || session.id,
          status: effectiveStatuses.get(session.id) ?? 'unknown',
          pinnedAt,
          isPinned: isSessionPinned,
          isImplicitlyPinned: isSessionImplicitlyPinned,
        });
      }

      if (sessions.length === 0 && !isSandboxPinned) continue;
      sessions.sort((left, right) => {
        if (right.pinnedAt !== left.pinnedAt) return right.pinnedAt - left.pinnedAt;
        return left.title.localeCompare(right.title);
      });
      const isSandboxImplicitlyPinned = false;
      const sandboxName = sandbox.name
        || sandbox.directory.replace(/\/+$/, '').split('/').pop()
        || sandbox.directory;
      sandboxes.push({
        type: 'sandbox',
        directory: sandbox.directory,
        projectId: project.id,
        name: sandboxName,
        pinnedAt: isSandboxPinned ? (isSandboxDirectlyPinned ? (sandboxLocal as number) : (projectLocal as number)) : 0,
        isPinned: isSandboxPinned,
        isImplicitlyPinned: isSandboxImplicitlyPinned,
        sessions,
      });
    }

    if (sandboxes.length === 0 && !isProjectPinned) continue;
    sandboxes.sort((left, right) => {
      const leftIsPrimary = left.directory === project.worktree;
      const rightIsPrimary = right.directory === project.worktree;
      if (leftIsPrimary !== rightIsPrimary) return leftIsPrimary ? -1 : 1;
      return left.name.localeCompare(right.name);
    });
    result.push({
      type: 'project',
      projectId: project.id,
      name: projectName,
      color: resolveProjectColor(project.icon?.color),
      pinnedAt: normalizePinnedAt(projectLocal),
      isPinned: isProjectPinned,
      sandboxes,
    });
  }

  return result.sort((left, right) => {
    if (left.pinnedAt !== right.pinnedAt) return right.pinnedAt - left.pinnedAt;
    return left.name.localeCompare(right.name);
  });
}
