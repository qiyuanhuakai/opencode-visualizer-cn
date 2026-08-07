export type CodeRowRect = { top: number; height: number; right: number };

export function shouldVirtualizeCodeRows(
  rowCount: number,
  threshold: number,
  wraps: boolean,
) {
  return rowCount > threshold && !wraps;
}

export function calculateVirtualRowWindow(params: {
  totalRows: number;
  scrollTop: number;
  containerHeight: number;
  rowHeight: number;
  overscanRows: number;
}) {
  const rowHeight = Math.max(1, params.rowHeight);
  const start = Math.max(0, Math.floor(params.scrollTop / rowHeight) - params.overscanRows);
  const visibleCount = Math.ceil(params.containerHeight / rowHeight);
  const end = Math.min(
    params.totalRows,
    start + visibleCount + params.overscanRows * 2,
  );
  return { start, end };
}

export function buildAbsoluteRowRects(
  firstRenderedLine: number,
  visibleRowRects: CodeRowRect[],
): Map<number, CodeRowRect> {
  const rows = new Map<number, CodeRowRect>();
  visibleRowRects.forEach((rect, index) => {
    rows.set(firstRenderedLine + index, rect);
  });
  return rows;
}

export function findLineAtY(rowRects: ReadonlyMap<number, CodeRowRect>, y: number): number | null {
  for (const [line, rect] of rowRects) {
    if (y >= rect.top && y < rect.top + rect.height) return line;
  }
  return null;
}

export function buildVisibleRangeHighlightStyles(
  rowRects: ReadonlyMap<number, CodeRowRect>,
  start: number,
  end: number,
) {
  return [...rowRects]
    .filter(([line]) => line >= start && line <= end)
    .map(([, rect]) => ({
      top: `${rect.top}px`,
      left: '0',
      right: '0',
      height: `${rect.height}px`,
    }));
}
