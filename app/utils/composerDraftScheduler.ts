export type ComposerDraftScheduler = {
  schedule: () => void;
  flush: () => void;
  cancel: () => void;
};

export function createComposerDraftScheduler(
  persist: () => void,
  delayMs: number,
): ComposerDraftScheduler {
  let timer: ReturnType<typeof setTimeout> | null = null;

  function cancel() {
    if (timer === null) return;
    clearTimeout(timer);
    timer = null;
  }

  function flush() {
    if (timer === null) return;
    cancel();
    persist();
  }

  function schedule() {
    cancel();
    timer = setTimeout(() => {
      timer = null;
      persist();
    }, delayMs);
  }

  return { schedule, flush, cancel };
}
