import type { TabToWorkerMessage, WorkerToTabMessage } from '../types/sse-worker';
import type {
  ProjectInfo,
  SessionInfo,
  SessionStatusInfo,
  SsePacket,
  WorkerStateEventMap,
  WorkerStateEventType,
  WorkerStatePacket,
} from '../types/sse';
import { createNotificationManager } from '../utils/notificationManager';
import {
  getCurrentProject,
  getSessionStatusMap,
  getVcsInfo,
  listProjects,
  listSessions,
  setAuthorization,
  setBaseUrl,
} from '../utils/opencode';
import { createSseConnection, type SseConnection } from '../utils/sseConnection';
import { createStateBuilder } from '../utils/stateBuilder';

type SharedWorkerSelf = {
  onconnect: ((event: MessageEvent) => void) | null;
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
  activeSelection: {
    port: MessagePort;
    projectId: string;
    sessionId: string;
  } | null;
  sessionHydrationLevelByDirectory: Map<string, 'preview' | 'full'>;
  sessionHydrationInFlightByDirectory: Map<
    string,
    {
      mode: 'preview' | 'full';
      promise: Promise<void>;
    }
  >;
  vcsHydratedDirectories: Set<string>;
  vcsHydrationInFlightByDirectory: Map<string, Promise<void>>;
  isBootstrappingState: boolean;
  bufferedStatePackets: SsePacket[];
  pendingSelectedDirectory: string | null;
};

const connections = new Map<string, ConnectionState>();
const portToKey = new Map<MessagePort, string>();
let opencodeQueue: Promise<void> = Promise.resolve();
const INITIAL_DIRECTORY_SESSION_LIMIT = 1;

function toKey(baseUrl: string, authorization?: string) {
  return `${baseUrl.replace(/\/+$/, '')}\u0000${authorization ?? ''}`;
}

function send(port: MessagePort, message: WorkerToTabMessage) {
  port.postMessage(message);
}

function broadcast(state: ConnectionState, message: WorkerToTabMessage) {
  for (const port of state.ports) {
    send(port, message);
  }
}

function normalizeDirectory(value: string) {
  const trimmed = value.trim();
  if (!trimmed) return '';
  const normalized = trimmed.replace(/\/+$/, '');
  return normalized || '/';
}

function asRecord(value: unknown): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  return value as Record<string, unknown>;
}

function asString(value: unknown): string | undefined {
  return typeof value === 'string' ? value : undefined;
}

function asObjectArray<T>(value: unknown): T[] {
  if (!Array.isArray(value)) return [];
  return value as T[];
}

function asStatusMap(value: unknown): Record<string, { type?: string }> {
  const record = asRecord(value);
  if (!record) return {};
  return record as Record<string, { type?: string }>;
}

function asNumber(value: unknown): number | undefined {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function asBoolean(value: unknown): boolean | undefined {
  return typeof value === 'boolean' ? value : undefined;
}

function asStringArray(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const values: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') return null;
    values.push(item);
  }
  return values;
}

function asStringMatrix(value: unknown): string[][] | null {
  if (!Array.isArray(value)) return null;
  const rows: string[][] = [];
  for (const row of value) {
    const parsed = asStringArray(row);
    if (!parsed) return null;
    rows.push(parsed);
  }
  return rows;
}

function isPermissionRule(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  const action = asString(record.action);
  return (
    Boolean(asString(record.permission)) &&
    Boolean(asString(record.pattern)) &&
    (action === 'allow' || action === 'deny' || action === 'ask')
  );
}

function isFileDiff(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return (
    Boolean(asString(record.file)) &&
    typeof record.before === 'string' &&
    typeof record.after === 'string' &&
    asNumber(record.additions) !== undefined &&
    asNumber(record.deletions) !== undefined
  );
}

function isSessionInfo(value: unknown): value is SessionInfo {
  const record = asRecord(value);
  if (!record) return false;

  if (
    !asString(record.id) ||
    !asString(record.slug) ||
    !asString(record.projectID) ||
    !asString(record.directory) ||
    asString(record.title) === undefined ||
    !asString(record.version)
  ) {
    return false;
  }

  const time = asRecord(record.time);
  if (!time || asNumber(time.created) === undefined || asNumber(time.updated) === undefined) {
    return false;
  }
  if (time.compacting !== undefined && asNumber(time.compacting) === undefined) {
    return false;
  }
  if (time.archived !== undefined && asNumber(time.archived) === undefined) {
    return false;
  }
  if (time.pinned !== undefined && asNumber(time.pinned) === undefined) {
    return false;
  }

  if (record.parentID !== undefined && asString(record.parentID) === undefined) {
    return false;
  }

  if (record.summary !== undefined) {
    const summary = asRecord(record.summary);
    if (!summary) return false;
    if (
      asNumber(summary.additions) === undefined ||
      asNumber(summary.deletions) === undefined ||
      asNumber(summary.files) === undefined
    ) {
      return false;
    }
    if (summary.diffs !== undefined) {
      if (!Array.isArray(summary.diffs)) return false;
      if (!summary.diffs.every((diff) => isFileDiff(diff))) return false;
    }
  }

  if (record.share !== undefined) {
    const share = asRecord(record.share);
    if (!share || !asString(share.url)) return false;
  }

  if (record.permission !== undefined) {
    if (!Array.isArray(record.permission)) return false;
    if (!record.permission.every((entry) => isPermissionRule(entry))) return false;
  }

  if (record.revert !== undefined) {
    const revert = asRecord(record.revert);
    if (!revert || !asString(revert.messageID)) return false;
    if (revert.partID !== undefined && asString(revert.partID) === undefined) return false;
    if (revert.snapshot !== undefined && asString(revert.snapshot) === undefined) return false;
    if (revert.diff !== undefined && asString(revert.diff) === undefined) return false;
  }

  return true;
}

function isSessionEventProperties(value: unknown): value is WorkerStateEventMap['session.created'] {
  const record = asRecord(value);
  if (!record) return false;
  return isSessionInfo(record.info);
}

function isSessionStatusInfo(value: unknown): value is SessionStatusInfo {
  const record = asRecord(value);
  if (!record) return false;
  const type = asString(record.type);
  if (type === 'idle' || type === 'busy') return true;
  if (type !== 'retry') return false;
  return (
    asNumber(record.attempt) !== undefined &&
    asString(record.message) !== undefined &&
    asNumber(record.next) !== undefined
  );
}

function isSessionStatusProperties(value: unknown): value is WorkerStateEventMap['session.status'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.sessionID) !== undefined && isSessionStatusInfo(record.status);
}

function isProjectInfo(value: unknown): value is ProjectInfo {
  const record = asRecord(value);
  if (!record) return false;

  if (!asString(record.id) || !asString(record.worktree)) {
    return false;
  }

  if (record.vcs !== undefined && record.vcs !== 'git') {
    return false;
  }

  if (record.name !== undefined && typeof record.name !== 'string') {
    return false;
  }

  const time = asRecord(record.time);
  if (!time || asNumber(time.created) === undefined || asNumber(time.updated) === undefined) {
    return false;
  }
  if (time.initialized !== undefined && asNumber(time.initialized) === undefined) {
    return false;
  }

  const sandboxes = asStringArray(record.sandboxes);
  if (!sandboxes) return false;

  if (record.icon !== undefined) {
    const icon = asRecord(record.icon);
    if (!icon) return false;
    if (icon.url !== undefined && typeof icon.url !== 'string') return false;
    if (icon.override !== undefined && typeof icon.override !== 'string') return false;
    if (icon.color !== undefined && typeof icon.color !== 'string') return false;
  }

  if (record.commands !== undefined) {
    const commands = asRecord(record.commands);
    if (!commands) return false;
    if (commands.start !== undefined && typeof commands.start !== 'string') return false;
  }

  return true;
}

function isVcsBranchUpdatedProperties(
  value: unknown,
): value is WorkerStateEventMap['vcs.branch.updated'] {
  const record = asRecord(value);
  if (!record) return false;
  return record.branch === undefined || asString(record.branch) !== undefined;
}

function isPermissionAskedProperties(
  value: unknown,
): value is WorkerStateEventMap['permission.asked'] {
  const record = asRecord(value);
  if (!record) return false;

  if (
    !asString(record.id) ||
    !asString(record.sessionID) ||
    !asString(record.permission) ||
    !asStringArray(record.patterns) ||
    !asRecord(record.metadata) ||
    !asStringArray(record.always)
  ) {
    return false;
  }

  if (record.tool !== undefined) {
    const tool = asRecord(record.tool);
    if (!tool) return false;
    if (!asString(tool.messageID) || !asString(tool.callID)) return false;
  }

  return true;
}

function isQuestionOption(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;
  return Boolean(asString(record.label) && asString(record.description));
}

function isQuestionInfo(value: unknown): boolean {
  const record = asRecord(value);
  if (!record) return false;

  if (!asString(record.question) || !asString(record.header)) {
    return false;
  }

  if (
    !Array.isArray(record.options) ||
    !record.options.every((option) => isQuestionOption(option))
  ) {
    return false;
  }

  if (record.multiple !== undefined && asBoolean(record.multiple) === undefined) {
    return false;
  }
  if (record.custom !== undefined && asBoolean(record.custom) === undefined) {
    return false;
  }

  return true;
}

function isQuestionAskedProperties(value: unknown): value is WorkerStateEventMap['question.asked'] {
  const record = asRecord(value);
  if (!record) return false;

  if (!asString(record.id) || !asString(record.sessionID)) {
    return false;
  }

  if (
    !Array.isArray(record.questions) ||
    !record.questions.every((question) => isQuestionInfo(question))
  ) {
    return false;
  }

  if (record.tool !== undefined) {
    const tool = asRecord(record.tool);
    if (!tool) return false;
    if (!asString(tool.messageID) || !asString(tool.callID)) return false;
  }

  return true;
}

function isPermissionRepliedProperties(
  value: unknown,
): value is WorkerStateEventMap['permission.replied'] {
  const record = asRecord(value);
  if (!record) return false;
  const reply = asString(record.reply);
  return (
    asString(record.sessionID) !== undefined &&
    asString(record.requestID) !== undefined &&
    (reply === 'once' || reply === 'always' || reply === 'reject')
  );
}

function isQuestionRepliedProperties(
  value: unknown,
): value is WorkerStateEventMap['question.replied'] {
  const record = asRecord(value);
  if (!record) return false;
  return (
    asString(record.sessionID) !== undefined &&
    asString(record.requestID) !== undefined &&
    asStringMatrix(record.answers) !== null
  );
}

function isQuestionRejectedProperties(
  value: unknown,
): value is WorkerStateEventMap['question.rejected'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.sessionID) !== undefined && asString(record.requestID) !== undefined;
}

function isWorktreeReadyProperties(value: unknown): value is WorkerStateEventMap['worktree.ready'] {
  const record = asRecord(value);
  if (!record) return false;
  return asString(record.name) !== undefined && asString(record.branch) !== undefined;
}

const WORKER_STATE_EVENT_TYPES = [
  'session.created',
  'session.updated',
  'session.deleted',
  'session.status',
  'project.updated',
  'vcs.branch.updated',
  'permission.asked',
  'question.asked',
  'permission.replied',
  'question.replied',
  'question.rejected',
  'worktree.ready',
] as const satisfies readonly WorkerStateEventType[];

const WORKER_STATE_EVENT_TYPE_SET = new Set<string>(WORKER_STATE_EVENT_TYPES);

function isWorkerStateEventType(value: string): value is WorkerStateEventType {
  return WORKER_STATE_EVENT_TYPE_SET.has(value);
}

function parseWorkerStatePacket(packet: SsePacket): WorkerStatePacket | null {
  const packetType = packet.payload.type;
  if (!isWorkerStateEventType(packetType)) return null;

  const properties = packet.payload.properties;
  switch (packetType) {
    case 'session.created': {
      if (!isSessionEventProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'session.created',
          properties,
        },
      };
    }
    case 'session.updated': {
      if (!isSessionEventProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'session.updated',
          properties,
        },
      };
    }
    case 'session.deleted': {
      if (!isSessionEventProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'session.deleted',
          properties,
        },
      };
    }
    case 'session.status': {
      if (!isSessionStatusProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'session.status',
          properties,
        },
      };
    }
    case 'project.updated': {
      if (!isProjectInfo(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'project.updated',
          properties,
        },
      };
    }
    case 'vcs.branch.updated': {
      if (!isVcsBranchUpdatedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'vcs.branch.updated',
          properties,
        },
      };
    }
    case 'permission.asked': {
      if (!isPermissionAskedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'permission.asked',
          properties,
        },
      };
    }
    case 'question.asked': {
      if (!isQuestionAskedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'question.asked',
          properties,
        },
      };
    }
    case 'permission.replied': {
      if (!isPermissionRepliedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'permission.replied',
          properties,
        },
      };
    }
    case 'question.replied': {
      if (!isQuestionRepliedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'question.replied',
          properties,
        },
      };
    }
    case 'question.rejected': {
      if (!isQuestionRejectedProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'question.rejected',
          properties,
        },
      };
    }
    case 'worktree.ready': {
      if (!isWorktreeReadyProperties(properties)) return null;
      return {
        directory: packet.directory,
        payload: {
          type: 'worktree.ready',
          properties,
        },
      };
    }
  }
}

function queueOpencodeTask<T>(state: ConnectionState, task: () => Promise<T>): Promise<T> {
  const run = opencodeQueue.then(async () => {
    setBaseUrl(state.baseUrl);
    setAuthorization(state.authorization);
    return task();
  });
  opencodeQueue = run.then(
    () => undefined,
    () => undefined,
  );
  return run;
}

function collectProjectDirectories(projects: Array<Record<string, unknown>>) {
  const directories: string[] = [''];
  const seen = new Set<string>(directories);

  projects.forEach((project) => {
    const worktree = normalizeDirectory(asString(project.worktree) ?? '');
    if (worktree && !seen.has(worktree)) {
      seen.add(worktree);
      directories.push(worktree);
    }

    const sandboxes = asStringArray(project.sandboxes) ?? [];
    sandboxes.forEach((sandbox) => {
      const directory = normalizeDirectory(sandbox);
      if (!directory || seen.has(directory)) return;
      seen.add(directory);
      directories.push(directory);
    });
  });

  return directories;
}

async function loadDirectorySessions(
  state: ConnectionState,
  directory: string,
  mode: 'preview' | 'full',
) {
  const normalizedDirectory = normalizeDirectory(directory);
  const currentLevel = state.sessionHydrationLevelByDirectory.get(normalizedDirectory);
  if (currentLevel === 'full' || (currentLevel === 'preview' && mode === 'preview')) {
    return;
  }

  const inFlight = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
  if (inFlight) {
    if (inFlight.mode === 'full' || inFlight.mode === mode) {
      await inFlight.promise;
      return;
    }
    await inFlight.promise;
    return loadDirectorySessions(state, normalizedDirectory, mode);
  }

  const promise = queueOpencodeTask(state, async () => {
    const [rawSessions, rawStatuses] = await Promise.all([
      listSessions({
        directory: normalizedDirectory,
        roots: true,
        limit: mode === 'preview' ? INITIAL_DIRECTORY_SESSION_LIMIT : undefined,
      }),
      getSessionStatusMap(normalizedDirectory),
    ]);

    const sessions = asObjectArray(rawSessions) as Parameters<
      typeof state.stateBuilder.applySessions
    >[0];
    state.stateBuilder.applySessions(sessions);
    state.stateBuilder.applyStatuses(asStatusMap(rawStatuses));

    const projectIds = new Set<string>();
    const resolvedProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
    if (resolvedProjectId) {
      projectIds.add(resolvedProjectId);
    }
    for (const session of sessions) {
      const projectId = session.projectID?.trim();
      if (projectId) projectIds.add(projectId);
    }

    for (const projectId of projectIds) {
      emitProjectUpdated(state, projectId);
    }

    state.sessionHydrationLevelByDirectory.set(normalizedDirectory, mode);
  }).finally(() => {
    const active = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
    if (active?.promise === promise) {
      state.sessionHydrationInFlightByDirectory.delete(normalizedDirectory);
    }
  });

  state.sessionHydrationInFlightByDirectory.set(normalizedDirectory, { mode, promise });
  await promise;
}

async function loadDirectoryVcs(state: ConnectionState, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  if (state.vcsHydratedDirectories.has(normalizedDirectory)) {
    return;
  }

  const inFlight = state.vcsHydrationInFlightByDirectory.get(normalizedDirectory);
  if (inFlight) {
    await inFlight;
    return;
  }

  const promise = queueOpencodeTask(state, async () => {
    const raw = await getVcsInfo(normalizedDirectory).catch(() => null);
    const vcsInfo = asRecord(raw);
    if (!vcsInfo) {
      state.vcsHydratedDirectories.add(normalizedDirectory);
      return;
    }

    const branch = asString(vcsInfo.branch);
    if (branch) {
      state.stateBuilder.applyVcsInfo(normalizedDirectory, { branch });
      emitProjectUpdated(state, state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory));
    }

    state.vcsHydratedDirectories.add(normalizedDirectory);
  }).finally(() => {
    const active = state.vcsHydrationInFlightByDirectory.get(normalizedDirectory);
    if (active === promise) {
      state.vcsHydrationInFlightByDirectory.delete(normalizedDirectory);
    }
  });

  state.vcsHydrationInFlightByDirectory.set(normalizedDirectory, promise);
  await promise;
}

function scheduleBackgroundHydration(state: ConnectionState, directories: string[]) {
  void (async () => {
    for (const directory of directories) {
      if (!connections.has(state.key)) return;
      if (state.pendingSelectedDirectory === normalizeDirectory(directory)) continue;
      await loadDirectorySessions(state, directory, 'full').catch(() => {});
      await loadDirectoryVcs(state, directory).catch(() => {});
    }
  })();
}

function flushBufferedStatePackets(state: ConnectionState) {
  if (state.bufferedStatePackets.length === 0) return;
  const buffered = [...state.bufferedStatePackets];
  state.bufferedStatePackets = [];
  for (const packet of buffered) {
    handleStatePacket(state, packet);
  }
}

function requestPriorityHydration(state: ConnectionState, directory?: string) {
  const normalizedDirectory = normalizeDirectory(directory ?? '');
  if (!normalizedDirectory) return;
  state.pendingSelectedDirectory = normalizedDirectory;
  void loadDirectorySessions(state, normalizedDirectory, 'full')
    .catch(() => {})
    .finally(() => {
      if (state.pendingSelectedDirectory === normalizedDirectory) {
        state.pendingSelectedDirectory = null;
      }
    });
  void loadDirectoryVcs(state, normalizedDirectory).catch(() => {});
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

async function resolveUnknownSessionDirectory(state: ConnectionState, info: SessionInfo) {
  const directory = normalizeDirectory(info.directory);
  if (!directory) return;

  const projectInfo = await queueOpencodeTask(state, async () => {
    const raw = await getCurrentProject(directory);
    return isProjectInfo(raw) ? raw : null;
  }).catch(() => null);
  if (!projectInfo) return;

  const worktree = normalizeDirectory(projectInfo.worktree);
  if (!worktree) return;

  const knownProjectId = state.stateBuilder.resolveProjectIdForDirectory(worktree);
  if (knownProjectId) {
    const changedProjectId = state.stateBuilder.registerSandboxDirectory(knownProjectId, directory);
    emitProjectUpdated(state, changedProjectId);
    const changedSessionProjectId = state.stateBuilder.applySessionMutated(info);
    emitProjectUpdated(state, changedSessionProjectId);
    return;
  }

  if (directory !== worktree) {
    return;
  }

  const changedProjectId = state.stateBuilder.processProjectUpdated(projectInfo);
  emitProjectUpdated(state, changedProjectId);

  const changedSessionProjectId = state.stateBuilder.applySessionMutated(info);
  emitProjectUpdated(state, changedSessionProjectId);
}

function handleStatePacket(state: ConnectionState, packet: SsePacket) {
  if (state.isBootstrappingState) {
    state.bufferedStatePackets.push(packet);
    return;
  }

  const parsedPacket = parseWorkerStatePacket(packet);
  if (!parsedPacket) return;

  const packetType = parsedPacket.payload.type;
  const packetDirectory = normalizeDirectory(parsedPacket.directory);
  let projectId: string | null = null;
  let notificationsChanged = false;

  switch (packetType) {
    case 'session.created': {
      const info = parsedPacket.payload.properties.info;
      projectId = state.stateBuilder.processSessionCreated(info);
      if (!projectId) {
        void resolveUnknownSessionDirectory(state, info);
      }
      break;
    }
    case 'session.updated': {
      const info = parsedPacket.payload.properties.info;
      projectId = state.stateBuilder.processSessionUpdated(info);
      if (!projectId) {
        void resolveUnknownSessionDirectory(state, info);
      }
      break;
    }
    case 'session.deleted': {
      const info = parsedPacket.payload.properties.info;
      const sessionId = info.id;
      const deletedDirectory = normalizeDirectory(info.directory);
      const deletedProjectId = state.stateBuilder.resolveProjectIdForDirectory(deletedDirectory);
      projectId = state.stateBuilder.processSessionDeleted(sessionId, deletedProjectId);
      if (deletedProjectId) {
        const cleared = state.notificationManager.clearSession(deletedProjectId, sessionId);
        notificationsChanged = cleared || notificationsChanged;
      }
      break;
    }
    case 'session.status': {
      const sessionId = parsedPacket.payload.properties.sessionID;
      const status = parsedPacket.payload.properties.status.type;
      const statusProjectId = state.stateBuilder.resolveProjectIdForDirectory(packetDirectory);
      if (statusProjectId) {
        projectId = state.stateBuilder.processSessionStatus(sessionId, status, statusProjectId);
        const rootSessionId = state.stateBuilder.resolveRootSessionIdForProject(
          statusProjectId,
          sessionId,
        );
        if (rootSessionId) {
          const idleRequestId = `idle:${statusProjectId}:${rootSessionId}`;
          const treeIdle = state.stateBuilder.isSessionTreeIdle(statusProjectId, rootSessionId);

          if (!treeIdle) {
            notificationsChanged =
              state.notificationManager.removeNotification(idleRequestId) || notificationsChanged;
          } else if (!shouldSuppressIdleNotification(state, statusProjectId, rootSessionId)) {
            const added = state.notificationManager.addNotification(
              statusProjectId,
              rootSessionId,
              idleRequestId,
            );
            notificationsChanged = added || notificationsChanged;
            if (added) {
              emitNotificationShow(state, statusProjectId, rootSessionId, 'idle');
            }
          }
        }
      }
      break;
    }
    case 'project.updated': {
      projectId = state.stateBuilder.processProjectUpdated(parsedPacket.payload.properties);
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
}

async function bootstrapState(state: ConnectionState): Promise<void> {
  if (state.bootstrapPromise) {
    return state.bootstrapPromise;
  }

  const builder = createStateBuilder();
  const run = queueOpencodeTask(state, async () => {
    state.isBootstrappingState = true;
    const projects = asObjectArray<Record<string, unknown>>(await listProjects());
    const directories = collectProjectDirectories(projects);

    builder.applyProjects(projects as Parameters<typeof builder.applyProjects>[0]);

    await Promise.all(
      directories.map(async (directory) => {
        const [sessions, statuses] = await Promise.all([
          listSessions({
            directory,
            roots: true,
            limit: INITIAL_DIRECTORY_SESSION_LIMIT,
          }),
          getSessionStatusMap(directory),
        ]);
        builder.applySessions(asObjectArray(sessions) as Parameters<typeof builder.applySessions>[0]);
        builder.applyStatuses(asStatusMap(statuses));
      }),
    );

    builder.getDefaultProjectId();
    state.stateBuilder = builder;
    state.sessionHydrationLevelByDirectory.clear();
    directories.forEach((directory) => {
      state.sessionHydrationLevelByDirectory.set(normalizeDirectory(directory), 'preview');
    });
    state.vcsHydratedDirectories.clear();

    broadcast(state, {
      type: 'state.bootstrap',
      projects: state.stateBuilder.getState().projects,
      notifications: state.notificationManager.getState(),
    });

    state.isBootstrappingState = false;
    flushBufferedStatePackets(state);

    if (state.pendingSelectedDirectory) {
      requestPriorityHydration(state, state.pendingSelectedDirectory);
    }

    scheduleBackgroundHydration(state, directories);
  });

  const bootstrapPromise = run.finally(() => {
    state.isBootstrappingState = false;
    if (state.bootstrapPromise === bootstrapPromise) {
      state.bootstrapPromise = undefined;
    }
  });
  state.bootstrapPromise = bootstrapPromise;
  return bootstrapPromise;
}

function cleanupIfUnused(state: ConnectionState) {
  if (state.ports.size > 0) return;
  state.client.disconnect();
  connections.delete(state.key);
}

function detachPort(port: MessagePort) {
  const key = portToKey.get(port);
  if (!key) return;
  portToKey.delete(port);
  const state = connections.get(key);
  if (!state) return;
  if (state.activeSelection?.port === port) {
    state.activeSelection = null;
  }
  state.ports.delete(port);
  cleanupIfUnused(state);
}

function createConnectionState(baseUrl: string, authorization?: string, errorMessages?: { emptyBaseUrl?: string; authenticationFailed?: string; streamClosed?: string; httpError?: (status: number) => string }) {
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
    sessionHydrationLevelByDirectory: new Map(),
    sessionHydrationInFlightByDirectory: new Map(),
    vcsHydratedDirectories: new Set(),
    vcsHydrationInFlightByDirectory: new Map(),
    isBootstrappingState: false,
    bufferedStatePackets: [],
    pendingSelectedDirectory: null,
    client: createSseConnection({
      onPacket(packet) {
        broadcast(state, { type: 'packet', packet });
        handleStatePacket(state, packet);
      },
      onOpen(isReconnect) {
        state.connected = true;
        broadcast(state, { type: 'connection.open' });
        if (isReconnect) {
          broadcast(state, { type: 'connection.reconnected' });
        }
        void bootstrapState(state).catch((error) => {
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

function attachPort(port: MessagePort, baseUrl: string, authorization?: string, errorMessages?: { emptyBaseUrl?: string; authenticationFailed?: string; streamClosed?: string; httpError?: (status: number) => string }) {
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
      });
    }
  }
}

function handleMessage(port: MessagePort, event: MessageEvent<TabToWorkerMessage>) {
  const message = event.data;
  if (!message || typeof message !== 'object') return;

  if (message.type === 'connect') {
    if (!message.baseUrl) {
      send(port, { type: 'connection.error', message: message.errorMessages?.emptyBaseUrl ?? 'SSE base URL is empty.' });
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
    const directory = normalizeDirectory(message.directory);
    if (!directory) return;

    void loadDirectorySessions(state, directory, 'full').catch(() => {});
    void loadDirectoryVcs(state, directory).catch(() => {});
    return;
  }

  if (message.type === 'selection.active') {
    const projectId = message.projectId.trim();
    const sessionId = message.sessionId.trim();
    const directory = normalizeDirectory(message.directory ?? '');
    if (!projectId || !sessionId) {
      if (state.activeSelection?.port === port) {
        state.activeSelection = null;
      }
      state.pendingSelectedDirectory = null;
      return;
    }
    state.activeSelection = {
      port,
      projectId,
      sessionId,
    };

    const rootSessionId = state.stateBuilder.resolveRootSessionIdForProject(projectId, sessionId);
    const idleRequestId = `idle:${projectId}:${rootSessionId || sessionId}`;
    const cleared = state.notificationManager.removeNotification(idleRequestId);
    if (cleared) {
      emitNotificationsUpdated(state);
    }

    if (directory) {
      requestPriorityHydration(state, directory);
      return;
    }

     const project = state.stateBuilder.getProject(projectId);
     if (project) {
       for (const sandbox of Object.values(project.sandboxes)) {
         if (!sandbox.sessions[sessionId]) continue;
         requestPriorityHydration(state, sandbox.directory);
         break;
       }
     }
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
