import { describe, expect, it } from 'vitest';

import { resolveRestoredPtyKind } from './forgePty';

describe('resolveRestoredPtyKind', () => {
  it('restores the persisted Forge PTY as the Forge panel', () => {
    // Given: a running PTY matches the persisted Forge id.
    const ptyId = 'pty-forge';

    // When: shell restoration resolves the window kind.
    const kind = resolveRestoredPtyKind(ptyId, 'pty-forge');

    // Then: the restored PTY recreates the Forge component rather than a plain terminal.
    expect(kind).toBe('forge');
  });

  it('keeps non-Forge PTYs as generic shells', () => {
    // Given: a regular terminal PTY id.
    const ptyId = 'pty-shell';

    // When: shell restoration resolves the window kind.
    const kind = resolveRestoredPtyKind(ptyId, 'pty-forge');

    // Then: ordinary PTYs retain the generic shell component.
    expect(kind).toBe('shell');
  });
});
