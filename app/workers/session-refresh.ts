import type { SessionInfo } from '../types/sse';
import { normalizeDirectory } from '../utils/path';
import { isSessionInfo } from './sse-state-packet';

type RefreshState = {
  hydrationGeneration: number;
  sessionRefreshInFlightById: Map<string, Promise<void>>;
  sessionRefreshPendingIds: Set<string>;
  stateBuilder: {
    applyAuthoritativeSessions: (sessions: SessionInfo[]) => void;
  };
};

type RefreshDependencies<State extends RefreshState> = {
  getSession: (id: string, directory: string) => Promise<unknown>;
  runTask: (state: State, task: () => Promise<unknown>, options: { generation: number }) => Promise<unknown>;
  isCurrent: (state: State) => boolean;
  emitProjectUpdated: (state: State, projectId: string) => void;
};

export function refreshSession<State extends RefreshState>(
  state: State,
  sessionId: string,
  directory: string,
  dependencies: RefreshDependencies<State>,
): void {
  const id = sessionId.trim();
  const normalizedDirectory = normalizeDirectory(directory);
  if (!id || !normalizedDirectory) return;
  if (state.sessionRefreshInFlightById.has(id)) {
    state.sessionRefreshPendingIds.add(id);
    return;
  }
  const generation = state.hydrationGeneration;
  const task = dependencies.runTask(state, () => dependencies.getSession(id, normalizedDirectory), { generation })
    .then((session) => {
      if (!dependencies.isCurrent(state) || state.hydrationGeneration !== generation || !isSessionInfo(session)) return;
      if (session.id !== id || normalizeDirectory(session.directory) !== normalizedDirectory) return;
      state.stateBuilder.applyAuthoritativeSessions([session]);
      dependencies.emitProjectUpdated(state, session.projectID);
    })
    .catch(() => {})
    .finally(() => {
      if (state.sessionRefreshInFlightById.get(id) !== task) return;
      state.sessionRefreshInFlightById.delete(id);
      if (state.sessionRefreshPendingIds.delete(id) && dependencies.isCurrent(state)) {
        refreshSession(state, id, normalizedDirectory, dependencies);
      }
    });
  state.sessionRefreshInFlightById.set(id, task);
}
