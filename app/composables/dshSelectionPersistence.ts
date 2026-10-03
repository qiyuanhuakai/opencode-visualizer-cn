import type { ProjectState } from '../types/worker-state';
import { storageGetJSON, storageSetJSON } from '../utils/storageKeys';

type Selection = { readonly projectId: string; readonly sessionId: string };

function connectionKey(bridgeUrl: string): string {
  try {
    const url = new URL(bridgeUrl.trim());
    return `state.dshLastSelection.v1:${encodeURIComponent(`${url.protocol}//${url.host}${url.pathname.replace(/\/+$/u, '')}`)}`;
  } catch (error) {
    if (error instanceof TypeError) return '';
    throw error;
  }
}

export function resolveDshSelection(
  projects: Record<string, ProjectState>,
  sessionId: string,
): Selection | undefined {
  for (const [projectId, project] of Object.entries(projects)) {
    for (const sandbox of Object.values(project.sandboxes)) {
      if (!Object.hasOwn(sandbox.sessions, sessionId)) continue;
      const session = sandbox.sessions[sessionId];
      if (session && !session.timeArchived) return { projectId, sessionId };
    }
  }
  return undefined;
}

export function createDshSelectionPersistence() {
  let committedConnection = '';

  function preferredSessionId(bridgeUrl: string, explicitSessionId = ''): string {
    if (explicitSessionId.trim()) return explicitSessionId.trim();
    const key = connectionKey(bridgeUrl);
    if (!key) return '';
    const stored = storageGetJSON<unknown>(key);
    return typeof stored === 'object' && stored !== null && 'sessionId' in stored
      && typeof stored.sessionId === 'string' ? stored.sessionId.trim() : '';
  }

  function persist(bridgeUrl: string, projects: Record<string, ProjectState>, sessionId: string) {
    const key = connectionKey(bridgeUrl);
    if (!key || key !== committedConnection) return;
    const selection = resolveDshSelection(projects, sessionId);
    if (selection) storageSetJSON(key, selection);
  }

  function commit(bridgeUrl: string, projects: Record<string, ProjectState>, sessionId: string) {
    committedConnection = connectionKey(bridgeUrl);
    const selection = resolveDshSelection(projects, sessionId);
    persist(bridgeUrl, projects, sessionId);
    return selection;
  }

  return {
    preferredSessionId,
    persist,
    commit,
    reset: () => { committedConnection = ''; },
  };
}
