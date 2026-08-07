export async function retryReferencedSessionIds(
  requestedSessionIds: string[],
  load: () => Promise<string[]>,
  options: {
    maxRetries?: number;
    wait?: (delayMs: number) => Promise<void>;
  } = {},
) {
  const maxRetries = options.maxRetries ?? 3;
  const wait = options.wait ?? ((delayMs) => new Promise<void>((resolve) => setTimeout(resolve, delayMs)));

  for (let attempt = 0; attempt <= maxRetries; attempt += 1) {
    const loadedSessionIds = await load();
    const loaded = new Set(loadedSessionIds);
    if (requestedSessionIds.every((sessionId) => loaded.has(sessionId))) {
      return loadedSessionIds;
    }
    if (attempt < maxRetries) await wait(250 * 2 ** attempt);
  }
  return [];
}
