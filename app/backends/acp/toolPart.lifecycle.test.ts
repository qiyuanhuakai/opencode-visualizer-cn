import { describe, expect, it } from 'vitest';
import { createAcpToolPart } from './toolPart';

describe('ACP partial tool lifecycle updates', () => {
  it.each(['completed', 'failed'])('preserves %s state on a later update without status', (status) => {
    const terminal = createAcpToolPart('session', 'message', {
      toolCallId: 'shell', status, rawOutput: 'result', rawInput: { command: 'pwd' },
    }, undefined, 2);
    const updated = createAcpToolPart('session', 'message', {
      toolCallId: 'shell', title: 'Shell command',
    }, terminal, 3);
    expect(updated.state).toEqual(terminal.state);
    const outputUpdate = createAcpToolPart('session', 'message', {
      toolCallId: 'shell', rawOutput: 'final output',
    }, terminal, 4);
    expect(outputUpdate.state).toMatchObject({
      status: terminal.state.status,
      ...(status === 'completed' ? { output: 'final output' } : { error: 'final output' }),
      time: { start: 2, end: 2 },
    });
  });
});
