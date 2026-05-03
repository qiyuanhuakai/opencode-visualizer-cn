import { computed, type ComputedRef, type Ref } from 'vue';
import type { CodexThread } from '../backends/codex/codexAdapter';
import { CODEX_PROJECT_ID } from '../backends/codex/bridgeUrl';
import type { CodexCanonicalHistoryEntry } from '../backends/codex/normalize';
import type { ProjectState, SessionState } from '../types/worker-state';

export { CODEX_PROJECT_ID };
export const CODEX_SANDBOX_NAME = 'Codex';
export const CODEX_GLOBAL_SANDBOX_NAME = 'Global';
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
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  return value > 0 && value < 1_000_000_000_000 ? value * 1000 : value;
}

function expandHomePath(path: string, homeDirectory: string) {
  const raw = path.trim();
  const home = homeDirectory.trim() || CODEX_DEFAULT_DIRECTORY;
  if (raw === '~') return home;
  if (raw.startsWith('~/')) return `${home.replace(/\/+$/u, '')}/${raw.slice(2).replace(/^\/+/, '')}`;
  return raw;
}

function basename(path: string) {
  return path.replace(/\/+$/u, '').split('/').filter(Boolean).at(-1) || path || CODEX_SANDBOX_NAME;
}

function threadSandboxDirectory(thread: CodexThread | undefined, fallbackDirectory = CODEX_DEFAULT_DIRECTORY) {
  const cwd = thread?.cwd?.trim();
  if (cwd) {
    const expanded = expandHomePath(cwd, fallbackDirectory);
    if (expanded && expanded !== CODEX_DEFAULT_DIRECTORY) return expanded;
  }
  const root = thread?.gitInfo?.root?.trim();
  if (root) return expandHomePath(root, fallbackDirectory);
  return CODEX_DEFAULT_DIRECTORY;
}

function threadSandboxName(thread: CodexThread | undefined, sandboxDirectory: string) {
  if (!thread?.gitInfo?.root?.trim()) return CODEX_GLOBAL_SANDBOX_NAME;
  const branch = thread.gitInfo.branch?.trim();
  const projectName = basename(sandboxDirectory);
  return branch ? `${projectName} · ${branch}` : projectName;
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
  sessionDirectory = threadSandboxDirectory(thread, fallbackDirectory),
): SessionState {
  return {
    id: thread.id,
    title: threadTitle(thread),
    status: threadStatus(thread),
    directory: sessionDirectory,
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
  const primaryDirectory = CODEX_DEFAULT_DIRECTORY;
  const sandboxes: ProjectState['sandboxes'] = {};

  for (const thread of threads) {
    const directory = threadSandboxDirectory(thread, fallbackDirectory);
    const sandbox = sandboxes[directory] ?? {
      directory,
      name: threadSandboxName(thread, directory),
      rootSessions: [],
      sessions: {},
    };
    sandbox.rootSessions.push(thread.id);
    sandbox.sessions[thread.id] = codexThreadToSession(thread, fallbackDirectory, pinnedThreadIds, directory);
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
  const activeDirectory = computed(() => threadSandboxDirectory(activeThread.value, fallbackDirectory.value));
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
