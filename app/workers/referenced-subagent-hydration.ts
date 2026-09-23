import type { SessionInfo } from '../types/sse';
import type { TabToWorkerMessage } from '../types/sse-worker';
import { normalizeDirectory } from '../utils/path';
import { mapWithConcurrency } from '../utils/mapWithConcurrency';
import { isSessionInfo } from './sse-state-packet';

type Hydration = {
  requestId: string;
  rootSessionId: string;
  generation: number;
  controller: AbortController;
};

type HydrationState = {
  hydrationGeneration: number;
  referencedSubagentHydrationByPort: Map<MessagePort, Hydration>;
  stateBuilder: { applyAuthoritativeSessions: (sessions: SessionInfo[]) => void };
};

type Dependencies<State extends HydrationState> = {
  getSession?: (id: string, directory: string, options: { signal: AbortSignal }) => Promise<unknown>;
  runTask: (state: State, task: () => Promise<unknown>, options: { signal: AbortSignal; generation: number }) => Promise<unknown>;
  isCurrent: (state: State) => boolean;
  emitProjectUpdated: (state: State, projectId: string) => void;
  cancel: (state: State, port: MessagePort) => void;
  sendResult: (port: MessagePort, hydration: Hydration, sessionIds: string[], cancelled: boolean) => void;
};

export async function hydrateReferencedSubagents<State extends HydrationState>(
  state: State,
  port: MessagePort,
  request: Extract<TabToWorkerMessage, { type: 'hydrate-referenced-subagents' }>,
  dependencies: Dependencies<State>,
): Promise<void> {
  const requestId = request.requestId.trim();
  const rootSessionId = request.rootSessionId.trim();
  const directory = normalizeDirectory(request.directory);
  const sessionIds = Array.from(
    new Set(
      request.sessionIds
        .slice(0, 128)
        .map((sessionId) => sessionId.trim())
        .filter(Boolean),
    ),
  ).filter((sessionId) => sessionId !== rootSessionId);
  const hydration: Hydration = {
    requestId,
    rootSessionId,
    generation: state.hydrationGeneration,
    controller: new AbortController(),
  };
  const getSession = dependencies.getSession;

  if (!requestId || !rootSessionId || !directory || sessionIds.length === 0 || !getSession) {
    dependencies.sendResult(port, hydration, [], false);
    return;
  }

  state.referencedSubagentHydrationByPort.set(port, hydration);
  const results = await mapWithConcurrency(sessionIds, 2, async (sessionId) => {
    const rawSession = await dependencies.runTask(state, () =>
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
    !dependencies.isCurrent(state)
  ) {
    dependencies.cancel(state, port);
    return;
  }

  const sessions = results.flatMap((result) =>
    result.status === 'fulfilled' && result.value ? [result.value] : [],
  );
  state.stateBuilder.applyAuthoritativeSessions(sessions);
  const projectIds = new Set(sessions.map((session) => session.projectID.trim()).filter(Boolean));
  for (const projectId of projectIds) dependencies.emitProjectUpdated(state, projectId);

  state.referencedSubagentHydrationByPort.delete(port);
  dependencies.sendResult(port, hydration, sessions.map((session) => session.id), false);
}
