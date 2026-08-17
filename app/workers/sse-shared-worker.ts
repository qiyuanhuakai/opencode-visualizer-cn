import type {
  DirectorySessionHydration,
  TabToWorkerMessage,
  WorkerToTabMessage,
} from '../types/sse-worker';
import type { SessionInfo, SsePacket } from '../types/sse';
import {
  asObjectArray,
  asRecord,
  asStatusMap,
  asString,
  isProjectInfo,
  isSessionInfo,
  parseWorkerStatePacket,
} from './sse-state-packet';
import { normalizeDirectory } from '../utils/path';
import { createNotificationManager } from '../utils/notificationManager';
import { createOpenCodeWorkerAdapter } from '../backends/openCodeAdapter';
import { createSseConnection, type SseConnection } from '../utils/sseConnection';
import { createStateBuilder } from '../utils/stateBuilder';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';
import { createOpencodeReadRunner, OpencodeReadAbortedError } from './opencode-read-runner';
import { bufferStatePacket, clearBufferedStatePackets, type BufferedStatePacket } from './sse-state-buffer';

type SharedWorkerSelf = {
  onconnect: ((event: MessageEvent) => void) | null;
};

type ReferencedSubagentHydration = {
  requestId: string;
  rootSessionId: string;
  generation: number;
  controller: AbortController;
};

type PendingUnknownSession = {
  info: SessionInfo;
  mutationSnapshot: ReturnType<ReturnType<typeof createStateBuilder>['beginMutationSnapshot']>;
};

type UnknownSessionResolution = {
  directory: string;
  generation: number;
  controller: AbortController;
  pendingBySessionId: Map<string, PendingUnknownSession>;
};

declare const self: SharedWorkerSelf;

type ConnectionState = {
  key: string;
  baseUrl: string;
  authorization?: string;
  ports: Set<MessagePort>;
  client: SseConnection;
  connected: boolean;
  stateBuilder: ReturnType<typeof createStateBuilder>;
  notificationManager: ReturnType<typeof createNotificationManager>;
  bootstrapPromise?: Promise<void>;
  bootstrapController?: AbortController;
  bootstrapToken?: symbol;
  activeSelection: {
    port: MessagePort;
    projectId: string;
    sessionId: string;
  } | null;
  sessionHydrationByDirectory: Map<string, DirectorySessionHydration>;
  sessionHydrationInFlightByDirectory: Map<string, Promise<void>>;
  sessionHydrationRequestByDirectory: Map<string, symbol>;
  sessionHydrationControllerByDirectory: Map<string, AbortController>;
  vcsHydratedDirectories: Set<string>;
  vcsHydrationInFlightByDirectory: Map<string, Promise<void>>;
  vcsHydrationRequestByDirectory: Map<string, symbol>;
  vcsHydrationControllerByDirectory: Map<string, AbortController>;
  isBootstrappingState: boolean;
  bufferedStatePackets: BufferedStatePacket[];
  bufferedStatePacketBytes: number;
  bufferedStateOverflowed: boolean;
  bootstrapResyncQueued: boolean;
  authoritativeResyncRequested: boolean;
  bootstrapRetryTimer?: ReturnType<typeof setTimeout>;
  bootstrapRetryAttempt: number;
  knownSessionDirectories: Set<string>;
  unknownSessionResolutionsByDirectory: Map<string, UnknownSessionResolution>;
  pendingUnknownSessionsById: Map<
    string,
    { resolution: UnknownSessionResolution; pending: PendingUnknownSession }
  >;
  pendingUnknownSessionCount: number;
  pendingSelectedDirectory: string | null;
  pendingDirectSessionHydrationDirectories: Set<string>;
  topologyReady: boolean;
  hydrationGeneration: number;
  backgroundHydrationRequested: boolean;
  backgroundHydrationStarted: boolean;
  backgroundHydrationCompleteSent: boolean;
  referencedSubagentHydrationByPort: Map<MessagePort, ReferencedSubagentHydration>;
};

const connections = new Map<string, ConnectionState>();
const portToKey = new Map<MessagePort, string>();
const MAX_UNKNOWN_SESSION_DIRECTORIES = 32;
const MAX_PENDING_UNKNOWN_SESSIONS = 2_000;
const MAX_PENDING_DIRECT_HYDRATIONS = 128;
const MAX_REFERENCED_SUBAGENT_IDS = 128;
const INITIAL_BOOTSTRAP_RETRY_MS = 50;
const MAX_BOOTSTRAP_RETRY_MS = 2_000;
const opencodeBackend = createOpenCodeWorkerAdapter();

function toKey(baseUrl: string, authorization?: string) {
  return `${baseUrl.replace(/\/+$/, '')}\u0000${authorization ?? ''}`;
}

function send(port: MessagePort, message: WorkerToTabMessage) { port.postMessage(message); }

function broadcast(state: ConnectionState, message: WorkerToTabMessage) { for (const port of state.ports) send(port, message); }

function isCurrentConnection(state: ConnectionState) { return connections.get(state.key) === state; }

const runOpencodeReadTask = createOpencodeReadRunner<ConnectionState>({
  isCurrent: isCurrentConnection,
  getGeneration: (state) => state.hydrationGeneration,
  configure: (state) => {
    opencodeBackend.configure?.({ baseUrl: state.baseUrl, authorization: state.authorization });
  },
});

function emitDirectoryHydration(
  state: ConnectionState,
  directory: string,
  hydration: DirectorySessionHydration,
) {
  state.sessionHydrationByDirectory.set(directory, hydration);
  broadcast(state, { type: 'state.directory-hydration-updated', directory, hydration });
}

function removeDirectoryHydration(state: ConnectionState, directory: string): void {
  if (!state.sessionHydrationByDirectory.delete(directory)) return;
  broadcast(state, { type: 'state.directory-hydration-removed', directory });
}

function abortDirectoryHydrations(state: ConnectionState, directory: string): void {
  state.sessionHydrationControllerByDirectory.get(directory)?.abort();
  state.vcsHydrationControllerByDirectory.get(directory)?.abort();
  state.sessionHydrationControllerByDirectory.delete(directory);
  state.vcsHydrationControllerByDirectory.delete(directory);
  state.sessionHydrationInFlightByDirectory.delete(directory);
  state.sessionHydrationRequestByDirectory.delete(directory);
  state.vcsHydrationInFlightByDirectory.delete(directory);
  state.vcsHydrationRequestByDirectory.delete(directory);
  state.vcsHydratedDirectories.delete(directory);
}

function abortAllDirectoryHydrations(state: ConnectionState): void {
  const directories = new Set([
    ...state.sessionHydrationByDirectory.keys(),
    ...state.sessionHydrationInFlightByDirectory.keys(),
    ...state.sessionHydrationControllerByDirectory.keys(),
    ...state.vcsHydrationInFlightByDirectory.keys(),
    ...state.vcsHydrationRequestByDirectory.keys(),
    ...state.vcsHydrationControllerByDirectory.keys(),
    ...state.vcsHydratedDirectories,
  ]);
  for (const directory of directories) abortDirectoryHydrations(state, directory);
}

function replaceHydrationGeneration(state: ConnectionState): number {
  abortAllDirectoryHydrations(state);
  state.hydrationGeneration += 1;
  return state.hydrationGeneration;
}

function abortCurrentBootstrap(state: ConnectionState): void {
  state.bootstrapController?.abort();
  state.bootstrapController = undefined;
  state.bootstrapToken = undefined;
  state.bootstrapPromise = undefined;
}

function ownsBootstrap(state: ConnectionState, token: symbol): boolean {
  return isCurrentConnection(state) && state.bootstrapToken === token;
}

function sendReferencedSubagentHydrationResult(
  port: MessagePort,
  hydration: ReferencedSubagentHydration,
  sessionIds: string[],
  cancelled: boolean,
) {
  send(port, {
    type: 'state.referenced-subagents-hydrated',
    requestId: hydration.requestId,
    rootSessionId: hydration.rootSessionId,
    sessionIds,
    cancelled,
  });
}

function cancelReferencedSubagentHydration(state: ConnectionState, port: MessagePort) {
  const hydration = state.referencedSubagentHydrationByPort.get(port);
  if (!hydration) return;
  state.referencedSubagentHydrationByPort.delete(port);
  hydration.controller.abort();
  sendReferencedSubagentHydrationResult(port, hydration, [], true);
}

function cancelAllReferencedSubagentHydrations(state: ConnectionState) {
  for (const port of state.referencedSubagentHydrationByPort.keys()) {
    cancelReferencedSubagentHydration(state, port);
  }
}

async function hydrateReferencedSubagents(
  state: ConnectionState,
  port: MessagePort,
  request: Extract<TabToWorkerMessage, { type: 'hydrate-referenced-subagents' }>,
) {
  cancelReferencedSubagentHydration(state, port);

  const requestId = request.requestId.trim();
  const rootSessionId = request.rootSessionId.trim();
  const directory = normalizeDirectory(request.directory);
  const sessionIds = Array.from(
    new Set(
      request.sessionIds
        .slice(0, MAX_REFERENCED_SUBAGENT_IDS)
        .map((sessionId) => sessionId.trim())
        .filter(Boolean),
    ),
  ).filter((sessionId) => sessionId !== rootSessionId);
  const hydration: ReferencedSubagentHydration = {
    requestId,
    rootSessionId,
    generation: state.hydrationGeneration,
    controller: new AbortController(),
  };
  const getSession = opencodeBackend.getSession;

  if (!requestId || !rootSessionId || !directory || sessionIds.length === 0 || !getSession) {
    sendReferencedSubagentHydrationResult(port, hydration, [], false);
    return;
  }

  state.referencedSubagentHydrationByPort.set(port, hydration);
  const results = await mapWithConcurrency(sessionIds, 2, async (sessionId) => {
    const rawSession = await runOpencodeReadTask(state, () =>
      getSession(sessionId, directory, { signal: hydration.controller.signal }),
      { signal: hydration.controller.signal, generation: hydration.generation },
    );
    if (!isSessionInfo(rawSession)) return null;
    if (rawSession.id !== sessionId || rawSession.parentID?.trim() !== rootSessionId) return null;
    if (normalizeDirectory(rawSession.directory) !== directory) return null;
    return rawSession;
  });

  const activeHydration = state.referencedSubagentHydrationByPort.get(port);
  if (activeHydration !== hydration) return;
  if (
    hydration.controller.signal.aborted ||
    hydration.generation !== state.hydrationGeneration ||
    !isCurrentConnection(state)
  ) {
    cancelReferencedSubagentHydration(state, port);
    return;
  }

  const sessions = results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  );
  state.stateBuilder.applyAuthoritativeSessions(sessions);
  const projectIds = new Set(sessions.map((session) => session.projectID.trim()).filter(Boolean));
  for (const projectId of projectIds) emitProjectUpdated(state, projectId);

  state.referencedSubagentHydrationByPort.delete(port);
  sendReferencedSubagentHydrationResult(
    port,
    hydration,
    sessions.map((session) => session.id),
    false,
  );
}

function rebuildKnownSessionDirectories(
  state: ConnectionState,
  broadcastNewHydration = true,
): void {
  const directories = new Set<string>();
  for (const project of Object.values(state.stateBuilder.getState().projects)) {
    const worktree = normalizeDirectory(project.worktree);
    if (worktree) directories.add(worktree);
    for (const directory of Object.keys(project.sandboxes)) {
      const normalizedDirectory = normalizeDirectory(directory);
      if (normalizedDirectory) directories.add(normalizedDirectory);
    }
  }

  state.knownSessionDirectories.clear();
  for (const directory of directories) state.knownSessionDirectories.add(directory);

  const trackedDirectories = new Set([
    ...state.knownSessionDirectories,
    ...state.sessionHydrationByDirectory.keys(),
    ...state.sessionHydrationInFlightByDirectory.keys(),
    ...state.sessionHydrationControllerByDirectory.keys(),
    ...state.vcsHydrationInFlightByDirectory.keys(),
    ...state.vcsHydrationRequestByDirectory.keys(),
    ...state.vcsHydrationControllerByDirectory.keys(),
    ...state.vcsHydratedDirectories,
  ]);
  for (const directory of trackedDirectories) {
    if (directories.has(directory)) continue;
    removeDirectoryHydration(state, directory);
    abortDirectoryHydrations(state, directory);
  }

  for (const directory of directories) {
    if (state.sessionHydrationByDirectory.has(directory)) continue;
    state.sessionHydrationByDirectory.set(directory, { status: 'unloaded' });
    if (broadcastNewHydration) {
      broadcast(state, {
        type: 'state.directory-hydration-updated',
        directory,
        hydration: { status: 'unloaded' },
      });
    }
  }
}

function isActiveDirectoryHydration(
  state: ConnectionState,
  directory: string,
  generation: number,
  requestToken: symbol,
  requests: Map<string, symbol>,
  controllers: Map<string, AbortController>,
  requireSessionHydration = false,
): boolean {
  if (
    !isCurrentConnection(state) ||
    state.hydrationGeneration !== generation ||
    !state.knownSessionDirectories.has(directory) ||
    (requireSessionHydration && !state.sessionHydrationByDirectory.has(directory)) ||
    requests.get(directory) !== requestToken
  )
    return false;
  const controller = controllers.get(directory);
  if (!controller || controller.signal.aborted) return false;

  const projectId = state.stateBuilder.resolveProjectIdForDirectory(directory);
  const project = projectId ? state.stateBuilder.getProject(projectId) : undefined;
  return Boolean(project?.sandboxes[directory]);
}

function isActiveDirectorySessionHydration(
  state: ConnectionState,
  directory: string,
  generation: number,
  requestToken: symbol,
): boolean {
  return isActiveDirectoryHydration(
    state,
    directory,
    generation,
    requestToken,
    state.sessionHydrationRequestByDirectory,
    state.sessionHydrationControllerByDirectory,
    true,
  );
}

function isActiveDirectoryVcsHydration(
  state: ConnectionState,
  directory: string,
  generation: number,
  requestToken: symbol,
): boolean {
  return isActiveDirectoryHydration(
    state,
    directory,
    generation,
    requestToken,
    state.vcsHydrationRequestByDirectory,
    state.vcsHydrationControllerByDirectory,
  );
}

async function loadDirectorySessions(state: ConnectionState, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const hydration = state.sessionHydrationByDirectory.get(normalizedDirectory);
  if (
    !hydration ||
    hydration.status === 'loaded' ||
    !state.knownSessionDirectories.has(normalizedDirectory)
  ) {
    return;
  }

  const inFlight = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
  if (inFlight) {
    await inFlight;
    return;
  }

  const generation = state.hydrationGeneration;
  const requestToken = Symbol(normalizedDirectory);
  const controller = new AbortController();
  const snapshotBuilder = state.stateBuilder;
  const statusSnapshot = snapshotBuilder.beginStatusSnapshot();
  const mutationSnapshot = snapshotBuilder.beginMutationSnapshot();
  state.sessionHydrationRequestByDirectory.set(normalizedDirectory, requestToken);
  state.sessionHydrationControllerByDirectory.set(normalizedDirectory, controller);
  emitDirectoryHydration(state, normalizedDirectory, { status: 'loading' });
  const promise = runOpencodeReadTask(state, async () => {
    const [rawSessions, rawStatuses] = await Promise.all([
      opencodeBackend.listSessions({
        directory: normalizedDirectory,
        roots: true,
        signal: controller.signal,
      }),
      opencodeBackend.getSessionStatusMap?.(normalizedDirectory, { signal: controller.signal }),
    ]);
    if (
      !isActiveDirectorySessionHydration(
        state,
        normalizedDirectory,
        generation,
        requestToken,
      )
    )
      return;

    const sessions = asObjectArray(rawSessions) as Parameters<typeof snapshotBuilder.applySessions>[0];
    snapshotBuilder.applySessionSnapshot(sessions, mutationSnapshot);
    snapshotBuilder.applyStatusSnapshot(
      sessions.map((session) => session.id),
      asStatusMap(rawStatuses),
      statusSnapshot,
    );
    if (snapshotBuilder.consumeSnapshotOverflow()) {
      requestAuthoritativeBootstrap(state);
      return;
    }

    const projectIds = new Set<string>();
    const resolvedProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
    if (resolvedProjectId) projectIds.add(resolvedProjectId);
    for (const session of sessions) {
      const projectId = session.projectID?.trim();
      if (projectId) projectIds.add(projectId);
    }
    for (const projectId of projectIds) emitProjectUpdated(state, projectId);
    emitDirectoryHydration(state, normalizedDirectory, { status: 'loaded' });
  }, { generation, signal: controller.signal })
    .catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof OpencodeReadAbortedError) return;
      if (
        isActiveDirectorySessionHydration(
          state,
          normalizedDirectory,
          generation,
          requestToken,
        )
      ) {
        emitDirectoryHydration(state, normalizedDirectory, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to load directory sessions.',
        });
      }
      throw error;
    })
    .finally(() => {
      snapshotBuilder.completeStatusSnapshot(statusSnapshot);
      snapshotBuilder.completeMutationSnapshot(mutationSnapshot);
      const active = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
      if (active === promise) {
        state.sessionHydrationInFlightByDirectory.delete(normalizedDirectory);
      }
      if (state.sessionHydrationRequestByDirectory.get(normalizedDirectory) === requestToken) {
        state.sessionHydrationRequestByDirectory.delete(normalizedDirectory);
      }
      if (state.sessionHydrationControllerByDirectory.get(normalizedDirectory) === controller) {
        state.sessionHydrationControllerByDirectory.delete(normalizedDirectory);
      }
    });

  state.sessionHydrationInFlightByDirectory.set(normalizedDirectory, promise);
  await promise;
}

async function loadDirectoryVcs(state: ConnectionState, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  if (!state.knownSessionDirectories.has(normalizedDirectory)) return;
  const liveProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
  const liveProject = liveProjectId ? state.stateBuilder.getProject(liveProjectId) : undefined;
  if (!liveProject?.sandboxes[normalizedDirectory]) return;
  if (state.vcsHydratedDirectories.has(normalizedDirectory)) {
    return;
  }

  const inFlight = state.vcsHydrationInFlightByDirectory.get(normalizedDirectory);
  if (inFlight) {
    await inFlight;
    return;
  }

  const generation = state.hydrationGeneration;
  const requestToken = Symbol(normalizedDirectory);
  const controller = new AbortController();
  state.vcsHydrationRequestByDirectory.set(normalizedDirectory, requestToken);
  state.vcsHydrationControllerByDirectory.set(normalizedDirectory, controller);
  const promise = runOpencodeReadTask(state, async () => {
    const raw = opencodeBackend.getVcsInfo
      ? await opencodeBackend
          .getVcsInfo(normalizedDirectory, { signal: controller.signal })
          .catch(() => null)
      : null;
    if (!isActiveDirectoryVcsHydration(state, normalizedDirectory, generation, requestToken)) return;
    const vcsInfo = asRecord(raw);
    if (!vcsInfo) {
      state.vcsHydratedDirectories.add(normalizedDirectory);
      return;
    }

    const branch = asString(vcsInfo.branch);
    if (branch) {
      state.stateBuilder.applyVcsInfo(normalizedDirectory, { branch });
      emitProjectUpdated(
        state,
        state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory),
      );
    }

    if (isActiveDirectoryVcsHydration(state, normalizedDirectory, generation, requestToken)) {
      state.vcsHydratedDirectories.add(normalizedDirectory);
    }
  }, { generation, signal: controller.signal })
    .catch((error: unknown) => {
      if (controller.signal.aborted || error instanceof OpencodeReadAbortedError) return;
      throw error;
    })
    .finally(() => {
    const active = state.vcsHydrationInFlightByDirectory.get(normalizedDirectory);
    if (active === promise) {
      state.vcsHydrationInFlightByDirectory.delete(normalizedDirectory);
    }
    if (state.vcsHydrationRequestByDirectory.get(normalizedDirectory) === requestToken) {
      state.vcsHydrationRequestByDirectory.delete(normalizedDirectory);
    }
    if (state.vcsHydrationControllerByDirectory.get(normalizedDirectory) === controller) {
      state.vcsHydrationControllerByDirectory.delete(normalizedDirectory);
    }
  });

  state.vcsHydrationInFlightByDirectory.set(normalizedDirectory, promise);
  await promise;
}

const BACKGROUND_HYDRATION_CONCURRENCY = 2;

function startBackgroundHydration(state: ConnectionState) {
  if (!state.topologyReady || state.backgroundHydrationStarted) return;
  state.backgroundHydrationStarted = true;
  const generation = state.hydrationGeneration;
  const directories = [...state.knownSessionDirectories];
  void (async () => {
    await mapWithConcurrency(directories, BACKGROUND_HYDRATION_CONCURRENCY, async (directory) => {
      if (!isCurrentConnection(state) || state.hydrationGeneration !== generation) return;
      await Promise.allSettled([
        loadDirectorySessions(state, directory),
        loadDirectoryVcs(state, directory),
      ]);
    });
    if (
      !isCurrentConnection(state) ||
      state.hydrationGeneration !== generation ||
      state.backgroundHydrationCompleteSent
    )
      return;
    state.backgroundHydrationCompleteSent = true;
    broadcast(state, { type: 'state.background-hydration-complete' });
  })();
}

function flushBufferedStatePackets(state: ConnectionState) {
  if (state.bufferedStatePackets.length === 0) return;
  const buffered = [...state.bufferedStatePackets];
  clearBufferedStatePackets(state);
  for (const { packet } of buffered) {
    handleStatePacket(state, packet);
  }
}

function requestPriorityHydration(state: ConnectionState, directory?: string) {
  const normalizedDirectory = normalizeDirectory(directory ?? '');
  if (!normalizedDirectory) return;
  state.pendingSelectedDirectory = normalizedDirectory;
  if (!state.topologyReady) return;
  const generation = state.hydrationGeneration;
  void Promise.allSettled([
    loadDirectorySessions(state, normalizedDirectory),
    loadDirectoryVcs(state, normalizedDirectory),
  ])
    .finally(() => {
      if (
        state.hydrationGeneration === generation &&
        state.pendingSelectedDirectory === normalizedDirectory
      ) {
        state.pendingSelectedDirectory = null;
      }
    });
}

function requestDirectSessionHydration(state: ConnectionState, directory: string): void {
  const normalizedDirectory = normalizeDirectory(directory);
  if (!normalizedDirectory) return;
  if (!state.topologyReady) {
    if (
      state.pendingDirectSessionHydrationDirectories.size < MAX_PENDING_DIRECT_HYDRATIONS ||
      state.pendingDirectSessionHydrationDirectories.has(normalizedDirectory)
    ) {
      state.pendingDirectSessionHydrationDirectories.add(normalizedDirectory);
    }
    return;
  }
  void loadDirectorySessions(state, normalizedDirectory).catch(() => {});
}

function drainPendingHydrationRequests(state: ConnectionState): void {
  const directDirectories = [...state.pendingDirectSessionHydrationDirectories];
  state.pendingDirectSessionHydrationDirectories.clear();
  for (const directory of directDirectories) {
    void loadDirectorySessions(state, directory).catch(() => {});
  }
  if (state.pendingSelectedDirectory) {
    requestPriorityHydration(state, state.pendingSelectedDirectory);
  }
  if (state.backgroundHydrationRequested) {
    startBackgroundHydration(state);
  }
}

function emitProjectUpdated(state: ConnectionState, projectId: string | null) {
  if (!projectId) return;
  const project = state.stateBuilder.getProject(projectId);
  if (!project) return;
  broadcast(state, {
    type: 'state.project-updated',
    projectId,
    project,
  });
}

function emitNotificationsUpdated(state: ConnectionState) {
  broadcast(state, {
    type: 'state.notifications-updated',
    notifications: state.notificationManager.getState(),
  });
}

function shouldSuppressIdleNotification(
  state: ConnectionState,
  projectId: string,
  rootSessionId: string,
) {
  if (!projectId || !rootSessionId) return false;
  const activeSelection = state.activeSelection;
  if (!activeSelection) return false;
  if (activeSelection.projectId !== projectId) return false;
  const activeRootSessionId = state.stateBuilder.resolveRootSessionIdForProject(
    projectId,
    activeSelection.sessionId,
  );
  return activeRootSessionId === rootSessionId;
}

function reconcileIdleNotification(
  state: ConnectionState,
  projectId: string | null,
  sessionId: string,
): boolean {
  if (!projectId) return false;
  const rootSessionId = state.stateBuilder.resolveRootSessionIdForProject(projectId, sessionId);
  if (!rootSessionId) return false;

  const idleRequestId = `idle:${projectId}:${rootSessionId}`;
  if (!state.stateBuilder.isSessionTreeIdle(projectId, rootSessionId)) {
    return state.notificationManager.removeNotification(idleRequestId);
  }
  if (shouldSuppressIdleNotification(state, projectId, rootSessionId)) return false;

  const added = state.notificationManager.addNotification(
    projectId,
    rootSessionId,
    idleRequestId,
  );
  if (added) emitNotificationShow(state, projectId, rootSessionId, 'idle');
  return added;
}

function emitNotificationShow(
  state: ConnectionState,
  projectId: string,
  sessionId: string,
  kind: 'permission' | 'question' | 'idle',
) {
  if (!projectId || !sessionId) return;
  broadcast(state, {
    type: 'notification.show',
    projectId,
    sessionId,
    kind,
  });
}

function hasKnownSessionDirectory(state: ConnectionState, info: SessionInfo): boolean {
  const directory = normalizeDirectory(info.directory);
  if (!directory) return false;
  if (state.unknownSessionResolutionsByDirectory.has(directory)) return false;
  if (!state.knownSessionDirectories.has(directory)) return false;
  const projectId = state.stateBuilder.resolveProjectIdForDirectory(directory);
  if (!projectId) return false;
  const project = state.stateBuilder.getProject(projectId);
  return Boolean(project?.sandboxes[directory]);
}

function emitResolvedSession(
  state: ConnectionState,
  info: SessionInfo,
  directory: string,
  mutationSnapshot: ReturnType<ReturnType<typeof createStateBuilder>['beginMutationSnapshot']>,
) {
  state.stateBuilder.applySessionSnapshot([info], mutationSnapshot);
  const projectId =
    state.stateBuilder.resolveProjectIdForDirectory(directory) || info.projectID.trim();
  emitProjectUpdated(state, projectId);
  if (reconcileIdleNotification(state, projectId, info.id)) {
    emitNotificationsUpdated(state);
  }
}

function isActiveUnknownSessionResolution(
  state: ConnectionState,
  resolution: UnknownSessionResolution,
): boolean {
  return (
    state.unknownSessionResolutionsByDirectory.get(resolution.directory) === resolution &&
    resolution.generation === state.hydrationGeneration &&
    !resolution.controller.signal.aborted &&
    isCurrentConnection(state)
  );
}

function completePendingUnknownSession(
  state: ConnectionState,
  sessionId: string,
  expected?: { resolution: UnknownSessionResolution; pending: PendingUnknownSession },
): void {
  const current = state.pendingUnknownSessionsById.get(sessionId);
  if (
    !current ||
    (expected &&
      (current.resolution !== expected.resolution || current.pending !== expected.pending))
  )
    return;

  state.pendingUnknownSessionsById.delete(sessionId);
  current.resolution.pendingBySessionId.delete(sessionId);
  state.pendingUnknownSessionCount = Math.max(0, state.pendingUnknownSessionCount - 1);
  state.stateBuilder.completeMutationSnapshot(current.pending.mutationSnapshot);

  if (
    current.resolution.pendingBySessionId.size === 0 &&
    state.unknownSessionResolutionsByDirectory.get(current.resolution.directory) ===
      current.resolution
  ) {
    state.unknownSessionResolutionsByDirectory.delete(current.resolution.directory);
    current.resolution.controller.abort();
  }
}

function abortUnknownSessionResolution(
  state: ConnectionState,
  resolution: UnknownSessionResolution,
): void {
  if (state.unknownSessionResolutionsByDirectory.get(resolution.directory) !== resolution) return;
  state.unknownSessionResolutionsByDirectory.delete(resolution.directory);
  resolution.controller.abort();
  for (const [sessionId, pending] of resolution.pendingBySessionId) {
    completePendingUnknownSession(state, sessionId, { resolution, pending });
  }
  resolution.pendingBySessionId.clear();
}

function abortAllUnknownSessionResolutions(state: ConnectionState): void {
  while (state.unknownSessionResolutionsByDirectory.size > 0) {
    const resolution = state.unknownSessionResolutionsByDirectory.values().next().value;
    if (!resolution) return;
    abortUnknownSessionResolution(state, resolution);
  }
}

function removePendingUnknownSession(state: ConnectionState, sessionId: string): void {
  const pending = state.pendingUnknownSessionsById.get(sessionId);
  if (!pending) return;
  completePendingUnknownSession(state, sessionId, pending);
}

async function resolveUnknownSessionDirectory(
  state: ConnectionState,
  resolution: UnknownSessionResolution,
) {
  try {
    const getCurrentProject = opencodeBackend.getCurrentProject;
    if (!getCurrentProject || !isActiveUnknownSessionResolution(state, resolution)) return;

    let raw: unknown;
    try {
      raw = await runOpencodeReadTask(
        state,
        () => getCurrentProject(resolution.directory, { signal: resolution.controller.signal }),
        { signal: resolution.controller.signal, generation: resolution.generation },
      );
    } catch (error) {
      if (error instanceof Error) return;
      throw error;
    }

    const projectInfo = isProjectInfo(raw) ? raw : null;
    if (!projectInfo || !isActiveUnknownSessionResolution(state, resolution)) return;

    const worktree = normalizeDirectory(projectInfo.worktree);
    if (!worktree) return;

    const knownProjectId = state.stateBuilder.resolveProjectIdForDirectory(worktree);
    let changedProjectId: string | null = null;
    if (knownProjectId) {
      changedProjectId = state.stateBuilder.registerSandboxDirectory(
        knownProjectId,
        resolution.directory,
      );
      changedProjectId ??= knownProjectId;
    } else {
      if (resolution.directory !== worktree) return;
      changedProjectId = state.stateBuilder.processProjectUpdated(projectInfo);
    }
    rebuildKnownSessionDirectories(state);
    emitProjectUpdated(state, changedProjectId);

    for (const [sessionId, pending] of resolution.pendingBySessionId) {
      const current = state.pendingUnknownSessionsById.get(sessionId);
      if (!current || current.resolution !== resolution || current.pending !== pending) continue;
       emitResolvedSession(state, pending.info, resolution.directory, pending.mutationSnapshot);
      completePendingUnknownSession(state, sessionId, current);
    }
  } finally {
    abortUnknownSessionResolution(state, resolution);
  }
}

function startUnknownSessionDirectoryResolution(state: ConnectionState, info: SessionInfo) {
  const directory = normalizeDirectory(info.directory);
  if (!directory || !isCurrentConnection(state)) return;

  removePendingUnknownSession(state, info.id);
  const existing = state.unknownSessionResolutionsByDirectory.get(directory);
  if (
    state.pendingUnknownSessionCount >= MAX_PENDING_UNKNOWN_SESSIONS ||
    (!existing &&
      state.unknownSessionResolutionsByDirectory.size >= MAX_UNKNOWN_SESSION_DIRECTORIES)
  ) {
    requestAuthoritativeBootstrap(state);
    return;
  }

  const resolution =
    existing ??
    (() => {
      const next: UnknownSessionResolution = {
        directory,
        generation: state.hydrationGeneration,
        controller: new AbortController(),
        pendingBySessionId: new Map(),
      };
      state.unknownSessionResolutionsByDirectory.set(directory, next);
      return next;
    })();
  const pending: PendingUnknownSession = {
    info,
    mutationSnapshot: state.stateBuilder.beginMutationSnapshot(),
  };
  resolution.pendingBySessionId.set(info.id, pending);
  state.pendingUnknownSessionsById.set(info.id, { resolution, pending });
  state.pendingUnknownSessionCount += 1;
  if (!existing) void resolveUnknownSessionDirectory(state, resolution);
}

function handleStatePacket(state: ConnectionState, packet: SsePacket) {
  const parsedPacket = parseWorkerStatePacket(packet);
  if (!parsedPacket) return;

  if (state.isBootstrappingState) {
    bufferStatePacket(state, parsedPacket);
    return;
  }

  const packetType = parsedPacket.payload.type;
  const packetDirectory = normalizeDirectory(parsedPacket.directory);
  let projectId: string | null = null;
  let notificationsChanged = false;

  switch (packetType) {
    case 'session.created': {
      const info = parsedPacket.payload.properties.info;
      const needsResolution = !hasKnownSessionDirectory(state, info);
      projectId = state.stateBuilder.processSessionCreated(info);
      notificationsChanged =
        reconcileIdleNotification(state, projectId, info.id) || notificationsChanged;
      if (needsResolution) startUnknownSessionDirectoryResolution(state, info);
      break;
    }
    case 'session.updated': {
      const info = parsedPacket.payload.properties.info;
      const needsResolution = !hasKnownSessionDirectory(state, info);
      projectId = state.stateBuilder.processSessionUpdated(info);
      notificationsChanged =
        reconcileIdleNotification(state, projectId, info.id) || notificationsChanged;
      if (needsResolution) startUnknownSessionDirectoryResolution(state, info);
      break;
    }
    case 'session.deleted': {
      const info = parsedPacket.payload.properties.info;
      const sessionId = info.id;
      const deletedDirectory = normalizeDirectory(info.directory);
      const deletedProjectId = state.stateBuilder.resolveProjectIdForDirectory(deletedDirectory);
      const formerRootSessionId = deletedProjectId
        ? state.stateBuilder.resolveRootSessionIdForProject(deletedProjectId, sessionId)
        : '';
      const isRootSession = formerRootSessionId === sessionId;
      if (deletedProjectId && !isRootSession) {
        notificationsChanged =
          state.notificationManager.clearRequestsForSession(deletedProjectId, sessionId) ||
          notificationsChanged;
      }
      projectId = state.stateBuilder.processSessionDeleted(sessionId, deletedProjectId);
      removePendingUnknownSession(state, sessionId);
      if (deletedProjectId) {
        if (isRootSession) {
          notificationsChanged =
            state.notificationManager.clearSession(deletedProjectId, sessionId) ||
            notificationsChanged;
        } else {
          const notificationSessionId = formerRootSessionId || sessionId;
          const idleRequestId = `idle:${deletedProjectId}:${notificationSessionId}`;
          notificationsChanged =
            state.notificationManager.removeNotification(idleRequestId) || notificationsChanged;
          notificationsChanged =
            reconcileIdleNotification(
              state,
              deletedProjectId,
              notificationSessionId,
            ) || notificationsChanged;
        }
      }
      break;
    }
    case 'session.status': {
      const sessionId = parsedPacket.payload.properties.sessionID;
      const status = parsedPacket.payload.properties.status.type;
      const statusProjectId = state.stateBuilder.resolveProjectIdForDirectory(packetDirectory);
      projectId = state.stateBuilder.processSessionStatus(
        sessionId,
        status,
        statusProjectId || undefined,
      );
      notificationsChanged =
        reconcileIdleNotification(state, statusProjectId || projectId, sessionId) ||
        notificationsChanged;
      break;
    }
    case 'project.updated': {
      projectId = state.stateBuilder.processProjectUpdated(parsedPacket.payload.properties);
      rebuildKnownSessionDirectories(state);
      break;
    }
    case 'vcs.branch.updated': {
      const branch = parsedPacket.payload.properties.branch ?? '';
      projectId = state.stateBuilder.processVcsBranchUpdated(packetDirectory, branch);
      break;
    }
    case 'permission.asked': {
      const request = parsedPacket.payload.properties;
      const requestProjectId = state.stateBuilder.resolveProjectIdForDirectory(packetDirectory);
      if (requestProjectId) {
        const added = state.notificationManager.addNotification(
          requestProjectId,
          request.sessionID,
          request.id,
        );
        notificationsChanged = added || notificationsChanged;
        if (added) {
          emitNotificationShow(state, requestProjectId, request.sessionID, 'permission');
        }
      }
      break;
    }
    case 'question.asked': {
      const request = parsedPacket.payload.properties;
      const requestProjectId = state.stateBuilder.resolveProjectIdForDirectory(packetDirectory);
      if (requestProjectId) {
        const added = state.notificationManager.addNotification(
          requestProjectId,
          request.sessionID,
          request.id,
        );
        notificationsChanged = added || notificationsChanged;
        if (added) {
          emitNotificationShow(state, requestProjectId, request.sessionID, 'question');
        }
      }
      break;
    }
    case 'permission.replied':
    case 'question.replied':
    case 'question.rejected': {
      const requestId = parsedPacket.payload.properties.requestID;
      notificationsChanged =
        state.notificationManager.removeNotification(requestId) || notificationsChanged;
      break;
    }
    case 'worktree.ready': {
      const readyBranch = parsedPacket.payload.properties.branch;
      projectId =
        state.stateBuilder.processVcsBranchUpdated(packetDirectory, readyBranch) || projectId;
      break;
    }
    default: {
      const _never: never = packetType;
      return _never;
    }
  }

  emitProjectUpdated(state, projectId);
  if (notificationsChanged) {
    emitNotificationsUpdated(state);
  }
  if (state.stateBuilder.consumeSnapshotOverflow()) {
    requestAuthoritativeBootstrap(state);
  }
}

function requestAuthoritativeBootstrap(state: ConnectionState): void {
  if (!isCurrentConnection(state)) return;
  if (state.authoritativeResyncRequested) return;
  state.authoritativeResyncRequested = true;
  cancelAllReferencedSubagentHydrations(state);
  abortAllUnknownSessionResolutions(state);
  replaceHydrationGeneration(state);
  scheduleAuthoritativeBootstrap(state);
}

function scheduleAuthoritativeBootstrap(state: ConnectionState): void {
  if (state.bootstrapResyncQueued || !isCurrentConnection(state)) return;
  state.bootstrapResyncQueued = true;
  queueMicrotask(() => {
    state.bootstrapResyncQueued = false;
    if (
      !isCurrentConnection(state) ||
      state.bootstrapPromise ||
      (!state.bufferedStateOverflowed && !state.authoritativeResyncRequested)
    )
      return;
    state.bufferedStateOverflowed = false;
    state.authoritativeResyncRequested = false;
    void bootstrapState(state).catch((error: unknown) => {
      const message =
        error instanceof Error ? error.message : 'Failed to bootstrap worker state.';
      broadcast(state, { type: 'connection.error', message });
    });
  });
}

function clearBootstrapRetry(state: ConnectionState, resetAttempt = false): void {
  if (state.bootstrapRetryTimer !== undefined) {
    clearTimeout(state.bootstrapRetryTimer);
    state.bootstrapRetryTimer = undefined;
  }
  if (resetAttempt) state.bootstrapRetryAttempt = 0;
}

function scheduleBootstrapRetry(state: ConnectionState): void {
  if (
    state.bootstrapRetryTimer !== undefined ||
    !state.connected ||
    !isCurrentConnection(state)
  )
    return;
  const delay = Math.min(
    INITIAL_BOOTSTRAP_RETRY_MS * 2 ** state.bootstrapRetryAttempt,
    MAX_BOOTSTRAP_RETRY_MS,
  );
  state.bootstrapRetryAttempt += 1;
  state.bootstrapRetryTimer = setTimeout(() => {
    state.bootstrapRetryTimer = undefined;
    if (!state.connected || !isCurrentConnection(state)) return;
    state.authoritativeResyncRequested = true;
    scheduleAuthoritativeBootstrap(state);
  }, delay);
}

async function bootstrapState(state: ConnectionState, forceRestart = false): Promise<void> {
  if (state.bootstrapPromise) {
    if (!forceRestart) {
      return state.bootstrapPromise;
    }
    abortCurrentBootstrap(state);
  }

  state.topologyReady = false;
  clearBootstrapRetry(state);
  const generation = replaceHydrationGeneration(state);
  const builder = createStateBuilder();
  const bootstrapToken = Symbol('bootstrap');
  const bootstrapController = new AbortController();
  state.bootstrapToken = bootstrapToken;
  state.bootstrapController = bootstrapController;
  state.isBootstrappingState = true;
  let bootstrapSucceeded = false;
  const run = (async () => {
    abortAllUnknownSessionResolutions(state);
    clearBufferedStatePackets(state);
    state.bufferedStateOverflowed = false;
    const projects = asObjectArray<Record<string, unknown>>(
      await runOpencodeReadTask(
        state,
        () =>
          opencodeBackend.listProjects?.(undefined, { signal: bootstrapController.signal }) ??
          Promise.resolve([]),
        {
          generation,
          signal: bootstrapController.signal,
          cancelOnAbort: true,
          priority: 'bootstrap',
        },
      ),
    );
    if (
      !ownsBootstrap(state, bootstrapToken) ||
      state.hydrationGeneration !== generation ||
      bootstrapController.signal.aborted
    )
      return;
    builder.applyProjects(projects as Parameters<typeof builder.applyProjects>[0]);
    builder.getDefaultProjectId();
    state.stateBuilder = builder;
    state.sessionHydrationByDirectory.clear();
    state.knownSessionDirectories.clear();
    rebuildKnownSessionDirectories(state, false);
    state.backgroundHydrationStarted = false;
    state.backgroundHydrationCompleteSent = false;
    state.topologyReady = true;

    broadcast(state, {
      type: 'state.bootstrap',
      projects: state.stateBuilder.getState().projects,
      notifications: state.notificationManager.getState(),
      sessionHydrationByDirectory: Object.fromEntries(state.sessionHydrationByDirectory),
    });

    state.isBootstrappingState = false;
    flushBufferedStatePackets(state);
    drainPendingHydrationRequests(state);
    bootstrapSucceeded = true;
  })();

  let bootstrapPromise: Promise<void>;
  bootstrapPromise = run.finally(() => {
    if (!ownsBootstrap(state, bootstrapToken) || state.bootstrapPromise !== bootstrapPromise) return;
    const shouldResync =
      state.bufferedStateOverflowed || state.authoritativeResyncRequested;
    state.isBootstrappingState = !bootstrapSucceeded;
    state.bootstrapPromise = undefined;
    state.bootstrapController = undefined;
    state.bootstrapToken = undefined;
    if (bootstrapSucceeded) {
      state.bootstrapRetryAttempt = 0;
      if (shouldResync) scheduleAuthoritativeBootstrap(state);
      return;
    }
    clearBufferedStatePackets(state);
    state.bufferedStateOverflowed = false;
    state.authoritativeResyncRequested = true;
    scheduleBootstrapRetry(state);
  });
  state.bootstrapPromise = bootstrapPromise;
  return bootstrapPromise;
}

function cleanupIfUnused(state: ConnectionState) {
  if (state.ports.size > 0) return;
  abortAllUnknownSessionResolutions(state);
  state.pendingDirectSessionHydrationDirectories.clear();
  replaceHydrationGeneration(state);
  abortCurrentBootstrap(state);
  clearBootstrapRetry(state, true);
  state.isBootstrappingState = false;
  state.client.disconnect();
  connections.delete(state.key);
}

function detachPort(port: MessagePort) {
  const key = portToKey.get(port);
  if (!key) return;
  portToKey.delete(port);
  const state = connections.get(key);
  if (!state) return;
  cancelReferencedSubagentHydration(state, port);
  if (state.activeSelection?.port === port) {
    state.activeSelection = null;
  }
  state.ports.delete(port);
  cleanupIfUnused(state);
}

function createConnectionState(
  baseUrl: string,
  authorization?: string,
  errorMessages?: {
    emptyBaseUrl?: string;
    authenticationFailed?: string;
    streamClosed?: string;
    httpError?: (status: number) => string;
  },
) {
  const key = toKey(baseUrl, authorization);
  let state: ConnectionState;
  state = {
    key,
    baseUrl,
    authorization,
    ports: new Set<MessagePort>(),
    connected: false,
    stateBuilder: createStateBuilder(),
    notificationManager: createNotificationManager((projectId, sessionId) => ({
      projectId,
      sessionId: state.stateBuilder.resolveRootSessionIdForProject(projectId, sessionId),
    })),
    activeSelection: null,
    sessionHydrationByDirectory: new Map(),
    sessionHydrationInFlightByDirectory: new Map(),
    sessionHydrationRequestByDirectory: new Map(),
    sessionHydrationControllerByDirectory: new Map(),
    vcsHydratedDirectories: new Set(),
    vcsHydrationInFlightByDirectory: new Map(),
    vcsHydrationRequestByDirectory: new Map(),
    vcsHydrationControllerByDirectory: new Map(),
    isBootstrappingState: false,
    bufferedStatePackets: [],
    bufferedStatePacketBytes: 0,
    bufferedStateOverflowed: false,
    bootstrapResyncQueued: false,
    authoritativeResyncRequested: false,
    bootstrapRetryAttempt: 0,
    knownSessionDirectories: new Set(),
    unknownSessionResolutionsByDirectory: new Map(),
    pendingUnknownSessionsById: new Map(),
    pendingUnknownSessionCount: 0,
    pendingSelectedDirectory: null,
    pendingDirectSessionHydrationDirectories: new Set(),
    topologyReady: false,
    hydrationGeneration: 0,
    backgroundHydrationRequested: false,
    backgroundHydrationStarted: false,
    backgroundHydrationCompleteSent: false,
    referencedSubagentHydrationByPort: new Map(),
    client: createSseConnection({
      onPacket(packet) {
        broadcast(state, { type: 'packet', packet });
        handleStatePacket(state, packet);
      },
      onOpen(isReconnect) {
        state.connected = true;
        clearBootstrapRetry(state, true);
        broadcast(state, { type: 'connection.open' });
        if (isReconnect) {
          cancelAllReferencedSubagentHydrations(state);
          abortAllUnknownSessionResolutions(state);
          abortCurrentBootstrap(state);
          state.topologyReady = false;
          replaceHydrationGeneration(state);
          broadcast(state, { type: 'connection.reconnected' });
        }
        void bootstrapState(state, isReconnect).catch((error) => {
          const message =
            error instanceof Error ? error.message : 'Failed to bootstrap worker state.';
          broadcast(state, { type: 'connection.error', message });
        });
      },
      onError(message, statusCode) {
        state.connected = false;
        broadcast(state, { type: 'connection.error', message, statusCode });
      },
    }),
  };
  state.client.connect({ baseUrl, authorization, errorMessages });
  return state;
}

function attachPort(
  port: MessagePort,
  baseUrl: string,
  authorization?: string,
  errorMessages?: {
    emptyBaseUrl?: string;
    authenticationFailed?: string;
    streamClosed?: string;
    httpError?: (status: number) => string;
  },
) {
  detachPort(port);
  const key = toKey(baseUrl, authorization);
  const existing = connections.get(key);
  const state = existing ?? createConnectionState(baseUrl, authorization, errorMessages);
  if (!existing) {
    connections.set(key, state);
  }

  state.ports.add(port);
  portToKey.set(port, key);

  if (state.connected) {
    send(port, { type: 'connection.open' });
    if (!state.bootstrapPromise) {
      send(port, {
        type: 'state.bootstrap',
        projects: state.stateBuilder.getState().projects,
        notifications: state.notificationManager.getState(),
    sessionHydrationByDirectory: Object.fromEntries(state.sessionHydrationByDirectory),
      });
    }
  }
}

function handleMessage(port: MessagePort, event: MessageEvent<TabToWorkerMessage>) {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'connect') {
    if (!message.baseUrl) {
      send(port, {
        type: 'connection.error',
        message: message.errorMessages?.emptyBaseUrl ?? 'SSE base URL is empty.',
      });
      return;
    }
    attachPort(port, message.baseUrl, message.authorization, message.errorMessages);
    return;
  }

  if (message.type === 'disconnect') {
    detachPort(port);
    return;
  }

  const key = portToKey.get(port);
  if (!key) return;
  const state = connections.get(key);
  if (!state) return;

  if (message.type === 'load-sessions') {
    requestDirectSessionHydration(state, message.directory);
    return;
  }

  if (message.type === 'hydrate-referenced-subagents') {
    void hydrateReferencedSubagents(state, port, message).catch(() => {
      const hydration = state.referencedSubagentHydrationByPort.get(port);
      if (!hydration || hydration.requestId !== message.requestId.trim()) return;
      state.referencedSubagentHydrationByPort.delete(port);
      sendReferencedSubagentHydrationResult(port, hydration, [], false);
    });
    return;
  }

  if (message.type === 'selection.active') {
    const projectId = message.projectId.trim();
    const sessionId = message.sessionId.trim();
    const directory = normalizeDirectory(message.directory ?? '');
    if (!projectId || !sessionId) {
      cancelReferencedSubagentHydration(state, port);
      if (state.activeSelection?.port === port) {
        state.activeSelection = null;
      }
      state.pendingSelectedDirectory = null;
      return;
    }
    const activeSubagentHydration = state.referencedSubagentHydrationByPort.get(port);
    if (activeSubagentHydration && activeSubagentHydration.rootSessionId !== sessionId) {
      cancelReferencedSubagentHydration(state, port);
    }
    state.activeSelection = {
      port,
      projectId,
      sessionId,
    };

    if (state.topologyReady) {
      const rootSessionId = state.stateBuilder.resolveRootSessionIdForProject(projectId, sessionId);
      const idleRequestId = `idle:${projectId}:${rootSessionId || sessionId}`;
      const cleared = state.notificationManager.removeNotification(idleRequestId);
      if (cleared) {
        emitNotificationsUpdated(state);
      }
    }

    if (directory) {
      requestPriorityHydration(state, directory);
    } else if (state.topologyReady) {
      const project = state.stateBuilder.getProject(projectId);
      if (project) {
        for (const sandbox of Object.values(project.sandboxes)) {
          if (!sandbox.sessions[sessionId]) continue;
          requestPriorityHydration(state, sandbox.directory);
          break;
        }
      }
    }
    state.backgroundHydrationRequested = true;
    startBackgroundHydration(state);
    return;
  }

  if (message.type === 'sandbox.deleted') {
    const projectId = message.projectId.trim();
    const directory = normalizeDirectory(message.directory);
    if (!projectId || !directory) return;
    const project = state.stateBuilder.getProject(projectId);
    const sandbox = project?.sandboxes[directory];
    if (sandbox) {
      Object.keys(sandbox.sessions).forEach((sessionId) => {
        state.notificationManager.clearSession(projectId, sessionId);
      });
      emitNotificationsUpdated(state);
    }
    const changedProjectId = state.stateBuilder.removeSandboxDirectory(projectId, directory);
    rebuildKnownSessionDirectories(state);
    emitProjectUpdated(state, changedProjectId);
  }
}

self.onconnect = (event: MessageEvent) => {
  const port = event.ports[0];
  if (!port) return;
  port.onmessage = (messageEvent) => {
    handleMessage(port, messageEvent as MessageEvent<TabToWorkerMessage>);
  };
  port.start();
};
