export type ProjectEntry = {
  id: string;
  worktree?: string;
  sandboxes?: string[];
};

export type SessionGraphSession = {
  id: string;
  projectID?: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  time?: {
    created?: number;
    updated?: number;
    archived?: number;
  };
};

type SessionStatusType = 'busy' | 'idle' | 'retry';

type SessionNode = {
  key: string;
  sessionID: string;
  projectID: string;
  parentID?: string;
  title?: string;
  slug?: string;
  directory?: string;
  timeCreated?: number;
  timeUpdated?: number;
  timeArchived?: number;
  retention: 'persistent' | 'ephemeral';
  lastSeenAt: number;
  lastActiveAt?: number;
};

type SandboxEntry = {
  worktree: string;
  directory: string;
  projectID?: string;
  branch?: string;
  sessionIDs: Set<string>;
};

type UpsertOptions = {
  projectIDHint?: string;
  directoryHint?: string;
  retention?: 'persistent' | 'ephemeral';
};

type RootQuery = {
  projectID?: string;
  directory?: string;
};

function normalizeDirectory(value?: string) {
  if (!value) return '';
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\/+$/, '');
  return normalized || '/';
}

function buildSessionKey(projectID: string, sessionID: string) {
  return `${projectID}:${sessionID}`;
}

function sortByUpdatedDesc(a: SessionNode, b: SessionNode) {
  return (b.timeUpdated ?? b.timeCreated ?? 0) - (a.timeUpdated ?? a.timeCreated ?? 0);
}

export function createSessionGraphStore() {
  const tree = new Map<string, Map<string, SandboxEntry>>();
  const nodesByKey = new Map<string, SessionNode>();
  const sessionIndex = new Map<string, string>();
  const statusByKey = new Map<string, SessionStatusType>();
  let version = 0;

  function bump() {
    version += 1;
  }

  function forEachSandbox(fn: (entry: SandboxEntry, sandbox: string, worktree: string) => void) {
    tree.forEach((sandboxes, worktree) => {
      sandboxes.forEach((entry, sandbox) => {
        fn(entry, sandbox, worktree);
      });
    });
  }

  function findNewestNodeBySessionID(sessionID: string) {
    let newest: SessionNode | undefined;
    nodesByKey.forEach((node) => {
      if (node.sessionID !== sessionID) return;
      if (!newest || sortByUpdatedDesc(node, newest) < 0) newest = node;
    });
    return newest;
  }

  function resolveNodeKey(sessionID: string, projectID?: string) {
    if (!sessionID) return '';
    if (projectID) {
      const exactKey = buildSessionKey(projectID, sessionID);
      if (nodesByKey.has(exactKey)) return exactKey;
    }

    const indexedDirectory = sessionIndex.get(sessionID);
    if (indexedDirectory) {
      const indexedSandbox = getSandboxByDirectory(indexedDirectory);
      if (indexedSandbox?.projectID) {
        const indexedKey = buildSessionKey(indexedSandbox.projectID, sessionID);
        if (nodesByKey.has(indexedKey)) return indexedKey;
      }
    }

    return findNewestNodeBySessionID(sessionID)?.key ?? '';
  }

  function getSandboxByDirectory(directory?: string) {
    const target = normalizeDirectory(directory);
    if (!target) return undefined;
    let found: SandboxEntry | undefined;
    forEachSandbox((entry, sandbox) => {
      if (found) return;
      if (normalizeDirectory(sandbox) === target) found = entry;
    });
    return found;
  }

  function ensureSandbox(worktreeRaw?: string, sandboxRaw?: string) {
    let worktree = normalizeDirectory(worktreeRaw);
    const sandbox = normalizeDirectory(sandboxRaw);
    if (!sandbox) return undefined;
    if (!worktree) worktree = sandbox;

    const existing = getSandboxByDirectory(sandbox);
    if (existing) {
      const currentWorktree = normalizeDirectory(existing.worktree) || sandbox;
      if (currentWorktree !== worktree) {
        const currentMap = tree.get(currentWorktree);
        if (currentMap) {
          currentMap.delete(sandbox);
          if (currentMap.size === 0) tree.delete(currentWorktree);
        }
        const nextMap = tree.get(worktree) ?? new Map<string, SandboxEntry>();
        existing.worktree = worktree;
        nextMap.set(sandbox, existing);
        tree.set(worktree, nextMap);
        bump();
      }
      return existing;
    }

    const sandboxes = tree.get(worktree) ?? new Map<string, SandboxEntry>();
    const created: SandboxEntry = {
      worktree,
      directory: sandbox,
      sessionIDs: new Set<string>(),
    };
    sandboxes.set(sandbox, created);
    tree.set(worktree, sandboxes);
    bump();
    return created;
  }

  function getSandbox(worktreeRaw: string, sandboxRaw: string) {
    const worktree = normalizeDirectory(worktreeRaw);
    const sandbox = normalizeDirectory(sandboxRaw);
    if (!worktree || !sandbox) return undefined;
    return tree.get(worktree)?.get(sandbox);
  }

  function getWorktreeEntries(worktreeRaw: string) {
    const worktree = normalizeDirectory(worktreeRaw);
    if (!worktree) return undefined;
    return tree.get(worktree);
  }

  function getWorktreeList() {
    return Array.from(tree.keys());
  }

  function getSandboxList(worktreeRaw: string) {
    const sandboxes = getWorktreeEntries(worktreeRaw);
    if (!sandboxes) return [] as string[];
    return Array.from(sandboxes.keys());
  }

  function setSandboxProjectID(sandboxRaw: string, projectID: string) {
    const sandbox = getSandboxByDirectory(sandboxRaw);
    if (!sandbox || !projectID) return false;
    if (sandbox.projectID === projectID) return false;
    sandbox.projectID = projectID;
    bump();
    return true;
  }

  function setSandboxBranch(sandboxRaw: string, branch: string) {
    const sandboxDirectory = normalizeDirectory(sandboxRaw);
    const normalizedBranch = branch?.trim();
    if (!sandboxDirectory || !normalizedBranch) return false;
    const sandbox = getSandboxByDirectory(sandboxDirectory) ?? ensureSandbox(sandboxDirectory, sandboxDirectory);
    if (!sandbox) return false;
    if (sandbox.branch === normalizedBranch) return false;
    sandbox.branch = normalizedBranch;
    bump();
    return true;
  }

  function getProjectRootForProject(projectID: string) {
    if (!projectID) return '';
    let found = '';
    forEachSandbox((entry, sandbox, worktree) => {
      if (found) return;
      if (entry.projectID !== projectID) return;
      if (normalizeDirectory(sandbox) === normalizeDirectory(worktree)) {
        found = worktree;
      }
    });
    if (found) return found;
    forEachSandbox((entry, _sandbox, worktree) => {
      if (found) return;
      if (entry.projectID === projectID) found = worktree;
    });
    return found;
  }

  function getDirectoriesForProject(projectID: string) {
    if (!projectID) return [] as string[];
    const result = new Set<string>();
    forEachSandbox((entry, sandbox) => {
      if (entry.projectID === projectID) result.add(sandbox);
    });
    return Array.from(result);
  }

  function getProjectDirectoryForProject(projectID: string) {
    const directories = getDirectoriesForProject(projectID);
    return directories[0] ?? '';
  }

  function getProjectIDsForDirectory(directory?: string) {
    const sandbox = getSandboxByDirectory(directory);
    if (!sandbox?.projectID) return [] as string[];
    return [sandbox.projectID];
  }

  function resolveProjectIDForDirectory(directory?: string) {
    return getProjectIDsForDirectory(directory)[0] ?? '';
  }

  function addDirectoryCandidate(directory: string, projectID: string) {
    const dir = normalizeDirectory(directory);
    if (!dir || !projectID) return;
    const worktree = getProjectRootForProject(projectID) || dir;
    const sandbox = ensureSandbox(worktree, dir);
    if (!sandbox) return;
    if (sandbox.projectID === projectID) return;
    sandbox.projectID = projectID;
    bump();
  }

  function setProjectRoot(projectID: string, directory: string) {
    const dir = normalizeDirectory(directory);
    if (!projectID || !dir) return;
    const rootEntry = ensureSandbox(dir, dir);
    if (!rootEntry) return;
    if (rootEntry.projectID !== projectID) {
      rootEntry.projectID = projectID;
      bump();
    }
  }

  function setProjectDirectory(projectID: string, directory: string) {
    addDirectoryCandidate(directory, projectID);
  }

  function refreshSessionIndex(sessionID: string) {
    const newest = findNewestNodeBySessionID(sessionID);
    if (!newest?.directory) {
      sessionIndex.delete(sessionID);
      return;
    }
    const sandbox = getSandboxByDirectory(newest.directory);
    if (!sandbox) {
      sessionIndex.delete(sessionID);
      return;
    }
    sandbox.sessionIDs.add(sessionID);
    sessionIndex.set(sessionID, sandbox.directory);
  }

  function detachSessionFromAllSandboxes(sessionID: string) {
    forEachSandbox((entry) => {
      entry.sessionIDs.delete(sessionID);
    });
  }

  function syncSandboxes(worktreeRaw: string, sandboxDirs: string[]) {
    let worktree = normalizeDirectory(worktreeRaw);
    if (!worktree) {
      const first = normalizeDirectory((sandboxDirs ?? [])[0]);
      worktree = first;
    }
    if (!worktree) return false;

    const wanted = new Set<string>();
    wanted.add(worktree);
    (sandboxDirs ?? []).forEach((dir) => {
      const normalized = normalizeDirectory(dir);
      if (normalized) wanted.add(normalized);
    });

    let changed = false;
    wanted.forEach((sandbox) => {
      if (!getSandbox(worktree, sandbox)) {
        ensureSandbox(worktree, sandbox);
        changed = true;
      }
    });

    const current = getWorktreeEntries(worktree);
    if (!current) return changed;
    const stale = Array.from(current.keys()).filter((sandbox) => !wanted.has(sandbox));
    stale.forEach((sandbox) => {
      const entry = current.get(sandbox);
      if (!entry) return;
      const affectedSessionIDs = Array.from(entry.sessionIDs);
      nodesByKey.forEach((node, key) => {
        if (normalizeDirectory(node.directory) !== sandbox) return;
        nodesByKey.delete(key);
        statusByKey.delete(key);
      });
      current.delete(sandbox);
      affectedSessionIDs.forEach((sessionID) => refreshSessionIndex(sessionID));
      changed = true;
    });
    if (current.size === 0) tree.delete(worktree);
    if (changed) bump();
    return changed;
  }

  function upsertSession(info: SessionGraphSession, options: UpsertOptions = {}) {
    if (!info?.id) return false;
    const existingKey = resolveNodeKey(info.id, info.projectID || options.projectIDHint);
    const existing = existingKey ? nodesByKey.get(existingKey) : undefined;
    const projectID =
      (info.projectID && info.projectID.trim()) ||
      (options.projectIDHint && options.projectIDHint.trim()) ||
      existing?.projectID ||
      '';
    if (!projectID) return false;

    const key = buildSessionKey(projectID, info.id);
    const previous = nodesByKey.get(key);
    const retention =
      options.retention ??
      previous?.retention ??
      (typeof info.parentID === 'string' && info.parentID ? 'ephemeral' : 'persistent');

    const directory =
      normalizeDirectory(info.directory) ||
      normalizeDirectory(options.directoryHint) ||
      normalizeDirectory(previous?.directory) ||
      normalizeDirectory(existing?.directory);

    let sandbox: SandboxEntry | undefined;
    if (directory) {
      sandbox = getSandboxByDirectory(directory);
      if (!sandbox) {
        const rootForProject = getProjectRootForProject(projectID);
        sandbox = ensureSandbox(rootForProject || directory, directory);
      }
    }
    if (!sandbox) {
      const rootForProject = getProjectRootForProject(projectID);
      const fallback = rootForProject || '/';
      sandbox = ensureSandbox(fallback, fallback);
    }
    if (!sandbox) return false;

    if (sandbox.projectID !== projectID) sandbox.projectID = projectID;

    const next: SessionNode = {
      key,
      sessionID: info.id,
      projectID,
      parentID: info.parentID ?? previous?.parentID,
      title: info.title ?? previous?.title,
      slug: info.slug ?? previous?.slug,
      directory: sandbox.directory,
      timeCreated: info.time?.created ?? previous?.timeCreated,
      timeUpdated: info.time?.updated ?? previous?.timeUpdated,
      timeArchived: info.time?.archived ?? previous?.timeArchived,
      retention,
      lastSeenAt: Date.now(),
      lastActiveAt: previous?.lastActiveAt,
    };

    if (existing && existing.key !== key) {
      nodesByKey.delete(existing.key);
      statusByKey.delete(existing.key);
    }

    nodesByKey.set(key, next);
    detachSessionFromAllSandboxes(info.id);
    sandbox.sessionIDs.add(info.id);
    sessionIndex.set(info.id, sandbox.directory);
    bump();
    return true;
  }

  function upsertSessions(list: SessionGraphSession[], options: UpsertOptions = {}) {
    let changed = false;
    list.forEach((item) => {
      if (upsertSession(item, options)) changed = true;
    });
    return changed;
  }

  function removeSession(sessionID: string, projectID?: string) {
    if (!sessionID) return false;
    const targets = projectID
      ? [buildSessionKey(projectID, sessionID)]
      : Array.from(nodesByKey.keys()).filter((key) => nodesByKey.get(key)?.sessionID === sessionID);

    let changed = false;
    targets.forEach((key) => {
      if (!nodesByKey.has(key)) return;
      nodesByKey.delete(key);
      statusByKey.delete(key);
      changed = true;
    });
    if (!changed) return false;

    detachSessionFromAllSandboxes(sessionID);
    refreshSessionIndex(sessionID);
    bump();
    return true;
  }

  function setStatus(sessionID: string, status: SessionStatusType, projectID?: string) {
    const key = resolveNodeKey(sessionID, projectID);
    if (!key) return false;
    if (statusByKey.get(key) === status) return false;
    statusByKey.set(key, status);
    const node = nodesByKey.get(key);
    if (node && (status === 'busy' || status === 'retry')) {
      node.lastActiveAt = Date.now();
      node.lastSeenAt = Date.now();
    }
    bump();
    return true;
  }

  function syncStatusesForProject(projectID: string, entries: [string, SessionStatusType][]) {
    if (!projectID) return false;
    const busyKeys = new Set<string>();
    let changed = false;
    entries.forEach(([sessionID, status]) => {
      const key = resolveNodeKey(sessionID, projectID);
      if (!key) return;
      busyKeys.add(key);
      if (statusByKey.get(key) !== status) {
        statusByKey.set(key, status);
        changed = true;
      }
      const node = nodesByKey.get(key);
      if (node && (status === 'busy' || status === 'retry')) node.lastActiveAt = Date.now();
    });
    const prefix = `${projectID}:`;
    statusByKey.forEach((status, key) => {
      const node = nodesByKey.get(key);
      const mappedProjectID = node?.directory
        ? getSandboxByDirectory(node.directory)?.projectID
        : undefined;
      const belongsToSyncedProject = key.startsWith(prefix) || mappedProjectID === projectID;
      if (!belongsToSyncedProject) return;
      if (busyKeys.has(key)) return;
      if (status === 'busy' || status === 'retry') {
        statusByKey.set(key, 'idle');
        changed = true;
      }
    });
    if (changed) bump();
    return changed;
  }

  function getSession(sessionID: string, projectID?: string): SessionGraphSession | undefined {
    const key = resolveNodeKey(sessionID, projectID);
    if (!key) return undefined;
    const node = nodesByKey.get(key);
    if (!node) return undefined;
    return {
      id: node.sessionID,
      projectID: node.projectID,
      parentID: node.parentID,
      title: node.title,
      slug: node.slug,
      directory: node.directory,
      time: {
        created: node.timeCreated,
        updated: node.timeUpdated,
        archived: node.timeArchived,
      },
    };
  }

  function getRootSessions(query: RootQuery = {}) {
    const normalizedDirectory = normalizeDirectory(query.directory);
    return Array.from(nodesByKey.values())
      .filter((node) => !node.parentID)
      .filter((node) => {
        if (query.projectID && node.projectID !== query.projectID) return false;
        if (!normalizedDirectory) return true;
        return normalizeDirectory(node.directory) === normalizedDirectory;
      })
      .sort(sortByUpdatedDesc)
      .map((node) => ({
        id: node.sessionID,
        projectID: node.projectID,
        parentID: node.parentID,
        title: node.title,
        slug: node.slug,
        directory: node.directory,
      time: {
        created: node.timeCreated,
        updated: node.timeUpdated,
        archived: node.timeArchived,
      },
    }));
  }

  function getParentMap(directory?: string) {
    const normalizedDirectory = normalizeDirectory(directory);
    const map = new Map<string, string | undefined>();
    nodesByKey.forEach((node) => {
      if (normalizedDirectory && normalizeDirectory(node.directory) !== normalizedDirectory) return;
      map.set(node.sessionID, node.parentID);
    });
    return map;
  }

  function getProjectIDForSession(sessionID: string, preferredProjectID?: string) {
    const preferredKey = preferredProjectID
      ? buildSessionKey(preferredProjectID, sessionID)
      : undefined;
    if (preferredKey && nodesByKey.has(preferredKey)) {
      return nodesByKey.get(preferredKey)?.projectID ?? '';
    }

    const indexedDirectory = sessionIndex.get(sessionID);
    if (!indexedDirectory) return '';
    const sandbox = getSandboxByDirectory(indexedDirectory);
    return sandbox?.projectID ?? '';
  }

  function listActiveSessionKeys(projectID?: string) {
    const result: string[] = [];
    statusByKey.forEach((status, key) => {
      if (status !== 'busy' && status !== 'retry') return;
      if (projectID && !key.startsWith(`${projectID}:`)) return;
      result.push(key);
    });
    return result;
  }

  function listActiveSessions(projectID?: string) {
    return listActiveSessionKeys(projectID)
      .map((key) => nodesByKey.get(key))
      .filter((node): node is SessionNode => Boolean(node))
      .map((node) => ({
        id: node.sessionID,
        projectID: node.projectID,
        parentID: node.parentID,
        directory: node.directory,
        title: node.title,
        slug: node.slug,
        time: {
          created: node.timeCreated,
          updated: node.timeUpdated,
          archived: node.timeArchived,
        },
      }));
  }

  function pruneEphemeralChildren(ttlMs: number, keepSessionIDs = new Set<string>()) {
    const now = Date.now();
    const removed = new Set<string>();
    let changed = false;
    nodesByKey.forEach((node, key) => {
      if (node.retention !== 'ephemeral') return;
      if (!node.parentID) return;
      if (keepSessionIDs.has(node.sessionID)) return;
      const status = statusByKey.get(key);
      if (status === 'busy' || status === 'retry') return;
      const lastActiveAt = node.lastActiveAt ?? node.timeUpdated ?? node.timeCreated ?? node.lastSeenAt;
      if (now - lastActiveAt < ttlMs) return;
      nodesByKey.delete(key);
      statusByKey.delete(key);
      removed.add(node.sessionID);
      changed = true;
    });
    if (!changed) return false;
    removed.forEach((sessionID) => {
      detachSessionFromAllSandboxes(sessionID);
      refreshSessionIndex(sessionID);
    });
    bump();
    return true;
  }

  function getKnownSessionIDs(): Set<string> {
    return new Set(sessionIndex.keys());
  }

  function setProjects(list: ProjectEntry[]) {
    let changed = false;
    (list ?? []).forEach((project) => {
      if (!project?.id) return;
      const projectID = project.id;
      const normalizedWorktree =
        normalizeDirectory(project.worktree) || (projectID === 'global' ? '/' : undefined);
      if (normalizedWorktree) {
        const root = ensureSandbox(normalizedWorktree, normalizedWorktree);
        if (root && root.projectID !== projectID) {
          root.projectID = projectID;
          changed = true;
        }
      }

      (project.sandboxes ?? []).forEach((sandboxDir) => {
        const sandbox = normalizeDirectory(sandboxDir);
        if (!sandbox) return;
        const entry = ensureSandbox(normalizedWorktree || sandbox, sandbox);
        if (!entry) return;
        if (entry.projectID !== projectID) {
          entry.projectID = projectID;
          changed = true;
        }
      });

      if (projectID === 'global') {
        const globalSandbox = ensureSandbox('/', '/');
        if (globalSandbox && globalSandbox.projectID !== 'global') {
          globalSandbox.projectID = 'global';
          changed = true;
        }
      }
    });
    if (changed) bump();
  }

  function upsertProjectEntry(entry: ProjectEntry) {
    if (!entry?.id) return;
    setProjects([entry]);
  }

  function getProjectEntry(projectID: string): ProjectEntry | undefined {
    if (!projectID) return undefined;
    let worktree = '';
    const sandboxes: string[] = [];

    const root = getProjectRootForProject(projectID);
    if (root) worktree = root;

    forEachSandbox((entry, sandbox, entryWorktree) => {
      if (entry.projectID !== projectID) return;
      if (!worktree) worktree = entryWorktree;
      if (sandbox !== worktree) sandboxes.push(sandbox);
    });

    if (!worktree && sandboxes.length === 0) return undefined;
    return {
      id: projectID,
      worktree: worktree || undefined,
      sandboxes,
    };
  }

  function getProjects(): ProjectEntry[] {
    const projectIDs = new Set<string>();
    forEachSandbox((entry) => {
      if (entry.projectID) projectIDs.add(entry.projectID);
    });
    return Array.from(projectIDs)
      .map((projectID) => getProjectEntry(projectID))
      .filter((project): project is ProjectEntry => Boolean(project));
  }

  function collectProjectDirectories(): string[] {
    const seen = new Set<string>();
    forEachSandbox((_entry, sandbox, worktree) => {
      seen.add(worktree);
      seen.add(sandbox);
    });
    return Array.from(seen);
  }

  function setWorktrees(projectRoot: string, list: string[]) {
    syncSandboxes(projectRoot, list);
  }

  function getWorktrees(projectRoot: string): string[] {
    return getSandboxList(projectRoot);
  }

  function appendWorktree(projectRoot: string, directory: string) {
    const root = normalizeDirectory(projectRoot);
    const dir = normalizeDirectory(directory);
    if (!root || !dir) return;
    if (getSandbox(root, dir)) return;
    ensureSandbox(root, dir);
    bump();
  }

  function removeWorktree(projectRoot: string, directory: string) {
    const root = normalizeDirectory(projectRoot);
    const dir = normalizeDirectory(directory);
    if (!root || !dir) return;
    const sandboxes = tree.get(root);
    const entry = sandboxes?.get(dir);
    if (!sandboxes || !entry) return;

    const affectedSessionIDs = Array.from(entry.sessionIDs);
    nodesByKey.forEach((node, key) => {
      if (normalizeDirectory(node.directory) !== dir) return;
      nodesByKey.delete(key);
      statusByKey.delete(key);
    });

    sandboxes.delete(dir);
    if (sandboxes.size === 0) tree.delete(root);
    affectedSessionIDs.forEach((sessionID) => refreshSessionIndex(sessionID));
    bump();
  }

  function setVcsInfo(directory: string, info: { branch: string }) {
    setSandboxBranch(directory, info.branch);
  }

  function setPendingVcs(directory: string, info: { branch: string }) {
    setSandboxBranch(directory, info.branch);
  }

  function getVcsInfo(directory: string): { branch: string } | undefined {
    const sandbox = getSandboxByDirectory(directory);
    if (!sandbox?.branch) return undefined;
    return { branch: sandbox.branch };
  }

  function promoteVcsForWorktrees(_worktreeList: string[]) {
    return false;
  }

  function getStatus(sessionID: string, projectID?: string): SessionStatusType | undefined {
    const key = resolveNodeKey(sessionID, projectID);
    if (key) {
      const exact = statusByKey.get(key);
      if (exact !== undefined) return exact;
    }
    const suffix = `:${sessionID}`;
    for (const [candidateKey, status] of statusByKey) {
      if (candidateKey.endsWith(suffix)) return status;
    }
    return undefined;
  }

  function dump() {
    const serializedTree: Record<
      string,
      Record<string, { projectID?: string; branch?: string; sessionCount: number }>
    > = {};
    const projectRootByProjectID: Record<string, string> = {};
    const directoryByProjectID: Record<string, string> = {};
    const projectIDsByDirectory: Record<string, string[]> = {};
    const worktreesByProjectRoot: Record<string, string[]> = {};
    const vcsByDirectory: Record<string, { branch: string }> = {};

    tree.forEach((sandboxes, worktree) => {
      const bySandbox: Record<string, { projectID?: string; branch?: string; sessionCount: number }> = {};
      const sandboxList: string[] = [];
      sandboxes.forEach((entry, sandbox) => {
        bySandbox[sandbox] = {
          projectID: entry.projectID,
          branch: entry.branch,
          sessionCount: entry.sessionIDs.size,
        };

        sandboxList.push(sandbox);

        if (entry.projectID) {
          const directoryList = projectIDsByDirectory[sandbox] ?? [];
          if (!directoryList.includes(entry.projectID)) directoryList.push(entry.projectID);
          projectIDsByDirectory[sandbox] = directoryList;

          if (!directoryByProjectID[entry.projectID]) directoryByProjectID[entry.projectID] = sandbox;
          if (sandbox === worktree || !projectRootByProjectID[entry.projectID]) {
            projectRootByProjectID[entry.projectID] = worktree;
          }
        }

        if (entry.branch) vcsByDirectory[sandbox] = { branch: entry.branch };
      });
      serializedTree[worktree] = bySandbox;
      worktreesByProjectRoot[worktree] = sandboxList;
    });

    const sessions = Array.from(nodesByKey.values()).map((node) => ({
      key: node.key,
      sessionID: node.sessionID,
      projectID: node.projectID,
      parentID: node.parentID,
      title: node.title,
      slug: node.slug,
      directory: node.directory,
      retention: node.retention,
      status: statusByKey.get(node.key) ?? 'unknown',
      timeCreated: node.timeCreated,
      timeUpdated: node.timeUpdated,
      lastSeenAt: node.lastSeenAt,
      lastActiveAt: node.lastActiveAt,
    }));

    const projectList = Object.keys(projectRootByProjectID).map((projectID) => {
      const worktree = projectRootByProjectID[projectID];
      const sandboxes = Object.entries(directoryByProjectID)
        .filter(([, directory]) => {
          const entry = getSandboxByDirectory(directory);
          return entry?.projectID === projectID && directory !== worktree;
        })
        .map(([, directory]) => directory);
      return {
        id: projectID,
        worktree,
        sandboxes,
      };
    });

    const nodes = sessions.map((session) => ({
      key: session.key,
      sessionID: session.sessionID,
      projectID: session.projectID,
      parentID: session.parentID,
      title: session.title,
      slug: session.slug,
      directory: session.directory,
      retention: session.retention,
      status: session.status,
      timeCreated: session.timeCreated,
      timeUpdated: session.timeUpdated,
      lastSeenAt: session.lastSeenAt,
      lastActiveAt: session.lastActiveAt,
    }));

    return {
      version,
      tree: serializedTree,
      sessions,
      statuses: Object.fromEntries(statusByKey),
      nodeCount: nodesByKey.size,
      sessionCount: sessionIndex.size,
      nodes,
      projectRootByProjectID,
      directoryByProjectID,
      projectIDsByDirectory,
      projectList,
      worktreesByProjectRoot,
      vcsByDirectory,
      pendingVcs: {},
    };
  }

  return {
    getVersion: () => version,
    ensureSandbox,
    getSandbox,
    getSandboxByDirectory,
    getWorktreeEntries,
    getWorktreeList,
    getSandboxList,
    setSandboxProjectID,
    setSandboxBranch,
    syncSandboxes,
    setProjectRoot,
    setProjectDirectory,
    addDirectoryCandidate,
    getProjectIDsForDirectory,
    resolveProjectIDForDirectory,
    getDirectoriesForProject,
    getProjectRootForProject,
    getProjectDirectoryForProject,
    upsertSession,
    upsertSessions,
    removeSession,
    setStatus,
    syncStatusesForProject,
    getSession,
    getProjectIDForSession,
    getRootSessions,
    getParentMap,
    listActiveSessionKeys,
    listActiveSessions,
    pruneEphemeralChildren,
    getKnownSessionIDs,
    setProjects,
    upsertProjectEntry,
    getProjects,
    getProjectEntry,
    collectProjectDirectories,
    setWorktrees,
    getWorktrees,
    appendWorktree,
    removeWorktree,
    setVcsInfo,
    setPendingVcs,
    getVcsInfo,
    promoteVcsForWorktrees,
    getStatus,
    dump,
  };
}
