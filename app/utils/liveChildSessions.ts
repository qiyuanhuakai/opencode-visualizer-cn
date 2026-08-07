import type { SessionHistoryMeta } from './threadSubagents';

export function discoverNewDirectChildren(
  previousIds: ReadonlySet<string> | undefined,
  rootSessionId: string,
  metaBySessionId: Record<string, SessionHistoryMeta>,
) {
  const currentIds = new Set(
    Object.entries(metaBySessionId).flatMap(([sessionId, meta]) =>
      meta.parentID === rootSessionId ? [sessionId] : [],
    ),
  );
  const newlyObservedIds = previousIds
    ? [...currentIds].filter((sessionId) => !previousIds.has(sessionId))
    : [];
  const activeIds = [...currentIds].filter((sessionId) => {
    const status = metaBySessionId[sessionId]?.status;
    return status === 'busy' || status === 'retry';
  });
  const newIds = [...new Set([...newlyObservedIds, ...activeIds])];
  return { currentIds, newIds };
}

export function resolveUnassignedLiveChildren(
  liveChildIds: string[],
  exactReferencedIds: ReadonlySet<string>,
  metaBySessionId: Record<string, SessionHistoryMeta>,
) {
  return liveChildIds.flatMap((sessionId) => {
    const meta = metaBySessionId[sessionId];
    if (!meta || exactReferencedIds.has(sessionId)) return [];
    return [{ sessionId, label: meta.label }];
  });
}
