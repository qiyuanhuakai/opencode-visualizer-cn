const WORKSPACE_REFRESH_INTERVAL_MS = 5_000;

export type WorkspaceRefreshLoop = {
  readonly start: () => void;
  readonly stop: () => void;
  readonly sync: () => void;
};

export type WorkspaceRefreshLoopOptions = {
  readonly intervalMs?: number;
  readonly isEnabled?: () => boolean;
  readonly onError?: (error: unknown) => void;
};

function isWindowAttentive() {
  if (typeof window === 'undefined' || typeof document === 'undefined') return false;
  return !document.hidden && document.hasFocus();
}

export function createWorkspaceRefreshLoop(
  refresh: () => Promise<void>,
  options: WorkspaceRefreshLoopOptions = {},
): WorkspaceRefreshLoop {
  const intervalMs = options.intervalMs ?? WORKSPACE_REFRESH_INTERVAL_MS;
  let started = false;
  let refreshRunning = false;
  let timer: ReturnType<typeof setTimeout> | null = null;

  function clearTimer() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function canRefresh() {
    return (options.isEnabled?.() ?? true) && isWindowAttentive();
  }

  function schedule(delayMs: number) {
    clearTimer();
    if (!started || refreshRunning || !canRefresh()) return;
    timer = setTimeout(() => {
      timer = null;
      void runRefresh();
    }, delayMs);
  }

  async function runRefresh() {
    if (!started || refreshRunning || !canRefresh()) return;
    refreshRunning = true;
    try {
      await refresh();
    } catch (error) {
      if (options.onError) options.onError(error);
      else console.error('[workspace-refresh] refresh failed:', error);
    } finally {
      refreshRunning = false;
      schedule(intervalMs);
    }
  }

  function sync() {
    if (!canRefresh()) {
      clearTimer();
      return;
    }
    schedule(0);
  }

  function handleAttentionChange() {
    sync();
  }

  function start() {
    if (started) return;
    if (typeof window === 'undefined' || typeof document === 'undefined') return;
    started = true;
    window.addEventListener('focus', handleAttentionChange);
    window.addEventListener('blur', handleAttentionChange);
    document.addEventListener('visibilitychange', handleAttentionChange);
    schedule(intervalMs);
  }

  function stop() {
    if (!started) return;
    started = false;
    clearTimer();
    window.removeEventListener('focus', handleAttentionChange);
    window.removeEventListener('blur', handleAttentionChange);
    document.removeEventListener('visibilitychange', handleAttentionChange);
  }

  return { start, stop, sync };
}
