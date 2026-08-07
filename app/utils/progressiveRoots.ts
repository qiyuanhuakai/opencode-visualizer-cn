export type ProgressiveRootWindow = { start: number; end: number };

export function initialProgressiveRootWindow(
  total: number,
  batchSize: number,
): ProgressiveRootWindow {
  return { start: Math.max(0, total - batchSize), end: total };
}

export function shiftProgressiveRootWindow(
  window: ProgressiveRootWindow,
  total: number,
  direction: 'older' | 'newer',
  batchSize: number,
  maxSize: number,
): ProgressiveRootWindow {
  if (direction === 'older') {
    const start = Math.max(0, window.start - batchSize);
    return { start, end: Math.min(window.end, start + maxSize) };
  }
  const end = Math.min(total, window.end + batchSize);
  return { start: Math.max(window.start, end - maxSize), end };
}

export function preserveProgressiveRootWindowOnAppend(
  previousRootIds: string[],
  nextRootIds: string[],
  window: ProgressiveRootWindow,
  maxSize: number,
) {
  const appended =
    nextRootIds.length >= previousRootIds.length &&
    previousRootIds.every((rootId, index) => nextRootIds[index] === rootId);
  if (!appended || window.end !== previousRootIds.length) return window;
  const end = nextRootIds.length;
  return { start: Math.max(window.start, end - maxSize), end };
}
