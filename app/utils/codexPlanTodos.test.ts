import { describe, expect, it } from 'vitest';
import { codexPlansToTodoSessions } from './codexPlanTodos';

describe('codexPlansToTodoSessions', () => {
  it('projects the latest plan per allowed thread into selected-first todo sessions', () => {
    const result = codexPlansToTodoSessions(
      [
        { threadId: 'a', turnId: 'old', plan: [{ step: 'Old', status: 'pending' }] },
        {
          threadId: 'b',
          turnId: 'b1',
          explanation: 'Background plan',
          plan: [{ step: 'Wait', status: 'inProgress' }],
        },
        {
          threadId: 'a',
          turnId: 'new',
          explanation: 'Current plan',
          plan: [{ step: 'Ship', status: 'completed' }],
        },
      ],
      new Set(['a', 'b', 'hidden']),
      'b',
      new Map([['a', 'Alpha'], ['b', 'Beta']]),
    );

    expect(result).toEqual([
      {
        sessionId: 'b', title: 'Beta', description: 'Background plan', isSubagent: false,
        todos: [{ content: 'Wait', status: 'in_progress', priority: 'medium' }],
        loading: false, error: undefined,
      },
      {
        sessionId: 'a', title: 'Alpha', description: 'Current plan', isSubagent: false,
        todos: [{ content: 'Ship', status: 'completed', priority: 'medium' }],
        loading: false, error: undefined,
      },
    ]);
  });
});
