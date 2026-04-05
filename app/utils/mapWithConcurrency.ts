export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  concurrency: number,
  runner: (item: T, index: number) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  if (items.length === 0) return [];

  const limit = Number.isFinite(concurrency) ? Math.max(1, Math.floor(concurrency)) : 1;
  const results: PromiseSettledResult<R>[] = [];
  let nextIndex = 0;

  async function worker() {
    while (true) {
      const currentIndex = nextIndex;
      nextIndex += 1;
      if (currentIndex >= items.length) return;

      try {
        const value = await runner(items[currentIndex], currentIndex);
        results[currentIndex] = {
          status: 'fulfilled',
          value,
        };
      } catch (reason) {
        results[currentIndex] = {
          status: 'rejected',
          reason,
        };
      }
    }
  }

  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, () => worker()));
  return results;
}
