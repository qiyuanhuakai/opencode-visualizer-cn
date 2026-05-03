import { describe, expect, it } from 'vitest';

import { shouldPreservePendingCodexSelection } from './codexSessionSelection';

describe('shouldPreservePendingCodexSelection', () => {
  it('preserves selection while the pending codex session is not yet in projected sandboxes', () => {
    expect(shouldPreservePendingCodexSelection({
      pendingSessionLock: 'thread-new',
      selectedSessionId: 'thread-new',
      projectSandboxes: {
        '/repo': {
          sessions: {
            'thread-old': {},
          },
        },
      },
    })).toBe(true);
  });

  it('stops preserving selection once the pending session materializes', () => {
    expect(shouldPreservePendingCodexSelection({
      pendingSessionLock: 'thread-new',
      selectedSessionId: 'thread-new',
      projectSandboxes: {
        '/repo': {
          sessions: {
            'thread-new': {},
          },
        },
      },
    })).toBe(false);
  });

  it('does not preserve selection for unrelated sessions', () => {
    expect(shouldPreservePendingCodexSelection({
      pendingSessionLock: 'thread-new',
      selectedSessionId: 'thread-old',
      projectSandboxes: {},
    })).toBe(false);
  });
});
