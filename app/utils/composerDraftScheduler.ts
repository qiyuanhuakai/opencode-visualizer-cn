import { registerLegacyWriter } from '../runtime/migration/writerFreeze';
export type ComposerDraftScheduler = {
  readonly pending: boolean;
  schedule: (task?: () => void) => void;
  flush: () => void;
  cancel: () => void;
  dispose: () => void;
};

export function createComposerDraftScheduler(
  persist: () => void,
  delayMs: number,
): ComposerDraftScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;
  let pendingTask: (() => void) | null = null;

  function cancel() {
    if (timer !== null) clearTimeout(timer);
    timer = null;
    pendingTask = null;
  }

  function flush() {
    if (pendingTask === null) return;
    const task = pendingTask ?? persist;
    cancel();
    try { task(); } catch (error) { pendingTask = task; throw error; }
  }

  function schedule(task = persist) {
    cancel();
    pendingTask = task;
    timer = setTimeout(() => {
      flush();
    }, delayMs);
  }

  const unregister = registerLegacyWriter(flush);
  return {
    get pending() {
      return pendingTask !== null;
    },
    schedule,
    flush,
    cancel,
    dispose() { flush(); unregister(); },
  };
}
