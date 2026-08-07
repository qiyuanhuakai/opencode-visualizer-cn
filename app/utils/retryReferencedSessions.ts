export async function retryReferencedSessionIds(
  requestedSessionIds: string[],
  load: () => Promise<string[]>,
  options: {
    maxRetries?: number;
    wait?: (delayMs: number) => Promise<void>;
    shouldContinue?: () => boolean;
  } = {},
) {
  const maxRetries = options.maxRetries ?? 3;
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));
  const shouldContinue = options.shouldContinue ?? (() => true);

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    if (!shouldContinue()) return [];
    const loadedSessionIds = await load();
    const loaded = new Set(loadedSessionIds);
    if (requestedSessionIds.every((sessionId) => loaded.has(sessionId))) {
      return loadedSessionIds;
    }
    if (attempt < maxRetries) {
      if (!shouldContinue()) return [];
      await wait(250 * 2 ** attempt);
    }
  }
  return [];
}
