export type CodeRowRect = { top: number; height: number; right: number };

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
