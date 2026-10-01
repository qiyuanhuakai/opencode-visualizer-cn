import { describe, expect, it } from 'vitest';
import { applyAcpUpdate, beginAcpPrompt, completeAcpPrompt } from './history';
import { createState } from './historyTestHarness';

describe('ACP interrupted prompt tool completion', () => {
  it.each(['cancelled', 'error'])('settles pending and running tools on %s without changing completed tools', (reason) => {
    const state = createState([]);
    beginAcpPrompt(state, [{ type: 'text', text: 'Inspect' }], 1, 'agent');
    for (const status of ['pending', 'in_progress', 'completed']) {
      applyAcpUpdate(state, {
        sessionUpdate: 'tool_call', toolCallId: status, status,
        title: 'bash', rawInput: { command: 'pwd' }, rawOutput: 'finished',
      }, 5, 'agent');
    }
    const entry = completeAcpPrompt(state, reason, 10);
    const tools = entry?.parts.filter(part => part.type === 'tool');
    expect(tools?.map(part => part.state.status)).toEqual(['error', 'error', 'completed']);
    for (const part of tools?.slice(0, 2) ?? []) {
      expect(part.state).toMatchObject({ error: expect.stringContaining(reason), time: { end: 10 } });
    }
    expect(tools?.[2]?.state).toMatchObject({ output: 'finished', time: { end: 5 } });
  });
});
