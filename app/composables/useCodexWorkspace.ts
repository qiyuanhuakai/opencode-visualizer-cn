import { computed, type ComputedRef, type Ref } from 'vue';
import type { CodexThread } from '../backends/codex/codexAdapter';
import { CODEX_PROJECT_ID } from '../backends/codex/bridgeUrl';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import type { ProjectState, SessionState } from '../types/worker-state';

export { CODEX_PROJECT_ID };
export const CODEX_SANDBOX_NAME = 'Codex';
export const CODEX_DEFAULT_DIRECTORY = '/';

export type CodexWorkspaceApi = {
  visibleThreads: ComputedRef<CodexThread[]>;
  threads: Ref<CodexThread[]>;
  activeThreadId: Ref<string>;
  canonicalHistory: Ref<CodexCanonicalHistoryEntry[]>;
  homeDir?: Ref<string>;
  pinnedThreadIds?: Ref<Set<string>>;
};

function threadTimestamp(value: unknown) {
  return typeof value === 'number' && Number.isFinite(value) ? value : undefined;
}

function threadDirectory(thread: CodexThread | undefined, fallbackDirectory = CODEX_DEFAULT_DIRECTORY) {
  return thread?.cwd?.trim() || fallbackDirectory;
}

function threadTitle(thread: CodexThread) {
  return thread.name?.trim() || thread.preview?.trim() || thread.id;
}

function threadStatus(thread: CodexThread): SessionState['status'] {
  if (thread.status === 'busy' || thread.status === 'running' || thread.status === 'inProgress') return 'busy';
  if (thread.status === 'retry') return 'retry';
  return 'idle';
}

export function codexThreadToSession(
  thread: CodexThread,
  fallbackDirectory = CODEX_DEFAULT_DIRECTORY,
  pinnedThreadIds: Set<string> = new Set(),
): SessionState {
  return {
    id: thread.id,
    title: threadTitle(thread),
    status: threadStatus(thread),
    directory: threadDirectory(thread, fallbackDirectory),
    timeCreated: threadTimestamp(thread.createdAt),
    timeUpdated: threadTimestamp(thread.updatedAt) ?? threadTimestamp(thread.createdAt),
    timePinned: pinnedThreadIds.has(thread.id) ? 1 : undefined,
  };
}

export function createCodexProjectState(
  threads: CodexThread[],
  fallbackDirectory = CODEX_DEFAULT_DIRECTORY,
  pinnedThreadIds: Set<string> = new Set(),
): ProjectState {
  const primaryDirectory = threadDirectory(threads[0], fallbackDirectory);
  const sandboxes: ProjectState['sandboxes'] = {};

  for (const thread of threads) {
    const directory = threadDirectory(thread, fallbackDirectory);
    const sandbox = sandboxes[directory] ?? {
      directory,
      name: directory === fallbackDirectory ? CODEX_SANDBOX_NAME : directory.split('/').filter(Boolean).at(-1) || CODEX_SANDBOX_NAME,
      rootSessions: [],
      sessions: {},
    };
    sandbox.rootSessions.push(thread.id);
    sandbox.sessions[thread.id] = codexThreadToSession(thread, fallbackDirectory, pinnedThreadIds);
    sandboxes[directory] = sandbox;
  }

  if (!sandboxes[primaryDirectory]) {
    sandboxes[primaryDirectory] = {
      directory: primaryDirectory,
      name: CODEX_SANDBOX_NAME,
      rootSessions: [],
      sessions: {},
    };
  }

  return {
    id: CODEX_PROJECT_ID,
    name: 'Codex',
    worktree: primaryDirectory,
    sandboxes,
  };
}

export function useCodexWorkspace(api: CodexWorkspaceApi) {
  const fallbackDirectory = computed(() => api.homeDir?.value || CODEX_DEFAULT_DIRECTORY);
  const project = computed(() => createCodexProjectState(
    api.visibleThreads.value,
    fallbackDirectory.value,
    api.pinnedThreadIds?.value,
  ));
  const projects = computed<Record<string, ProjectState>>(() => ({
    [CODEX_PROJECT_ID]: project.value,
  }));
  const activeThread = computed(() => (
    api.threads.value.find((thread) => thread.id === api.activeThreadId.value)
    ?? api.visibleThreads.value[0]
  ));
  const activeDirectory = computed(() => threadDirectory(activeThread.value, fallbackDirectory.value));
  const activeSessionId = computed(() => activeThread.value?.id ?? '');
  const history = computed(() => api.canonicalHistory.value);

  return {
    project,
    projects,
    activeDirectory,
    activeSessionId,
    history,
  };
}
