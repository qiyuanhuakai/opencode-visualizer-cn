export type TerminalScrollSnapshot = {
  readonly baseY: number;
  readonly cursorY: number;
  readonly rows: number;
  readonly viewportY: number;
  readonly wasAtBottomBeforeWrite: boolean;
};

export type TerminalScrollTarget = { readonly kind: 'bottom' } | { readonly kind: 'line'; readonly line: number } | { readonly kind: 'none' };

export function resolveTerminalScrollTarget(snapshot: TerminalScrollSnapshot): TerminalScrollTarget {
  if (snapshot.wasAtBottomBeforeWrite) return { kind: 'bottom' };

  const cursorLine = Math.max(0, snapshot.baseY + snapshot.cursorY);
  const viewportBottom = snapshot.viewportY + Math.max(1, snapshot.rows) - 1;
  if (snapshot.viewportY > snapshot.baseY) return { kind: 'line', line: cursorLine };
  if (cursorLine < snapshot.viewportY) return { kind: 'line', line: cursorLine };
  if (cursorLine > viewportBottom && snapshot.viewportY >= snapshot.baseY) return { kind: 'line', line: cursorLine };
  return { kind: 'none' };
}
