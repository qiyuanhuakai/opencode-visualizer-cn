import type {
  DirectorySessionHydration,
  TabToWorkerMessage,
  WorkerToTabMessage,
} from '../types/sse-worker';
import type {
  ProjectInfo,
  SessionInfo,
  SessionStatusInfo,
  SsePacket,
  WorkerStateEventMap,
  WorkerStateEventType,
  WorkerStatePacket,
} from '../types/sse';
import { normalizeDirectory } from '../utils/path';
import { createNotificationManager } from '../utils/notificationManager';
import { createOpenCodeAdapter } from '../backends/openCodeAdapter';
import { createSseConnection, type SseConnection } from '../utils/sseConnection';
import { createStateBuilder } from '../utils/stateBuilder';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';

type SharedWorkerSelf = {
  onconnect: ((event: MessageEvent) => void) | null;
};

type ReferencedSubagentHydration = {
  requestId: string;
  rootSessionId: string;
  generation: number;
  controller: AbortController;
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
  sessionHydrationByDirectory: Map<string, DirectorySessionHydration>;
  sessionHydrationInFlightByDirectory: Map<string, Promise<void>>;
  vcsHydratedDirectories: Set<string>;
  vcsHydrationInFlightByDirectory: Map<string, Promise<void>>;
  isBootstrappingState: boolean;
  bufferedStatePackets: SsePacket[];
  pendingSelectedDirectory: string | null;
  topologyReady: boolean;
  hydrationGeneration: number;
  backgroundHydrationRequested: boolean;
  backgroundHydrationStarted: boolean;
  backgroundHydrationCompleteSent: boolean;
  referencedSubagentHydrationByPort: Map<MessagePort, ReferencedSubagentHydration>;
};

const connections = new Map<string, ConnectionState>();
const portToKey = new Map<MessagePort, string>();
const OPENCODE_READ_CONCURRENCY = 12;
const opencodeBackend = createOpenCodeAdapter();
let activeOpencodeReadTasks = 0;
const pendingOpencodeReadResolvers: Array<() => void> = [];

async function acquireOpencodeReadSlot() {
  if (activeOpencodeReadTasks < OPENCODE_READ_CONCURRENCY) {
    activeOpencodeReadTasks += 1;
    return;
  }

  await new Promise<void>((resolve) => {
    pendingOpencodeReadResolvers.push(resolve);
  });
}

function releaseOpencodeReadSlot() {
  activeOpencodeReadTasks = Math.max(0, activeOpencodeReadTasks - 1);
  const next = pendingOpencodeReadResolvers.shift();
  if (!next) return;
  activeOpencodeReadTasks += 1;
  next();
}

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

function isCurrentConnection(state: ConnectionState) {
  return connections.get(state.key) === state;
}

function getSessionHydrationSnapshot(state: ConnectionState) {
  return Object.fromEntries(state.sessionHydrationByDirectory);
}

function emitDirectoryHydration(
  state: ConnectionState,
  directory: string,
  hydration: DirectorySessionHydration,
) {
  state.sessionHydrationByDirectory.set(directory, hydration);
  broadcast(state, { type: 'state.directory-hydration-updated', directory, hydration });
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
  const hasFile = Boolean(asString(record.file));
  const hasAdditions = asNumber(record.additions) !== undefined;
  const hasDeletions = asNumber(record.deletions) !== undefined;
  if (!hasFile || !hasAdditions || !hasDeletions) return false;
  // Support legacy format (before + after) and new format (patch only)
  const hasLegacyContent = typeof record.before === 'string' && typeof record.after === 'string';
  const hasPatchContent = typeof record.patch === 'string';
  return hasLegacyContent || hasPatchContent;
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

async function runOpencodeReadTask<T>(state: ConnectionState, task: () => Promise<T>): Promise<T> {
  await acquireOpencodeReadSlot();
  try {
    opencodeBackend.configure?.({ baseUrl: state.baseUrl, authorization: state.authorization });
    return await task();
  } finally {
    releaseOpencodeReadSlot();
  }
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
    new Set(request.sessionIds.map((sessionId) => sessionId.trim()).filter(Boolean)),
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

function collectProjectDirectories(projects: Array<Record<string, unknown>>) {
  const directories: string[] = [];
  const seen = new Set<string>();

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

async function loadDirectorySessions(state: ConnectionState, directory: string) {
  const normalizedDirectory = normalizeDirectory(directory);
  const hydration = state.sessionHydrationByDirectory.get(normalizedDirectory);
  if (!hydration || hydration.status === 'loaded') {
    return;
  }

  const inFlight = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
  if (inFlight) {
    await inFlight;
    return;
  }

  const generation = state.hydrationGeneration;
  const statusRevision = state.stateBuilder.beginStatusSnapshot();
  const mutationRevision = state.stateBuilder.beginMutationSnapshot();
  emitDirectoryHydration(state, normalizedDirectory, { status: 'loading' });
  const promise = runOpencodeReadTask(state, async () => {
    const [rawSessions, rawStatuses] = await Promise.all([
      opencodeBackend.listSessions({ directory: normalizedDirectory, roots: true }),
      opencodeBackend.getSessionStatusMap?.(normalizedDirectory),
    ]);
    if (!isCurrentConnection(state) || state.hydrationGeneration !== generation) return;

    // Guard against resurrecting a deleted worktree: if the sandbox no longer
    // exists in the current state builder, skip applying stale session data.
    const liveProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
    const liveProject = liveProjectId ? state.stateBuilder.getProject(liveProjectId) : undefined;
    if (!liveProject?.sandboxes[normalizedDirectory]) return;

    const sessions = asObjectArray(rawSessions) as Parameters<
      typeof state.stateBuilder.applySessions
    >[0];
    state.stateBuilder.applySessionSnapshot(sessions, mutationRevision);
    state.stateBuilder.applyStatusSnapshot(
      sessions.map((session) => session.id),
      asStatusMap(rawStatuses),
      statusRevision,
    );

    const projectIds = new Set<string>();
    const resolvedProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
    if (resolvedProjectId) projectIds.add(resolvedProjectId);
    for (const session of sessions) {
      const projectId = session.projectID?.trim();
      if (projectId) projectIds.add(projectId);
    }
    for (const projectId of projectIds) emitProjectUpdated(state, projectId);
    emitDirectoryHydration(state, normalizedDirectory, { status: 'loaded' });
  })
    .catch((error: unknown) => {
      if (isCurrentConnection(state) && state.hydrationGeneration === generation) {
        emitDirectoryHydration(state, normalizedDirectory, {
          status: 'error',
          error: error instanceof Error ? error.message : 'Failed to load directory sessions.',
        });
      }
      throw error;
    })
    .finally(() => {
      state.stateBuilder.completeStatusSnapshot(statusRevision);
      state.stateBuilder.completeMutationSnapshot(mutationRevision);
      const active = state.sessionHydrationInFlightByDirectory.get(normalizedDirectory);
      if (active === promise) {
        state.sessionHydrationInFlightByDirectory.delete(normalizedDirectory);
      }
    });

  state.sessionHydrationInFlightByDirectory.set(normalizedDirectory, promise);
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

  const generation = state.hydrationGeneration;
  const promise = runOpencodeReadTask(state, async () => {
    const raw = await opencodeBackend.getVcsInfo?.(normalizedDirectory).catch(() => null);
    if (!isCurrentConnection(state) || state.hydrationGeneration !== generation) return;
    const vcsInfo = asRecord(raw);
    if (!vcsInfo) {
      state.vcsHydratedDirectories.add(normalizedDirectory);
      return;
    }

    const liveProjectId = state.stateBuilder.resolveProjectIdForDirectory(normalizedDirectory);
    const liveProject = liveProjectId ? state.stateBuilder.getProject(liveProjectId) : undefined;
    if (!liveProject?.sandboxes[normalizedDirectory]) {
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

const BACKGROUND_HYDRATION_CONCURRENCY = 2;

function startBackgroundHydration(state: ConnectionState) {
  if (!state.topologyReady || state.backgroundHydrationStarted) return;
  state.backgroundHydrationStarted = true;
  const generation = state.hydrationGeneration;
  const directories = [...state.sessionHydrationByDirectory].flatMap(([directory, hydration]) =>
    hydration.status === 'loaded' ? [] : [directory],
  );
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
  state.bufferedStatePackets = [];
  for (const packet of buffered) {
    handleStatePacket(state, packet);
  }
}

function requestPriorityHydration(state: ConnectionState, directory?: string) {
  const normalizedDirectory = normalizeDirectory(directory ?? '');
  if (!normalizedDirectory) return;
  state.pendingSelectedDirectory = normalizedDirectory;
  if (!state.topologyReady) return;
  void loadDirectorySessions(state, normalizedDirectory)
    .catch(() => {})
    .finally(() => {
      if (state.pendingSelectedDirectory === normalizedDirectory) {
        state.pendingSelectedDirectory = null;
      }
    });
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

  const projectInfo = await runOpencodeReadTask(state, async () => {
    const raw = await opencodeBackend.getCurrentProject?.(directory);
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

async function bootstrapState(state: ConnectionState, forceRestart = false): Promise<void> {
  if (state.bootstrapPromise) {
    if (!forceRestart) {
      return state.bootstrapPromise;
    }
    // The reconnect already bumped hydrationGeneration, so the pending run
    // aborts at its post-await guard; detach it so the fresh run can start.
    state.bootstrapPromise = undefined;
  }

  const builder = createStateBuilder();
  let aborted = false;
  const run = (async () => {
    state.isBootstrappingState = true;
    const generation = state.hydrationGeneration;
    const projects = asObjectArray<Record<string, unknown>>(
      await runOpencodeReadTask(
        state,
        () => opencodeBackend.listProjects?.() ?? Promise.resolve([]),
      ),
    );
    if (!isCurrentConnection(state) || state.hydrationGeneration !== generation) {
      aborted = true;
      return;
    }
    builder.applyProjects(projects as Parameters<typeof builder.applyProjects>[0]);
    builder.getDefaultProjectId();
    state.stateBuilder = builder;
    state.hydrationGeneration += 1;
    state.sessionHydrationByDirectory.clear();
    for (const directory of collectProjectDirectories(projects)) {
      state.sessionHydrationByDirectory.set(directory, { status: 'unloaded' });
    }
    state.sessionHydrationInFlightByDirectory.clear();
    state.vcsHydratedDirectories.clear();
    state.vcsHydrationInFlightByDirectory.clear();
    state.backgroundHydrationStarted = false;
    state.backgroundHydrationCompleteSent = false;
    state.topologyReady = true;

    broadcast(state, {
      type: 'state.bootstrap',
      projects: state.stateBuilder.getState().projects,
      notifications: state.notificationManager.getState(),
      sessionHydrationByDirectory: getSessionHydrationSnapshot(state),
    });

    state.isBootstrappingState = false;
    flushBufferedStatePackets(state);

    if (state.pendingSelectedDirectory) {
      requestPriorityHydration(state, state.pendingSelectedDirectory);
    }
    if (state.backgroundHydrationRequested) {
      startBackgroundHydration(state);
    }
  })();

  const bootstrapPromise = run.finally(() => {
    if (!aborted) {
      state.isBootstrappingState = false;
    }
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
    vcsHydratedDirectories: new Set(),
    vcsHydrationInFlightByDirectory: new Map(),
    isBootstrappingState: false,
    bufferedStatePackets: [],
    pendingSelectedDirectory: null,
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
        broadcast(state, { type: 'connection.open' });
        if (isReconnect) {
          cancelAllReferencedSubagentHydrations(state);
          state.hydrationGeneration += 1;
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
        sessionHydrationByDirectory: getSessionHydrationSnapshot(state),
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
    const directory = normalizeDirectory(message.directory);
    if (!directory) return;

    void loadDirectorySessions(state, directory).catch(() => {});
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

    const rootSessionId = state.stateBuilder.resolveRootSessionIdForProject(projectId, sessionId);
    const idleRequestId = `idle:${projectId}:${rootSessionId || sessionId}`;
    const cleared = state.notificationManager.removeNotification(idleRequestId);
    if (cleared) {
      emitNotificationsUpdated(state);
    }

    if (directory) {
      requestPriorityHydration(state, directory);
    } else {
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
    emitProjectUpdated(state, changedProjectId);
    if (state.sessionHydrationByDirectory.has(directory)) {
      emitDirectoryHydration(state, directory, { status: 'error', error: 'Sandbox deleted.' });
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
