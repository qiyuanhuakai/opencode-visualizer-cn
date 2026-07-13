import { describe, expect, it } from 'vitest';

import { resolveTerminalScrollTarget } from './terminalScroll';

describe('resolveTerminalScrollTarget', () => {
  it('keeps following the terminal bottom when output arrived while already at the bottom', () => {
    // Given: the xterm viewport was following the bottom before the PTY write parsed.
    const snapshot = {
      baseY: 42,
      cursorY: 23,
      rows: 24,
      viewportY: 41,
      wasAtBottomBeforeWrite: true,
    };

    // When: the scroll policy resolves the next viewport action.
    const target = resolveTerminalScrollTarget(snapshot);

    // Then: it explicitly follows xterm's bottom after asynchronous parsing.
    expect(target).toEqual({ kind: 'bottom' });
  });

  it('scrolls back to the cursor when xterm viewport drifts below the current buffer bottom', () => {
    // Given: the scrollbar remains at an impossible old bottom after the terminal screen resets.
    const snapshot = {
      baseY: 3,
      cursorY: 0,
      rows: 24,
      viewportY: 120,
      wasAtBottomBeforeWrite: false,
    };

    // When: the cursor line is above the stale viewport.
    const target = resolveTerminalScrollTarget(snapshot);

    // Then: the terminal scrolls to the cursor instead of leaving the scrollbar at the stale bottom.
    expect(target).toEqual({ kind: 'line', line: 3 });
  });

  it('does not yank a user away from scrollback when new output lands below their viewport', () => {
    // Given: the user intentionally scrolled above the active output region.
    const snapshot = {
      baseY: 200,
      cursorY: 18,
      rows: 24,
      viewportY: 40,
      wasAtBottomBeforeWrite: false,
    };

    // When: the cursor is below the visible viewport.
    const target = resolveTerminalScrollTarget(snapshot);

    // Then: no automatic follow occurs because this is legitimate user scrollback.
    expect(target).toEqual({ kind: 'none' });
  });
});
