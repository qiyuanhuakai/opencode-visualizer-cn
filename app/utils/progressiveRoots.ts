export function preserveProgressiveRootLimit(
  previousRootIds: string[],
  nextRootIds: string[],
  currentLimit: number,
) {
  if (nextRootIds.length <= previousRootIds.length) {
    return Math.min(currentLimit, nextRootIds.length);
  }
  const appended = previousRootIds.every((rootId, index) => nextRootIds[index] === rootId);
  if (!appended) return Math.min(currentLimit, nextRootIds.length);
  return Math.min(currentLimit + nextRootIds.length - previousRootIds.length, nextRootIds.length);
}
