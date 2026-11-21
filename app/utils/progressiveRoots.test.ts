import { describe, expect, it } from 'vitest';
import {
  initialProgressiveRootWindow,
  reconcileProgressiveRootWindow,
  shiftProgressiveRootWindow,
} from './progressiveRoots';

describe('progressive root window', () => {
  it('starts with the newest batch and shifts through older/newer bounded windows', () => {
    let window = initialProgressiveRootWindow(250, 20);
    expect(window).toEqual({ start: 230, end: 250 });

    for (let index = 0; index < 6; index += 1) {
      window = shiftProgressiveRootWindow(window, 250, 'older', 20, 100);
    }
    expect(window).toEqual({ start: 110, end: 210 });
    expect(window.end - window.start).toBe(100);

    window = shiftProgressiveRootWindow(window, 250, 'newer', 20, 100);
    expect(window).toEqual({ start: 130, end: 230 });
  });

  it('preserves an appended live root while enforcing the hard window bound', () => {
    const previous = Array.from({ length: 100 }, (_, index) => `root-${index}`);

    expect(
      reconcileProgressiveRootWindow(
        previous,
        [...previous, 'root-100'],
        { start: 0, end: 100 },
        100,
      ),
    ).toEqual({ start: 1, end: 101 });
  });

  it('keeps a full paused window stable when a new root appends', () => {
    const previous = Array.from({ length: 100 }, (_, index) => `root-${index}`);

    expect(
      reconcileProgressiveRootWindow(
        previous,
        [...previous, 'root-100'],
        { start: 0, end: 100 },
        100,
        false,
      ),
    ).toEqual({ start: 0, end: 100 });
  });

  it('reveals the earlier loaded card even when the newest page had no overflow to scroll', () => {
    expect(reconcileProgressiveRootWindow(['new'], ['older', 'new'], { start: 0, end: 1 }, 100))
      .toEqual({ start: 0, end: 2 });
  });

  it('preserves a window away from the start when roots are prepended', () => {
    expect(reconcileProgressiveRootWindow(['a', 'b', 'c'], ['older', 'a', 'b', 'c'], { start: 1, end: 3 }, 100))
      .toEqual({ start: 2, end: 4 });
  });

  it('resets an out-of-range window after revert shrinks the renderable roots', () => {
    const previous = Array.from({ length: 250 }, (_, index) => `root-${index}`);
    const next = previous.slice(0, 101);

    expect(
      reconcileProgressiveRootWindow(previous, next, { start: 230, end: 250 }, 100),
    ).toEqual({ start: 81, end: 101 });
  });
});
