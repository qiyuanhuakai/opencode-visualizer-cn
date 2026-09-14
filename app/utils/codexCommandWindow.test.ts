import { describe, expect, it } from 'vitest';
import { fitCodexCommandWindow } from './codexCommandWindow';

describe('Codex command window bounds', () => {
  it('keeps every edge inside a smaller canvas after a desktop window is resized to mobile', () => {
    const result = fitCodexCommandWindow({ x: 360, y: 24, width: 560, height: 560 }, { width: 375, height: 480 });
    expect(result).toEqual({ x: 16, y: 16, width: 343, height: 448 });
  });
  it('preserves a user position and size that already fit', () => {
    const window = { x: 300, y: 40, width: 500, height: 360 };
    expect(fitCodexCommandWindow(window, { width: 1280, height: 800 })).toEqual(window);
  });
});
