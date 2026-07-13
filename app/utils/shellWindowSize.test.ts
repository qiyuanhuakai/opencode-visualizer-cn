import { describe, expect, it } from 'vitest';

import { clampShellWindowSize } from './shellWindowSize';

describe('clampShellWindowSize', () => {
  it('keeps measured size when no minimum exists', () => {
    // Given: xterm reported a healthy measured shell size.
    const measured = { width: 960, height: 420 };

    // When: no custom panel minimum is required.
    const actual = clampShellWindowSize(measured);

    // Then: the measured size is preserved exactly.
    expect(actual).toEqual(measured);
  });

  it('uses the custom minimum when xterm measures a collapsed host', () => {
    // Given: xterm measured a zero-height host before the custom panel finished layout.
    const measured = { width: 960, height: 38 };
    const minimum = { width: 960, height: 520 };

    // When: the window size is clamped for a panel with toolbar chrome.
    const actual = clampShellWindowSize(measured, minimum);

    // Then: the panel remains tall enough to show toolbar, prompt, and terminal rows.
    expect(actual).toEqual(minimum);
  });
});
