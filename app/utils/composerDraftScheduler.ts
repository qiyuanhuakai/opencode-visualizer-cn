export type ComposerDraftScheduler = {
  schedule: (task?: () => void) => void;
  flush: () => void;
  cancel: () => void;
};

export function createComposerDraftScheduler(
  persist: () => void,
  delayMs: number,
): ComposerDraftScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingTask: (() => void) | null = null;

  function cancel() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
    pendingTask = null;
  }

  function flush() {
    if (timer === null) return;
    const task = pendingTask ?? persist;
    cancel();
    task();
  }

  function schedule(task = persist) {
    cancel();
    pendingTask = task;
    timer = setTimeout(() => {
      const pending = pendingTask ?? persist;
      timer = null;
      pendingTask = null;
      pending();
    }, delayMs);
  }

  return { schedule, flush, cancel };
}
