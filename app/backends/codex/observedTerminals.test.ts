import { describe, expect, it } from 'vitest';
import { observeCodexTerminals } from './observedTerminals';

function event(method: string, params: unknown, id = 1) {
  return { id, time: id * 1000, method, params };
}
function started(threadId = 'main') {
  return event('item/started', {
    threadId,
    item: {
      id: 'cmd',
      type: 'commandExecution',
      command: 'npm run dev',
      cwd: '/repo',
      status: 'inProgress',
    },
  });
}
describe('observed Codex terminals', () => {
  it('filters other threads and unscoped events', () => {
    const events = [
      started('other'),
      event('item/started', { item: { id: 'unknown', type: 'commandExecution' } }),
      started(),
    ];
    expect(observeCodexTerminals(events, 'main').map((item) => item.id)).toEqual(['cmd']);
    expect(observeCodexTerminals(events, '')).toEqual([]);
  });
  it('replaces streamed output with completion and shows the last three nonempty lines', () => {
    const events = [
      started(),
      event(
        'item/commandExecution/outputDelta',
        { threadId: 'main', itemId: 'cmd', delta: 'stale output' },
        2,
      ),
      event(
        'item/completed',
        {
          threadId: 'main',
          item: {
            id: 'cmd',
            type: 'commandExecution',
            status: 'failed',
            exitCode: 2,
            aggregatedOutput: 'first\n\nsecond\nthird\n \nfourth\n',
          },
        },
        3,
      ),
    ];
    expect(observeCodexTerminals(events, 'main')[0]).toMatchObject({
      status: 'failed',
      exitCode: 2,
      command: 'npm run dev',
      outputLines: ['second', 'third', 'fourth'],
    });
  });
  it('merges split deltas before selecting lines', () => {
    const events = [
      started(),
      event(
        'item/commandExecution/outputDelta',
        { threadId: 'main', itemId: 'cmd', delta: 'one\ntw' },
        2,
      ),
      event(
        'item/commandExecution/outputDelta',
        { threadId: 'main', itemId: 'cmd', delta: 'o\nthree\nfour' },
        3,
      ),
    ];
    expect(observeCodexTerminals(events, 'main')[0]?.outputLines).toEqual(['two', 'three', 'four']);
  });
  it('updates the process and interaction time without adding stdin to output', () => {
    const events = [
      started(),
      event(
        'item/commandExecution/terminalInteraction',
        { threadId: 'main', itemId: 'cmd', processId: '77', stdin: 'secret input' },
        4,
      ),
    ];
    expect(observeCodexTerminals(events, 'main')[0]).toMatchObject({
      processId: '77',
      interactionTime: 4000,
      outputLines: [],
    });
  });
  it('reports an unknown state when only an interaction was observed', () => {
    const events = [
      event('item/commandExecution/terminalInteraction', {
        threadId: 'main',
        itemId: 'cmd',
        processId: '77',
        stdin: '',
      }),
    ];
    expect(observeCodexTerminals(events, 'main')[0]?.status).toBe('unknown');
  });
});
