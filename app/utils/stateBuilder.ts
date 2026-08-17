import type { ProjectInfo, SessionInfo } from '../types/sse';
import type { ProjectState, SandboxState, ServerState, SessionState } from '../types/worker-state';
import { normalizeDirectory } from './path';

const PROJECT_COLOR_HEX: Record<string, string> = {
  pink: '#e34ba9',
  mint: '#95f3d9',
  orange: '#ff802b',
  purple: '#9d5bd2',
  cyan: '#369eff',
  lime: '#c4f042',
};

const CHILD_SESSION_PRUNE_TTL_MS = 20 * 60 * 1000;
const GLOBAL_PROJECT_NAME = 'global';
const RESERVED_RECORD_KEYS = new Set([...Object.getOwnPropertyNames(Object.prototype), 'prototype']);

type SessionStatusType = Exclude<SessionState['status'], undefined>;

type SessionMutationInfo = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  revert?: SessionInfo['revert'];
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
    pinned?: number;
  };
};

type SessionLocation = {
  projectId: string;
  directory: string;
};

type SessionEntry = {
  projectId: string;
  directory: string;
  session: SessionState;
};

type SnapshotToken = {
  readonly id: symbol;
  readonly baseline: number;
  readonly sequence: number;
  invalidated?: boolean;
};

type SnapshotRegistry = Set<SnapshotToken>;

const MAX_SNAPSHOT_REVISION_TRACKERS = 2_000;

export function resolveProjectColorHex(raw?: string): string | undefined {
  if (!raw) return undefined;
  const trimmed = raw.trim();
  return PROJECT_COLOR_HEX[trimmed] ?? trimmed;
}

function toSortTime(session: SessionState) {
  if (session.timePinned) return session.timePinned;
  return session.timeUpdated ?? session.timeCreated ?? 0;
}

function isRootSession(session: SessionState) {
  return !(session.parentID && session.parentID.trim());
}

function isSameStringArray(a: string[], b: string[]) {
  if (a.length !== b.length) return false;
  for (let index = 0; index < a.length; index += 1) {
    if (a[index] !== b[index]) return false;
  }
  return true;
}

function isSessionStatus(value: string): value is SessionStatusType {
  return value === 'busy' || value === 'idle' || value === 'retry';
}

function isSafeRecordKey(value: string): boolean {
  const normalized = value.trim();
  return normalized.length > 0 && !RESERVED_RECORD_KEYS.has(normalized);
}

function normalizeSafeDirectory(value?: string): string {
  const normalized = normalizeDirectory(value);
  return normalized && isSafeRecordKey(normalized) ? normalized : '';
}

function resolveProjectName(projectId: string, name?: string) {
  const trimmed = name?.trim();
  if (trimmed) return trimmed;
  if (projectId === 'global') return GLOBAL_PROJECT_NAME;
  return undefined;
}

function createDefaultProject(id: string, worktree: string): ProjectState {
  const normalizedWorktree = normalizeSafeDirectory(worktree) || '/';
  return {
    id,
    name: resolveProjectName(id),
    worktree: normalizedWorktree,
    sandboxes: {
      [normalizedWorktree]: {
        directory: normalizedWorktree,
        name: '',
        rootSessions: [],
        sessions: {},
      },
    },
  };
}

function sanitizeDirectoryList(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  const result = new Set<string>();
  value.forEach((entry) => {
    if (typeof entry !== 'string') return;
    const normalized = normalizeSafeDirectory(entry);
    if (!normalized) return;
    result.add(normalized);
  });
  return Array.from(result);
}

function isSameRevert(a: SessionInfo['revert'], b: SessionInfo['revert']) {
  if (!a && !b) return true;
  if (!a || !b) return false;
  return (
    a.messageID === b.messageID &&
    a.partID === b.partID &&
    a.snapshot === b.snapshot &&
    a.diff === b.diff
  );
}

export function createStateBuilder() {
  let state: ServerState = { projects: {} };

  const projectIdByDirectory = new Map<string, string>();
  const sessionLocationById = new Map<string, SessionLocation>();
  const ephemeralLastSeenAt = new Map<string, number>();
  const ephemeralLastActiveAt = new Map<string, number>();
  const authoritativeChildSessionIds = new Set<string>();
  const pendingStatusBySessionId = new Map<string, SessionStatusType>();
  const statusRevisionBySessionId = new Map<string, number>();
  const statusSnapshotFenceBySessionId = new Map<string, number>();
  const activeStatusSnapshots: SnapshotRegistry = new Set();
  let statusRevision = 0;
  let snapshotSequence = 0;
  const mutationRevisionBySessionId = new Map<string, number>();
  const activeMutationSnapshots: SnapshotRegistry = new Set();
  let mutationRevision = 0;
  const MAX_PENDING_STATUSES = 2_000;
  let snapshotOverflowed = false;
  const deferredRootSessionOrder = new Set<SandboxState>();
  let deferRootSessionSorting = false;

  function recordSessionMutation(sessionId: string) {
    if (!isSafeRecordKey(sessionId)) return;
    mutationRevision += 1;
    if (!hasValidActiveSnapshot(activeMutationSnapshots)) return;
    if (
      !mutationRevisionBySessionId.has(sessionId) &&
      mutationRevisionBySessionId.size >= MAX_SNAPSHOT_REVISION_TRACKERS
    ) {
      invalidateAllSnapshots();
      return;
    }
    mutationRevisionBySessionId.set(sessionId, mutationRevision);
  }

  function recordStatusRevision(sessionId: string) {
    if (!isSafeRecordKey(sessionId)) return;
    statusRevision += 1;
    if (!hasValidActiveSnapshot(activeStatusSnapshots)) return;
    if (
      !statusRevisionBySessionId.has(sessionId) &&
      statusRevisionBySessionId.size >= MAX_SNAPSHOT_REVISION_TRACKERS
    ) {
      invalidateAllSnapshots();
      return;
    }
    statusRevisionBySessionId.set(sessionId, statusRevision);
  }

  function bufferPendingStatus(sessionId: string, status: SessionStatusType) {
    pendingStatusBySessionId.delete(sessionId);
    pendingStatusBySessionId.set(sessionId, status);
    while (pendingStatusBySessionId.size > MAX_PENDING_STATUSES) {
      const oldestSessionId = pendingStatusBySessionId.keys().next().value;
      if (!oldestSessionId) break;
      pendingStatusBySessionId.delete(oldestSessionId);
    }
  }

  function hasValidActiveSnapshot(activeSnapshots: SnapshotRegistry): boolean {
    for (const snapshot of activeSnapshots) {
      if (!snapshot.invalidated) return true;
    }
    return false;
  }

  function invalidateAllSnapshots(): void {
    for (const snapshot of activeMutationSnapshots) snapshot.invalidated = true;
    for (const snapshot of activeStatusSnapshots) snapshot.invalidated = true;
    mutationRevisionBySessionId.clear();
    statusRevisionBySessionId.clear();
    snapshotOverflowed = true;
  }

  function beginSnapshot(revision: number, activeSnapshots: SnapshotRegistry): SnapshotToken {
    const token: SnapshotToken = {
      id: Symbol('snapshot'),
      baseline: revision,
      sequence: ++snapshotSequence,
      invalidated: false,
    };
    activeSnapshots.add(token);
    return token;
  }

  function getActiveSnapshot(
    token: SnapshotToken,
    activeSnapshots: SnapshotRegistry,
  ): SnapshotToken | undefined {
    return activeSnapshots.has(token) ? token : undefined;
  }

  function isUsableSnapshot(token: SnapshotToken, activeSnapshots: SnapshotRegistry): boolean {
    const activeSnapshot = getActiveSnapshot(token, activeSnapshots);
    return Boolean(activeSnapshot && !activeSnapshot.invalidated);
  }

  function completeSnapshot(
    token: SnapshotToken,
    activeSnapshots: SnapshotRegistry,
    revisionsBySessionId: Map<string, number>,
  ): void {
    const activeSnapshot = getActiveSnapshot(token, activeSnapshots);
    if (!activeSnapshot) return;
    activeSnapshots.delete(token);

    let oldestActiveRevision = Number.POSITIVE_INFINITY;
    for (const snapshot of activeSnapshots) {
      if (!snapshot.invalidated) {
        oldestActiveRevision = Math.min(oldestActiveRevision, snapshot.baseline);
      }
    }
    if (oldestActiveRevision === Number.POSITIVE_INFINITY) {
      revisionsBySessionId.clear();
      return;
    }
    for (const [sessionId, sessionRevision] of revisionsBySessionId) {
      if (sessionRevision <= oldestActiveRevision) revisionsBySessionId.delete(sessionId);
    }
  }

  function getProject(projectId: string): ProjectState | undefined {
    if (!isSafeRecordKey(projectId)) return undefined;
    return state.projects[projectId];
  }

  function indexProjectDirectories(project: ProjectState) {
    const projectId = project.id;
    if (!projectId) return;

    for (const [directory, id] of projectIdByDirectory) {
      if (id === projectId) {
        projectIdByDirectory.delete(directory);
      }
    }

    const root = normalizeSafeDirectory(project.worktree);
    if (root) projectIdByDirectory.set(root, projectId);
    Object.keys(project.sandboxes).forEach((directory) => {
       const normalized = normalizeSafeDirectory(directory);
      if (!normalized) return;
      projectIdByDirectory.set(normalized, projectId);
    });
  }

  function rebuildIndexes() {
    projectIdByDirectory.clear();
    sessionLocationById.clear();

    const knownSessionIds = new Set<string>();
    Object.values(state.projects).forEach((project) => {
      indexProjectDirectories(project);
      Object.entries(project.sandboxes).forEach(([directory, sandbox]) => {
        const normalizedDirectory = normalizeSafeDirectory(directory);
        if (!normalizedDirectory) return;
        Object.keys(sandbox.sessions).forEach((sessionId) => {
          knownSessionIds.add(sessionId);
          sessionLocationById.set(sessionId, {
            projectId: project.id,
            directory: normalizedDirectory,
          });
        });
      });
    });

    Array.from(ephemeralLastSeenAt.keys()).forEach((sessionId) => {
      if (!knownSessionIds.has(sessionId)) ephemeralLastSeenAt.delete(sessionId);
    });
    Array.from(ephemeralLastActiveAt.keys()).forEach((sessionId) => {
      if (!knownSessionIds.has(sessionId)) ephemeralLastActiveAt.delete(sessionId);
    });
    Array.from(authoritativeChildSessionIds).forEach((sessionId) => {
      if (!knownSessionIds.has(sessionId)) authoritativeChildSessionIds.delete(sessionId);
    });
  }

  function ensureProject(projectId: string, worktreeHint?: string): ProjectState {
    const normalizedProjectId = projectId.trim();
    const worktree = normalizeSafeDirectory(worktreeHint) || '/';
    const existing = state.projects[normalizedProjectId];
    if (existing) {
      if (!normalizeSafeDirectory(existing.worktree)) {
        existing.worktree = worktree;
      }
      const normalizedWorktree = normalizeSafeDirectory(existing.worktree) || worktree;
      existing.worktree = normalizedWorktree;
      if (!existing.sandboxes[normalizedWorktree]) {
        existing.sandboxes[normalizedWorktree] = {
          directory: normalizedWorktree,
          name: '',
          rootSessions: [],
          sessions: {},
        };
      }
      indexProjectDirectories(existing);
      return existing;
    }

    const created = createDefaultProject(normalizedProjectId, worktree);
    state.projects[normalizedProjectId] = created;
    indexProjectDirectories(created);
    return created;
  }

  function ensureSandbox(project: ProjectState, directoryHint?: string): SandboxState {
    const fallback = normalizeSafeDirectory(project.worktree) || '/';
    const normalizedDirectory = normalizeSafeDirectory(directoryHint) || fallback;
    const existing = project.sandboxes[normalizedDirectory];
    if (existing) return existing;
    const created: SandboxState = {
      directory: normalizedDirectory,
      name: '',
      rootSessions: [],
      sessions: {},
    };
    project.sandboxes[normalizedDirectory] = created;
    projectIdByDirectory.set(normalizedDirectory, project.id);
    return created;
  }

  function resolveProjectIdForDirectory(directory?: string) {
    const normalized = normalizeSafeDirectory(directory);
    if (!normalized) return '';
    return projectIdByDirectory.get(normalized) ?? '';
  }

  function updateRootSessionOrder(sandbox: SandboxState) {
    const roots = Object.values(sandbox.sessions)
      .filter((session) => isRootSession(session))
      .sort((a, b) => toSortTime(b) - toSortTime(a))
      .map((session) => session.id);
    const current = Array.isArray(sandbox.rootSessions) ? sandbox.rootSessions : [];
    if (isSameStringArray(current, roots)) return;
    sandbox.rootSessions = roots;
  }

  function updateRootSessionOrderOrDefer(sandbox: SandboxState): void {
    if (deferRootSessionSorting) {
      deferredRootSessionOrder.add(sandbox);
      return;
    }
    updateRootSessionOrder(sandbox);
  }

  function flushDeferredRootSessionOrder(): void {
    for (const sandbox of deferredRootSessionOrder) updateRootSessionOrder(sandbox);
    deferredRootSessionOrder.clear();
  }

  function findSessionEntry(
    sessionId: string,
    preferredProjectId?: string,
  ): SessionEntry | undefined {
    if (!sessionId || !isSafeRecordKey(sessionId)) return undefined;
    const preferred = preferredProjectId?.trim();
    if (preferred && !isSafeRecordKey(preferred)) return undefined;
    if (preferred) {
      const project = state.projects[preferred];
      if (project) {
        for (const [directory, sandbox] of Object.entries(project.sandboxes)) {
          const session = sandbox.sessions[sessionId];
          if (!session) continue;
          return {
            projectId: preferred,
            directory,
            session,
          };
        }
      }
    }

    const indexed = sessionLocationById.get(sessionId);
    if (indexed) {
      const project = state.projects[indexed.projectId];
      const sandbox = project?.sandboxes[indexed.directory];
      const session = sandbox?.sessions[sessionId];
      if (session) {
        return {
          projectId: indexed.projectId,
          directory: indexed.directory,
          session,
        };
      }
    }

    for (const [projectId, project] of Object.entries(state.projects)) {
      for (const [directory, sandbox] of Object.entries(project.sandboxes)) {
        const session = sandbox.sessions[sessionId];
        if (!session) continue;
        return {
          projectId,
          directory,
          session,
        };
      }
    }
    return undefined;
  }

  function removeSession(sessionId: string, preferredProjectId?: string): string | null {
    if (!isSafeRecordKey(sessionId)) return null;
    const preferred = preferredProjectId?.trim();
    if (preferred && !isSafeRecordKey(preferred)) return null;
    const entry = findSessionEntry(sessionId, preferredProjectId);
    if (!entry) return null;
    const project = state.projects[entry.projectId];
    const sandbox = project?.sandboxes[entry.directory];
    if (!project || !sandbox) return null;
    delete sandbox.sessions[sessionId];
    sessionLocationById.delete(sessionId);
    ephemeralLastSeenAt.delete(sessionId);
    ephemeralLastActiveAt.delete(sessionId);
    authoritativeChildSessionIds.delete(sessionId);
    pendingStatusBySessionId.delete(sessionId);
    updateRootSessionOrderOrDefer(sandbox);
    return entry.projectId;
  }

  function resolveRootSessionIdInProject(sessionId: string, projectId: string): string {
    if (!sessionId) return sessionId;
    const visited = new Set<string>();
    let current = sessionId;
    while (current && !visited.has(current)) {
      visited.add(current);
      const entry = findSessionEntry(current, projectId);
      const parentId = entry?.session.parentID?.trim();
      if (!parentId) return current;
      current = parentId;
    }
    return current || sessionId;
  }

  function collectDescendantIds(projectId: string, rootSessionId: string): string[] {
    const project = state.projects[projectId];
    if (!project) return [];

    const descendants: string[] = [];
    const queue = [rootSessionId];
    const visited = new Set<string>([rootSessionId]);

    while (queue.length > 0) {
      const parentId = queue.shift();
      if (!parentId) continue;

      Object.values(project.sandboxes).forEach((sandbox) => {
        Object.values(sandbox.sessions).forEach((session) => {
          if (session.parentID !== parentId) return;
          if (visited.has(session.id)) return;
          visited.add(session.id);
          descendants.push(session.id);
          queue.push(session.id);
        });
      });
    }

    return descendants;
  }

  function moveSessionWithinProject(projectId: string, sessionId: string, targetDirectory: string) {
    const entry = findSessionEntry(sessionId, projectId);
    if (!entry) return;
    const project = state.projects[projectId];
    if (!project) return;
    const source = project.sandboxes[entry.directory];
    const target = ensureSandbox(project, targetDirectory);
    if (!source || !target) return;
    if (entry.directory === target.directory) return;

    const nextSession: SessionState = {
      ...entry.session,
      directory: target.directory,
    };

    delete source.sessions[sessionId];
    target.sessions[sessionId] = nextSession;
    sessionLocationById.set(sessionId, { projectId, directory: target.directory });
    updateRootSessionOrderOrDefer(source);
    updateRootSessionOrderOrDefer(target);
  }

  function moveRootDescendantsToRootSandbox(
    projectId: string,
    rootSessionId: string,
    rootDirectory: string,
  ) {
    const descendantIds = collectDescendantIds(projectId, rootSessionId);
    descendantIds.forEach((sessionId) => {
      moveSessionWithinProject(projectId, sessionId, rootDirectory);
    });
  }

  function pruneEphemeralChildren() {
    const now = Date.now();
    const stale: Array<{ sessionId: string; projectId: string }> = [];

    Object.entries(state.projects).forEach(([projectId, project]) => {
      Object.values(project.sandboxes).forEach((sandbox) => {
        Object.values(sandbox.sessions).forEach((session) => {
          if (!session.parentID) return;
          if (authoritativeChildSessionIds.has(session.id)) return;
          if (session.status === 'busy' || session.status === 'retry') return;
          const seenAt =
            ephemeralLastSeenAt.get(session.id) ??
            session.timeUpdated ??
            session.timeCreated ??
            now;
          const activeAt = ephemeralLastActiveAt.get(session.id) ?? seenAt;
          if (now - activeAt < CHILD_SESSION_PRUNE_TTL_MS) return;
          stale.push({ sessionId: session.id, projectId });
        });
      });
    });

    stale.forEach(({ sessionId, projectId }) => {
      removeSession(sessionId, projectId);
    });
  }

  function upsertSession(info: SessionMutationInfo): string | null {
    if (!info?.id || !isSafeRecordKey(info.id)) return null;
    const incomingDirectory = normalizeDirectory(info.directory);
    if (incomingDirectory && !isSafeRecordKey(incomingDirectory)) return null;
    const existing = findSessionEntry(info.id);
    const resolvedProjectId = info.projectID?.trim();
    if (!resolvedProjectId || !isSafeRecordKey(resolvedProjectId)) return null;

    let project = state.projects[resolvedProjectId];
    if (!project) {
      project = { id: resolvedProjectId, worktree: '', sandboxes: {} };
      state.projects[resolvedProjectId] = project;
    }
    const incomingParentId = info.parentID?.trim() || undefined;
    const previous = existing?.session;
    const parentID = incomingParentId ?? previous?.parentID;
    const replayedStatus = pendingStatusBySessionId.get(info.id);
    const hasRevert = Object.prototype.hasOwnProperty.call(info, 'revert');
    const revert = hasRevert ? info.revert : previous?.revert;

    let targetDirectory =
      normalizeSafeDirectory(info.directory) ||
      normalizeSafeDirectory(existing?.directory) ||
      normalizeSafeDirectory(project.worktree) ||
      '/';

    if (parentID) {
      const rootId = resolveRootSessionIdInProject(parentID, resolvedProjectId);
      const rootEntry = findSessionEntry(rootId, resolvedProjectId);
      if (rootEntry?.directory) {
        targetDirectory = normalizeSafeDirectory(rootEntry.directory) || targetDirectory;
      }
    }

    const sandbox = ensureSandbox(project, targetDirectory);
    const next: SessionState = {
      id: info.id,
      title: info.title ?? previous?.title,
      slug: info.slug ?? previous?.slug,
      parentID,
      status: replayedStatus ?? previous?.status,
      directory: sandbox.directory,
      timeCreated: info.time?.created ?? previous?.timeCreated,
      timeUpdated: info.time?.updated ?? previous?.timeUpdated,
      timeArchived: info.time?.archived ?? previous?.timeArchived,
      timePinned: info.time?.pinned ?? previous?.timePinned,
      revert,
    };

    const hasSameProject = existing?.projectId === resolvedProjectId;
    const hasSameDirectory = normalizeDirectory(existing?.directory) === sandbox.directory;
    const unchanged =
      Boolean(previous) &&
      hasSameProject &&
      hasSameDirectory &&
      previous?.title === next.title &&
      previous?.slug === next.slug &&
      previous?.parentID === next.parentID &&
      previous?.status === next.status &&
      previous?.timeCreated === next.timeCreated &&
      previous?.timeUpdated === next.timeUpdated &&
      previous?.timeArchived === next.timeArchived &&
      previous?.timePinned === next.timePinned &&
      isSameRevert(previous?.revert, next.revert);
    if (unchanged) return null;

    if (existing && (!hasSameProject || !hasSameDirectory)) {
      const existingProject = state.projects[existing.projectId];
      const existingSandbox = existingProject?.sandboxes[existing.directory];
      if (existingSandbox) {
        delete existingSandbox.sessions[info.id];
        updateRootSessionOrderOrDefer(existingSandbox);
      }
    }

    sandbox.sessions[info.id] = next;
    sessionLocationById.set(info.id, {
      projectId: resolvedProjectId,
      directory: sandbox.directory,
    });
    pendingStatusBySessionId.delete(info.id);
    updateRootSessionOrderOrDefer(sandbox);

    if (next.parentID) {
      const now = Date.now();
      ephemeralLastSeenAt.set(next.id, now);
      if (next.status === 'busy' || next.status === 'retry') {
        ephemeralLastActiveAt.set(next.id, now);
      }
    } else {
      ephemeralLastSeenAt.delete(next.id);
      ephemeralLastActiveAt.delete(next.id);
      moveRootDescendantsToRootSandbox(resolvedProjectId, next.id, sandbox.directory);
    }

    return resolvedProjectId;
  }

  function applyProject(project: ProjectInfo): boolean {
    if (!project?.id || !isSafeRecordKey(project.id)) return false;
    const existed = Boolean(state.projects[project.id]);
    const incomingWorktree = normalizeDirectory(project.worktree);
    if (incomingWorktree && !isSafeRecordKey(incomingWorktree)) return false;
    const worktree = normalizeSafeDirectory(project.worktree) || '/';
    const target = ensureProject(project.id, worktree);

    let changed = !existed;
    if (target.worktree !== worktree) {
      target.worktree = worktree;
      changed = true;
    }

    const nextName = resolveProjectName(project.id, project.name);
    if (target.name !== nextName) {
      target.name = nextName;
      changed = true;
    }

    const nextIcon = project.icon
      ? {
          url: project.icon.url,
          override: project.icon.override,
          color: project.icon.color,
        }
      : undefined;
    if (JSON.stringify(target.icon) !== JSON.stringify(nextIcon)) {
      target.icon = nextIcon;
      changed = true;
    }

    const nextCommands = project.commands
      ? {
          start: project.commands.start,
        }
      : undefined;
    if (JSON.stringify(target.commands) !== JSON.stringify(nextCommands)) {
      target.commands = nextCommands;
      changed = true;
    }

    const nextTime = project.time
      ? {
          created: project.time.created,
          updated: project.time.updated,
          initialized: project.time.initialized,
        }
      : undefined;
    if (JSON.stringify(target.time) !== JSON.stringify(nextTime)) {
      target.time = nextTime;
      changed = true;
    }

    const hadRootSandbox = Boolean(target.sandboxes[worktree]);
    const rootSandbox = ensureSandbox(target, worktree);
    if (!hadRootSandbox) changed = true;
    if (!rootSandbox.rootSessions) rootSandbox.rootSessions = [];

    const directories = new Set<string>([worktree]);
    sanitizeDirectoryList(project.sandboxes).forEach((directory) => {
      directories.add(directory);
    });

    directories.forEach((directory) => {
      const hadSandbox = Boolean(target.sandboxes[directory]);
      const sandbox = ensureSandbox(target, directory);
      if (!hadSandbox) changed = true;
      if (!sandbox.name) sandbox.name = '';
      if (!sandbox.rootSessions) sandbox.rootSessions = [];
      if (!sandbox.sessions) sandbox.sessions = {};
    });

    // Global never reports sandboxes; skip prune so session.created directories survive.
    const incomingSandboxes = sanitizeDirectoryList(project.sandboxes);
    const skipPrune = project.id === 'global' && incomingSandboxes.length === 0;

    if (!skipPrune) {
      for (const directory of Object.keys(target.sandboxes)) {
        if (!directories.has(directory)) {
          delete target.sandboxes[directory];
          changed = true;
        }
      }
    }

    indexProjectDirectories(target);
    return changed;
  }

  function applyProjects(projects: ProjectInfo[]) {
    (Array.isArray(projects) ? projects : []).forEach((project) => {
      applyProject(project);
    });
  }

  function applySessions(sessions: SessionInfo[]) {
    const list = Array.isArray(sessions) ? sessions : [];
    const wasDeferred = deferRootSessionSorting;
    deferRootSessionSorting = true;
    try {
      list.forEach((session) => {
        upsertSession({
          ...session,
          revert: session.revert,
        });
      });
    } finally {
      deferRootSessionSorting = wasDeferred;
      if (!wasDeferred) flushDeferredRootSessionOrder();
    }
  }

  function applySessionSnapshot(
    sessions: SessionInfo[],
    snapshotToken: SnapshotToken,
  ): void {
    if (!isUsableSnapshot(snapshotToken, activeMutationSnapshots)) return;
    applySessions(
      (Array.isArray(sessions) ? sessions : []).filter(
        (session) =>
          (mutationRevisionBySessionId.get(session.id) ?? 0) <= snapshotToken.baseline,
      ),
    );
  }

  function applyAuthoritativeSessions(sessions: SessionInfo[]) {
    const list = Array.isArray(sessions) ? sessions : [];
    list.forEach((session) => {
      if (isSafeRecordKey(session.id) && session.parentID?.trim()) {
        authoritativeChildSessionIds.add(session.id);
      }
    });
    applySessions(list);
  }

  function applyStatuses(statusMap: Record<string, { type?: string }>) {
    Object.entries(statusMap ?? {}).forEach(([sessionId, info]) => {
      if (!isSafeRecordKey(sessionId)) return;
      const type = info?.type;
      if (!type || !isSessionStatus(type)) return;
      const entry = findSessionEntry(sessionId);
      if (!entry) {
        bufferPendingStatus(sessionId, type);
        return;
      }
      if (entry.session.status === type) return;
      entry.session.status = type;
      if (type === 'busy' || type === 'retry') {
        ephemeralLastActiveAt.set(sessionId, Date.now());
      }
    });
    pruneEphemeralChildren();
  }

  function applyStatusSnapshot(
    sessionIds: string[],
    statusMap: Record<string, { type?: string }>,
    snapshotToken?: SnapshotToken,
  ): void {
    if (
      snapshotToken &&
      !isUsableSnapshot(snapshotToken, activeStatusSnapshots)
    )
      return;
    const maximumStatusRevision = snapshotToken?.baseline ?? Number.POSITIVE_INFINITY;
    const applicableStatuses = Object.fromEntries(
      Object.entries(statusMap).filter(
        ([sessionId]) =>
          isSafeRecordKey(sessionId) &&
          (!snapshotToken ||
            (statusSnapshotFenceBySessionId.get(sessionId) ?? 0) < snapshotToken.sequence) &&
          (statusRevisionBySessionId.get(sessionId) ?? 0) <= maximumStatusRevision,
      ),
    );
    if (snapshotToken && !isUsableSnapshot(snapshotToken, activeStatusSnapshots)) return;
    if (!snapshotToken) Object.keys(applicableStatuses).forEach(recordStatusRevision);
    applyStatuses(applicableStatuses);
    if (snapshotToken) {
      Object.keys(applicableStatuses).forEach((sessionId) => {
        statusSnapshotFenceBySessionId.set(sessionId, snapshotToken.sequence);
      });
    }
    for (const sessionId of sessionIds) {
      if (!isSafeRecordKey(sessionId)) continue;
      if (sessionId in statusMap) continue;
      if (
        snapshotToken &&
        (statusSnapshotFenceBySessionId.get(sessionId) ?? 0) >= snapshotToken.sequence
      )
        continue;
      if ((statusRevisionBySessionId.get(sessionId) ?? 0) > maximumStatusRevision) continue;
      if (snapshotToken && !isUsableSnapshot(snapshotToken, activeStatusSnapshots)) return;
      if (!snapshotToken) recordStatusRevision(sessionId);
      if (snapshotToken) statusSnapshotFenceBySessionId.set(sessionId, snapshotToken.sequence);
      pendingStatusBySessionId.delete(sessionId);
      const entry = findSessionEntry(sessionId);
      if (!entry?.session.status) continue;
      const sandbox = state.projects[entry.projectId]?.sandboxes[entry.directory];
      if (sandbox) sandbox.sessions[sessionId] = { ...entry.session, status: undefined };
    }
  }

  function applyVcsInfo(directory: string, info: { branch: string }) {
    const branch = info?.branch?.trim();
    const normalizedDirectory = normalizeSafeDirectory(directory);
    if (!branch || !normalizedDirectory) return;

    let projectId = resolveProjectIdForDirectory(normalizedDirectory);
    if (!projectId) {
      projectId = getDefaultProjectId();
    }
    const project = ensureProject(projectId, normalizedDirectory);
    const sandbox = ensureSandbox(project, normalizedDirectory);
    sandbox.name = branch;
    indexProjectDirectories(project);
  }

  function processSessionCreated(info: SessionInfo): string | null {
    const directory = normalizeDirectory(info.directory);
    if (directory && !isSafeRecordKey(directory)) return null;
    recordSessionMutation(info.id);
    if (info.parentID?.trim()) authoritativeChildSessionIds.add(info.id);
    const changed = upsertSession({
      ...info,
      revert: info.revert,
    });
    pruneEphemeralChildren();
    return changed;
  }

  function processSessionUpdated(info: SessionInfo): string | null {
    const directory = normalizeDirectory(info.directory);
    if (directory && !isSafeRecordKey(directory)) return null;
    recordSessionMutation(info.id);
    const changed = upsertSession({
      ...info,
      revert: info.revert,
    });
    pruneEphemeralChildren();
    return changed;
  }

  function processSessionDeleted(sessionId: string, projectId?: string): string | null {
    const normalizedProjectId = projectId?.trim();
    if (
      !isSafeRecordKey(sessionId) ||
      (normalizedProjectId !== undefined && !isSafeRecordKey(normalizedProjectId))
    )
      return null;
    recordSessionMutation(sessionId);
    recordStatusRevision(sessionId);
    pendingStatusBySessionId.delete(sessionId);
    const changed = removeSession(sessionId, projectId);
    pruneEphemeralChildren();
    return changed;
  }

  function processSessionStatus(
    sessionId: string,
    status: string,
    projectId?: string,
  ): string | null {
    const normalizedProjectId = projectId?.trim();
    if (
      !isSafeRecordKey(sessionId) ||
      (normalizedProjectId !== undefined && !isSafeRecordKey(normalizedProjectId)) ||
      !isSessionStatus(status)
    )
      return null;
    recordStatusRevision(sessionId);
    const entry = findSessionEntry(sessionId, projectId);
    if (!entry) {
      bufferPendingStatus(sessionId, status);
      return null;
    }
    pendingStatusBySessionId.delete(sessionId);
    if (entry.session.status === status) return null;
    entry.session.status = status;
    if (status === 'busy' || status === 'retry') {
      ephemeralLastActiveAt.set(sessionId, Date.now());
    }
    pruneEphemeralChildren();
    return entry.projectId;
  }

  function beginStatusSnapshot() {
    return beginSnapshot(statusRevision, activeStatusSnapshots);
  }

  function completeStatusSnapshot(token: SnapshotToken) {
    completeSnapshot(token, activeStatusSnapshots, statusRevisionBySessionId);
    let oldestActiveSequence = Number.POSITIVE_INFINITY;
    for (const snapshot of activeStatusSnapshots) {
      if (!snapshot.invalidated) {
        oldestActiveSequence = Math.min(oldestActiveSequence, snapshot.sequence);
      }
    }
    if (oldestActiveSequence === Number.POSITIVE_INFINITY) {
      statusSnapshotFenceBySessionId.clear();
      return;
    }
    for (const [sessionId, sequence] of statusSnapshotFenceBySessionId) {
      if (sequence < oldestActiveSequence) statusSnapshotFenceBySessionId.delete(sessionId);
    }
  }

  function beginMutationSnapshot() {
    return beginSnapshot(mutationRevision, activeMutationSnapshots);
  }

  function completeMutationSnapshot(token: SnapshotToken) {
    completeSnapshot(token, activeMutationSnapshots, mutationRevisionBySessionId);
  }

  function consumeSnapshotOverflow(): boolean {
    if (!snapshotOverflowed) return false;
    snapshotOverflowed = false;
    return true;
  }

  function processProjectUpdated(project: ProjectInfo): string | null {
    const changed = applyProject(project);
    return changed ? project.id : null;
  }

  function processVcsBranchUpdated(directory: string, branch: string): string | null {
    const normalizedDirectory = normalizeSafeDirectory(directory);
    const normalizedBranch = branch?.trim();
    if (!normalizedDirectory || !normalizedBranch) return null;

    let projectId = resolveProjectIdForDirectory(normalizedDirectory);
    if (!projectId) {
      projectId = getDefaultProjectId();
    }
    const project = ensureProject(projectId, normalizedDirectory);
    const sandbox = ensureSandbox(project, normalizedDirectory);
    if (sandbox.name === normalizedBranch) return null;
    sandbox.name = normalizedBranch;
    return project.id;
  }

  function registerSandboxDirectory(projectId: string, directory: string): string | null {
    const normalizedProjectId = projectId.trim();
    const normalizedDirectory = normalizeSafeDirectory(directory);
    if (
      !normalizedProjectId ||
      !isSafeRecordKey(normalizedProjectId) ||
      !normalizedDirectory
    )
      return null;
    const project = state.projects[normalizedProjectId];
    if (!project) return null;
    if (project.sandboxes[normalizedDirectory]) {
      projectIdByDirectory.set(normalizedDirectory, normalizedProjectId);
      return null;
    }
    ensureSandbox(project, normalizedDirectory);
    indexProjectDirectories(project);
    return normalizedProjectId;
  }

  function removeSandboxDirectory(projectId: string, directory: string): string | null {
    const normalizedProjectId = projectId.trim();
    const normalizedDirectory = normalizeSafeDirectory(directory);
    if (
      !normalizedProjectId ||
      !isSafeRecordKey(normalizedProjectId) ||
      !normalizedDirectory
    )
      return null;

    const project = state.projects[normalizedProjectId];
    if (!project) return null;

    const worktreeDirectory = normalizeSafeDirectory(project.worktree);
    if (!worktreeDirectory || normalizedDirectory === worktreeDirectory) {
      return null;
    }

    const sandbox = project.sandboxes[normalizedDirectory];
    if (!sandbox) return null;

    Object.keys(sandbox.sessions).forEach((sessionId) => {
      sessionLocationById.delete(sessionId);
      ephemeralLastSeenAt.delete(sessionId);
      ephemeralLastActiveAt.delete(sessionId);
      authoritativeChildSessionIds.delete(sessionId);
    });

    delete project.sandboxes[normalizedDirectory];
    indexProjectDirectories(project);
    return normalizedProjectId;
  }

  function applySessionMutated(info: SessionMutationInfo): string | null {
    const changed = upsertSession(info);
    pruneEphemeralChildren();
    return changed;
  }

  function applySessionRemoved(sessionId: string, projectId?: string): string | null {
    const normalizedProjectId = projectId?.trim();
    if (
      !isSafeRecordKey(sessionId) ||
      (normalizedProjectId !== undefined && !isSafeRecordKey(normalizedProjectId))
    )
      return null;
    const changed = removeSession(sessionId, projectId);
    pruneEphemeralChildren();
    return changed;
  }

  function getState() {
    return state;
  }

  function getDefaultProjectId() {
    if (!state.projects.global) {
      const global = createDefaultProject('global', '/');
      state.projects.global = global;
      rebuildIndexes();
    }
    if (!state.projects.global.name?.trim()) {
      state.projects.global.name = GLOBAL_PROJECT_NAME;
    }
    return 'global';
  }

  function resolveRootSessionIdForProject(projectId: string, sessionId: string): string {
    const normalizedProjectId = projectId.trim();
    const normalizedSessionId = sessionId.trim();
    if (
      !normalizedProjectId ||
      !normalizedSessionId ||
      !isSafeRecordKey(normalizedProjectId) ||
      !isSafeRecordKey(normalizedSessionId)
    )
      return '';
    return resolveRootSessionIdInProject(normalizedSessionId, normalizedProjectId);
  }

  function isSessionTreeIdle(projectId: string, sessionId: string): boolean {
    const normalizedProjectId = projectId.trim();
    const normalizedSessionId = sessionId.trim();
    if (
      !normalizedProjectId ||
      !normalizedSessionId ||
      !isSafeRecordKey(normalizedProjectId) ||
      !isSafeRecordKey(normalizedSessionId)
    )
      return false;

    const rootSessionId = resolveRootSessionIdInProject(normalizedSessionId, normalizedProjectId);
    if (!rootSessionId) return false;

    const project = state.projects[normalizedProjectId];
    if (!project) return false;

    const childrenByParent = new Map<string, string[]>();
    for (const sandbox of Object.values(project.sandboxes)) {
      for (const session of Object.values(sandbox.sessions)) {
        const parentId = session.parentID?.trim();
        if (!parentId || !isSafeRecordKey(session.id)) continue;
        const children = childrenByParent.get(parentId) ?? [];
        children.push(session.id);
        childrenByParent.set(parentId, children);
      }
    }

    const queue = [rootSessionId];
    const visited = new Set<string>();
    let queueIndex = 0;

    while (queueIndex < queue.length) {
      const currentId = queue[queueIndex];
      queueIndex += 1;
      if (!currentId || visited.has(currentId)) continue;
      visited.add(currentId);

      const entry = findSessionEntry(currentId, normalizedProjectId);
      if (!entry) return false;
      if (entry.session.status !== 'idle') return false;

      for (const childId of childrenByParent.get(currentId) ?? []) {
        if (!visited.has(childId)) queue.push(childId);
      }
    }

    return true;
  }

  return {
    applyProjects,
    applySessions,
    applySessionSnapshot,
    applyAuthoritativeSessions,
    applyStatuses,
    applyStatusSnapshot,
    beginStatusSnapshot,
    completeStatusSnapshot,
    consumeSnapshotOverflow,
    beginMutationSnapshot,
    completeMutationSnapshot,
    applyVcsInfo,
    processSessionCreated,
    processSessionUpdated,
    processSessionDeleted,
    processSessionStatus,
    processProjectUpdated,
    processVcsBranchUpdated,
    registerSandboxDirectory,
    removeSandboxDirectory,
    applySessionMutated,
    applySessionRemoved,
    resolveProjectIdForDirectory,
    getState,
    getProject,
    getDefaultProjectId,
    resolveRootSessionIdForProject,
    isSessionTreeIdle,
  };
}
