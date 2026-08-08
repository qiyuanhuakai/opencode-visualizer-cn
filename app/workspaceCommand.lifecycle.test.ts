import { describe, expect, it, vi } from 'vitest';

import { createWorkspaceCommandRunner } from '../bridge/workspaceCommand.js';

describe('workspace command lifecycle', () => {
  it('rejects new commands synchronously after closing admission', async () => {
    const spawnProcess = vi.fn(() => {
      throw new Error('spawn should not be called');
    });
    const runner = createWorkspaceCommandRunner({ spawnProcess });

    await runner.close();

    await expect(runner.run({ command: process.execPath })).rejects.toThrow(
      'Command runner is shutting down',
    );
    expect(spawnProcess).not.toHaveBeenCalled();
  });
});
