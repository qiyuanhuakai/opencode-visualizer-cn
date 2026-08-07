export type CodeRowRect = { top: number; height: number; right: number };

export function buildAbsoluteRowRects(
  firstRenderedLine: number,
  visibleRowRects: CodeRowRect[],
): Array<CodeRowRect | undefined> {
  const rows: Array<CodeRowRect | undefined> = [];
  visibleRowRects.forEach((rect, index) => {
    rows[firstRenderedLine + index] = rect;
  });
  return rows;
}

export function findLineAtY(
  rowRects: Array<CodeRowRect | undefined>,
  y: number,
): number | null {
  for (let line = 0; line < rowRects.length; line += 1) {
    const rect = rowRects[line];
    if (!rect) continue;
    if (y >= rect.top && y < rect.top + rect.height) return line;
  }
  return null;
}
