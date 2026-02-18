/**
 * Pure notification state manager — no Vue, no framework dependencies.
 *
 * Tracks pending notification request IDs grouped by root session ID.
 * Child session IDs are resolved to their root parent via the
 * `resolveRoot` callback supplied at creation time.
 */

export function createNotificationManager(
  resolveRoot: (sessionId: string) => string,
) {
  // rootSessionId → Set<requestId>
  let state: Map<string, Set<string>> = new Map();
  // Insertion-ordered list of root session IDs (for badge ordering)
  let sessionOrder: string[] = [];

  /**
   * Add a notification for the given session + request.
   * The sessionId is resolved to its root parent before storage.
   * Returns `true` if the state actually changed (new requestId added).
   */
  function addNotification(sessionId: string, requestId: string): boolean {
    if (!sessionId || !requestId) return false;
    const rootId = resolveRoot(sessionId);
    const existing = state.get(rootId);
    if (existing?.has(requestId)) return false;

    const next = new Map(state);
    const requestSet = new Set(existing ?? []);
    requestSet.add(requestId);
    next.set(rootId, requestSet);
    state = next;

    if (!sessionOrder.includes(rootId)) {
      sessionOrder = [...sessionOrder, rootId];
    }
    return true;
  }

  /**
   * Remove a notification request across all sessions.
   * If a session's set becomes empty, the session entry is removed.
   * Returns `true` if the state actually changed.
   */
  function removeNotification(requestId: string): boolean {
    if (!requestId) return false;
    for (const [rootId, requestSet] of state.entries()) {
      if (!requestSet.has(requestId)) continue;

      const next = new Map(state);
      const updatedSet = new Set(requestSet);
      updatedSet.delete(requestId);

      if (updatedSet.size === 0) {
        next.delete(rootId);
        sessionOrder = sessionOrder.filter((id) => id !== rootId);
      } else {
        next.set(rootId, updatedSet);
      }
      state = next;
      return true;
    }
    return false;
  }

  /**
   * Clear all notifications for a session (resolved to root).
   * Returns `true` if the state actually changed.
   */
  function clearSession(sessionId: string): boolean {
    if (!sessionId) return false;
    const rootId = resolveRoot(sessionId);
    if (!state.has(rootId)) return false;

    const next = new Map(state);
    next.delete(rootId);
    state = next;
    sessionOrder = sessionOrder.filter((id) => id !== rootId);
    return true;
  }

  /**
   * Return a structured-cloneable snapshot of the current state.
   * Safe for `postMessage` (no `Set` values).
   */
  function getState(): Record<string, string[]> {
    const out: Record<string, string[]> = {};
    for (const [rootId, requestSet] of state.entries()) {
      out[rootId] = [...requestSet];
    }
    return out;
  }

  /** Whether any notification is pending. */
  function hasAny(): boolean {
    return state.size > 0;
  }

  /** Root session IDs in insertion order. */
  function getSessionIds(): string[] {
    return sessionOrder.filter((id) => state.has(id));
  }

  /**
   * Bulk-import state (e.g. from a bootstrap / postMessage payload).
   * Replaces the current state entirely.
   */
  function importState(data: Record<string, string[]>): void {
    const next = new Map<string, Set<string>>();
    const order: string[] = [];
    for (const [rootId, requestIds] of Object.entries(data)) {
      if (requestIds.length > 0) {
        next.set(rootId, new Set(requestIds));
        order.push(rootId);
      }
    }
    state = next;
    sessionOrder = order;
  }

  return {
    addNotification,
    removeNotification,
    clearSession,
    getState,
    hasAny,
    getSessionIds,
    importState,
  };
}
