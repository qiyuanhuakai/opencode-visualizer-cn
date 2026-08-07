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
  const newIds = previousIds
    ? [...currentIds].filter((sessionId) => !previousIds.has(sessionId))
    : [];
  return { currentIds, newIds };
}
