type WorkerResultRequestOptions<T> = {
  register: (finish: (value: T | undefined) => void) => () => void;
  send: () => boolean;
  timeoutMs: number;
};

export function requestWorkerResult<T>(
  options: WorkerResultRequestOptions<T>,
): Promise<T | undefined> {
  return new Promise((resolve) => {
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout> | undefined;
    let unregister = () => {};
    const finish = (value: T | undefined) => {
      if (settled) return;
      settled = true;
      if (timeoutId !== undefined) clearTimeout(timeoutId);
      unregister();
      resolve(value);
    };
    unregister = options.register(finish);
    if (settled) {
      unregister();
      return;
    }
    if (!options.send()) {
      finish(undefined);
      return;
    }
    timeoutId = setTimeout(() => finish(undefined), options.timeoutMs);
  });
}

export async function retryReferencedSessionIds(
  requestedSessionIds: string[],
  load: (sessionIds: string[]) => Promise<string[] | undefined>,
  options: {
    maxRetries?: number;
    maxBatchSize?: number;
    wait?: (delayMs: number) => Promise<void>;
    shouldContinue?: () => boolean;
  } = {},
) {
  const maxRetries = options.maxRetries ?? 3;
  const maxBatchSize = Math.max(1, Math.trunc(options.maxBatchSize ?? 128));
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const shouldContinue = options.shouldContinue ?? (() => true);
  const requested = Array.from(new Set(requestedSessionIds));
  const requestedSet = new Set(requested);
  const loaded = new Set<string>();

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!shouldContinue()) return [];
    const missing = requested.filter((sessionId) => !loaded.has(sessionId));
    for (let start = 0; start < missing.length; start += maxBatchSize) {
      if (!shouldContinue()) return [];
      const loadedSessionIds = await load(missing.slice(start, start + maxBatchSize));
      if (loadedSessionIds === undefined) return undefined;
      for (const sessionId of loadedSessionIds) {
        if (requestedSet.has(sessionId)) loaded.add(sessionId);
      }
    }
    if (requested.every((sessionId) => loaded.has(sessionId))) {
      return requested;
    }
    if (attempt < maxRetries) {
      if (!shouldContinue()) return [];
      await wait(250 * 2 ** attempt);
    }
  }
  return requested.filter((sessionId) => loaded.has(sessionId));
}
