import { describe, expect, it, vi } from 'vitest';

import { createAcpProcessManager } from '../bridge/acpProcessManager.js';
import { formatAcpProcessError } from '../bridge/acpProcessState.js';

describe('ACP process startup errors', () => {
  it('keeps actionable tail lines without exposing a bundled source dump', async () => {
    const script = [
      "process.stderr.write('G'.repeat(9000));",
      "process.stderr.write('\\nSyntaxError: Unexpected identifier G\\nBun v1.3.11 (Linux x64)\\n');",
      'process.exit(1);',
    ].join('');
    const manager = createAcpProcessManager();

    await manager.reconcile([
      {
      id: 'broken',
      name: 'Broken ACP',
      command: process.execPath,
      args: ['-e', script],
        enabled: true,
      },
    ]);
    await vi.waitFor(() => expect(manager.getStatus()[0]?.state).toBe('error'));

    const error = manager.getStatus()[0]?.error ?? '';
    expect(error).toContain('SyntaxError: Unexpected identifier G');
    expect(error).toContain('Bun v1.3.11');
    expect(error.length).toBeLessThan(1_024);
    expect(error).not.toContain('G'.repeat(200));
    await manager.stopAll();
  });

  it('adds an actionable Bun upgrade hint for Oh My Pi parser failures', () => {
    expect(formatAcpProcessError(
      { id: 'oh-my-pi' },
      'SyntaxError: Unexpected identifier G\nBun v1.3.11 (Linux x64)',
    )).toContain('Update Bun');
  });
});
